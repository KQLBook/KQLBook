import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
	CloudflareTurnstileVerifier,
	GenerationGuard,
	type RateLimiterLike,
} from "./abuse-control";
import { OpenRouterClient } from "./openrouter";
import type { OpenRouterModel } from "./types";

interface AiRuntimeEnv {
	AI_RATE_LIMITER?: RateLimiterLike;
	OPENROUTER_API_KEY?: string;
	OPENROUTER_MODEL?: OpenRouterModel;
	TURNSTILE_SECRET_KEY?: string;
	APP_URL?: string;
	ALLOW_LOCAL_AI_WITHOUT_RATE_LIMITER?: string;
	AI_ALWAYS_REQUIRE_TURNSTILE?: string;
}

export interface AiRuntime {
	openRouter: OpenRouterClient;
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
		openRouter: new OpenRouterClient({
			apiKey: env.OPENROUTER_API_KEY ?? "",
			model: env.OPENROUTER_MODEL,
			siteUrl: env.APP_URL,
			appName: "KQL Book",
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
