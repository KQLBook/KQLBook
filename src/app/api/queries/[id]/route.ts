import { getCurrentUser, requireCurrentUser } from "@/lib/auth/session";
import {
  deleteQuery,
  getQueryById,
  updateQuery,
} from "@/lib/db/repository";

import {
  apiJson,
  apiNoContent,
  getDatabase,
  getRouteId,
  handleApiError,
  parseJson,
  queryResponse,
  requireSameOrigin,
  type RouteContext,
  updateQuerySchema,
} from "../_shared";

export async function GET(request: Request, context: RouteContext) {
  try {
    const id = await getRouteId(context);
    const user = await getCurrentUser(request);
    const query = await getQueryById(getDatabase(), id, user?.id ?? null);

    return apiJson(queryResponse(query));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const id = await getRouteId(context);
    const input = await parseJson(request, updateQuerySchema);
    const query = await updateQuery(getDatabase(), id, user.id, input);

    return apiJson(queryResponse(query));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const id = await getRouteId(context);
    await deleteQuery(getDatabase(), id, user.id);

    return apiNoContent();
  } catch (error) {
    return handleApiError(error);
  }
}
