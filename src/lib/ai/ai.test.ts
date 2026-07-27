import { describe, expect, it, vi } from "vitest";

import { GenerationGuard } from "./abuse-control";
import { OpenRouterClient } from "./openrouter";
import { WorkersAiEmbedder } from "./workers-ai";

describe("OpenRouterClient", () => {
	it("requests strict structured output and validates the response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			Response.json({
				choices: [{ message: { content: "{\"value\":\"ok\"}" } }],
			}),
		);
		const client = new OpenRouterClient({
			apiKey: "test-key",
			fetch: fetchMock,
		});

		const output = await client.structured({
			name: "test",
			schema: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
			system: "Return data.",
			user: "{}",
			validate: (value) => value as { value: string },
			maxTokens: 20,
		});

		expect(output).toEqual({ value: "ok" });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(body.provider.require_parameters).toBe(true);
	});

	it("maps exhausted-credit responses to a recoverable API error", async () => {
		const client = new OpenRouterClient({
			apiKey: "test-key",
			fetch: vi.fn().mockResolvedValue(
				Response.json(
					{ error: { code: 402, message: "Insufficient credits" } },
					{ status: 402 },
				),
			),
		});

		await expect(
			client.structured({
				name: "test",
				schema: { type: "object" },
				system: "Return data.",
				user: "{}",
				validate: (value) => value,
				maxTokens: 20,
			}),
		).rejects.toMatchObject({
			code: "credits_exhausted",
			status: 503,
		});
	});

	it("does not expose an unmapped provider error message", async () => {
		const client = new OpenRouterClient({
			apiKey: "test-key",
			fetch: vi.fn().mockResolvedValue(
				Response.json(
					{
						error: {
							code: 400,
							message: "Raw provider details that must remain private.",
						},
					},
					{ status: 400 },
				),
			),
		});

		await expect(
			client.structured({
				name: "test",
				schema: { type: "object" },
				system: "Return data.",
				user: "{}",
				validate: (value) => value,
				maxTokens: 20,
			}),
		).rejects.toMatchObject({
			code: "upstream_error",
			message: "The AI provider rejected the request.",
		});
	});

	it("times out even when an injected fetch does not observe AbortSignal", async () => {
		const client = new OpenRouterClient({
			apiKey: "test-key",
			fetch: vi.fn().mockReturnValue(new Promise(() => undefined)),
			timeoutMs: 5,
		});

		await expect(
			client.structured({
				name: "test",
				schema: { type: "object" },
				system: "Return data.",
				user: "{}",
				validate: (value) => value,
				maxTokens: 20,
			}),
		).rejects.toMatchObject({
			code: "timeout",
			status: 504,
			retryable: true,
		});
	});
});

describe("WorkersAiEmbedder", () => {
	it("accepts a 1024-dimensional BGE-M3 embedding", async () => {
		const embedding = Array.from({ length: 1_024 }, (_, index) => index / 1_024);
		const ai = {
			run: vi.fn().mockResolvedValue({ data: [embedding] }),
		};

		await expect(new WorkersAiEmbedder(ai).embed("SigninLogs")).resolves.toEqual(
			embedding,
		);
	});
});

describe("GenerationGuard", () => {
	it("fails closed when no rate limiter is configured", async () => {
		const guard = new GenerationGuard({});

		await expect(
			guard.check({
				request: new Request("https://example.com/api/ai/generate"),
				viewerId: null,
			}),
		).rejects.toMatchObject({
			code: "abuse_control_unavailable",
			status: 503,
		});
	});

	it("requires and verifies Turnstile after the limiter denies", async () => {
		const turnstile = { verify: vi.fn().mockResolvedValue(true) };
		const guard = new GenerationGuard({
			rateLimiter: {
				limit: vi.fn().mockResolvedValue({ success: false }),
			},
			turnstile,
		});
		const request = new Request("https://example.com/api/ai/generate", {
			headers: {
				"cf-connecting-ip": "192.0.2.1",
				"x-kql-device-id": "device-123",
			},
		});

		await expect(
			guard.check({
				request,
				viewerId: null,
				turnstileToken: "token",
			}),
		).resolves.toBeUndefined();
		expect(turnstile.verify).toHaveBeenCalledWith(
			expect.objectContaining({
				token: "token",
				remoteIp: "192.0.2.1",
				expectedAction: "ai-generate",
			}),
		);
	});
});
