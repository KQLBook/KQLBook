import { afterEach, describe, expect, it } from "vitest";

import {
	D1IngestionStore,
	type D1IngestionClient,
} from "../../src/lib/ingest/d1-store";
import type { RepositoryIngestionBatch } from "../../src/lib/ingest/types";

import { TestD1Database } from "../support/sqlite-d1";

const sha = "b".repeat(40);

interface QueryOverrides {
	id?: string;
	dedupeKey?: string;
	kql?: string;
	contentHash?: string;
	title?: string;
	description?: string;
	dialect?: "sentinel" | "defender-xdr";
	tags?: string[];
}

function batch(
	commitSha = sha,
	overrides: QueryOverrides = {},
): RepositoryIngestionBatch {
	const requiredNotice = "Copyright Example\nMIT permission notice";
	return {
		repository: {
			id: "source_repository_example",
			fullName: "example/kql",
			defaultBranch: "main",
			sourceUrl: "https://github.com/example/kql",
			trusted: true,
			},
			commitSha,
		license: {
			spdxId: "MIT",
			name: "MIT License",
			licenseUrl: `https://github.com/example/kql/blob/${sha}/LICENSE`,
				requiredNotice,
			},
			processedSourcePaths: ["rules/signin.kql"],
			emptySourcePaths: [],
		queries: [
			{
				id: overrides.id ?? "imported_query_example",
				dedupeKey: overrides.dedupeKey ?? "c".repeat(64),
				sourceIdentity: "example/kql:rules/signin.kql:0",
				title: overrides.title ?? "Failed sign-ins",
				kql:
					overrides.kql ??
					"SigninLogs\n| where ResultType != 0",
				description:
					overrides.description ?? "Finds failed sign-ins.",
				explanation:
					overrides.description ?? "Finds failed sign-ins.",
				dialect: overrides.dialect ?? "sentinel",
				tables: ["SigninLogs"],
				operators: ["where"],
				tags: overrides.tags ?? ["sentinel", "authentication"],
				extractionKind: "standalone-kql",
				contentHash: overrides.contentHash ?? "d".repeat(64),
				source: {
					repository: "example/kql",
					path: "rules/signin.kql",
					commitSha,
					blockIndex: 0,
					originalAuthor: "Example Author",
					sourceUrl: `https://github.com/example/kql/blob/${commitSha}/rules/signin.kql`,
				},
				license: {
					spdxId: "MIT",
					name: "MIT License",
					licenseUrl: `https://github.com/example/kql/blob/${sha}/LICENSE`,
					requiredNotice,
				},
			},
		],
	};
}

describe("D1 ingestion store", () => {
	let database: TestD1Database | null = null;

	afterEach(() => {
		database?.close();
		database = null;
	});

	it("persists public queries, immutable provenance, notices, and outbox work idempotently", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);

		await expect(store.writeBatch(batch())).resolves.toEqual({
			inserted: 1,
			unchanged: 0,
		});
		await expect(store.writeBatch(batch(sha))).resolves.toEqual({
			inserted: 0,
			unchanged: 1,
		});

		const query = await database
			.prepare(
				`SELECT visibility, owner_id, current_version_id
				FROM queries WHERE id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(query).toMatchObject({
			visibility: "public",
			owner_id: null,
		});
		expect(query?.current_version_id).toMatch(/^imported_version_/);

		const provenance = await database
			.prepare(
				`SELECT source_path, commit_sha, original_author, required_notice
				FROM query_provenance WHERE query_id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(provenance).toMatchObject({
			source_path: "rules/signin.kql",
			commit_sha: sha,
			original_author: "Example Author",
			required_notice: "Copyright Example\nMIT permission notice",
		});

		const license = await database
			.prepare(
				`SELECT spdx_id, ingestion_allowed, required_notice
				FROM licenses WHERE spdx_id = 'MIT'`,
			)
			.first<Record<string, unknown>>();
		expect(license).toMatchObject({
			spdx_id: "MIT",
			ingestion_allowed: 1,
			required_notice: "Copyright Example\nMIT permission notice",
		});

		const sourceRepository = await database
			.prepare(
				`SELECT provider, repository, default_branch, source_url, trusted
				FROM source_repositories WHERE id = ?`,
			)
			.bind("source_repository_example")
			.first<Record<string, unknown>>();
		expect(sourceRepository).toEqual({
			provider: "github",
			repository: "example/kql",
			default_branch: "main",
			source_url: "https://github.com/example/kql",
			trusted: 1,
		});

		const outbox = await database
			.prepare(
				`SELECT operation, namespace_kind, owner_id
				FROM embedding_outbox WHERE query_id = ?`,
			)
			.bind("imported_query_example")
			.all<Record<string, unknown>>();
		expect(outbox.results).toEqual([
			expect.objectContaining({
				operation: "upsert",
				namespace_kind: "public",
				owner_id: null,
			}),
		]);
	});

	it("keeps an unchanged version while advancing provenance to a newer commit", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);
		const nextSha = "e".repeat(40);

		await store.writeBatch(batch(sha));
		await expect(store.writeBatch(batch(nextSha))).resolves.toEqual({
			inserted: 0,
			unchanged: 1,
		});

		const versions = await database
			.prepare(
				`SELECT id, version_number
				FROM query_versions WHERE query_id = ?`,
			)
			.bind("imported_query_example")
			.all<Record<string, unknown>>();
		expect(versions.results).toHaveLength(1);
		expect(versions.results[0]).toMatchObject({ version_number: 1 });

		const provenance = await database
			.prepare(
				`SELECT commit_sha, source_url
				FROM query_provenance WHERE query_id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(provenance).toEqual({
			commit_sha: nextSha,
			source_url: `https://github.com/example/kql/blob/${nextSha}/rules/signin.kql`,
		});
	});

	it("creates version 2 for changed content on a later commit and keeps it current", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);
		const nextSha = "f".repeat(40);
		const changedBatch = batch(nextSha, {
			dedupeKey: "1".repeat(64),
			kql: "SigninLogs\n| where ResultType != 0\n| take 100",
			contentHash: "2".repeat(64),
		});

		await expect(store.writeBatch(batch(sha))).resolves.toEqual({
			inserted: 1,
			unchanged: 0,
		});
		await expect(store.writeBatch(changedBatch)).resolves.toEqual({
			inserted: 1,
			unchanged: 0,
		});
		await expect(store.writeBatch(changedBatch)).resolves.toEqual({
			inserted: 0,
			unchanged: 1,
		});

		const versions = await database
			.prepare(
				`SELECT id, version_number, kql, content_hash
				FROM query_versions
				WHERE query_id = ?
				ORDER BY version_number`,
			)
			.bind("imported_query_example")
			.all<Record<string, unknown>>();
		expect(versions.results).toEqual([
			expect.objectContaining({
				version_number: 1,
				kql: "SigninLogs\n| where ResultType != 0",
				content_hash: "d".repeat(64),
			}),
			expect.objectContaining({
				version_number: 2,
				kql: "SigninLogs\n| where ResultType != 0\n| take 100",
				content_hash: "2".repeat(64),
			}),
		]);

		const current = await database
			.prepare(
				`SELECT q.current_version_id, v.version_number, v.content_hash
				FROM queries AS q
				JOIN query_versions AS v ON v.id = q.current_version_id
				WHERE q.id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(current).toEqual({
			current_version_id: versions.results[1].id,
			version_number: 2,
			content_hash: "2".repeat(64),
		});

		const provenance = await database
			.prepare(
				`SELECT commit_sha, source_url
				FROM query_provenance WHERE query_id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(provenance).toEqual({
			commit_sha: nextSha,
			source_url: `https://github.com/example/kql/blob/${nextSha}/rules/signin.kql`,
		});
	});

	it("creates a new version for metadata repairs and retains source identity across a dialect correction", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);

		await store.writeBatch(batch(sha));
		await expect(
			store.writeBatch(
				batch(sha, {
					id: "imported_query_changed_dialect_id",
					title: "Find failed Entra sign-ins",
					description:
						"Finds failed Entra sign-ins for investigation.",
					dialect: "defender-xdr",
					tags: ["defender-xdr", "authentication"],
					contentHash: "3".repeat(64),
				}),
			),
		).resolves.toEqual({ inserted: 1, unchanged: 0 });

		const queries = await database
			.prepare("SELECT id, current_version_id FROM queries")
			.all<Record<string, unknown>>();
		expect(queries.results).toHaveLength(1);
		expect(queries.results[0].id).toBe("imported_query_example");

		const current = await database
			.prepare(
				`SELECT v.version_number, v.title, v.description, v.explanation,
					v.dialect, v.tags_json
				FROM queries AS q
				JOIN query_versions AS v ON v.id = q.current_version_id
				WHERE q.id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(current).toEqual({
			version_number: 2,
			title: "Find failed Entra sign-ins",
			description:
				"Finds failed Entra sign-ins for investigation.",
			explanation:
				"Finds failed Entra sign-ins for investigation.",
			dialect: "defender-xdr",
			tags_json: JSON.stringify([
				"defender-xdr",
				"authentication",
			]),
		});
	});

	it("recovers a physical index after an interrupted provenance relocation", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);
		const initial = batch(sha);
		await store.writeBatch(initial);
		await database
			.prepare(
				`UPDATE query_provenance
				SET query_block_index =
					1000000000000 + (rowid * 1000000) + query_block_index`,
			)
			.run();

		const changed = batch("f".repeat(40), {
			id: "proposed_replacement",
			kql: "SigninLogs\n| where ResultType != 0\n| take 25",
			contentHash: "7".repeat(64),
		});
		await expect(store.writeBatch(changed)).resolves.toEqual({
			inserted: 1,
			unchanged: 0,
		});

		const restored = await database
			.prepare(
				`SELECT
					queries.id,
					provenance.query_block_index,
					version.kql
				FROM queries
				JOIN query_provenance AS provenance
					ON provenance.query_id = queries.id
				JOIN query_versions AS version
					ON version.id = queries.current_version_id`,
			)
			.first<Record<string, unknown>>();
		expect(restored).toEqual({
			id: "imported_query_example",
			query_block_index: 0,
			kql: changed.queries[0].kql,
		});
	});

	it("deactivates a stale imported path and restores the same query after a valid reimport", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);

		await store.writeBatch(batch(sha));
		await store.writeBatch({
			...batch("e".repeat(40)),
			queries: [],
			emptySourcePaths: ["rules/signin.kql"],
		});

		const deactivated = await database
			.prepare(
				`SELECT id, deleted_at
				FROM queries WHERE id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(deactivated?.id).toBe("imported_query_example");
		expect(deactivated?.deleted_at).toEqual(expect.any(String));

		const hiddenFromFts = await database
			.prepare(
				"SELECT count(*) AS count FROM query_search WHERE query_id = ?",
			)
			.bind("imported_query_example")
			.first<{ count: number }>();
		expect(hiddenFromFts?.count).toBe(0);

		const operationsAfterRemoval = await database
			.prepare(
				`SELECT operation
				FROM embedding_outbox
				WHERE query_id = ?
				ORDER BY created_at, rowid`,
			)
			.bind("imported_query_example")
			.all<{ operation: string }>();
		expect(operationsAfterRemoval.results.map((row) => row.operation)).toEqual([
			"upsert",
			"delete",
		]);

		await expect(
			store.writeBatch(batch("f".repeat(40))),
		).resolves.toEqual({
			inserted: 0,
			unchanged: 1,
		});

		const restored = await database
			.prepare(
				`SELECT id, deleted_at
				FROM queries WHERE id = ?`,
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(restored).toEqual({
			id: "imported_query_example",
			deleted_at: null,
		});

		const visibleInFts = await database
			.prepare(
				"SELECT count(*) AS count FROM query_search WHERE query_id = ?",
			)
			.bind("imported_query_example")
			.first<{ count: number }>();
		expect(visibleInFts?.count).toBe(1);
	});

	it("does not deactivate user-owned rows or reconcile a path with an accepted query", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);
		const initial = batch(sha);

		await store.writeBatch(initial);
		await database
			.prepare(
				`INSERT INTO user (
					id, name, email, emailVerified, createdAt, updatedAt, role
				) VALUES (?, ?, ?, 1, ?, ?, 'user')`,
			)
			.bind(
				"user_example",
				"Example",
				"example@example.com",
				"2026-01-01T00:00:00.000Z",
				"2026-01-01T00:00:00.000Z",
			)
			.run();
		await database
			.prepare("UPDATE queries SET owner_id = ? WHERE id = ?")
			.bind("user_example", "imported_query_example")
			.run();

		await store.writeBatch({
			...batch("e".repeat(40)),
			queries: [],
			emptySourcePaths: ["rules/signin.kql"],
		});

		const userOwned = await database
			.prepare(
				"SELECT owner_id, deleted_at FROM queries WHERE id = ?",
			)
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(userOwned).toEqual({
			owner_id: "user_example",
			deleted_at: null,
		});

		await database
			.prepare("UPDATE queries SET owner_id = NULL WHERE id = ?")
			.bind("imported_query_example")
			.run();
		await store.writeBatch({
			...initial,
			emptySourcePaths: ["rules/signin.kql"],
		});

		const acceptedPath = await database
			.prepare("SELECT deleted_at FROM queries WHERE id = ?")
			.bind("imported_query_example")
			.first<Record<string, unknown>>();
		expect(acceptedPath).toEqual({ deleted_at: null });
	});

	it("preserves shifted SmartScreen query IDs by exact KQL before index fallback", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);
		const initial = batch(sha);
		const template = initial.queries[0];
		const path =
			"Defender For Endpoint/MDE-DefenderSmartScreenEvents.md";
		const makeQuery = (
			id: string,
			blockIndex: number,
			kql: string,
			hashCharacter: string,
		) => ({
			...template,
			id,
			dedupeKey: hashCharacter.repeat(64),
			sourceIdentity: `example/kql:${path}:${blockIndex}`,
			title: `SmartScreen query ${blockIndex + 1}`,
			kql,
			contentHash: hashCharacter.toUpperCase().repeat(64),
			source: {
				...template.source,
				path,
				blockIndex,
			},
		});
		const kql = [
			"DeviceEvents | where ActionType == 'SmartScreenUserOverride'",
			"DeviceEvents | where ActionType == 'SmartScreenUrlWarning'",
			"DeviceEvents | where ActionType == 'CustomPolicy'",
			"DeviceEvents | where ActionType == 'SmartScreenAppWarning'",
			"DeviceEvents | where ActionType == 'ExploitGuardNetworkProtectionBlocked'",
		];
		const oldQueries = [
			makeQuery("old_warning", 0, kql[1], "1"),
			makeQuery("old_custom", 1, kql[2], "2"),
			makeQuery("old_app", 2, kql[3], "3"),
			makeQuery("old_network", 3, kql[4], "4"),
		];

		await store.writeBatch({
			...initial,
			queries: oldQueries,
			processedSourcePaths: [path],
		});
		await expect(
			store.writeBatch({
				...initial,
				queries: [
					// The physical-index ID collides with the old accepted block 0.
					makeQuery("old_warning", 0, kql[0], "5"),
					makeQuery("proposed_warning", 1, kql[1], "1"),
					makeQuery("proposed_custom", 2, kql[2], "2"),
					makeQuery("proposed_app", 3, kql[3], "3"),
					makeQuery("proposed_network", 4, kql[4], "4"),
				],
				processedSourcePaths: [path],
			}),
		).resolves.toEqual({ inserted: 1, unchanged: 4 });

		const rows = await database
			.prepare(
				`SELECT
					queries.id,
					queries.deleted_at,
					provenance.query_block_index,
					version.kql
				FROM queries
				JOIN query_provenance AS provenance
					ON provenance.query_id = queries.id
				JOIN query_versions AS version
					ON version.id = queries.current_version_id
				WHERE provenance.source_path = ?
				ORDER BY provenance.query_block_index`,
			)
			.bind(path)
			.all<{
				id: string;
				deleted_at: string | null;
				query_block_index: number;
				kql: string;
			}>();

		expect(rows.results).toHaveLength(5);
		expect(rows.results.map((row) => row.kql)).toEqual(kql);
		expect(rows.results.map((row) => row.query_block_index)).toEqual([
			0, 1, 2, 3, 4,
		]);
		expect(rows.results.every((row) => row.deleted_at === null)).toBe(true);
		expect(rows.results[0].id).not.toBe("old_warning");
		expect(rows.results.slice(1).map((row) => row.id)).toEqual([
			"old_warning",
			"old_custom",
			"old_app",
			"old_network",
		]);
	});

	it("reconciles obsolete blocks within a successfully processed path", async () => {
		database = new TestD1Database();
		const store = new D1IngestionStore(
			database as unknown as D1IngestionClient,
		);
		const initial = batch(sha);
		const first = initial.queries[0];
		const second = {
			...first,
			id: "imported_query_example_second",
			dedupeKey: "5".repeat(64),
			sourceIdentity: "example/kql:rules/signin.kql:1",
			title: "Successful sign-ins",
			kql: "SigninLogs\n| where ResultType == 0",
			contentHash: "6".repeat(64),
			source: {
				...first.source,
				blockIndex: 1,
			},
		};

		await store.writeBatch({
			...initial,
			queries: [first, second],
		});
		await store.writeBatch({
			...initial,
			queries: [first],
			emptySourcePaths: ["rules/signin.kql"],
		});

		const afterPartialImport = await database
			.prepare(
				`SELECT count(*) AS count
				FROM queries
				WHERE deleted_at IS NULL`,
			)
			.first<{ count: number }>();
		expect(afterPartialImport?.count).toBe(1);

		await store.writeBatch({
			...initial,
			queries: [],
			emptySourcePaths: ["rules/signin.kql"],
		});

		const afterEmptyImport = await database
			.prepare(
				`SELECT count(*) AS count
				FROM queries
				WHERE deleted_at IS NULL`,
			)
			.first<{ count: number }>();
		expect(afterEmptyImport?.count).toBe(0);
	});
});
