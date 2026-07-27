import { optionalSession } from "@/lib/auth/session";
import { recordSearchHistory } from "@/lib/db/repository";
import { normalizeSearchText } from "@/lib/search/normalize";
import { createSearchRuntime } from "@/lib/search/runtime";

import { handleGenerationRequest } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const searchRuntime = createSearchRuntime();

	return handleGenerationRequest(request, {
		searchService: searchRuntime.searchService,
		generator: searchRuntime.generator,
		guard: searchRuntime.guard,
		resolveViewer: async (source) => {
			const session = await optionalSession(source);
			return { userId: session?.user.id ?? null };
		},
		recordHistory: async (searchRequest, response, viewer, modeOverride) => {
			if (!viewer.userId) {
				return;
			}
			await recordSearchHistory(searchRuntime.db, {
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
				retrievalMode: modeOverride ?? response.mode,
				resultCount: response.results.length,
			});
		},
	});
}

