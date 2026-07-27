import { isRecord } from "../search/normalize";
import { OperationTimeoutError } from "./errors";
import { runWithTimeout } from "./timeout";

const DEVICE_HEADER = "x-kql-device-id";
const MAX_DEVICE_ID_LENGTH = 128;

export interface RateLimiterLike {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface TurnstileVerifier {
	verify(options: {
		token: string;
		remoteIp?: string;
		expectedAction: string;
		expectedHostname?: string;
		signal?: AbortSignal;
	}): Promise<boolean>;
}

export interface GenerationGuardOptions {
	rateLimiter?: RateLimiterLike;
	turnstile?: TurnstileVerifier;
	allowLocalBypass?: boolean;
	alwaysRequireTurnstile?: boolean;
}

export interface GenerationGuardInput {
	request: Request;
	viewerId: string | null;
	turnstileToken?: string;
	signal?: AbortSignal;
}

export class AbuseControlError extends Error {
	readonly code:
		| "rate_limited"
		| "challenge_required"
		| "challenge_failed"
		| "abuse_control_unavailable";
	readonly status: number;
	readonly challengeRequired: boolean;

	constructor(
		code: AbuseControlError["code"],
		message: string,
		options: { status: number; challengeRequired?: boolean },
	) {
		super(message);
		this.name = "AbuseControlError";
		this.code = code;
		this.status = options.status;
		this.challengeRequired = options.challengeRequired ?? false;
	}
}

function clientIp(request: Request): string {
	return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

function deviceId(request: Request): string {
	const value = request.headers.get(DEVICE_HEADER)?.trim();
	if (!value || value.length > MAX_DEVICE_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(value)) {
		return "unidentified";
	}
	return value;
}

function isLocalRequest(request: Request): boolean {
	const hostname = new URL(request.url).hostname;
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

async function sha256Key(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export class GenerationGuard {
	readonly #rateLimiter?: RateLimiterLike;
	readonly #turnstile?: TurnstileVerifier;
	readonly #allowLocalBypass: boolean;
	readonly #alwaysRequireTurnstile: boolean;

	constructor(options: GenerationGuardOptions) {
		this.#rateLimiter = options.rateLimiter;
		this.#turnstile = options.turnstile;
		this.#allowLocalBypass = options.allowLocalBypass ?? false;
		this.#alwaysRequireTurnstile = options.alwaysRequireTurnstile ?? false;
	}

	async check(input: GenerationGuardInput): Promise<void> {
		if (!this.#rateLimiter) {
			if (this.#allowLocalBypass && isLocalRequest(input.request)) {
				return;
			}
			throw new AbuseControlError(
				"abuse_control_unavailable",
				"AI generation is unavailable because abuse controls are not configured.",
				{ status: 503 },
			);
		}

		const actor = input.viewerId
			? `user:${input.viewerId}`
			: `anonymous:${clientIp(input.request)}:${deviceId(input.request)}`;
		const key = await sha256Key(`ai-generate:${actor}`);

		let rateLimitResult: { success: boolean };
		try {
			rateLimitResult = await this.#rateLimiter.limit({ key });
		} catch {
			throw new AbuseControlError(
				"abuse_control_unavailable",
				"AI generation abuse controls are temporarily unavailable.",
				{ status: 503 },
			);
		}

		const challengeRequired = this.#alwaysRequireTurnstile || !rateLimitResult.success;
		if (!challengeRequired && !input.turnstileToken) {
			return;
		}
		if (!input.turnstileToken) {
			throw new AbuseControlError(
				rateLimitResult.success ? "challenge_required" : "rate_limited",
				"Complete the verification challenge before trying again.",
				{ status: 429, challengeRequired: true },
			);
		}
		if (!this.#turnstile) {
			throw new AbuseControlError(
				"abuse_control_unavailable",
				"Verification is not configured.",
				{ status: 503, challengeRequired: true },
			);
		}

		const verified = await this.#turnstile.verify({
			token: input.turnstileToken,
			remoteIp: clientIp(input.request),
			expectedAction: "ai-generate",
			expectedHostname: new URL(input.request.url).hostname,
			signal: input.signal,
		});
		if (!verified) {
			throw new AbuseControlError(
				"challenge_failed",
				"Verification failed. Refresh the challenge and try again.",
				{ status: 403, challengeRequired: true },
			);
		}
	}
}

export interface CloudflareTurnstileOptions {
	secretKey: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export class CloudflareTurnstileVerifier implements TurnstileVerifier {
	readonly #secretKey: string;
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;

	constructor(options: CloudflareTurnstileOptions) {
		this.#secretKey = options.secretKey;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 5_000;
	}

	async verify(options: {
		token: string;
		remoteIp?: string;
		expectedAction: string;
		expectedHostname?: string;
		signal?: AbortSignal;
	}): Promise<boolean> {
		if (!this.#secretKey) {
			return false;
		}

		try {
			return await runWithTimeout(async (signal) => {
				const response = await this.#fetch(
					"https://challenges.cloudflare.com/turnstile/v0/siteverify",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							secret: this.#secretKey,
							response: options.token,
							remoteip: options.remoteIp,
							idempotency_key: crypto.randomUUID(),
						}),
						signal,
					},
				);
				if (!response.ok) {
					return false;
				}

				const result: unknown = await response.json();
				if (!isRecord(result) || result.success !== true) {
					return false;
				}
				if (result.action !== options.expectedAction) {
					return false;
				}
				if (
					options.expectedHostname &&
					result.hostname !== options.expectedHostname
				) {
					return false;
				}
				return true;
			}, this.#timeoutMs, options.signal);
		} catch (error) {
			if (error instanceof OperationTimeoutError) {
				return false;
			}
			return false;
		}
	}
}
