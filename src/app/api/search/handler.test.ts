import { describe, expect, it, vi } from "vitest";

import { SearchService } from "../../../lib/search/service";
import type { SearchDependencies } from "../../../lib/search/ports";
import type { SearchResult } from "../../../lib/search/types";

import { handleSearchRequest } from "./handler";

describe("GET /api/search handler", () => {
	it("returns a structured validation error for an empty query", async () => {
		const response = await handleSearchRequest(
			new Request("https://example.com/api/search"),
			{
				searchService: {} as SearchService,
				resolveViewer: vi.fn(),
			},
		);

		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toMatchObject({
			error: {
				code: "query_required",
				details: { field: "q" },
			},
		});
	});

	it("includes the created history ID for a signed-in search", async () => {
		const lexicalResult: SearchResult = {
			queryId: "query-1",
			versionId: "version-1",
			title: "Failed sign-ins",
			snippet: "SigninLogs | where ResultType != 0",
			dialect: "sentinel",
			tables: ["SigninLogs"],
				starCount: 0,
				sourceRepository: "Azure/Azure-Sentinel",
				sourceRepositoryUrl: "https://github.com/Azure/Azure-Sentinel",
				matchType: "lexical",
			score: 0.9,
			provenance: null,
			visibility: "public",
		};
		const dependencies: SearchDependencies = {
			lexical: {
				searchLexical: vi.fn().mockResolvedValue([lexicalResult]),
			},
			authorization: {
				getAuthorizedByIds: vi.fn().mockResolvedValue([]),
			},
			intent: {
				extractIntent: vi.fn(),
			},
			embedding: {
				embed: vi.fn(),
			},
			semantic: {
				searchSemantic: vi.fn(),
			},
		};
		const recordHistory = vi.fn().mockResolvedValue({
			id: "history-1",
		});
		const response = await handleSearchRequest(
			new Request(
				"https://example.com/api/search?q=failed%20sign-ins",
			),
			{
				searchService: new SearchService(dependencies),
				resolveViewer: vi.fn().mockResolvedValue({
					userId: "user-1",
				}),
				recordHistory,
			},
		);

		expect(response.status).toBe(200);
		expect(recordHistory).toHaveBeenCalledOnce();
		await expect(response.json()).resolves.toMatchObject({
			data: {
				historyId: "history-1",
				results: [
					{
						queryId: "query-1",
							starCount: 0,
							sourceRepository: "Azure/Azure-Sentinel",
							sourceRepositoryUrl:
								"https://github.com/Azure/Azure-Sentinel",
						},
				],
			},
		});
	});

	it("does not add a history ID to an anonymous response", async () => {
		const dependencies: SearchDependencies = {
			lexical: {
				searchLexical: vi.fn().mockResolvedValue([]),
			},
			authorization: {
				getAuthorizedByIds: vi.fn().mockResolvedValue([]),
			},
			intent: {
				extractIntent: vi.fn().mockRejectedValue(new Error("offline")),
			},
			embedding: {
				embed: vi.fn().mockRejectedValue(new Error("offline")),
			},
			semantic: {
				searchSemantic: vi.fn(),
			},
		};
		const recordHistory = vi.fn();
		const response = await handleSearchRequest(
			new Request("https://example.com/api/search?q=unknown"),
			{
				searchService: new SearchService(dependencies),
				resolveViewer: vi.fn().mockResolvedValue({ userId: null }),
				recordHistory,
			},
		);
		const body = (await response.json()) as {
			data: { historyId?: string };
		};

		expect(response.status).toBe(200);
		expect(recordHistory).not.toHaveBeenCalled();
		expect(body.data).not.toHaveProperty("historyId");
	});
});
