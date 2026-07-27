import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
	CloudflareTurnstileVerifier,
	GenerationGuard,
	type RateLimiterLike,
} from "./abuse-control";
import { DeepSeekClient } from "./deepseek";
import type { DeepSeekModel } from "./types";

interface AiRuntimeEnv {
	AI_RATE_LIMITER?: RateLimiterLike;
	DEEPSEEK_API_KEY?: string | SecretsStoreSecret;
	DEEPSEEK_BASE_URL?: string;
	DEEPSEEK_MODEL?: DeepSeekModel;
	TURNSTILE_SECRET_KEY?: string;
	ALLOW_LOCAL_AI_WITHOUT_RATE_LIMITER?: string;
	AI_ALWAYS_REQUIRE_TURNSTILE?: string;
}

export interface AiRuntime {
	deepSeek: DeepSeekClient;
	guard: GenerationGuard;
}

export function createAiRuntime(): AiRuntime {
	const env = getCloudflareContext().env as unknown as AiRuntimeEnv;
	const turnstile = env.TURNSTILE_SECRET_KEY
		? new CloudflareTurnstileVerifier({
				secretKey: env.TURNSTILE_SECRET_KEY,
			})
		: undefined;

	return {
		deepSeek: new DeepSeekClient({
			apiKey: env.DEEPSEEK_API_KEY ?? "",
			baseUrl: env.DEEPSEEK_BASE_URL,
			model: env.DEEPSEEK_MODEL,
		}),
		guard: new GenerationGuard({
			rateLimiter: env.AI_RATE_LIMITER,
			turnstile,
			allowLocalBypass:
				env.ALLOW_LOCAL_AI_WITHOUT_RATE_LIMITER === "true",
			alwaysRequireTurnstile:
				env.AI_ALWAYS_REQUIRE_TURNSTILE === "true",
		}),
	};
}
