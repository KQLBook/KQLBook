import { getCloudflareContext } from "@opennextjs/cloudflare";

import { createSearchRuntime } from "@/lib/search/runtime";

import { handleEmbeddingProcessRequest } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface EmbeddingSyncEnv {
	EMBEDDING_SYNC_SECRET?: string;
}

export async function POST(request: Request): Promise<Response> {
	const env = getCloudflareContext().env as unknown as EmbeddingSyncEnv;

	return handleEmbeddingProcessRequest(request, {
		secret: env.EMBEDDING_SYNC_SECRET,
		process: (signal) =>
			createSearchRuntime().outboxProcessor.process(signal),
	});
}

