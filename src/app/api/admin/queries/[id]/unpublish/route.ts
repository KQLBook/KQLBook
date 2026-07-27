import { requireAdmin } from "@/lib/auth/session";
import { adminUnpublishQuery } from "@/lib/db/repository";

import {
  apiJson,
  getDatabase,
  getRouteId,
  handleApiError,
  parseJson,
  queryResponse,
  requireSameOrigin,
  type RouteContext,
  unpublishQuerySchema,
} from "../../../../queries/_shared";

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const admin = await requireAdmin(request);
    const queryId = await getRouteId(context);
    const { reason } = await parseJson(request, unpublishQuerySchema);
    const query = await adminUnpublishQuery(getDatabase(), {
      queryId,
      adminId: admin.id,
      reason,
    });

    return apiJson(queryResponse(query));
  } catch (error) {
    return handleApiError(error);
  }
}
