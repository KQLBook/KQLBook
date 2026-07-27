import { requireCurrentUser } from "@/lib/auth/session";
import { clearHistory, listHistory } from "@/lib/db/repository";

import {
  apiJson,
  apiNoContent,
  getDatabase,
  handleApiError,
  parseListOptions,
  requireSameOrigin,
} from "../queries/_shared";

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser(request);
    const { cursor, limit } = parseListOptions(request);
    const history = await listHistory(getDatabase(), user.id, {
      cursor,
      limit,
    });

    return apiJson(history);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireCurrentUser(request);
    await clearHistory(getDatabase(), user.id);

    return apiNoContent();
  } catch (error) {
    return handleApiError(error);
  }
}
