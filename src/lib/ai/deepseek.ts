import { AiServiceError, OperationTimeoutError } from "./errors";
import { runWithTimeout } from "./timeout";
import {
	DEEPSEEK_BASE_URL,
	DEEPSEEK_MODEL,
	type DeepSeekModel,
} from "./types";

type JsonSchema = Record<string, unknown>;

interface DeepSeekErrorBody {
	error?: {
		code?: number;
		message?: string;
		metadata?: {
			error_type?: string;
		};
	};
}

interface DeepSeekMessage {
	content?: unknown;
}

interface DeepSeekResponse extends DeepSeekErrorBody {
	choices?: Array<{
		message?: DeepSeekMessage;
	}>;
}

export interface DeepSeekStructuredRequest<T> {
	name: string;
	schema: JsonSchema;
	system: string;
	user: string;
	validate: (value: unknown) => T;
	maxTokens: number;
	signal?: AbortSignal;
}

export interface DeepSeekApiKeyBinding {
	get(): Promise<string>;
}

export interface DeepSeekClientOptions {
	apiKey: string | DeepSeekApiKeyBinding;
	fetch?: typeof fetch;
	model?: DeepSeekModel;
	baseUrl?: string;
	timeoutMs?: number;
}

async function apiKeyValue(
	source: string | DeepSeekApiKeyBinding,
): Promise<string> {
	if (typeof source === "string") {
		return source;
	}

	try {
		return await source.get();
	} catch (error) {
		throw new AiServiceError(
			"configuration_error",
			"AI credentials could not be read.",
			{ status: 503, cause: error },
		);
	}
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

function errorFromStatus(
	status: number,
	retryAfterSeconds?: number,
): AiServiceError {
	switch (status) {
		case 401:
			return new AiServiceError("configuration_error", "AI credentials are invalid.", {
				status: 503,
			});
		case 402:
			return new AiServiceError("credits_exhausted", "AI generation credits are exhausted.", {
				status: 503,
			});
		case 403:
			return new AiServiceError("content_blocked", "The AI provider rejected this request.", {
				status: 422,
			});
		case 408:
		case 504:
			return new AiServiceError("timeout", "The AI provider timed out.", {
				status: 504,
				retryable: true,
			});
		case 429:
			return new AiServiceError("rate_limited", "The AI provider is rate limiting requests.", {
				status: 429,
				retryable: true,
				retryAfterSeconds,
			});
		case 502:
		case 503:
			return new AiServiceError("service_unavailable", "The AI provider is unavailable.", {
				status: 503,
				retryable: true,
				retryAfterSeconds,
			});
		default:
			return new AiServiceError(
				"upstream_error",
				"The AI provider rejected the request.",
				{
					status: status >= 500 ? 503 : 422,
					retryable: status >= 500,
				},
			);
	}
}

function messageContent(message: DeepSeekMessage | undefined): string {
	const content = message?.content;
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (
					typeof part === "object" &&
					part !== null &&
					"text" in part &&
					typeof part.text === "string"
				) {
					return part.text;
				}
				return "";
			})
			.join("");
	}
	return "";
}

export class DeepSeekClient {
	readonly #apiKey: string | DeepSeekApiKeyBinding;
	readonly #fetch: typeof fetch;
	readonly #model: DeepSeekModel;
	readonly #baseUrl: string;
	readonly #timeoutMs: number;

	constructor(options: DeepSeekClientOptions) {
		this.#apiKey = options.apiKey;
		this.#fetch = options.fetch ?? fetch;
		this.#model = options.model ?? DEEPSEEK_MODEL;
		this.#baseUrl = (options.baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, "");
		this.#timeoutMs = options.timeoutMs ?? 15_000;
	}

	get model(): DeepSeekModel {
		return this.#model;
	}

	async structured<T>(request: DeepSeekStructuredRequest<T>): Promise<T> {
		try {
			return await runWithTimeout(async (signal) => {
				const apiKey = await apiKeyValue(this.#apiKey);
				if (!apiKey) {
					throw new AiServiceError(
						"configuration_error",
						"AI generation is not configured.",
						{ status: 503 },
					);
				}

				const headers = new Headers({
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				});

				const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
					method: "POST",
					headers,
					signal,
					body: JSON.stringify({
						model: this.#model,
						messages: [
							{
								role: "system",
								content: [
									request.system,
									`Return one valid JSON object named ${request.name} matching this JSON Schema:`,
									JSON.stringify(request.schema),
								].join("\n"),
							},
							{ role: "user", content: request.user },
						],
						response_format: {
							type: "json_object",
						},
						temperature: 0.1,
						max_tokens: request.maxTokens,
						stream: false,
					}),
				});

				let body: DeepSeekResponse;
				try {
					body = (await response.json()) as DeepSeekResponse;
				} catch (error) {
					throw new AiServiceError(
						"invalid_response",
						"The AI provider returned an unreadable response.",
						{ status: 502, retryable: true, cause: error },
					);
				}

				if (!response.ok || body.error) {
					const upstreamStatus =
						typeof body.error?.code === "number"
							? body.error.code
							: response.status;
					throw errorFromStatus(
						upstreamStatus,
							parseRetryAfter(response.headers.get("Retry-After")),
						);
				}

				const content = messageContent(body.choices?.[0]?.message);
				if (!content) {
					throw new AiServiceError(
						"invalid_response",
						"The AI provider returned no structured content.",
						{ status: 502, retryable: true },
					);
				}

				let parsed: unknown;
				try {
					parsed = JSON.parse(content);
				} catch (error) {
					throw new AiServiceError(
						"invalid_response",
						"The AI provider returned malformed structured content.",
						{ status: 502, retryable: true, cause: error },
					);
				}

				try {
					return request.validate(parsed);
				} catch (error) {
					throw new AiServiceError(
						"invalid_response",
						"The AI provider response did not match the required schema.",
						{ status: 502, retryable: true, cause: error },
					);
				}
			}, this.#timeoutMs, request.signal);
		} catch (error) {
			if (error instanceof AiServiceError) {
				throw error;
			}
			if (error instanceof OperationTimeoutError) {
				throw new AiServiceError("timeout", "The AI provider timed out.", {
					status: 504,
					retryable: true,
					cause: error,
				});
			}
			throw new AiServiceError("service_unavailable", "The AI provider is unavailable.", {
				status: 503,
				retryable: true,
				cause: error,
			});
		}
	}
}
