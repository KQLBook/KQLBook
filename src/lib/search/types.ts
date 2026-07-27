export const KQL_DIALECTS = [
	"sentinel",
	"defender-xdr",
	"azure-data-explorer",
	"azure-resource-graph",
	"intune-device-query",
] as const;

export type KqlDialect = (typeof KQL_DIALECTS)[number];

export type QueryVisibility = "public" | "private";

export type SearchMatchType = "lexical" | "semantic" | "hybrid";

export interface SearchRequest {
	q: string;
	dialects: KqlDialect[];
	tables: string[];
	operators: string[];
	tags: string[];
	authors: string[];
	sources: string[];
	cursor?: string;
	limit: number;
}

export interface SearchProvenance {
	sourceName: string;
	sourceUrl?: string;
	repository?: string;
	repositoryUrl?: string;
	provider?: "github" | "local";
	licenseSpdx?: string;
	trusted?: boolean;
}

export interface SearchResult {
	queryId: string;
	versionId: string;
	title: string;
	snippet: string;
	dialect: KqlDialect;
	tables: string[];
	starCount: number;
	sourceRepository: string | null;
	sourceRepositoryUrl: string | null;
	matchType: SearchMatchType;
	/**
	 * A normalized relevance score in the inclusive range [0, 1].
	 * Database adapters must convert raw BM25 values before returning rows.
	 */
	score: number;
	provenance: SearchProvenance | null;
	visibility: QueryVisibility;
}

export interface SearchIntent {
	normalizedQuery: string;
	concepts: string[];
	dialect: KqlDialect | null;
	dialectConfidence: number;
	tables: string[];
	operators: string[];
	tags: string[];
}

export interface SemanticCandidate {
	queryId: string;
	versionId: string;
	score: number;
	namespace: string;
}

export type SearchStage = "lexical" | "intent" | "embedding" | "semantic" | "authorization";

export interface SearchStageIssue {
	stage: SearchStage;
	code: string;
	recoverable: boolean;
}

export interface AdequacyAssessment {
	adequate: boolean;
	confidence: number;
	reason:
		| "exact-title"
		| "exact-table"
		| "strong-score"
		| "clear-leading-result"
		| "weak-score"
		| "no-results";
}

export type RetrievalMode = "lexical" | "semantic" | "hybrid" | "none";

export interface GenerationFallback {
	status: "available" | "unavailable";
	reason: "retrieval-inadequate" | "retrieval-incomplete";
	dialectRequired: boolean;
}

export interface SearchResponse {
	query: string;
	results: SearchResult[];
	mode: RetrievalMode;
	adequacy: AdequacyAssessment;
	intent: SearchIntent | null;
	attempted: SearchStage[];
	issues: SearchStageIssue[];
	fallback: GenerationFallback | null;
	nextCursor?: string;
	historyId?: string;
}

export interface SearchViewer {
	userId: string | null;
}
