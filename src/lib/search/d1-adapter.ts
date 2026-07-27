import {
	getAuthorizedQueriesByIds,
	searchQueriesLexical,
} from "@/lib/db/repository";

import type {
	LexicalSearchPort,
	QueryAuthorizationPort,
} from "./ports";
import type {
	SearchRequest,
	SearchResult,
	SearchViewer,
} from "./types";

export class D1SearchAdapter
	implements LexicalSearchPort, QueryAuthorizationPort
{
	readonly #db: D1Database;

	constructor(db: D1Database) {
		this.#db = db;
	}

	searchLexical(
		request: SearchRequest,
		viewer: SearchViewer,
	): Promise<SearchResult[]> {
		return searchQueriesLexical(this.#db, request, viewer.userId);
	}

	getAuthorizedByIds(
		queryIds: string[],
		viewer: SearchViewer,
		request: SearchRequest,
	): Promise<SearchResult[]> {
		return getAuthorizedQueriesByIds(
			this.#db,
			queryIds,
			viewer.userId,
			request,
		);
	}
}
