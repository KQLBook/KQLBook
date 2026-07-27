import { apiErrorResponse, jsonData } from "../../../lib/search/http";
import { parseSearchParams } from "../../../lib/search/normalize";
import type { SearchService } from "../../../lib/search/service";
import type {
	SearchRequest,
	SearchResponse,
	SearchViewer,
} from "../../../lib/search/types";

export interface SearchRouteDependencies {
	searchService: SearchService;
	resolveViewer(request: Request): Promise<SearchViewer>;
	recordHistory?: (
		request: SearchRequest,
		response: SearchResponse,
		viewer: SearchViewer,
		modeOverride?: "generated",
	) => Promise<{ id: string } | undefined>;
}

export async function handleSearchRequest(
	request: Request,
	dependencies: SearchRouteDependencies,
): Promise<Response> {
	try {
		const searchRequest = parseSearchParams(new URL(request.url).searchParams);
		const viewer = await dependencies.resolveViewer(request);
		let response = await dependencies.searchService.search(
			searchRequest,
			viewer,
			request.signal,
		);

		if (viewer.userId && dependencies.recordHistory) {
			const history = await dependencies.recordHistory(
				searchRequest,
				response,
				viewer,
			);
			if (history?.id) {
				response = {
					...response,
					historyId: history.id,
				};
			}
		}

		return jsonData(response);
	} catch (error) {
		return apiErrorResponse(error);
	}
}
