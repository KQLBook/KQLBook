import { describe, expect, it, vi } from "vitest";

import { assessAdequacy } from "./adequacy";
import { parseSearchParams } from "./normalize";
import type { SearchDependencies } from "./ports";
import { SearchService } from "./service";
import type { SearchRequest, SearchResult } from "./types";

const request: SearchRequest = {
	q: "failed sign-ins",
	dialects: ["sentinel"],
	tables: [],
	operators: [],
	tags: [],
	authors: [],
	sources: [],
	limit: 20,
};

function result(
	overrides: Partial<SearchResult> = {},
): SearchResult {
	return {
		queryId: "query-1",
		versionId: "version-1",
		title: "Failed sign-ins",
		snippet: "SigninLogs | where ResultType != 0",
		dialect: "sentinel",
		tables: ["SigninLogs"],
		starCount: 0,
		sourceRepository: null,
		sourceRepositoryUrl: null,
		matchType: "lexical",
		score: 0.8,
		provenance: null,
		visibility: "public",
		...overrides,
	};
}

function dependencies(
	overrides: Partial<SearchDependencies> = {},
): SearchDependencies {
	return {
		lexical: {
			searchLexical: vi.fn().mockResolvedValue([]),
		},
		authorization: {
			getAuthorizedByIds: vi.fn().mockResolvedValue([]),
		},
		intent: {
			extractIntent: vi.fn().mockResolvedValue({
				normalizedQuery: request.q,
				concepts: ["authentication failure"],
				dialect: "sentinel",
				dialectConfidence: 0.9,
				tables: ["SigninLogs"],
				operators: ["where"],
				tags: [],
			}),
		},
		embedding: {
			embed: vi.fn().mockResolvedValue([0.1, 0.2]),
		},
		semantic: {
			searchSemantic: vi.fn().mockResolvedValue([]),
		},
		...overrides,
	};
}

describe("search input", () => {
	it("normalizes aliases, comma-separated filters, and repeated values", () => {
		const params = new URLSearchParams([
			["q", "  failed   sign-ins  "],
			["dialect", "log-analytics"],
			["table", "SigninLogs, AuditLogs"],
			["table", "signinlogs"],
		]);

		expect(parseSearchParams(params)).toMatchObject({
			q: "failed sign-ins",
			dialects: ["sentinel"],
			tables: ["SigninLogs", "AuditLogs"],
			limit: 20,
		});
	});
});

describe("adequacy", () => {
	it("accepts an exact title independent of punctuation and case", () => {
		expect(
			assessAdequacy(
				[result({ title: "FAILED: sign ins", score: 0.2 })],
				"failed sign-ins",
			),
		).toMatchObject({ adequate: true, reason: "exact-title" });
	});
});

describe("SearchService", () => {
	it("stops after an adequate lexical result", async () => {
		const intent = { extractIntent: vi.fn() };
		const deps = dependencies({
			lexical: {
				searchLexical: vi.fn().mockResolvedValue([result()]),
			},
			intent,
		});

		const response = await new SearchService(deps).search(request, {
			userId: null,
		});

		expect(response.mode).toBe("lexical");
		expect(response.attempted).toEqual(["lexical"]);
		expect(intent.extractIntent).not.toHaveBeenCalled();
	});

	it("runs semantic search and reauthorizes every vector candidate", async () => {
		const authorized = result({
			queryId: "query-2",
			versionId: "version-2",
			title: "Authentication failure investigation",
			matchType: "semantic",
			score: 0,
		});
		const authorization = {
			getAuthorizedByIds: vi.fn().mockResolvedValue([authorized]),
		};
		const semantic = {
			searchSemantic: vi.fn().mockResolvedValue([
				{
					queryId: "query-2",
					versionId: "version-2",
					score: 0.91,
					namespace: "public",
				},
			]),
		};
		const deps = dependencies({
			lexical: {
				searchLexical: vi.fn().mockResolvedValue([
					result({ score: 0.2, title: "Unrelated query" }),
				]),
			},
			authorization,
			semantic,
		});

		const response = await new SearchService(deps).search(request, {
			userId: null,
		});

		expect(authorization.getAuthorizedByIds).toHaveBeenCalledWith(
			["query-2"],
			{ userId: null },
			request,
		);
		expect(response.results[0]).toMatchObject({
			queryId: "query-2",
			matchType: "semantic",
			score: 0.91,
		});
		expect(response.fallback).toBeNull();
	});

	it("does not expose a vector candidate rejected by D1", async () => {
		const deps = dependencies({
			lexical: {
				searchLexical: vi.fn().mockResolvedValue([]),
			},
			semantic: {
				searchSemantic: vi.fn().mockResolvedValue([
					{
						queryId: "private-query",
						versionId: "private-version",
						score: 0.99,
						namespace: "public",
					},
				]),
			},
			authorization: {
				getAuthorizedByIds: vi.fn().mockResolvedValue([]),
			},
		});

		const response = await new SearchService(deps).search(request, {
			userId: null,
		});

		expect(response.results).toEqual([]);
		expect(response.fallback).toMatchObject({
			status: "available",
			reason: "retrieval-inadequate",
		});
	});

	it("drops a stale vector when D1 points to a newer current version", async () => {
		const deps = dependencies({
			lexical: {
				searchLexical: vi.fn().mockResolvedValue([]),
			},
			semantic: {
				searchSemantic: vi.fn().mockResolvedValue([
					{
						queryId: "query-2",
						versionId: "stale-version",
						score: 0.99,
						namespace: "public",
					},
				]),
			},
			authorization: {
				getAuthorizedByIds: vi.fn().mockResolvedValue([
					result({
						queryId: "query-2",
						versionId: "current-version",
						title: "Current version title",
						matchType: "semantic",
						score: 0,
					}),
				]),
			},
		});

		const response = await new SearchService(deps).search(request, {
			userId: null,
		});

		expect(response.results).toEqual([]);
		expect(response.adequacy).toMatchObject({
			adequate: false,
			reason: "no-results",
		});
	});

	it("searches public and caller-private namespaces separately", async () => {
		const semantic = {
			searchSemantic: vi.fn().mockResolvedValue([]),
		};
		const deps = dependencies({ semantic });

		await new SearchService(deps).search(request, {
			userId: "internal_user-123",
		});

		expect(semantic.searchSemantic.mock.calls.map((call) => call[1].namespace)).toEqual([
			"public",
			"private:internal_user-123",
		]);
	});
});
