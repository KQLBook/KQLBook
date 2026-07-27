import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { GenerationGuard } from "@/lib/ai/abuse-control";
import { DeepSeekQueryGenerator } from "@/lib/ai/generation";
import { DeepSeekIntentExtractor } from "@/lib/ai/intent";
import { createAiRuntime } from "@/lib/ai/runtime";
import type { GenerationPort } from "@/lib/ai/types";
import { WorkersAiEmbedder, type WorkersAiLike } from "@/lib/ai/workers-ai";

import { D1SearchAdapter } from "./d1-adapter";
import { D1EmbeddingOutboxStore } from "./d1-outbox-adapter";
import { EmbeddingOutboxProcessor } from "./outbox";
import { SearchService } from "./service";
import {
	CloudflareVectorMutation,
	CloudflareVectorSearch,
	type VectorizeIndexLike,
	type VectorizeMutationIndexLike,
} from "./vectorize";

interface SearchRuntimeEnv {
	DB: D1Database;
	VECTORIZE: VectorizeIndexLike & VectorizeMutationIndexLike;
	AI: WorkersAiLike;
}

export interface SearchRuntime {
	db: D1Database;
	searchService: SearchService;
	generator: GenerationPort;
	guard: GenerationGuard;
	outboxProcessor: EmbeddingOutboxProcessor;
}

export function createSearchRuntime(): SearchRuntime {
	const env = getCloudflareContext().env as unknown as SearchRuntimeEnv;
	const { deepSeek, guard } = createAiRuntime();
	const d1 = new D1SearchAdapter(env.DB);
	const embedding = new WorkersAiEmbedder(env.AI);
	const searchService = new SearchService({
		lexical: d1,
		authorization: d1,
		intent: new DeepSeekIntentExtractor(deepSeek),
		embedding,
		semantic: new CloudflareVectorSearch(env.VECTORIZE),
	});
	return {
		db: env.DB,
		searchService,
		generator: new DeepSeekQueryGenerator(deepSeek),
		guard,
		outboxProcessor: new EmbeddingOutboxProcessor({
			store: new D1EmbeddingOutboxStore(env.DB),
			embedding,
			vectors: new CloudflareVectorMutation(env.VECTORIZE),
		}),
	};
}
