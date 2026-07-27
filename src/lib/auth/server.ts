import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { betterAuth } from "better-auth";

export const USER_ROLES = ["user", "admin"] as const;

export type UserRole = (typeof USER_ROLES)[number];

interface AuthBindings {
	DB: D1Database;
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_URL?: string;
	GITHUB_CLIENT_ID?: string | SecretsStoreSecret;
	GITHUB_CLIENT_SECRET?: string | SecretsStoreSecret;
	ADMIN_GITHUB_IDS?: string;
}

type RequestSource = Request | Headers;

export class AuthConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthConfigurationError";
	}
}

function requiredValue(value: string | undefined, name: string): string {
	const normalized = value?.trim();
	if (!normalized) {
		throw new AuthConfigurationError(
			`Missing required authentication binding: ${name}`,
		);
	}
	return normalized;
}

function isD1Database(value: unknown): value is D1Database {
	if (!value || typeof value !== "object") {
		return false;
	}

	return ["prepare", "batch", "exec"].every(
		(method) => typeof (value as Record<string, unknown>)[method] === "function",
	);
}

function localOrigin(source: RequestSource | undefined): string | undefined {
	let url: URL;

	if (source instanceof Request) {
		url = new URL(source.url);
	} else if (source) {
		const host = source.get("host");
		if (!host) {
			return undefined;
		}
		const forwardedProtocol = source.get("x-forwarded-proto");
		const protocol = forwardedProtocol === "https" ? "https" : "http";
		url = new URL(`${protocol}://${host}`);
	} else {
		return undefined;
	}

	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
		return undefined;
	}

	return url.origin;
}

function authBaseURL(
	configuredURL: string | undefined,
	source: RequestSource | undefined,
): string {
	const value = configuredURL?.trim();
	if (!value) {
		const origin = localOrigin(source);
		if (origin) {
			return origin;
		}
		throw new AuthConfigurationError(
			"Missing required authentication binding: BETTER_AUTH_URL",
		);
	}

	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new AuthConfigurationError(
			"BETTER_AUTH_URL must use http or https.",
		);
	}
	if (
		url.protocol !== "https:" &&
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
	) {
		throw new AuthConfigurationError(
			"BETTER_AUTH_URL must use https outside local development.",
		);
	}
	return url.origin;
}

function readBindings(): {
	bindings: AuthBindings;
	waitUntil: (promise: Promise<unknown>) => void;
} {
	const { env, ctx } = getCloudflareContext();
	const bindings = env as unknown as AuthBindings;

	if (!isD1Database(bindings.DB)) {
		throw new AuthConfigurationError(
			"Missing required authentication binding: DB",
		);
	}

	return {
		bindings,
		waitUntil: (promise) => ctx.waitUntil(promise),
	};
}

function environmentValue(
	bindingValue: string | undefined,
	processValue: string | undefined,
): string | undefined {
	return bindingValue ?? processValue;
}

async function credentialValue(
	bindingValue: string | SecretsStoreSecret | undefined,
	processValue: string | undefined,
	name: string,
): Promise<string | undefined> {
	if (typeof bindingValue === "string") {
		return bindingValue;
	}
	if (!bindingValue) {
		return processValue;
	}

	try {
		return await bindingValue.get();
	} catch {
		throw new AuthConfigurationError(
			`Unable to read authentication binding: ${name}`,
		);
	}
}

function configuredAdminIds(value: string | undefined): Set<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter((id) => /^\d+$/.test(id)),
	);
}

export async function createAuth(source?: RequestSource) {
	const { bindings, waitUntil } = readBindings();
	const secret = requiredValue(
		environmentValue(
			bindings.BETTER_AUTH_SECRET,
			process.env.BETTER_AUTH_SECRET,
		),
		"BETTER_AUTH_SECRET",
	);
	const githubClientId = requiredValue(
		await credentialValue(
			bindings.GITHUB_CLIENT_ID,
			process.env.GITHUB_CLIENT_ID,
			"GITHUB_CLIENT_ID",
		),
		"GITHUB_CLIENT_ID",
	);
	const githubClientSecret = requiredValue(
		await credentialValue(
			bindings.GITHUB_CLIENT_SECRET,
			process.env.GITHUB_CLIENT_SECRET,
			"GITHUB_CLIENT_SECRET",
		),
		"GITHUB_CLIENT_SECRET",
	);
	const configuredBaseURL = environmentValue(
		bindings.BETTER_AUTH_URL,
		process.env.BETTER_AUTH_URL,
	);
	const adminGitHubIds = configuredAdminIds(
		environmentValue(
			bindings.ADMIN_GITHUB_IDS,
			process.env.ADMIN_GITHUB_IDS,
		),
	);

	const promoteAdmin = async (userId: string, githubId: string) => {
		if (!adminGitHubIds.has(githubId)) {
			return;
		}
		await bindings.DB.prepare(
			`UPDATE "user"
			 SET "role" = 'admin', "updatedAt" = ?
			 WHERE "id" = ?`,
		)
			.bind(new Date().toISOString(), userId)
			.run();
	};

	return betterAuth({
		appName: "KQL Book",
		baseURL: authBaseURL(configuredBaseURL, source),
		basePath: "/api/auth",
		secret,
		database: bindings.DB,
		socialProviders: {
			github: {
				clientId: githubClientId,
				clientSecret: githubClientSecret,
			},
		},
		user: {
			deleteUser: {
				enabled: true,
			},
			additionalFields: {
				role: {
					type: ["user", "admin"] as ["user", "admin"],
					required: true,
					defaultValue: "user" as const,
					input: false,
					sortable: true,
				},
			},
		},
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			freshAge: 60 * 60,
		},
		account: {
			encryptOAuthTokens: true,
			accountLinking: {
				enabled: false,
				disableImplicitLinking: true,
				allowDifferentEmails: false,
				allowUnlinkingAll: false,
			},
		},
		rateLimit: {
			enabled: true,
			storage: "database",
			window: 60,
			max: 100,
		},
		databaseHooks: {
			account: {
				create: {
					after: async (account) => {
						if (account.providerId === "github") {
							await promoteAdmin(account.userId, account.accountId);
						}
					},
				},
			},
			session: {
				create: {
					after: async (session) => {
						if (adminGitHubIds.size === 0) {
							return;
						}
						const account = await bindings.DB.prepare(
							`SELECT "accountId"
							 FROM "account"
							 WHERE "userId" = ? AND "providerId" = 'github'
							 LIMIT 1`,
						)
							.bind(session.userId)
							.first<{ accountId: string }>();
						if (account) {
							await promoteAdmin(session.userId, account.accountId);
						}
					},
				},
			},
		},
		advanced: {
			cookiePrefix: "kql-community",
			ipAddress: {
				ipAddressHeaders: ["cf-connecting-ip"],
			},
			database: {
				generateId: "uuid",
			},
			backgroundTasks: {
				handler: waitUntil,
			},
		},
		telemetry: {
			enabled: false,
		},
	});
}

export type KqlAuth = Awaited<ReturnType<typeof createAuth>>;
export type AuthSession = KqlAuth["$Infer"]["Session"];
