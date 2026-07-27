import type { SearchResult, SemanticCandidate } from "./types";

const LEXICAL_WEIGHT = 0.62;
const SEMANTIC_WEIGHT = 0.38;
const HYBRID_BONUS = 0.06;

function clampScore(score: number): number {
	if (!Number.isFinite(score)) {
		return 0;
	}
	return Math.max(0, Math.min(1, score));
}

function resultKey(queryId: string, versionId: string): string {
	return `${queryId}\u0000${versionId}`;
}

function candidateForResult(
	result: SearchResult,
	candidatesByQuery: ReadonlyMap<string, SemanticCandidate[]>,
): SemanticCandidate | undefined {
	return candidatesByQuery
		.get(result.queryId)
		?.find((candidate) => candidate.versionId === result.versionId);
}

export function mergeSearchResults(
	lexicalResults: readonly SearchResult[],
	authorizedSemanticResults: readonly SearchResult[],
	semanticCandidates: readonly SemanticCandidate[],
	limit: number,
): SearchResult[] {
	const candidatesByQuery = new Map<string, SemanticCandidate[]>();
	for (const candidate of semanticCandidates) {
		const existing = candidatesByQuery.get(candidate.queryId) ?? [];
		existing.push(candidate);
		candidatesByQuery.set(candidate.queryId, existing);
	}

	const lexicalByKey = new Map(
		lexicalResults.map((result) => [resultKey(result.queryId, result.versionId), result]),
	);
	const semanticByKey = new Map(
		authorizedSemanticResults
			.filter((result) => candidateForResult(result, candidatesByQuery))
			.map((result) => [resultKey(result.queryId, result.versionId), result]),
	);
	const keys = new Set([...lexicalByKey.keys(), ...semanticByKey.keys()]);
	const merged: SearchResult[] = [];

	for (const key of keys) {
		const lexical = lexicalByKey.get(key);
		const authorized = semanticByKey.get(key);
		const base = lexical ?? authorized;
		if (!base) {
			continue;
		}

		const candidate = candidateForResult(base, candidatesByQuery);
		const lexicalScore = lexical ? clampScore(lexical.score) : 0;
		const semanticScore = candidate ? clampScore(candidate.score) : 0;
		const isHybrid = Boolean(lexical && candidate);
		const weightedScore = isHybrid
			? lexicalScore * LEXICAL_WEIGHT +
				semanticScore * SEMANTIC_WEIGHT +
				HYBRID_BONUS
			: lexical
				? lexicalScore
				: semanticScore;

		merged.push({
			...base,
			matchType: isHybrid ? "hybrid" : lexical ? "lexical" : "semantic",
			score: clampScore(weightedScore),
		});
	}

	return merged
		.sort((left, right) => {
			if (right.score !== left.score) {
				return right.score - left.score;
			}
			if (right.starCount !== left.starCount) {
				return right.starCount - left.starCount;
			}
			return left.queryId.localeCompare(right.queryId);
		})
		.slice(0, limit);
}
