import { comparableSearchText } from "./normalize";
import type { AdequacyAssessment, SearchResult } from "./types";

export interface AdequacyThresholds {
	strongScore: number;
	leadingScore: number;
	minimumLead: number;
}

export const DEFAULT_ADEQUACY_THRESHOLDS: AdequacyThresholds = {
	strongScore: 0.74,
	leadingScore: 0.64,
	minimumLead: 0.12,
};

function clampScore(score: number): number {
	if (!Number.isFinite(score)) {
		return 0;
	}
	return Math.max(0, Math.min(1, score));
}

export function assessAdequacy(
	results: readonly SearchResult[],
	query: string,
	thresholds: AdequacyThresholds = DEFAULT_ADEQUACY_THRESHOLDS,
): AdequacyAssessment {
	if (results.length === 0) {
		return {
			adequate: false,
			confidence: 0,
			reason: "no-results",
		};
	}

	const comparableQuery = comparableSearchText(query);
	const exactTitle = results.find(
		(result) => comparableSearchText(result.title) === comparableQuery,
	);
	if (exactTitle) {
		return {
			adequate: true,
			confidence: Math.max(0.96, clampScore(exactTitle.score)),
			reason: "exact-title",
		};
	}

	const exactTable = results.find((result) =>
		result.tables.some((table) => comparableSearchText(table) === comparableQuery),
	);
	if (exactTable) {
		return {
			adequate: true,
			confidence: Math.max(0.9, clampScore(exactTable.score)),
			reason: "exact-table",
		};
	}

	const sortedScores = results.map((result) => clampScore(result.score)).sort((a, b) => b - a);
	const topScore = sortedScores[0] ?? 0;
	if (topScore >= thresholds.strongScore) {
		return {
			adequate: true,
			confidence: topScore,
			reason: "strong-score",
		};
	}

	const runnerUp = sortedScores[1] ?? 0;
	if (
		topScore >= thresholds.leadingScore &&
		topScore - runnerUp >= thresholds.minimumLead
	) {
		return {
			adequate: true,
			confidence: topScore,
			reason: "clear-leading-result",
		};
	}

	return {
		adequate: false,
		confidence: topScore,
		reason: "weak-score",
	};
}

