import type { GenerationGuard } from "../../../../lib/ai/abuse-control";
import { parseGenerationBody } from "../../../../lib/ai/input";
import type { GenerationPort } from "../../../../lib/ai/types";
import {
	apiErrorResponse,
	jsonData,
	jsonError,
	readJsonBody,
	requireSameOrigin,
} from "../../../../lib/search/http";
import type { SearchService } from "../../../../lib/search/service";
import {
	KQL_DIALECTS,
	type KqlDialect,
	type SearchRequest,
	type SearchResponse,
	type SearchViewer,
} from "../../../../lib/search/types";

const MINIMUM_DIALECT_CONFIDENCE = 0.75;

export interface GenerationRouteDependencies {
	searchService: SearchService;
	generator: GenerationPort;
	guard: GenerationGuard;
	resolveViewer(request: Request): Promise<SearchViewer>;
	recordHistory?: (
		request: SearchRequest,
		response: SearchResponse,
		viewer: SearchViewer,
		modeOverride?: "generated",
	) => Promise<void>;
}

export async function handleGenerationRequest(
	request: Request,
	dependencies: GenerationRouteDependencies,
): Promise<Response> {
	try {
		requireSameOrigin(request);
		const input = parseGenerationBody(await readJsonBody(request));
		const viewer = await dependencies.resolveViewer(request);

		await dependencies.guard.check({
			request,
			viewerId: viewer.userId,
			turnstileToken: input.turnstileToken,
			signal: request.signal,
		});

		const retrieval = await dependencies.searchService.search(
			input.request,
			viewer,
			request.signal,
		);

		if (retrieval.adequacy.adequate) {
			await dependencies.recordHistory?.(input.request, retrieval, viewer);
			return jsonError(
				409,
				"retrieval_sufficient",
				"Existing queries adequately match this request.",
				{ retrieval },
			);
		}
		if (retrieval.fallback?.status !== "available") {
			await dependencies.recordHistory?.(input.request, retrieval, viewer);
			return jsonError(
				503,
				"retrieval_incomplete",
				"AI fallback is unavailable until both retrieval stages complete.",
				{ retrieval },
			);
		}

		const inferredDialect: KqlDialect | null =
			retrieval.intent?.dialect &&
			retrieval.intent.dialectConfidence >= MINIMUM_DIALECT_CONFIDENCE
				? retrieval.intent.dialect
				: null;
		const targetDialect = input.targetDialect ?? inferredDialect;
		if (!targetDialect) {
			await dependencies.recordHistory?.(input.request, retrieval, viewer);
			return jsonError(
				422,
				"dialect_required",
				"Choose a KQL dialect before generating a query.",
				{ dialects: KQL_DIALECTS },
			);
		}

		const generated = await dependencies.generator.generateQuery({
			request: input.request,
			viewer,
			targetDialect,
			supportingResults: retrieval.results,
			privateProcessingAcknowledged: input.privateProcessingAcknowledged,
			signal: request.signal,
		});
		await dependencies.recordHistory?.(
			input.request,
			retrieval,
			viewer,
			"generated",
		);

		return jsonData({ generated, retrieval }, 201);
	} catch (error) {
		return apiErrorResponse(error);
	}
}
