import { describe, expect, it, vi } from "vitest";

import type { DeepSeekClient } from "../src/lib/ai/deepseek";
import { DeepSeekQueryGenerator } from "../src/lib/ai/generation";
import type { SearchDependencies } from "../src/lib/search/ports";
import { SearchService } from "../src/lib/search/service";
import type {
	SearchIntent,
	SearchRequest,
	SearchResult,
} from "../src/lib/search/types";

const intent: SearchIntent = {
	normalizedQuery: "failed sign-ins",
	concepts: ["authentication failure"],
	dialect: "sentinel",
	dialectConfidence: 0.95,
	tables: ["SigninLogs"],
	operators: ["where"],
	tags: [],
};

function result(
	queryId: string,
	visibility: "public" | "private",
): SearchResult {
	return {
		queryId,
		versionId: `${queryId}-version`,
		title:
			visibility === "public"
				? "Public failed sign-ins"
				: "Private failed sign-ins",
		snippet: "SigninLogs | where ResultType != 0",
		dialect: "sentinel",
		tables: ["SigninLogs"],
		starCount: 0,
		sourceRepository: null,
		sourceRepositoryUrl: null,
		matchType: "semantic",
		score: 0,
		provenance: null,
		visibility,
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
			extractIntent: vi.fn().mockResolvedValue(intent),
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

describe("search privacy across the retrieval pipeline", () => {
	it("does not expose a stale private vector to an anonymous visitor", async () => {
		const semantic = {
			searchSemantic: vi.fn().mockResolvedValue([
				{
					queryId: "private-query",
					versionId: "private-query-version",
					score: 0.99,
					namespace: "public",
				},
			]),
		};
		const authorization = {
			getAuthorizedByIds: vi.fn().mockResolvedValue([]),
		};
		const response = await new SearchService(
			dependencies({ semantic, authorization }),
		).search(
			{
				q: "failed sign-ins",
				dialects: [],
				tables: [],
				operators: [],
				tags: [],
				authors: [],
				sources: [],
				limit: 20,
			},
			{ userId: null },
		);

		expect(response).toMatchObject({
			results: [],
			attempted: [
				"lexical",
				"intent",
				"embedding",
				"semantic",
				"authorization",
			],
		});
		expect(semantic.searchSemantic).toHaveBeenCalledOnce();
		expect(semantic.searchSemantic).toHaveBeenCalledWith(
			expect.any(Array),
			expect.objectContaining({ namespace: "public" }),
		);
		expect(authorization.getAuthorizedByIds).toHaveBeenCalledWith(
			["private-query"],
			{ userId: null },
			expect.objectContaining({ q: "failed sign-ins" }),
		);
	});

	it("searches public and caller-private namespaces, then records signed-in history", async () => {
		const publicResult = result("public-query", "public");
		const privateResult = result("private-query", "private");
		const semantic = {
			searchSemantic: vi
				.fn()
				.mockImplementation(
					async (
						_embedding: readonly number[],
						options: { namespace: string },
					) => [
						{
							queryId:
								options.namespace === "public"
									? publicResult.queryId
									: privateResult.queryId,
							versionId:
								options.namespace === "public"
									? publicResult.versionId
									: privateResult.versionId,
							score: 0.9,
							namespace: options.namespace,
						},
					],
				),
		};
		const authorization = {
			getAuthorizedByIds: vi
				.fn()
				.mockResolvedValue([publicResult, privateResult]),
		};
		const response = await new SearchService(
			dependencies({ semantic, authorization }),
		).search(
			{
				q: "failed sign-ins",
				dialects: [],
				tables: [],
				operators: [],
				tags: [],
				authors: [],
				sources: [],
				limit: 20,
			},
			{ userId: "internal-user-1" },
		);

		expect(response.results.map((item) => item.queryId).sort()).toEqual([
			"private-query",
			"public-query",
		]);
		expect(
			semantic.searchSemantic.mock.calls.map(
				(call) => call[1].namespace,
			),
		).toEqual(["public", "private:internal-user-1"]);
	});
});

describe("private context sent to DeepSeek", () => {
	it("includes private supporting results only after explicit acknowledgement", async () => {
		const requests: Array<{ user: string }> = [];
		const client = {
			structured: vi.fn(
				async (request: {
					user: string;
					validate(value: unknown): unknown;
				}) => {
					requests.push({ user: request.user });
					return request.validate({
						title: "Generated failed sign-ins",
						kql: "SigninLogs | where ResultType != 0",
						explanation: "Finds failed sign-ins.",
						dialect: "sentinel",
						tables: ["SigninLogs"],
						assumptions: [],
					});
				},
			),
		};
		const generator = new DeepSeekQueryGenerator(
			client as unknown as DeepSeekClient,
		);
		const searchRequest: SearchRequest = {
			q: "failed sign-ins",
			dialects: ["sentinel"],
			tables: [],
			operators: [],
			tags: [],
			authors: [],
			sources: [],
			limit: 20,
		};
		const supportingResults = [
			result("public-query", "public"),
			result("private-query", "private"),
		];

		await generator.generateQuery({
			request: searchRequest,
			viewer: { userId: "internal-user-1" },
			targetDialect: "sentinel",
			supportingResults,
			privateProcessingAcknowledged: false,
		});
		await generator.generateQuery({
			request: searchRequest,
			viewer: { userId: "internal-user-1" },
			targetDialect: "sentinel",
			supportingResults,
			privateProcessingAcknowledged: true,
		});

		const withoutAcknowledgement = JSON.parse(requests[0].user) as {
			supportingResults: Array<{ queryId: string }>;
		};
		const withAcknowledgement = JSON.parse(requests[1].user) as {
			supportingResults: Array<{ queryId: string }>;
		};
		expect(
			withoutAcknowledgement.supportingResults.map(
				(item) => item.queryId,
			),
		).toEqual(["public-query"]);
		expect(
			withAcknowledgement.supportingResults.map((item) => item.queryId),
		).toEqual(["public-query", "private-query"]);
	});
});
