import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SearchRequest } from "../search/types";
import { TestD1Database } from "../../../tests/support/sqlite-d1";
import type { D1Client } from "./helpers";
import {
	claimEmbeddingOutbox,
	createQuery,
	getAuthorizedQueriesByIds,
	listPublicQueries,
	loadCurrentEmbeddingDocument,
	searchQueriesLexical,
	starQuery,
} from "./repository";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = "2026-07-26T12:00:00.000Z";

const request: SearchRequest = {
	q: "failed sign-ins",
	dialects: [],
	tables: [],
	operators: [],
	tags: [],
	authors: [],
	sources: [],
	limit: 20,
};

async function seedUser(database: TestD1Database, id: string, email: string) {
	await database
		.prepare(
			`INSERT INTO user (
         id,
         name,
         email,
         emailVerified,
         createdAt,
         updatedAt
       ) VALUES (?, ?, ?, 1, ?, ?)`,
		)
		.bind(id, email.split("@")[0], email, CREATED_AT, CREATED_AT)
		.run();
}

async function attachSource(
	database: TestD1Database,
	queryId: string,
	provider: "github" | "local",
	repository: string,
) {
	const licenseId = "test-license-mit";
	const sourceId = `source-${provider}-${queryId}`;
	await database
		.prepare(
			`INSERT OR IGNORE INTO licenses (
         id,
         spdx_id,
         name,
         license_url,
         ingestion_allowed,
         reviewed_at
       ) VALUES (?, 'MIT', 'MIT License', 'https://opensource.org/license/mit', 1, ?)`,
		)
		.bind(licenseId, CREATED_AT)
		.run();
	await database
		.prepare(
			`INSERT INTO source_repositories (
         id,
         provider,
         repository,
         source_url,
         license_id
       ) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			sourceId,
			provider,
			repository,
			`https://example.com/${repository}`,
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
         original_author,
         source_url,
         license_id
       ) VALUES (?, ?, ?, ?, 'Test author', ?, ?)`,
		)
		.bind(
			queryId,
			sourceId,
			`${queryId}.kql`,
			"a".repeat(40),
			`https://example.com/${repository}/${queryId}.kql`,
			licenseId,
		)
		.run();
	await database
		.prepare("UPDATE queries SET owner_id = NULL WHERE id = ?")
		.bind(queryId)
		.run();
}

describe("D1 search repository", () => {
	let database: TestD1Database;
	let db: D1Client;

	beforeEach(async () => {
		database = new TestD1Database();
		db = database as unknown as D1Client;
		await seedUser(database, OWNER_ID, "owner@example.com");
		await seedUser(database, OTHER_ID, "other@example.com");
	});

	afterEach(() => database.close());

	it("keeps private FTS rows available only to their owner", async () => {
		const publicQuery = await createQuery(db, {
			ownerId: OWNER_ID,
			title: "Failed sign-ins by account",
			kql: "SigninLogs | where ResultType != 0",
			description: "Summarize failed sign-ins for each account.",
			dialect: "sentinel",
			visibility: "public",
			tables: ["SigninLogs"],
			operators: ["where"],
		});
		const privateQuery = await createQuery(db, {
			ownerId: OWNER_ID,
			title: "Private failed sign-ins",
			kql: "SigninLogs | where ResultType != 0 | take 20",
			dialect: "sentinel",
			tables: ["SigninLogs"],
		});

		await expect(
			searchQueriesLexical(db, request, null),
		).resolves.toEqual([
			expect.objectContaining({
				queryId: publicQuery.id,
				visibility: "public",
			}),
		]);

		const ownerResults = await searchQueriesLexical(db, request, OWNER_ID);
		expect(ownerResults.map((item) => item.queryId).sort()).toEqual(
			[publicQuery.id, privateQuery.id].sort(),
		);

		const otherResults = await searchQueriesLexical(db, request, OTHER_ID);
		expect(otherResults.map((item) => item.queryId)).toEqual([publicQuery.id]);
	});

	it("reauthorizes semantic IDs, applies filters, and preserves candidate order", async () => {
		const sentinel = await createQuery(db, {
			ownerId: OWNER_ID,
			title: "Sentinel failed sign-ins",
			kql: "SigninLogs | where ResultType != 0",
			dialect: "sentinel",
			visibility: "public",
			tables: ["SigninLogs"],
		});
		const defender = await createQuery(db, {
			ownerId: OWNER_ID,
			title: "Defender failed authentications",
			kql: "DeviceLogonEvents | where ActionType == 'LogonFailed'",
			dialect: "defender-xdr",
			visibility: "public",
			tables: ["DeviceLogonEvents"],
		});

		const results = await getAuthorizedQueriesByIds(
			db,
			[defender.id, sentinel.id],
			null,
			{ ...request, dialects: ["sentinel"] },
		);

		expect(results.map((item) => item.queryId)).toEqual([sentinel.id]);
	});

	it("claims an embedding job and loads its current immutable version", async () => {
		const query = await createQuery(db, {
			ownerId: OWNER_ID,
			title: "Private process query",
			kql: "DeviceProcessEvents | take 10",
			dialect: "defender-xdr",
			tables: ["DeviceProcessEvents"],
		});

		const jobs = await claimEmbeddingOutbox(db, "test-worker", 10);
		expect(jobs).toEqual([
			expect.objectContaining({
				queryId: query.id,
				versionId: query.currentVersionId,
				namespaceKind: "private",
				ownerId: OWNER_ID,
				lockedBy: "test-worker",
			}),
		]);
		await expect(
			loadCurrentEmbeddingDocument(db, query.id),
		).resolves.toMatchObject({
			queryId: query.id,
			versionId: query.currentVersionId,
			title: "Private process query",
		});
	});

	it("returns public feed pages in 20-row batches without duplicates", async () => {
		const queryIds: string[] = [];
		for (let index = 0; index < 25; index += 1) {
			const query = await createQuery(db, {
				ownerId: OWNER_ID,
				title: `Public query ${index}`,
				kql: `SigninLogs | take ${index + 1}`,
				description: `Public query description ${index}`,
				dialect: "sentinel",
				visibility: "public",
				tables: ["SigninLogs"],
			});
			queryIds.push(query.id);
		}
		await starQuery(db, queryIds[0], OTHER_ID);

		const firstPage = await listPublicQueries(db, { limit: 20 });
		const secondPage = await listPublicQueries(db, {
			cursor: firstPage.nextCursor,
			limit: 20,
		});
		const returnedIds = [
			...firstPage.items.map((item) => item.id),
			...secondPage.items.map((item) => item.id),
		];

		expect(firstPage.items).toHaveLength(20);
		expect(firstPage.items[0].id).toBe(queryIds[0]);
		expect(firstPage.nextCursor).toBeDefined();
		expect(secondPage.items).toHaveLength(5);
		expect(secondPage.nextCursor).toBeUndefined();
		expect(new Set(returnedIds).size).toBe(25);
		expect(new Set(returnedIds)).toEqual(new Set(queryIds));
	});

	it("excludes bundled local demos while retaining GitHub imports", async () => {
		const demo = await createQuery(db, {
			ownerId: OWNER_ID,
			title: "Bundled demo",
			kql: "SigninLogs | take 1",
			dialect: "sentinel",
			visibility: "public",
		});
		await attachSource(database, demo.id, "local", "kqlbook.com/demo");

		const imported = await createQuery(db, {
			ownerId: OWNER_ID,
			title: "Imported GitHub query",
			kql: "DeviceProcessEvents | take 1",
			dialect: "defender-xdr",
			visibility: "public",
		});
		await attachSource(database, imported.id, "github", "example/kql");

		const page = await listPublicQueries(db, { limit: 20 });

		expect(page.items.map((item) => item.id)).toContain(imported.id);
		expect(page.items.map((item) => item.id)).not.toContain(demo.id);
	});
});
