import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { D1Client } from "../src/lib/db/helpers";
import type { SearchRequest } from "../src/lib/search/types";
import {
	adminUnpublishQuery,
	createQuery,
	createReport,
	getAuthorizedQueriesByIds,
	getQueryById,
	listOwnedQueries,
	listStarredQueries,
	searchQueriesLexical,
	setQueryVisibility,
	starQuery,
	updateQuery,
} from "../src/lib/db/repository";

import { TestD1Database } from "./support/sqlite-d1";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-07-26T12:00:00.000Z";

async function seedUser(
	database: TestD1Database,
	id: string,
	email: string,
	role: "user" | "admin" = "user",
) {
	await database
		.prepare(
			`INSERT INTO user (
				id,
				name,
				email,
				emailVerified,
				createdAt,
				updatedAt,
				role
			) VALUES (?, ?, ?, 1, ?, ?, ?)`,
		)
		.bind(id, email.split("@")[0], email, CREATED_AT, CREATED_AT, role)
		.run();
}

describe("query privacy and authorization with the D1 schema", () => {
	let database: TestD1Database;
	let d1: D1Client;

	beforeEach(async () => {
		database = new TestD1Database();
		d1 = database as unknown as D1Client;
		await seedUser(database, OWNER_ID, "owner@example.com");
		await seedUser(database, OTHER_USER_ID, "other@example.com");
		await seedUser(database, ADMIN_ID, "admin@example.com", "admin");
	});

	afterEach(() => {
		database.close();
	});

	it("defaults a new query to private and returns it only to its owner", async () => {
		const query = await createQuery(d1, {
			ownerId: OWNER_ID,
			title: "Failed sign-ins",
			kql: "SigninLogs | where ResultType != 0",
			dialect: "sentinel",
			tables: ["SigninLogs"],
		});

		expect(query.visibility).toBe("private");
		await expect(getQueryById(d1, query.id, null)).rejects.toMatchObject({
			status: 404,
			code: "QUERY_NOT_FOUND",
		});
		await expect(
			getQueryById(d1, query.id, OTHER_USER_ID),
		).rejects.toMatchObject({
			status: 404,
			code: "QUERY_NOT_FOUND",
		});
		await expect(getQueryById(d1, query.id, OWNER_ID)).resolves.toMatchObject({
			id: query.id,
			ownerId: OWNER_ID,
			visibility: "private",
		});

		const searchRequest: SearchRequest = {
			q: "SigninLogs",
			dialects: ["sentinel"],
			tables: [],
			operators: [],
			tags: [],
			authors: [],
			sources: [],
			limit: 20,
		};
		await expect(
			searchQueriesLexical(d1, searchRequest, null),
		).resolves.toEqual([]);
		await expect(
			searchQueriesLexical(d1, searchRequest, OWNER_ID),
		).resolves.toEqual([
			expect.objectContaining({
				queryId: query.id,
				visibility: "private",
			}),
		]);
		await expect(
			getAuthorizedQueriesByIds(d1, [query.id], null, searchRequest),
		).resolves.toEqual([]);
		await expect(
			getAuthorizedQueriesByIds(
				d1,
				[query.id],
				OWNER_ID,
				searchRequest,
			),
		).resolves.toEqual([
			expect.objectContaining({
				queryId: query.id,
				visibility: "private",
			}),
		]);
	});

	it("publishes immediately while preserving validation warnings", async () => {
		const query = await createQuery(d1, {
			ownerId: OWNER_ID,
			title: "Potential secret example",
			kql: "SigninLogs | extend api_key = 'this-is-a-test-secret'",
			dialect: "sentinel",
			visibility: "public",
		});

		expect(query.visibility).toBe("public");
		expect(query.currentVersion.validationWarnings).not.toHaveLength(0);
		await expect(getQueryById(d1, query.id, null)).resolves.toMatchObject({
			id: query.id,
			visibility: "public",
		});
	});

	it("blocks invalid KQL before create or update writes", async () => {
		await expect(
			createQuery(d1, {
				ownerId: OWNER_ID,
				title: "Incomplete query",
				kql: "SigninLogs | where",
				dialect: "sentinel",
			}),
		).rejects.toMatchObject({
			name: "KqlSyntaxValidationError",
			diagnostics: [
				expect.objectContaining({
					code: "KS006",
				}),
			],
		});
		await expect(listOwnedQueries(d1, OWNER_ID)).resolves.toMatchObject({
			items: [],
		});

		const query = await createQuery(d1, {
			ownerId: OWNER_ID,
			title: "Valid query",
			kql: "SigninLogs | take 10",
			dialect: "sentinel",
		});

		await expect(
			updateQuery(d1, query.id, OWNER_ID, {
				kql: "SigninLogs | where",
			}),
		).rejects.toMatchObject({
			name: "KqlSyntaxValidationError",
		});
		await expect(getQueryById(d1, query.id, OWNER_ID)).resolves.toMatchObject({
			currentVersion: {
				id: query.currentVersion.id,
				versionNumber: 1,
				kql: "SigninLogs | take 10",
			},
		});
	});

	it("refuses to publish a legacy invalid query", async () => {
		const query = await createQuery(d1, {
			ownerId: OWNER_ID,
			title: "Legacy query",
			kql: "SigninLogs | take 10",
			dialect: "sentinel",
		});
		const invalidVersionId = crypto.randomUUID();
		await database
			.prepare(
				`INSERT INTO query_versions (
					id,
					query_id,
					version_number,
					title,
					kql,
					dialect,
					content_hash,
					created_by_user_id
				) VALUES (?, ?, 2, ?, ?, ?, ?, ?)`,
			)
			.bind(
				invalidVersionId,
				query.id,
				"Legacy invalid query",
				"SigninLogs | where",
				"sentinel",
				"legacy-invalid-content-hash",
				OWNER_ID,
			)
			.run();
		await database
			.prepare("UPDATE queries SET current_version_id = ? WHERE id = ?")
			.bind(invalidVersionId, query.id)
			.run();

		await expect(
			setQueryVisibility(d1, query.id, OWNER_ID, "public"),
		).rejects.toMatchObject({
			name: "KqlSyntaxValidationError",
		});
		await expect(getQueryById(d1, query.id, OWNER_ID)).resolves.toMatchObject({
			visibility: "private",
		});
	});

	it("returns repository identity separately from saved stars", async () => {
		const query = await createQuery(d1, {
			ownerId: OWNER_ID,
			title: "Repository metadata example",
			kql: "SigninLogs | take 10",
			dialect: "sentinel",
			visibility: "public",
			tables: ["SigninLogs"],
		});
		const licenseId = "license-mit";
		const repositoryId = "repository-azure-sentinel";

		await database
			.prepare(
				`INSERT INTO licenses (
					id,
					spdx_id,
					name,
					license_url,
					required_notice,
					ingestion_allowed,
					reviewed_at
				) VALUES (?, 'MIT', 'MIT License', ?, '', 1, ?)`,
			)
			.bind(
				licenseId,
				"https://opensource.org/license/mit",
				CREATED_AT,
			)
			.run();
		await database
			.prepare(
				`INSERT INTO source_repositories (
					id,
					provider,
					repository,
					default_branch,
						source_url,
						license_id,
						trusted
					) VALUES (?, 'github', ?, 'master', ?, ?, 1)`,
			)
			.bind(
				repositoryId,
					"Azure/Azure-Sentinel",
					"https://github.com/Azure/Azure-Sentinel",
					licenseId,
				)
			.run();
		await database
			.prepare(
				`INSERT INTO query_provenance (
					query_id,
					source_repository_id,
					source_path,
					commit_sha,
					query_block_index,
					original_author,
					source_url,
					license_id,
					required_notice
				) VALUES (?, ?, ?, ?, 0, ?, ?, ?, '')`,
			)
			.bind(
				query.id,
				repositoryId,
				"Solutions/Microsoft Entra ID/Queries/example.kql",
				"0123456789abcdef0123456789abcdef01234567",
				"Microsoft",
				"https://github.com/Azure/Azure-Sentinel/blob/master/example.kql",
				licenseId,
			)
			.run();

			const expectedSource = {
				sourceRepository: "Azure/Azure-Sentinel",
				sourceRepositoryUrl: "https://github.com/Azure/Azure-Sentinel",
				starCount: 0,
		};

		await expect(getQueryById(d1, query.id, null)).resolves.toMatchObject({
			...expectedSource,
				provenance: {
					provider: "github",
					repositoryUrl: "https://github.com/Azure/Azure-Sentinel",
				},
		});
		await expect(listOwnedQueries(d1, OWNER_ID)).resolves.toMatchObject({
			items: [expect.objectContaining(expectedSource)],
		});

		const searchRequest: SearchRequest = {
			q: "Repository metadata example",
			dialects: [],
			tables: [],
			operators: [],
			tags: [],
			authors: [],
			sources: [],
			limit: 20,
		};
		const results = await searchQueriesLexical(
			d1,
			searchRequest,
			null,
		);
		expect(results).toEqual([
			expect.objectContaining({
				queryId: query.id,
				...expectedSource,
					provenance: expect.objectContaining({
						provider: "github",
						repositoryUrl:
							"https://github.com/Azure/Azure-Sentinel",
					}),
			}),
		]);
		await expect(
			getAuthorizedQueriesByIds(
				d1,
				[query.id],
				null,
				searchRequest,
			),
		).resolves.toEqual([
			expect.objectContaining({
				queryId: query.id,
				...expectedSource,
			}),
		]);
	});

	it("allows one star on a visible public query and removes it on unpublish", async () => {
		const query = await createQuery(d1, {
			ownerId: OWNER_ID,
			title: "Rare process launches",
			kql: "DeviceProcessEvents | take 10",
			dialect: "defender-xdr",
			visibility: "public",
		});

		await starQuery(d1, query.id, OTHER_USER_ID);
		const duplicate = await starQuery(d1, query.id, OTHER_USER_ID);
		expect(duplicate.starCount).toBe(1);

		const starred = await listStarredQueries(d1, OTHER_USER_ID);
		expect(starred.items).toHaveLength(1);
		expect(starred.items[0]).toMatchObject({
			id: query.id,
			starCount: 1,
			starredByViewer: true,
		});

		await setQueryVisibility(d1, query.id, OWNER_ID, "private");
		expect((await listStarredQueries(d1, OTHER_USER_ID)).items).toEqual([]);
		await expect(starQuery(d1, query.id, OTHER_USER_ID)).rejects.toMatchObject({
			status: 404,
			code: "PUBLIC_QUERY_NOT_FOUND",
		});
	});

	it("lets an administrator unpublish a reported public query", async () => {
		const query = await createQuery(d1, {
			ownerId: OWNER_ID,
			title: "Suspicious query",
			kql: "DeviceNetworkEvents | take 10",
			dialect: "defender-xdr",
			visibility: "public",
		});
		await createReport(d1, {
			queryId: query.id,
			reporterId: OTHER_USER_ID,
			reason: "other",
			details: "Integration test report",
		});

		const unpublished = await adminUnpublishQuery(d1, {
			queryId: query.id,
			adminId: ADMIN_ID,
			reason: "Reviewed in an integration test",
		});

		expect(unpublished.moderationStatus).toBe("unpublished");
		await expect(getQueryById(d1, query.id, null)).rejects.toMatchObject({
			status: 404,
			code: "QUERY_NOT_FOUND",
		});
		await expect(getQueryById(d1, query.id, OWNER_ID)).resolves.toMatchObject({
			id: query.id,
			moderationStatus: "unpublished",
		});
	});
});
