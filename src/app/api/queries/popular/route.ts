import { listPublicQueries } from "@/lib/db/repository";

import {
	getDatabase,
	handleApiError,
	parseListOptions,
	publicApiJson,
} from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	try {
		const { cursor, limit } = parseListOptions(request);
		const queries = await listPublicQueries(getDatabase(), {
			cursor,
			limit,
		});

		return publicApiJson(queries);
	} catch (error) {
		return handleApiError(error);
	}
}
