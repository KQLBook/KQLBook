import type {
	SearchIntent,
	SearchRequest,
	SearchResult,
	SearchViewer,
	SemanticCandidate,
} from "./types";

export interface LexicalSearchPort {
	searchLexical(request: SearchRequest, viewer: SearchViewer): Promise<SearchResult[]>;
}

export interface QueryAuthorizationPort {
	getAuthorizedByIds(
		queryIds: string[],
		viewer: SearchViewer,
		request: SearchRequest,
	): Promise<SearchResult[]>;
}

export interface IntentExtractionPort {
	extractIntent(request: SearchRequest, signal?: AbortSignal): Promise<SearchIntent>;
}

export interface EmbeddingPort {
	embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

export interface SemanticSearchOptions {
	namespace: string;
	limit: number;
	signal?: AbortSignal;
}

export interface SemanticSearchPort {
	searchSemantic(
		embedding: readonly number[],
		options: SemanticSearchOptions,
	): Promise<SemanticCandidate[]>;
}

export interface SearchDependencies {
	lexical: LexicalSearchPort;
	authorization: QueryAuthorizationPort;
	intent: IntentExtractionPort;
	embedding: EmbeddingPort;
	semantic: SemanticSearchPort;
}
