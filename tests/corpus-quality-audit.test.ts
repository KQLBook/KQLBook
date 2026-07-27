import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
	auditCorpusQualityFile,
	findProseWrapper,
	findSuspiciousTableNames,
	isGenericCorpusTitle,
} from "../scripts/audit-corpus-quality";

interface SqliteDatabase {
	close(): void;
	exec(sql: string): void;
}

interface SqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as SqliteModule;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("corpus quality rules", () => {
	it("recognizes placeholder titles without flagging descriptive titles", () => {
		expect(isGenericCorpusTitle("Sentinel 1")).toBe(true);
		expect(isGenericCorpusTitle("Defender XDR")).toBe(true);
		expect(isGenericCorpusTitle("References")).toBe(true);
		expect(isGenericCorpusTitle("Query #5")).toBe(true);
		expect(isGenericCorpusTitle("Log Analytics (Sentinel)")).toBe(true);
		expect(
			isGenericCorpusTitle("Microsoft Defender Antivirus Detections"),
		).toBe(true);
		expect(isGenericCorpusTitle("Follow-up pivots (recommended)")).toBe(true);
		expect(isGenericCorpusTitle("Follow\u2011up pivots (recommended)")).toBe(true);
		expect(isGenericCorpusTitle("Microsoft Defender for Endpoint 7")).toBe(
			true,
		);
		expect(
			isGenericCorpusTitle("Microsoft Sentinel / Defender XDR 3"),
		).toBe(true);
		expect(
			isGenericCorpusTitle("Microsoft Sentinel, Microsoft 365 Defender 2"),
		).toBe(true);
		expect(isGenericCorpusTitle("Detect suspicious PowerShell downloads")).toBe(
			false,
		);
	});

	it("finds uncommented wrappers but ignores comments", () => {
		expect(
			findProseWrapper(`Use Case: Detect application hangs

Query:
WindowsEvent('Application', 7d)`),
		).toBe("Use Case: Detect application hangs");
		expect(
			findProseWrapper(`// Use Case: Detect application hangs
WindowsEvent('Application', 7d)`),
		).toBeNull();
		expect(
			findProseWrapper(`datatable(
	Description: string,
	RequiredAction: string
) []`),
		).toBeNull();
		expect(
			findProseWrapper(
				'set "SYSTEMROOT=C:\\Windows\\Temp" && cmd /c example.exe',
			),
		).toBe(
			'set "SYSTEMROOT=C:\\Windows\\Temp" && cmd /c example.exe',
		);
		expect(
			findProseWrapper(
				"let Regex = @'.*/(.*)HTTP'; Between the last '/' and 'HTTP'.",
			),
		).toBe("Between the last '/' and 'HTTP'.");
		expect(
			findProseWrapper(
				"let Regex = @'\\\\(.*?)\\\\'; Between \\ extra \\ to escape.",
			),
		).toBe("Between \\ extra \\ to escape.");
	});

	it("finds suspicious extracted table identifiers", () => {
		expect(findSuspiciousTableNames('["DeviceInfo","hint","where"]')).toEqual([
			"hint",
			"where",
		]);
		expect(findSuspiciousTableNames('["DeviceInfo"]')).toEqual([]);
	});
});

describe("corpus quality database audit", () => {
	it("passes a consistent active query and its FTS row", async () => {
		const databasePath = await createFixture(`
			INSERT INTO queries VALUES ('q-good', 'visible', 'v-good', NULL);
			INSERT INTO query_versions VALUES (
				'v-good',
				'q-good',
				'Detect suspicious PowerShell downloads',
				'DeviceProcessEvents | where FileName == "powershell.exe"',
				'Finds PowerShell process events.',
				'Filters process events for PowerShell.',
				'["DeviceProcessEvents"]',
				'["where"]',
				'["powershell","process"]'
			);
			INSERT INTO query_search VALUES (
				'q-good',
				'v-good',
				'Detect suspicious PowerShell downloads',
				'DeviceProcessEvents',
				'Finds PowerShell process events.',
				'DeviceProcessEvents | where FileName == "powershell.exe"',
				'where',
				'powershell process',
				'',
				''
			);
			INSERT INTO queries VALUES ('q-tableless', 'visible', 'v-tableless', NULL);
			INSERT INTO query_versions VALUES (
				'v-tableless',
				'q-tableless',
				'Calculate a ten-minute time range',
				'range Timestamp from ago(10m) to now() step 1m',
				'Creates a time series without reading a table.',
				'Returns one row for each minute in the selected period.',
				'[]',
				'["range"]',
				'["time-series"]'
			);
			INSERT INTO query_search VALUES (
				'q-tableless',
				'v-tableless',
				'Calculate a ten-minute time range',
				'',
				'Creates a time series without reading a table.',
				'range Timestamp from ago(10m) to now() step 1m',
				'range',
				'time-series',
				'',
				''
			);
			INSERT INTO queries VALUES (
				'q-deleted',
				'visible',
				'v-deleted',
				'2026-07-26T00:00:00.000Z'
			);
			INSERT INTO query_versions VALUES (
				'v-deleted',
				'q-deleted',
				'Sentinel 1',
				'Use Case: stale deleted query',
				'',
				'',
				'["hint"]',
				'[]',
				'[]'
			);
		`);

		const audit = auditCorpusQualityFile(databasePath);

		expect(audit.totalFindings).toBe(0);
		expect(audit.activeCurrentRows).toBe(2);
		expect(audit.tablelessCurrentRows).toBe(1);
		expect(audit.expectedFtsRows).toBe(2);
		expect(runAuditCommand(databasePath).status).toBe(0);
	});

	it("reports metadata, current-version, and FTS failures", async () => {
		const databasePath = await createFixture(`
			INSERT INTO queries VALUES ('q-bad', 'visible', 'v-bad', NULL);
			INSERT INTO query_versions VALUES (
				'v-bad',
				'q-bad',
				'Sentinel 1',
				'Use Case: Find events

Query:
DeviceInfo | take 10',
				'',
				'',
				'["hint"]',
				'["take"]',
				'[]'
			);
			INSERT INTO queries VALUES ('q-no-current', 'visible', NULL, NULL);
			INSERT INTO query_search VALUES (
				'q-bad',
				'v-old',
				'Sentinel 1',
				'hint',
				'',
				'Use Case: Find events',
				'take',
				'',
				'',
				''
			);
			INSERT INTO query_search VALUES (
				'q-ghost',
				'v-ghost',
				'Ghost',
				'',
				'Ghost',
				'print 1',
				'',
				'ghost',
				'',
				''
			);
		`);

		const audit = auditCorpusQualityFile(databasePath);
		const codes = new Set(audit.issues.map((issue) => issue.code));

		expect(codes).toEqual(
			new Set([
				"empty-description",
				"empty-explanation",
				"empty-tags",
				"generic-title",
				"prose-wrapper",
				"suspicious-table",
				"current-version",
				"fts-mismatch",
				"fts-unexpected",
			]),
		);
		expect(audit.totalFindings).toBe(9);
		expect(runAuditCommand(databasePath).status).toBe(1);
	});

	it("reports duplicate titles within the same imported repository", async () => {
		const databasePath = await createFixture(`
			INSERT INTO source_repositories VALUES ('s-one', 'example/repository');
			INSERT INTO queries VALUES ('q-one', 'visible', 'v-one', NULL);
			INSERT INTO queries VALUES ('q-two', 'visible', 'v-two', NULL);
			INSERT INTO query_versions VALUES (
				'v-one', 'q-one', 'Audit device actions',
				'DeviceEvents | take 1', 'Finds device actions.',
				'Returns one device action.', '["DeviceEvents"]',
				'["take"]', '["defender-xdr","device-events"]'
			);
			INSERT INTO query_versions VALUES (
				'v-two', 'q-two', 'Audit device actions',
				'DeviceEvents | take 2', 'Finds device actions.',
				'Returns two device actions.', '["DeviceEvents"]',
				'["take"]', '["defender-xdr","device-events"]'
			);
			INSERT INTO query_provenance VALUES (
				'q-one', 's-one', 'Defender/Audit.md', ''
			);
			INSERT INTO query_provenance VALUES (
				'q-two', 's-one', 'Defender/AnotherAudit.md', ''
			);
			INSERT INTO query_search VALUES (
				'q-one', 'v-one', 'Audit device actions', 'DeviceEvents',
				'Finds device actions.', 'DeviceEvents | take 1', 'take',
				'defender-xdr device-events', '', 'example/repository'
			);
			INSERT INTO query_search VALUES (
				'q-two', 'v-two', 'Audit device actions', 'DeviceEvents',
				'Finds device actions.', 'DeviceEvents | take 2', 'take',
				'defender-xdr device-events', '', 'example/repository'
			);
		`);

		const audit = auditCorpusQualityFile(databasePath);

		expect(audit.totalFindings).toBe(1);
		expect(audit.issues).toEqual([
			expect.objectContaining({
				code: "duplicate-source-title",
				count: 1,
			}),
		]);
	});

	it("reports a declaration-only snippet as incomplete KQL", async () => {
		const databasePath = await createFixture(`
			INSERT INTO queries VALUES ('q-snippet', 'visible', 'v-snippet', NULL);
			INSERT INTO query_versions VALUES (
				'v-snippet', 'q-snippet', 'Reusable IP expression',
				'let IpRegex = "[0-9.]+";',
				'Defines a reusable IP expression.',
				'Defines a reusable IP expression.',
				'[]', '[]', '["regex","ip-address"]'
			);
			INSERT INTO query_search VALUES (
				'q-snippet', 'v-snippet', 'Reusable IP expression', '',
				'Defines a reusable IP expression.', 'let IpRegex = "[0-9.]+";',
				'', 'regex ip-address', '', ''
			);
		`);

		const audit = auditCorpusQualityFile(databasePath);

		expect(audit.totalFindings).toBe(1);
		expect(audit.issues).toEqual([
			expect.objectContaining({
				code: "invalid-kql-structure",
				count: 1,
			}),
		]);
	});
});

function runAuditCommand(databasePath: string) {
	return spawnSync(
		process.execPath,
		[
			fileURLToPath(
				new URL("../scripts/run-audit-corpus-quality.mjs", import.meta.url),
			),
			"--database",
			databasePath,
			"--sample-limit",
			"0",
		],
		{ encoding: "utf8" },
	);
}

async function createFixture(seedSql: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "kql-corpus-audit-test-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "fixture.sqlite");
	const database = new DatabaseSync(databasePath);
	try {
		database.exec(`
			CREATE TABLE queries (
				id TEXT PRIMARY KEY,
				moderation_status TEXT NOT NULL,
				current_version_id TEXT,
				deleted_at TEXT
			);
			CREATE TABLE query_versions (
				id TEXT PRIMARY KEY,
				query_id TEXT NOT NULL,
				title TEXT NOT NULL,
				kql TEXT NOT NULL,
				description TEXT NOT NULL,
				explanation TEXT NOT NULL,
				tables_json TEXT NOT NULL,
				operators_json TEXT NOT NULL,
				tags_json TEXT NOT NULL
			);
			CREATE TABLE source_repositories (
				id TEXT PRIMARY KEY,
				repository TEXT NOT NULL
			);
			CREATE TABLE query_provenance (
				query_id TEXT PRIMARY KEY,
				source_repository_id TEXT NOT NULL,
				source_path TEXT NOT NULL DEFAULT '',
				original_author TEXT NOT NULL
			);
			CREATE VIRTUAL TABLE query_search USING fts5(
				query_id UNINDEXED,
				version_id UNINDEXED,
				title,
				tables,
				description,
				kql,
				operators,
				tags,
				author,
				source
			);
			${seedSql}
		`);
	} finally {
		database.close();
	}
	await readFile(databasePath);
	return databasePath;
}
