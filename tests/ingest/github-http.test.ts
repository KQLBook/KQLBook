import { describe, expect, it, vi } from "vitest";

import {
	GithubHttpClient,
	parseRepositoryName,
} from "../../src/lib/ingest/github-http";

const sha = "a".repeat(40);

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("GitHub HTTP adapter", () => {
	it("validates repository names before constructing URLs", () => {
		expect(parseRepositoryName("Azure/Azure-Sentinel")).toEqual({
			owner: "Azure",
			name: "Azure-Sentinel",
			fullName: "Azure/Azure-Sentinel",
		});
		expect(() => parseRepositoryName("https://github.com/Azure/Azure-Sentinel")).toThrow(
			/owner\/name/,
		);
		expect(() => parseRepositoryName("../private")).toThrow(/owner\/name/);
	});

	it("reads repository and license metadata using authenticated GitHub requests", async () => {
		const fetchMock = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
			void init;
			const url = String(input);
			if (url.endsWith("/repos/example/kql")) {
				return json({
					full_name: "example/kql",
					name: "kql",
					default_branch: "main",
					html_url: "https://github.com/example/kql",
					owner: { login: "example" },
					license: {
						spdx_id: "MIT",
						name: "MIT License",
						url: "https://api.github.com/licenses/mit",
					},
				});
			}
			return json({
				path: "LICENSE",
				html_url: `https://github.com/example/kql/blob/${sha}/LICENSE`,
				encoding: "base64",
				content: btoa("MIT license text"),
				license: { spdx_id: "MIT", name: "MIT License" },
			});
			},
		);
		const client = new GithubHttpClient({
			fetch: fetchMock,
			token: "secret-token",
		});

		await expect(client.getRepository("example/kql")).resolves.toMatchObject({
			fullName: "example/kql",
			license: { spdxId: "MIT" },
		});
		await expect(
			client.getLicenseFile("example/kql", sha),
		).resolves.toMatchObject({
			spdxId: "MIT",
			text: "MIT license text",
		});

		const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
		expect(headers.get("authorization")).toBe("Bearer secret-token");
		expect(headers.get("x-github-api-version")).toBe("2022-11-28");
	});

	it("fails closed when GitHub truncates a recursive tree", async () => {
		const client = new GithubHttpClient({
			fetch: vi.fn().mockResolvedValue(
				json({
					sha,
					truncated: true,
					tree: [],
				}),
			),
		});

		await expect(client.listTree("example/kql", sha)).rejects.toMatchObject({
			code: "TREE_TRUNCATED",
		});
	});

	it("does not require or return repository star counts during ingestion", async () => {
		const client = new GithubHttpClient({
			fetch: vi.fn().mockResolvedValue(
				json({
					full_name: "example/kql",
					name: "kql",
					default_branch: "main",
					html_url: "https://github.com/example/kql",
					stargazers_count: -1,
					owner: { login: "example" },
					license: {
						spdx_id: "MIT",
						name: "MIT License",
						url: "https://api.github.com/licenses/mit",
					},
				}),
			),
		});

		const repository = await client.getRepository("example/kql");
		expect(repository).not.toHaveProperty("starCount");
	});
});
