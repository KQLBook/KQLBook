import {
	jsonData,
	jsonError,
} from "../../../../../lib/search/http";
import { hasValidBearerSecret } from "../../../../../lib/search/internal-auth";
import type { EmbeddingOutboxBatchResult } from "../../../../../lib/search/outbox";

export interface EmbeddingProcessRouteDependencies {
	secret?: string;
	process(signal: AbortSignal): Promise<EmbeddingOutboxBatchResult>;
}

export async function handleEmbeddingProcessRequest(
	request: Request,
	dependencies: EmbeddingProcessRouteDependencies,
): Promise<Response> {
	if (!dependencies.secret) {
		return jsonError(
			503,
			"service_unavailable",
			"Embedding sync is not configured.",
		);
	}

	const authorized = await hasValidBearerSecret(
		request.headers.get("authorization"),
		dependencies.secret,
	);
	if (!authorized) {
		return jsonError(401, "unauthorized", "Authentication required.");
	}

	try {
		const result = await dependencies.process(request.signal);
		return jsonData(result);
	} catch {
		return jsonError(
			503,
			"service_unavailable",
			"Embedding sync is temporarily unavailable.",
		);
	}
}

