import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
	D1IngestionStore,
	GithubHttpClient,
	GithubIngestionPipeline,
} from "@/lib/ingest";

import { handleGithubIngestionRequest } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface GithubIngestionEnv {
	DB: D1Database;
	INGESTION_SYNC_SECRET?: string;
	GITHUB_INGESTION_TOKEN?: string;
}

export async function POST(request: Request): Promise<Response> {
	const env = getCloudflareContext().env as unknown as GithubIngestionEnv;
	const pipeline = new GithubIngestionPipeline({
		github: new GithubHttpClient({
			token: env.GITHUB_INGESTION_TOKEN,
		}),
		store: new D1IngestionStore(env.DB),
	});

	return handleGithubIngestionRequest(request, {
		secret: env.INGESTION_SYNC_SECRET,
		ingest: (input) => pipeline.ingest(input),
	});
}
