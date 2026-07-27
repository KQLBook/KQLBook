import { createRequire } from "node:module";
import { resolve } from "node:path";

import { isGenericQueryTitle } from "../src/lib/ingest/enrichment";
import { findKqlStructuralProblem } from "../src/lib/ingest/parsers";

type SqliteValue = string | number | bigint | Uint8Array | null;

interface SqliteStatement {
	all(...values: SqliteValue[]): Array<Record<string, unknown>>;
}

interface SqliteDatabase {
	close(): void;
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
}

interface SqliteModule {
	DatabaseSync: new (
		path: string,
		options?: { readOnly?: boolean },
	) => SqliteDatabase;
}

export type CorpusQualityIssueCode =
	| "empty-description"
	| "empty-explanation"
	| "empty-tags"
	| "generic-title"
	| "duplicate-source-title"
	| "prose-wrapper"
	| "invalid-kql-structure"
	| "suspicious-table"
	| "current-version"
	| "fts-missing"
	| "fts-mismatch"
	| "fts-unexpected";

export interface CorpusQualitySample {
	queryId: string;
	versionId?: string;
	title?: string;
	detail: string;
}

export interface CorpusQualityIssue {
	code: CorpusQualityIssueCode;
	label: string;
	count: number;
	samples: CorpusQualitySample[];
}

export interface CorpusQualityAudit {
	databasePath: string;
	activeQueries: number;
	activeCurrentRows: number;
	tablelessCurrentRows: number;
	expectedFtsRows: number;
	actualFtsRows: number;
	totalFindings: number;
	issues: CorpusQualityIssue[];
}

interface ActiveQueryRow {
	query_id: string;
	moderation_status: string;
	current_version_id: string | null;
	version_id: string | null;
	version_query_id: string | null;
	title: string | null;
	kql: string | null;
	description: string | null;
	explanation: string | null;
	tables_json: string | null;
	operators_json: string | null;
	tags_json: string | null;
	author: string;
	source: string;
	source_path: string;
}

interface FtsRow {
	query_id: string;
	version_id: string;
	title: string;
	tables: string;
	description: string;
	kql: string;
	operators: string;
	tags: string;
	author: string;
	source: string;
}

interface IssueAccumulator {
	label: string;
	count: number;
	samples: CorpusQualitySample[];
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as SqliteModule;

const ISSUE_LABELS: Record<CorpusQualityIssueCode, string> = {
	"empty-description": "Empty descriptions",
	"empty-explanation": "Empty explanations",
	"empty-tags": "Empty tags",
	"generic-title": "Generic placeholder titles",
	"duplicate-source-title": "Duplicate titles within one source repository",
	"prose-wrapper": "Prose wrappers in executable KQL",
	"invalid-kql-structure": "Incomplete or structurally invalid KQL",
	"suspicious-table": "Suspicious extracted table names",
	"current-version": "Invalid or missing current versions",
	"fts-missing": "Missing FTS rows",
	"fts-mismatch": "Mismatched or duplicate FTS rows",
	"fts-unexpected": "Unexpected FTS rows",
};

const PROSE_WRAPPER =
	/^(?:use\s+case\s*:|what\s+it\s+does\s*:|purpose\s*:|description\s*:|author\s*:|query\s*:|intune\s+device\s+query\s*[-:]\s*kql\s*$|```(?:kql|kusto)?\s*$|#{1,6}\s+\S|set\s+"[^"\r\n]+=[^"\r\n]*"\s*&&\s*(?:cmd(?:\.exe)?\b|[A-Za-z0-9_.-]+\.exe\b)|cmd(?:\.exe)?\s+\/c\b|powershell(?:\.exe)?\s+(?:-|\/)|pwsh(?:\.exe)?\s+(?:-|\/))/iu;
const KQL_TYPED_COLUMN =
	/^(?:description|author)\s*:\s*(?:bool|datetime|decimal|dynamic|guid|int|long|real|string|timespan)(?:\s*[,)]|$)/iu;

const SUSPICIOUS_TABLE_NAMES = new Set([
	"as",
	"evaluate",
	"extend",
	"find",
	"hint",
	"invoke",
	"join",
	"kind",
	"limit",
	"lookup",
	"on",
	"order",
	"parse",
	"project",
	"render",
	"search",
	"sort",
	"summarize",
	"take",
	"union",
	"where",
	"withsource",
]);

const FTS_FIELDS: Array<keyof Omit<FtsRow, "query_id" | "version_id">> = [
	"title",
	"tables",
	"description",
	"kql",
	"operators",
	"tags",
	"author",
	"source",
];

export function isGenericCorpusTitle(title: string): boolean {
	const normalized = title
		.trim()
		.replace(/\s*[-_:#.]\s*(\d+)$/u, " $1");
	const withoutOrdinal = normalized.replace(/\s+\d+$/u, "");
	const combinedParts = withoutOrdinal.split(/\s*(?:,|\+)\s*/u);
	return (
		isGenericQueryTitle(normalized) ||
		(combinedParts.length > 1 &&
			combinedParts.every((part) => isGenericQueryTitle(part))) ||
		/^untitled(?:\s+\d+)?$/iu.test(normalized)
	);
}

export function findProseWrapper(kql: string): string | null {
	const executable = stripKqlComments(kql);
	for (const line of executable.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (
			trimmed &&
			PROSE_WRAPPER.test(trimmed) &&
			!KQL_TYPED_COLUMN.test(trimmed)
		) {
			return trimmed;
		}
	}
	const sentence = findNonKqlSentence(executable);
	if (sentence) {
		return sentence;
	}
	return null;
}

function findNonKqlSentence(kql: string): string | null {
	const masked = maskKqlStrings(kql);
	for (const pattern of [
		/(?:^|[;\n])\s*([A-Za-z][A-Za-z0-9_-]*\s+[A-Za-z][^|;=\n]*[.!?])\s*(?=$|[;\n])/mu,
		/(?:^|[;\n])\s*(Between\b[^|;=\n]*[.!?])\s*(?=$|[;\n])/imu,
	]) {
		const match = masked.match(pattern);
		if (!match?.[1]) {
			continue;
		}
		const start = (match.index ?? 0) + match[0].indexOf(match[1]);
		return kql.slice(start, start + match[1].length).trim() || null;
	}
	return null;
}

function maskKqlStrings(value: string): string {
	let output = "";
	let quote: "'" | '"' | null = null;

	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		const next = value[index + 1];
		if (quote) {
			if (character === quote) {
				if (next === quote) {
					output += "  ";
					index += 1;
				} else {
					quote = null;
					output += " ";
				}
			} else {
				output += character === "\n" ? "\n" : " ";
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			output += " ";
			continue;
		}
		output += character;
	}

	return output;
}

export function findSuspiciousTableNames(tablesJson: string): string[] {
	let values: unknown;
	try {
		values = JSON.parse(tablesJson);
	} catch {
		return ["<invalid tables_json>"];
	}
	if (!Array.isArray(values)) {
		return ["<invalid tables_json>"];
	}
	return [
		...new Set(
			values
				.filter((value): value is string => typeof value === "string")
				.filter((value) =>
					SUSPICIOUS_TABLE_NAMES.has(value.trim().toLocaleLowerCase("en-US")),
				),
		),
	];
}

export function auditCorpusQualityFile(
	databasePath: string,
	options: { sampleLimit?: number } = {},
): CorpusQualityAudit {
	const resolvedPath = resolve(databasePath);
	const sampleLimit = Math.max(0, options.sampleLimit ?? 10);
	const database = new DatabaseSync(resolvedPath, { readOnly: true });
	try {
		database.exec("PRAGMA query_only = ON");
		return auditDatabase(database, resolvedPath, sampleLimit);
	} finally {
		database.close();
	}
}

function auditDatabase(
	database: SqliteDatabase,
	databasePath: string,
	sampleLimit: number,
): CorpusQualityAudit {
	const activeRows = database
		.prepare(
			`SELECT
			   q.id AS query_id,
			   q.moderation_status,
			   q.current_version_id,
			   v.id AS version_id,
			   v.query_id AS version_query_id,
			   v.title,
			   v.kql,
			   v.description,
			   v.explanation,
			   v.tables_json,
			   v.operators_json,
			   v.tags_json,
			   coalesce(p.original_author, '') AS author,
			   coalesce(s.repository, '') AS source,
			   coalesce(p.source_path, '') AS source_path
			 FROM queries AS q
			 LEFT JOIN query_versions AS v ON v.id = q.current_version_id
			 LEFT JOIN query_provenance AS p ON p.query_id = q.id
			 LEFT JOIN source_repositories AS s
			   ON s.id = p.source_repository_id
			 WHERE q.deleted_at IS NULL
			 ORDER BY q.id`,
		)
		.all() as unknown as ActiveQueryRow[];
	const ftsRows = database
		.prepare(
			`SELECT
			   query_id,
			   version_id,
			   title,
			   tables,
			   description,
			   kql,
			   operators,
			   tags,
			   author,
			   source
			 FROM query_search
			 ORDER BY query_id, rowid`,
		)
		.all() as unknown as FtsRow[];

	const issues = new Map<CorpusQualityIssueCode, IssueAccumulator>();
	const addIssue = (
		code: CorpusQualityIssueCode,
		sample: CorpusQualitySample,
	): void => {
		const accumulator = issues.get(code) ?? {
			label: ISSUE_LABELS[code],
			count: 0,
			samples: [],
		};
		accumulator.count += 1;
		if (accumulator.samples.length < sampleLimit) {
			accumulator.samples.push(sample);
		}
		issues.set(code, accumulator);
	};

	const validCurrentRows = new Map<string, ActiveQueryRow>();
	let tablelessCurrentRows = 0;
	const sourceTitles = new Map<string, string>();
	for (const row of activeRows) {
		const title = row.title ?? undefined;
		const sample = (
			detail: string,
			versionId = row.version_id ?? undefined,
		): CorpusQualitySample => ({
			queryId: row.query_id,
			versionId,
			title,
			detail,
		});

		if (!row.current_version_id) {
			addIssue("current-version", sample("current_version_id is null"));
			continue;
		}
		if (!row.version_id) {
			addIssue(
				"current-version",
				sample(
					`current version ${row.current_version_id} does not exist`,
					row.current_version_id,
				),
			);
			continue;
		}
		if (row.version_query_id !== row.query_id) {
			addIssue(
				"current-version",
				sample(
					`current version belongs to ${row.version_query_id ?? "no query"}`,
				),
			);
			continue;
		}

		validCurrentRows.set(row.query_id, row);
		if (jsonArrayIsEmpty(row.tables_json)) {
			tablelessCurrentRows += 1;
		}
		if (!row.description?.trim()) {
			addIssue("empty-description", sample("description is empty"));
		}
		if (!row.explanation?.trim()) {
			addIssue("empty-explanation", sample("explanation is empty"));
		}
		if (jsonArrayIsEmpty(row.tags_json)) {
			addIssue("empty-tags", sample("tags_json is empty"));
		}
		if (row.title && isGenericCorpusTitle(row.title)) {
			addIssue("generic-title", sample(`generic title: ${row.title}`));
		}
		if (row.title && row.source && row.source_path) {
			const sourceTitleKey = [
				row.source.toLocaleLowerCase("en-US"),
				row.title.trim().toLocaleLowerCase("en-US"),
			].join("\u0000");
			const firstQueryId = sourceTitles.get(sourceTitleKey);
			if (firstQueryId) {
				addIssue(
					"duplicate-source-title",
					sample(`same repository title as ${firstQueryId}: ${row.title}`),
				);
			} else {
				sourceTitles.set(sourceTitleKey, row.query_id);
			}
		}
		if (row.kql) {
			const wrapper = findProseWrapper(row.kql);
			if (wrapper) {
				addIssue("prose-wrapper", sample(`non-KQL line: ${wrapper}`));
			}
			const structuralProblem = findKqlStructuralProblem(row.kql);
			if (structuralProblem) {
				addIssue(
					"invalid-kql-structure",
					sample(structuralProblem),
				);
			}
		}
		if (row.tables_json) {
			const suspicious = findSuspiciousTableNames(row.tables_json);
			if (suspicious.length > 0) {
				addIssue(
					"suspicious-table",
					sample(`suspicious tables: ${suspicious.join(", ")}`),
				);
			}
		}
	}

	const expectedFtsRows = new Map(
		[...validCurrentRows.values()]
			.filter((row) => row.moderation_status === "visible")
			.map((row) => [row.query_id, expectedFtsRow(row)]),
	);
	const actualFtsByQuery = new Map<string, FtsRow[]>();
	for (const row of ftsRows) {
		const rows = actualFtsByQuery.get(row.query_id) ?? [];
		rows.push(row);
		actualFtsByQuery.set(row.query_id, rows);
	}

	for (const [queryId, expected] of expectedFtsRows) {
		const actual = actualFtsByQuery.get(queryId) ?? [];
		if (actual.length === 0) {
			addIssue("fts-missing", {
				queryId,
				versionId: expected.version_id,
				title: expected.title,
				detail: "visible active query has no query_search row",
			});
			continue;
		}
		if (actual.length !== 1) {
			addIssue("fts-mismatch", {
				queryId,
				versionId: expected.version_id,
				title: expected.title,
				detail: `expected one query_search row, found ${actual.length}`,
			});
			continue;
		}
		const mismatches = compareFtsRows(expected, actual[0]);
		if (mismatches.length > 0) {
			addIssue("fts-mismatch", {
				queryId,
				versionId: expected.version_id,
				title: expected.title,
				detail: `mismatched fields: ${mismatches.join(", ")}`,
			});
		}
	}

	for (const [queryId, rows] of actualFtsByQuery) {
		if (expectedFtsRows.has(queryId)) {
			continue;
		}
		for (const row of rows) {
			addIssue("fts-unexpected", {
				queryId,
				versionId: row.version_id,
				title: row.title,
				detail:
					"query_search row has no visible active current query",
			});
		}
	}

	const formattedIssues: CorpusQualityIssue[] = [];
	for (const [code, issue] of issues) {
		formattedIssues.push({ code, ...issue });
	}
	const totalFindings = formattedIssues.reduce(
		(total, issue) => total + issue.count,
		0,
	);

	return {
		databasePath,
		activeQueries: activeRows.length,
		activeCurrentRows: validCurrentRows.size,
		tablelessCurrentRows,
		expectedFtsRows: expectedFtsRows.size,
		actualFtsRows: ftsRows.length,
		totalFindings,
		issues: formattedIssues,
	};
}

function expectedFtsRow(row: ActiveQueryRow): FtsRow {
	return {
		query_id: row.query_id,
		version_id: row.version_id ?? "",
		title: row.title ?? "",
		tables: jsonArrayToFts(row.tables_json),
		description: row.description ?? "",
		kql: row.kql ?? "",
		operators: jsonArrayToFts(row.operators_json),
		tags: jsonArrayToFts(row.tags_json),
		author: row.author,
		source: row.source,
	};
}

function compareFtsRows(expected: FtsRow, actual: FtsRow): string[] {
	const mismatches: string[] = [];
	if (actual.version_id !== expected.version_id) {
		mismatches.push("version_id");
	}
	for (const field of FTS_FIELDS) {
		if (actual[field] !== expected[field]) {
			mismatches.push(field);
		}
	}
	return mismatches;
}

function jsonArrayIsEmpty(value: string | null): boolean {
	if (!value) {
		return true;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return !Array.isArray(parsed) || parsed.length === 0;
	} catch {
		return true;
	}
}

function jsonArrayToFts(value: string | null): string {
	if (!value) {
		return "";
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) {
			return "";
		}
		return parsed
			.filter(
				(item): item is string | number =>
					typeof item === "string" || typeof item === "number",
			)
			.join(" ");
	} catch {
		return "";
	}
}

function stripKqlComments(kql: string): string {
	let output = "";
	let quote: "'" | '"' | null = null;
	let lineComment = false;
	let blockComment = false;

	for (let index = 0; index < kql.length; index += 1) {
		const character = kql[index];
		const next = kql[index + 1];
		if (lineComment) {
			if (character === "\n") {
				lineComment = false;
				output += character;
			} else {
				output += " ";
			}
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				output += "  ";
				index += 1;
			} else {
				output += character === "\n" ? "\n" : " ";
			}
			continue;
		}
		if (quote) {
			output += character;
			if (character === quote) {
				if (next === quote) {
					output += next;
					index += 1;
				} else {
					quote = null;
				}
			}
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			output += character;
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			output += "  ";
			index += 1;
			continue;
		}
		if (character === "/" && next === "*") {
			blockComment = true;
			output += "  ";
			index += 1;
			continue;
		}
		output += character;
	}
	return output;
}

function parseArguments(args: string[]): {
	database: string;
	json: boolean;
	sampleLimit: number;
} {
	let database: string | undefined;
	let json = false;
	let sampleLimit = 10;

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--database") {
			database = args[index + 1];
			index += 1;
		} else if (argument === "--json") {
			json = true;
		} else if (argument === "--sample-limit") {
			const value = Number(args[index + 1]);
			if (!Number.isInteger(value) || value < 0) {
				throw new Error("--sample-limit must be a non-negative integer.");
			}
			sampleLimit = value;
			index += 1;
		} else if (!argument.startsWith("-") && !database) {
			database = argument;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}
	if (!database) {
		throw new Error(
			"Usage: npm run db:audit:corpus -- --database <sqlite-file> [--json] [--sample-limit <count>]",
		);
	}
	return { database, json, sampleLimit };
}

function printAudit(audit: CorpusQualityAudit): void {
	console.log(`Database: ${audit.databasePath}`);
	console.log(
		`Rows: ${audit.activeQueries} active queries, ${audit.activeCurrentRows} valid current versions`,
	);
	console.log(
		`Table metadata: ${audit.tablelessCurrentRows} current rows name no table (informational)`,
	);
	console.log(
		`FTS: ${audit.actualFtsRows} actual rows, ${audit.expectedFtsRows} expected rows`,
	);
	if (audit.totalFindings === 0) {
		console.log("Corpus quality audit passed.");
		return;
	}
	console.log(`Findings: ${audit.totalFindings}`);
	for (const issue of audit.issues) {
		console.log(`- ${issue.label}: ${issue.count}`);
		for (const sample of issue.samples) {
			const title = sample.title ? ` (${sample.title})` : "";
			console.log(`  ${sample.queryId}${title}: ${sample.detail}`);
		}
	}
}

async function main(): Promise<void> {
	try {
		const options = parseArguments(process.argv.slice(2));
		const audit = auditCorpusQualityFile(options.database, {
			sampleLimit: options.sampleLimit,
		});
		if (options.json) {
			console.log(JSON.stringify(audit, null, 2));
		} else {
			printAudit(audit);
		}
		process.exitCode = audit.totalFindings === 0 ? 0 : 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}

if (process.env.KQL_CORPUS_AUDIT_CLI === "1") {
	await main();
}
