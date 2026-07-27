import { describe, expect, it, vi } from "vitest";

import { hasValidBearerSecret } from "../../../../../lib/search/internal-auth";

import { handleEmbeddingProcessRequest } from "./handler";

function request(authorization?: string): Request {
	return new Request(
		"https://example.com/api/internal/embeddings/process",
		{
			method: "POST",
			headers: authorization
				? { Authorization: authorization }
				: undefined,
		},
	);
}

describe("embedding sync bearer authentication", () => {
	it("accepts an exact bearer secret and rejects altered values", async () => {
		await expect(
			hasValidBearerSecret("Bearer correct-secret", "correct-secret"),
		).resolves.toBe(true);
		await expect(
			hasValidBearerSecret("Bearer correct-secret-extra", "correct-secret"),
		).resolves.toBe(false);
		await expect(
			hasValidBearerSecret(null, "correct-secret"),
		).resolves.toBe(false);
	});
});

describe("POST /api/internal/embeddings/process handler", () => {
	it("fails closed when the server secret is not configured", async () => {
		const process = vi.fn();
		const response = await handleEmbeddingProcessRequest(
			request("Bearer anything"),
			{ process },
		);

		expect(response.status).toBe(503);
		expect(process).not.toHaveBeenCalled();
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("returns the same generic 401 for missing and incorrect credentials", async () => {
		const process = vi.fn();
		const dependencies = {
			secret: "correct-secret",
			process,
		};

		const missing = await handleEmbeddingProcessRequest(
			request(),
			dependencies,
		);
		const incorrect = await handleEmbeddingProcessRequest(
			request("Bearer incorrect"),
			dependencies,
		);

		expect(missing.status).toBe(401);
		expect(incorrect.status).toBe(401);
		expect(await missing.json()).toEqual(await incorrect.json());
		expect(process).not.toHaveBeenCalled();
	});

	it("runs one outbox batch after successful authentication", async () => {
		const process = vi.fn().mockResolvedValue({
			claimed: 3,
			completed: 2,
			retried: 1,
		});
		const source = request("Bearer correct-secret");
		const response = await handleEmbeddingProcessRequest(source, {
			secret: "correct-secret",
			process,
		});

		expect(response.status).toBe(200);
		expect(process).toHaveBeenCalledWith(source.signal);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		await expect(response.json()).resolves.toEqual({
			data: {
				claimed: 3,
				completed: 2,
				retried: 1,
			},
		});
	});
});

