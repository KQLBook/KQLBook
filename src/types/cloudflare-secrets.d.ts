interface KqlCloudflareSecretBindings {
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
	DEEPSEEK_API_KEY?: string | SecretsStoreSecret;
	TURNSTILE_SECRET_KEY?: string;
	NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
	ADMIN_GITHUB_IDS?: string;
	EMBEDDING_SYNC_SECRET?: string;
	INGESTION_SYNC_SECRET?: string;
	GITHUB_INGESTION_TOKEN?: string;
	AI_ALWAYS_REQUIRE_TURNSTILE?: string;
	ALLOW_LOCAL_AI_WITHOUT_RATE_LIMITER?: string;
}

interface KqlProcessSecretBindings {
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
	DEEPSEEK_API_KEY?: string;
	DEEPSEEK_BASE_URL?: string;
	DEEPSEEK_MODEL?: string;
	TURNSTILE_SECRET_KEY?: string;
	NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
	ADMIN_GITHUB_IDS?: string;
	EMBEDDING_SYNC_SECRET?: string;
	INGESTION_SYNC_SECRET?: string;
	GITHUB_INGESTION_TOKEN?: string;
	AI_ALWAYS_REQUIRE_TURNSTILE?: string;
	ALLOW_LOCAL_AI_WITHOUT_RATE_LIMITER?: string;
}

// Declaration merging adds secrets to Wrangler's generated binding interface.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface CloudflareEnv extends KqlCloudflareSecretBindings {}

declare namespace Cloudflare {
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface Env extends KqlCloudflareSecretBindings {}
}

declare namespace NodeJS {
	interface ProcessEnv extends KqlProcessSecretBindings {
		GITHUB_APP_ID?: string;
		GITHUB_CLIENT_ID?: string;
		GITHUB_CLIENT_SECRET?: string;
	}
}
