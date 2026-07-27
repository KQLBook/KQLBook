import { optionalSession } from "@/lib/auth/session";
import { recordSearchHistory } from "@/lib/db/repository";
import { normalizeSearchText } from "@/lib/search/normalize";
import { createSearchRuntime } from "@/lib/search/runtime";

import { handleSearchRequest } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
	const searchRuntime = createSearchRuntime();

	return handleSearchRequest(request, {
		searchService: searchRuntime.searchService,
		resolveViewer: async (source) => {
			const session = await optionalSession(source);
			return { userId: session?.user.id ?? null };
		},
		recordHistory: async (searchRequest, response, viewer) => {
			if (!viewer.userId) {
				return;
			}
			return recordSearchHistory(searchRuntime.db, {
				userId: viewer.userId,
				rawRequest: searchRequest.q,
				normalizedRequest: normalizeSearchText(searchRequest.q),
				filters: {
					dialects: searchRequest.dialects,
					tables: searchRequest.tables,
					operators: searchRequest.operators,
					tags: searchRequest.tags,
					authors: searchRequest.authors,
					sources: searchRequest.sources,
				},
				retrievalMode: response.mode,
				resultCount: response.results.length,
			});
		},
	});
}
