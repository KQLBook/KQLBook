import { describe, expect, it, vi } from "vitest";

import { AbuseControlError } from "../../../lib/ai/abuse-control";
import { AiServiceError } from "../../../lib/ai/errors";
import type { QueryMetadata } from "../../../lib/ai/query-metadata";
import type { CreateQueryInput, QueryRecord } from "../../../lib/db/types";

import {
	type CreateQueryRouteDependencies,
	handleCreateQueryRequest,
} from "./handler";

function sourceRequest(
	body: Record<string, unknown> | string = {
		title: "Failed sign-ins",
		kql: "SigninLogs | where ResultType != 0",
		explanation: "Finds unsuccessful sign-ins.",
		visibility: "private",
		aiMetadataAcknowledged: true,
	},
	headers: Record<string, string> = {},
): Request {
	return new Request("https://kqlbook.com/api/queries", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "https://kqlbook.com",
			...headers,
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function queryRecord(input: CreateQueryInput): QueryRecord {
	const queryId = crypto.randomUUID();
	const versionId = crypto.randomUUID();

	return {
		id: queryId,
		ownerId: input.ownerId,
		visibility: input.visibility ?? "private",
		moderationStatus: "visible",
		currentVersionId: versionId,
		starCount: 0,
		sourceRepository: null,
		sourceRepositoryUrl: null,
		starredByViewer: false,
		createdAt: "2026-07-26T00:00:00.000Z",
		updatedAt: "2026-07-26T00:00:00.000Z",
		publishedAt: null,
		provenance: null,
		currentVersion: {
			id: versionId,
			queryId,
			versionNumber: 1,
			title: input.title,
			kql: input.kql,
			description: input.description ?? "",
			explanation: input.explanation ?? "",
			dialect: input.dialect,
			tables: input.tables ?? [],
			operators: input.operators ?? [],
			tags: input.tags ?? [],
			assumptions: [],
			validationWarnings: [],
			aiGenerated: false,
			generationModel: null,
			contentHash: "test-content-hash",
			createdByUserId: input.ownerId,
			createdAt: "2026-07-26T00:00:00.000Z",
		},
	};
}

function setup(metadataOverrides: Partial<QueryMetadata> = {}) {
	const resolveCurrentUser = vi.fn().mockResolvedValue({ id: "user-1" });
	const guard = { check: vi.fn().mockResolvedValue(undefined) };
	const metadata = {
		analyze: vi.fn().mockResolvedValue({
			dialect: "sentinel",
			dialectConfidence: 0.98,
			tables: ["SigninLogs"],
			operators: ["where"],
			tags: ["identity", "authentication"],
			...metadataOverrides,
		}),
	};
	const persist = vi
		.fn<(input: CreateQueryInput) => Promise<QueryRecord>>()
		.mockImplementation(async (input) => queryRecord(input));
	const dependencies = {
		resolveCurrentUser,
		guard,
		metadata,
		persist,
	} satisfies CreateQueryRouteDependencies;

	return { dependencies, resolveCurrentUser, guard, metadata, persist };
}

describe("POST /api/queries handler", () => {
	it("persists only server-produced metadata for the signed-in owner", async () => {
		const { dependencies, guard, metadata, persist } = setup();
		const response = await handleCreateQueryRequest(
			sourceRequest(),
			dependencies,
		);

		expect(response.status).toBe(201);
		expect(guard.check).toHaveBeenCalledWith(
			expect.objectContaining({ viewerId: "user-1" }),
		);
		expect(metadata.analyze).toHaveBeenCalledWith(
			{
				title: "Failed sign-ins",
				kql: "SigninLogs | where ResultType != 0",
				explanation: "Finds unsuccessful sign-ins.",
				confirmedDialect: undefined,
			},
			expect.any(AbortSignal),
		);
		expect(persist).toHaveBeenCalledWith({
			ownerId: "user-1",
			title: "Failed sign-ins",
			kql: "SigninLogs | where ResultType != 0",
			description: "Finds unsuccessful sign-ins.",
			explanation: "Finds unsuccessful sign-ins.",
			dialect: "sentinel",
			visibility: "private",
			tables: ["SigninLogs"],
			operators: ["where"],
			tags: ["identity", "authentication"],
		});
		expect(persist.mock.calls[0][0]).not.toHaveProperty("aiGenerated");
		expect(persist.mock.calls[0][0]).not.toHaveProperty("generationModel");
		await expect(response.json()).resolves.toMatchObject({
			data: {
				visibility: "private",
				dialect: "sentinel",
				tables: ["SigninLogs"],
				aiGenerated: false,
			},
		});
	});

	it("rejects cross-origin requests before authentication or AI", async () => {
		const { dependencies, resolveCurrentUser, guard, metadata, persist } =
			setup();
		const response = await handleCreateQueryRequest(
			sourceRequest(undefined, {
				origin: "https://attacker.example",
				"sec-fetch-site": "cross-site",
			}),
			dependencies,
		);

		expect(response.status).toBe(403);
		expect(resolveCurrentUser).not.toHaveBeenCalled();
		expect(guard.check).not.toHaveBeenCalled();
		expect(metadata.analyze).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	it("authenticates before parsing or sending content to AI", async () => {
		const { dependencies, resolveCurrentUser, guard, metadata, persist } =
			setup();
		resolveCurrentUser.mockRejectedValue(
			Object.assign(new Error("Sign in to continue."), {
				status: 401 as const,
				code: "AUTH_REQUIRED" as const,
			}),
		);

		const response = await handleCreateQueryRequest(
			sourceRequest("{"),
			dependencies,
		);

		expect(response.status).toBe(401);
		expect(guard.check).not.toHaveBeenCalled();
		expect(metadata.analyze).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	it("rejects client-supplied metadata before invoking AI", async () => {
		const { dependencies, guard, metadata, persist } = setup();
		const response = await handleCreateQueryRequest(
			sourceRequest({
				title: "Failed sign-ins",
				kql: "SigninLogs | take 10",
				aiMetadataAcknowledged: true,
				tables: ["ForgedTable"],
			}),
			dependencies,
		);

		expect(response.status).toBe(422);
		expect(guard.check).not.toHaveBeenCalled();
		expect(metadata.analyze).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
	});

	it("rejects invalid KQL before abuse checks, AI, or persistence", async () => {
		const { dependencies, guard, metadata, persist } = setup();
		const response = await handleCreateQueryRequest(
			sourceRequest({
				title: "Incomplete query",
				kql: "SigninLogs | where",
				explanation: "",
				visibility: "private",
				aiMetadataAcknowledged: true,
			}),
			dependencies,
		);

		expect(response.status).toBe(422);
		expect(guard.check).not.toHaveBeenCalled();
		expect(metadata.analyze).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		await expect(response.json()).resolves.toMatchObject({
			error: {
				code: "invalid_kql",
				message: "Fix the KQL errors and try again.",
				details: {
					diagnostics: [
						expect.objectContaining({
							code: "KS006",
							severity: "error",
							line: 1,
						}),
					],
				},
			},
		});
	});

	it("requires a dialect confirmation when AI confidence is low", async () => {
		const { dependencies, persist } = setup({
			dialect: null,
			dialectConfidence: 0.34,
		});
		const response = await handleCreateQueryRequest(
			sourceRequest(),
			dependencies,
		);

		expect(response.status).toBe(422);
		expect(persist).not.toHaveBeenCalled();
		await expect(response.json()).resolves.toMatchObject({
			error: {
				code: "dialect_confirmation_required",
				details: {
					dialects: expect.arrayContaining([
						"sentinel",
						"defender-xdr",
						"azure-data-explorer",
						"azure-resource-graph",
						"intune-device-query",
					]),
				},
			},
		});
	});

	it("asks for confirmation when inferred dialect rules reject the query", async () => {
		const { dependencies, persist } = setup({
			dialect: "intune-device-query",
			dialectConfidence: 0.96,
			tables: ["Device"],
		});
		const response = await handleCreateQueryRequest(
			sourceRequest({
				title: "Device names",
				kql: "Device | extend LowerName = tolower(DeviceName)",
				explanation: "",
				visibility: "private",
				aiMetadataAcknowledged: true,
			}),
			dependencies,
		);

		expect(response.status).toBe(422);
		expect(persist).not.toHaveBeenCalled();
		await expect(response.json()).resolves.toMatchObject({
			error: {
				code: "dialect_confirmation_required",
				details: {
					diagnostics: [
						expect.objectContaining({
							code: "KQL_DIALECT_OPERATOR_NOT_SUPPORTED",
						}),
					],
				},
			},
		});
	});

	it("rejects a confirmed dialect violation before AI", async () => {
		const { dependencies, guard, metadata, persist } = setup();
		const response = await handleCreateQueryRequest(
			sourceRequest({
				title: "Device names",
				kql: "Device | extend LowerName = tolower(DeviceName)",
				explanation: "",
				visibility: "private",
				aiMetadataAcknowledged: true,
				confirmedDialect: "intune-device-query",
			}),
			dependencies,
		);

		expect(response.status).toBe(422);
		expect(guard.check).not.toHaveBeenCalled();
		expect(metadata.analyze).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		await expect(response.json()).resolves.toMatchObject({
			error: {
				code: "invalid_kql",
				details: {
					diagnostics: [
						expect.objectContaining({
							code: "KQL_DIALECT_OPERATOR_NOT_SUPPORTED",
						}),
					],
				},
			},
		});
	});

	it("sanitizes AI provider failures and never writes a partial query", async () => {
		const { dependencies, metadata, persist } = setup();
		metadata.analyze.mockRejectedValue(
			new AiServiceError(
				"upstream_error",
				"Raw provider message containing submitted KQL.",
				{ status: 422 },
			),
		);
		const response = await handleCreateQueryRequest(
			sourceRequest(),
			dependencies,
		);
		const body = JSON.stringify(await response.json());

		expect(response.status).toBe(422);
		expect(body).not.toContain("Raw provider message");
		expect(body).not.toContain("SigninLogs");
		expect(persist).not.toHaveBeenCalled();
	});

	it("stops before AI and persistence when the rate guard denies", async () => {
		const { dependencies, guard, metadata, persist } = setup();
		guard.check.mockRejectedValue(
			new AbuseControlError(
				"rate_limited",
				"Complete the verification challenge before trying again.",
				{ status: 429, challengeRequired: true },
			),
		);

		const response = await handleCreateQueryRequest(
			sourceRequest(),
			dependencies,
		);

		expect(response.status).toBe(429);
		expect(metadata.analyze).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		await expect(response.json()).resolves.toMatchObject({
			error: {
				details: {
					challengeRequired: true,
				},
			},
		});
	});
});
