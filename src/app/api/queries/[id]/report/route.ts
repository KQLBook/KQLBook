import { requireCurrentUser } from "@/lib/auth/session";
import { createReport } from "@/lib/db/repository";

import {
  apiJson,
  getDatabase,
  getRouteId,
  handleApiError,
  parseJson,
  reportQuerySchema,
  requireSameOrigin,
  type RouteContext,
} from "../../_shared";

export async function POST(request: Request, context: RouteContext) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    const queryId = await getRouteId(context);
    const input = await parseJson(request, reportQuerySchema);
    const report = await createReport(getDatabase(), {
      queryId,
      reporterId: user.id,
      ...input,
    });

    return apiJson(report, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
