import { requireCurrentUser } from "@/lib/auth/session";
import { createQuery, listOwnedQueries } from "@/lib/db/repository";
import { DeepSeekQueryMetadataAnalyzer } from "@/lib/ai/query-metadata";
import { createAiRuntime } from "@/lib/ai/runtime";

import {
  apiJson,
  getDatabase,
  handleApiError,
  parseListOptions,
} from "./_shared";
import { handleCreateQueryRequest } from "./handler";

export async function GET(request: Request) {
  try {
    const user = await requireCurrentUser(request);
    const options = parseListOptions(request);
    const result = await listOwnedQueries(getDatabase(), user.id, options);

    return apiJson(result);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  const ai = createAiRuntime();

  return handleCreateQueryRequest(request, {
    resolveCurrentUser: requireCurrentUser,
    guard: ai.guard,
    metadata: new DeepSeekQueryMetadataAnalyzer(ai.deepSeek),
    persist: (input) => createQuery(getDatabase(), input),
  });
}
