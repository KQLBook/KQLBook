import { describe, expect, it, vi } from "vitest";

import { IngestionError } from "../../../../../lib/ingest/errors";
import type { RepositoryIngestionResult } from "../../../../../lib/ingest/types";

import { handleGithubIngestionRequest } from "./handler";

const URL = "https://example.com/api/internal/ingest/github";
const SECRET = "correct-secret";

const ingestionResult: RepositoryIngestionResult = {
	repository: "owner/repository",
	commitSha: "a".repeat(40),
	licenseSpdx: "MIT",
	discoveredFiles: 3,
	candidateFiles: 2,
	acceptedQueries: 1,
	skipped: [],
	write: {
		inserted: 1,
		unchanged: 0,
	},
};

function request(
	body: unknown = {
		repository: "owner/repository",
		defaultDialect: "sentinel",
	},
	options: {
		method?: string;
		authorization?: string | null;
		contentType?: string;
		rawBody?: string;
		headers?: Record<string, string>;
	} = {},
): Request {
	return new Request(URL, {
		method: options.method ?? "POST",
		headers: {
			...(options.authorization === null
				? {}
				: {
						Authorization:
							options.authorization ?? `Bearer ${SECRET}`,
					}),
			"Content-Type": options.contentType ?? "application/json",
			...options.headers,
		},
		body:
			options.method === "GET"
				? undefined
				: options.rawBody ?? JSON.stringify(body),
	});
}

async function errorBody(response: Response): Promise<{
	error: { code: string; message: string; details?: unknown };
}> {
	return (await response.json()) as {
		error: { code: string; message: string; details?: unknown };
	};
}

describe("POST /api/internal/ingest/github handler", () => {
	it("rejects methods other than POST", async () => {
		const ingest = vi.fn();
		const response = await handleGithubIngestionRequest(
			request(undefined, { method: "GET" }),
			{ secret: SECRET, ingest },
		);

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(ingest).not.toHaveBeenCalled();
	});

	it("fails closed when the ingestion secret is not configured", async () => {
		const ingest = vi.fn();
		const response = await handleGithubIngestionRequest(request(), { ingest });

		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(ingest).not.toHaveBeenCalled();
	});

	it("returns the same generic 401 for missing and invalid credentials", async () => {
		const ingest = vi.fn();
		const dependencies = { secret: SECRET, ingest };

		const missing = await handleGithubIngestionRequest(
			request(undefined, { authorization: null }),
			dependencies,
		);
		const invalid = await handleGithubIngestionRequest(
			request(undefined, { authorization: "Bearer wrong-secret" }),
			dependencies,
		);

		expect(missing.status).toBe(401);
		expect(invalid.status).toBe(401);
		expect(await errorBody(missing)).toEqual(await errorBody(invalid));
		expect(missing.headers.get("cache-control")).toBe("private, no-store");
		expect(ingest).not.toHaveBeenCalled();
	});

	it("passes a strict, bounded request to the pipeline", async () => {
		const ingest = vi.fn().mockResolvedValue(ingestionResult);
		const source = request({
			repository: "owner/repository",
			ref: "refs/heads/main",
			defaultDialect: "azure-data-explorer",
			pathDialects: [
				{ prefix: "Sentinel/Rules", dialect: "sentinel" },
				{ prefix: "MDE", dialect: "defender-xdr" },
			],
			sourcePaths: ["Sentinel/Rules/example.yaml", "MDE/process.kql"],
			trusted: true,
		});

		const response = await handleGithubIngestionRequest(source, {
			secret: SECRET,
			ingest,
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(ingest).toHaveBeenCalledWith({
			repository: "owner/repository",
			ref: "refs/heads/main",
			defaultDialect: "azure-data-explorer",
			pathDialects: [
				{ prefix: "Sentinel/Rules", dialect: "sentinel" },
				{ prefix: "MDE", dialect: "defender-xdr" },
			],
			sourcePaths: ["Sentinel/Rules/example.yaml", "MDE/process.kql"],
			trusted: true,
			signal: source.signal,
		});
		await expect(response.json()).resolves.toEqual({ data: ingestionResult });
	});

	it.each([
		[
			"an unknown field",
			{
				repository: "owner/repository",
				defaultDialect: "sentinel",
				apiBaseUrl: "https://attacker.example",
			},
		],
		[
			"an invalid repository",
			{ repository: "https://github.com/owner/repository", defaultDialect: "sentinel" },
		],
		[
			"an unsupported dialect",
			{ repository: "owner/repository", defaultDialect: "splunk" },
		],
		[
			"an unsafe ref",
			{ repository: "owner/repository", ref: "main..evil", defaultDialect: "sentinel" },
		],
		[
			"an unsafe path prefix",
			{
				repository: "owner/repository",
				defaultDialect: "sentinel",
				pathDialects: [{ prefix: "../rules", dialect: "sentinel" }],
			},
		],
		[
			"duplicate path prefixes",
			{
				repository: "owner/repository",
				defaultDialect: "sentinel",
				pathDialects: [
					{ prefix: "Rules", dialect: "sentinel" },
					{ prefix: "rules", dialect: "defender-xdr" },
				],
			},
		],
		[
			"a non-boolean trusted value",
			{
				repository: "owner/repository",
				defaultDialect: "sentinel",
				trusted: "yes",
			},
		],
	])("rejects %s", async (_description, body) => {
		const ingest = vi.fn();
		const response = await handleGithubIngestionRequest(request(body), {
			secret: SECRET,
			ingest,
		});

		expect(response.status).toBe(422);
		expect((await errorBody(response)).error.code).toBe("validation_error");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(ingest).not.toHaveBeenCalled();
	});

	it("rejects invalid JSON and non-JSON content", async () => {
		const ingest = vi.fn();
		const dependencies = { secret: SECRET, ingest };

		const invalidJson = await handleGithubIngestionRequest(
			request(undefined, { rawBody: "{" }),
			dependencies,
		);
		const nonJson = await handleGithubIngestionRequest(
			request(undefined, {
				contentType: "application/x-www-form-urlencoded",
				rawBody: "repository=owner/repository",
			}),
			dependencies,
		);

		expect(invalidJson.status).toBe(400);
		expect((await errorBody(invalidJson)).error.code).toBe("invalid_json");
		expect(nonJson.status).toBe(415);
		expect((await errorBody(nonJson)).error.code).toBe(
			"unsupported_media_type",
		);
		expect(ingest).not.toHaveBeenCalled();
	});

	it("rejects request bodies over 64 KiB", async () => {
		const ingest = vi.fn();
		const response = await handleGithubIngestionRequest(
			request(undefined, {
				rawBody: JSON.stringify({
					repository: "owner/repository",
					defaultDialect: "sentinel",
					padding: "x".repeat(66_000),
				}),
			}),
			{ secret: SECRET, ingest },
		);

		expect(response.status).toBe(413);
		expect((await errorBody(response)).error.code).toBe("payload_too_large");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(ingest).not.toHaveBeenCalled();
	});

	it("maps licensing failures without writing a successful response", async () => {
		const ingest = vi.fn().mockRejectedValue(
			new IngestionError(
				"LICENSE_DISALLOWED",
				"Repository declares GPL-3.0.",
			),
		);
		const response = await handleGithubIngestionRequest(request(), {
			secret: SECRET,
			ingest,
		});

		expect(response.status).toBe(422);
		expect(await errorBody(response)).toEqual({
			error: {
				code: "repository_not_eligible",
				message: "Repository declares GPL-3.0.",
				details: { reason: "LICENSE_DISALLOWED" },
			},
		});
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});

	it("does not expose GitHub error details", async () => {
		const ingest = vi.fn().mockRejectedValue(
			new IngestionError(
				"GITHUB_HTTP_ERROR",
				"GitHub request failed with HTTP 403.",
				{ message: "token-sensitive upstream detail" },
			),
		);
		const response = await handleGithubIngestionRequest(request(), {
			secret: SECRET,
			ingest,
		});
		const body = await response.text();

		expect(response.status).toBe(502);
		expect(body).not.toContain("token-sensitive");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
	});
});
