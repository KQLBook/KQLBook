import { requireCurrentUser } from "@/lib/auth/session";
import { listStarredQueries } from "@/lib/db/repository";

import {
  apiJson,
  getDatabase,
  handleApiError,
  parseListOptions,
} from "../_shared";

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser(request);
    const { cursor, limit } = parseListOptions(request);
    const queries = await listStarredQueries(getDatabase(), user.id, {
      cursor,
      limit,
    });

    return apiJson(queries);
  } catch (error) {
    return handleApiError(error);
  }
}
