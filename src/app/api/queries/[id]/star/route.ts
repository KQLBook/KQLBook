import { requireCurrentUser } from "@/lib/auth/session";
import { starQuery, unstarQuery } from "@/lib/db/repository";

import {
  apiJson,
  apiNoContent,
  getDatabase,
  getRouteId,
  handleApiError,
  requireSameOrigin,
  type RouteContext,
} from "../../_shared";

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const id = await getRouteId(context);
    const star = await starQuery(getDatabase(), id, user.id);

    return apiJson(star);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const id = await getRouteId(context);
    await unstarQuery(getDatabase(), id, user.id);

    return apiNoContent();
  } catch (error) {
    return handleApiError(error);
  }
}
