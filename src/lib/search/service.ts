import { assessAdequacy } from "./adequacy";
import { SearchServiceError } from "./errors";
import { mergeSearchResults } from "./merge";
import { namespacesForViewer } from "./namespaces";
import { normalizeSearchText } from "./normalize";
import type { SearchDependencies } from "./ports";
import type {
	RetrievalMode,
	SearchIntent,
	SearchRequest,
	SearchResponse,
	SearchResult,
	SearchStage,
	SearchStageIssue,
	SearchViewer,
	SemanticCandidate,
} from "./types";

const MINIMUM_DIALECT_CONFIDENCE = 0.75;

function dialectRequired(
	request: SearchRequest,
	intent: SearchIntent | null,
): boolean {
	return (
		request.dialects.length === 0 &&
		(!intent?.dialect || intent.dialectConfidence < MINIMUM_DIALECT_CONFIDENCE)
	);
}

function retrievalMode(results: readonly SearchResult[]): RetrievalMode {
	if (results.some((result) => result.matchType === "hybrid")) {
		return "hybrid";
	}
	if (results.some((result) => result.matchType === "semantic")) {
		return "semantic";
	}
	return results.length > 0 ? "lexical" : "none";
}

function intentSearchText(request: SearchRequest, intent: SearchIntent | null): string {
	if (!intent) {
		return request.q;
	}

	return normalizeSearchText(
		[
			intent.normalizedQuery || request.q,
			...intent.concepts,
			...intent.tables,
			...intent.operators,
			...intent.tags,
		].join(" "),
	);
}

function safeIssue(stage: SearchStage, code: string, recoverable = true): SearchStageIssue {
	return { stage, code, recoverable };
}

export class SearchService {
	readonly #dependencies: SearchDependencies;

	constructor(dependencies: SearchDependencies) {
		this.#dependencies = dependencies;
	}

	async search(
		request: SearchRequest,
		viewer: SearchViewer,
		signal?: AbortSignal,
	): Promise<SearchResponse> {
		const attempted: SearchStage[] = ["lexical"];
		const issues: SearchStageIssue[] = [];
		let lexicalResults: SearchResult[];

		try {
			lexicalResults = await this.#dependencies.lexical.searchLexical(request, viewer);
		} catch (error) {
			throw new SearchServiceError(
				"lexical_search_unavailable",
				"Search is temporarily unavailable.",
				{ cause: error },
			);
		}

		const lexicalAdequacy = assessAdequacy(lexicalResults, request.q);
		if (lexicalAdequacy.adequate) {
			return {
				query: request.q,
				results: lexicalResults.slice(0, request.limit),
				mode: "lexical",
				adequacy: lexicalAdequacy,
				intent: null,
				attempted,
				issues,
				fallback: null,
			};
		}

		attempted.push("intent");
		let intent: SearchIntent | null = null;
		try {
			intent = await this.#dependencies.intent.extractIntent(request, signal);
		} catch {
			issues.push(safeIssue("intent", "intent_extraction_failed"));
		}

		attempted.push("embedding");
		let embedding: number[];
		try {
			embedding = await this.#dependencies.embedding.embed(
				intentSearchText(request, intent),
				signal,
			);
		} catch {
			issues.push(safeIssue("embedding", "embedding_failed"));
			return {
				query: request.q,
				results: lexicalResults.slice(0, request.limit),
				mode: retrievalMode(lexicalResults),
				adequacy: lexicalAdequacy,
				intent,
				attempted,
				issues,
				fallback: {
					status: "unavailable",
					reason: "retrieval-incomplete",
					dialectRequired: dialectRequired(request, intent),
				},
			};
		}

		attempted.push("semantic");
		const namespaces = namespacesForViewer(viewer.userId);
		const semanticSettled = await Promise.allSettled(
			namespaces.map((namespace) =>
				this.#dependencies.semantic.searchSemantic(embedding, {
					namespace,
					limit: Math.min(Math.max(request.limit * 2, 10), 50),
					signal,
				}),
			),
		);

		const semanticCandidates: SemanticCandidate[] = [];
		let semanticComplete = true;
		for (const result of semanticSettled) {
			if (result.status === "fulfilled") {
				semanticCandidates.push(...result.value);
			} else {
				semanticComplete = false;
			}
		}
		if (!semanticComplete) {
			issues.push(safeIssue("semantic", "semantic_search_failed"));
		}

		let authorizedSemanticResults: SearchResult[] = [];
		if (semanticCandidates.length > 0) {
			attempted.push("authorization");
			const queryIds = [...new Set(semanticCandidates.map((candidate) => candidate.queryId))];
			try {
				authorizedSemanticResults =
					await this.#dependencies.authorization.getAuthorizedByIds(
						queryIds,
						viewer,
						request,
					);
			} catch {
				issues.push(safeIssue("authorization", "authorization_check_failed", false));
				semanticComplete = false;
			}
		}

		const merged = mergeSearchResults(
			lexicalResults,
			authorizedSemanticResults,
			semanticCandidates,
			request.limit,
		);
		const adequacy = assessAdequacy(merged, request.q);

		return {
			query: request.q,
			results: merged,
			mode: retrievalMode(merged),
			adequacy,
			intent,
			attempted,
			issues,
			fallback: adequacy.adequate
				? null
				: {
						status: semanticComplete ? "available" : "unavailable",
						reason: semanticComplete ? "retrieval-inadequate" : "retrieval-incomplete",
						dialectRequired: dialectRequired(request, intent),
					},
		};
	}
}
