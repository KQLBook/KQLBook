import { requireCurrentUser } from "@/lib/auth/session";
import { setQueryVisibility } from "@/lib/db/repository";

import {
  apiJson,
  getDatabase,
  getRouteId,
  handleApiError,
  parseJson,
  queryResponse,
  requireSameOrigin,
  type RouteContext,
  updateVisibilitySchema,
} from "../../_shared";

export async function PATCH(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const id = await getRouteId(context);
    const { visibility } = await parseJson(request, updateVisibilitySchema);
    const query = await setQueryVisibility(
      getDatabase(),
      id,
      user.id,
      visibility,
    );

    return apiJson(queryResponse(query));
  } catch (error) {
    return handleApiError(error);
  }
}
