import { requireCurrentUser } from "@/lib/auth/session";
import { setHistoryClickedQuery } from "@/lib/db/repository";

import {
  apiNoContent,
  getDatabase,
  getHistoryId,
  handleApiError,
  historyClickSchema,
  parseJson,
  requireSameOrigin,
  type RouteContext,
} from "../../../queries/_shared";

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const historyId = await getHistoryId(context);
    const { queryId } = await parseJson(request, historyClickSchema);
    await setHistoryClickedQuery(
      getDatabase(),
      historyId,
      user.id,
      queryId,
    );

    return apiNoContent();
  } catch (error) {
    return handleApiError(error);
  }
}
