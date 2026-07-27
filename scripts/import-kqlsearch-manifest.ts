import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
	D1IngestionStore,
	type D1IngestionClient,
} from "../src/lib/ingest/d1-store";
import { GithubHttpClient } from "../src/lib/ingest/github-http";
import { assertApprovedRepositoryLicense } from "../src/lib/ingest/license-policy";
import { GithubIngestionPipeline } from "../src/lib/ingest/pipeline";
import type {
	ApprovedIngestionLicense,
	PathDialectRule,
} from "../src/lib/ingest/types";
import type { KqlDialect } from "../src/lib/search/types";
import { LocalD1Database } from "./support/local-d1";
import {
	cloneGithubRepository,
	LocalGitGithubSource,
} from "./support/local-git-github";

const ELIGIBLE_STATUS =
	"repository_license_eligible_pending_file_checks";

interface RepositoryDialectConfig {
	defaultDialect: KqlDialect;
	pathDialects?: readonly PathDialectRule[];
}

const DIALECT_CONFIG = new Map<string, RepositoryDialectConfig>(
	Object.entries({
		"ugurkocde/intunedevicequery": {
			defaultDialect: "intune-device-query",
		},
		"davidalonsod/dalonso-security-repo": {
			defaultDialect: "sentinel",
		},
		"bert-janp/hunting-queries-detection-rules": {
			defaultDialect: "defender-xdr",
			pathDialects: [
				{ prefix: "Sentinel", dialect: "sentinel" },
				{ prefix: "Data Lake", dialect: "sentinel" },
				{
					prefix: "Azure Resource Graph",
					dialect: "azure-resource-graph",
				},
			],
		},
		"slimkql/hunting-queries-detection-rules": {
			defaultDialect: "defender-xdr",
			pathDialects: [
				{ prefix: "Sentinel", dialect: "sentinel" },
				{ prefix: "ADX", dialect: "azure-data-explorer" },
				{
					prefix: "Azure Resource Graph",
					dialect: "azure-resource-graph",
				},
			],
		},
		"ep3p/sentinel_kql": {
			defaultDialect: "sentinel",
			pathDialects: [
				{
					prefix: "Queries/Azure Resource Graph",
					dialect: "azure-resource-graph",
				},
			],
		},
		"natehutch365/kql": {
			defaultDialect: "defender-xdr",
			pathDialects: [
				{
					prefix: "Log Analytics and Sentinel",
					dialect: "sentinel",
				},
			],
		},
		"jkerai1/kql-queries": {
			defaultDialect: "sentinel",
			pathDialects: [
				{ prefix: "Defender", dialect: "defender-xdr" },
				{
					prefix: "Azure Resource Graph",
					dialect: "azure-resource-graph",
				},
			],
		},
		"reprise99/sentinel-queries": {
			defaultDialect: "sentinel",
			pathDialects: [
				{
					prefix: "Defender for Endpoint",
					dialect: "defender-xdr",
				},
				{
					prefix: "Azure Resource Graph",
					dialect: "azure-resource-graph",
				},
			],
		},
		"alexverboon/hunting-queries-detection-rules": {
			defaultDialect: "defender-xdr",
			pathDialects: [
				{ prefix: "Sentinel", dialect: "sentinel" },
				{
					prefix: "Azure Resource Graph",
					dialect: "azure-resource-graph",
				},
			],
		},
		"cyb3rmik3/kql-threat-hunting-queries": {
			defaultDialect: "defender-xdr",
			pathDialects: [
				{ prefix: "Sentinel", dialect: "sentinel" },
				{
					prefix:
						"Learning/visualizing-fortigate-cve-2022-40684-belsen-group-leaked-affected-ips.md",
					dialect: "azure-data-explorer",
				},
				{
					prefix: "Azure Resource Graph",
					dialect: "azure-resource-graph",
				},
			],
		},
		"lawndoc/advancedhuntingqueries": {
			defaultDialect: "defender-xdr",
		},
		"thomaskur/sentinel-and-defenderxdr": {
			defaultDialect: "defender-xdr",
		},
		"kustoking/hunting-queries-detection-rules": {
			defaultDialect: "sentinel",
			pathDialects: [
				{
					prefix: "Microsoft 365 Defender For Office 365",
					dialect: "defender-xdr",
				},
			],
		},
	} satisfies Record<string, RepositoryDialectConfig>),
);

interface ManifestRepository {
	repository: string;
	defaultBranch: string;
	licenseSpdx: ApprovedIngestionLicense;
	sourcePaths: Set<string>;
}

interface ImportResult {
	repository: string;
	commitSha: string;
	licenseSpdx: string;
	manifestPaths: number;
	candidateFiles: number;
	acceptedQueries: number;
	insertedVersions: number;
	unchangedVersions: number;
	skipped: Record<string, number>;
}

async function main(): Promise<void> {
	const options = parseArguments(process.argv.slice(2));
	const manifestPath =
		options.manifest ?? (await findDefaultManifest());
	const databasePath =
		options.database ?? (await findLocalDatabase());
	const repositories = await readManifest(manifestPath);
	const selected = options.repository
		? repositories.filter(
				(item) =>
					item.repository.toLocaleLowerCase("en-US") ===
					options.repository?.toLocaleLowerCase("en-US"),
			)
		: repositories;

	if (selected.length === 0) {
		throw new Error(
			options.repository
				? `No eligible manifest rows found for ${options.repository}.`
				: "The manifest contains no eligible repositories.",
		);
	}
	for (const repository of selected) {
		if (!DIALECT_CONFIG.has(repository.repository.toLocaleLowerCase("en-US"))) {
			throw new Error(
				`No reviewed dialect mapping exists for ${repository.repository}.`,
			);
		}
	}

	console.log(`Manifest: ${manifestPath}`);
	console.log(`Local D1: ${databasePath}`);
	console.log(
		`Eligible sources: ${selected.length} repositories, ${selected.reduce(
			(total, item) => total + item.sourcePaths.size,
			0,
		)} unique paths`,
	);

	const database = new LocalD1Database(databasePath);
	const store = new D1IngestionStore(
		database as unknown as D1IngestionClient,
	);
	const api = new GithubHttpClient({
		token: process.env.GITHUB_INGESTION_TOKEN,
	});
	const temporaryRoot = await mkdtemp(
		join(tmpdir(), "kqlbook-manifest-import-"),
	);
	const imported: ImportResult[] = [];
	const failures: Array<{ repository: string; message: string }> = [];

	try {
		await assertDatabaseSchema(database);
		for (const [index, manifest] of selected.entries()) {
			const config = DIALECT_CONFIG.get(
				manifest.repository.toLocaleLowerCase("en-US"),
			);
			if (!config) {
				throw new Error(`Missing dialect mapping for ${manifest.repository}.`);
			}
			const clonePath = join(temporaryRoot, `repository-${index + 1}`);
			console.log(
				`[${index + 1}/${selected.length}] ${manifest.repository}: checking license and cloning ${manifest.sourcePaths.size} paths`,
			);

			try {
				const repository = await api.getRepository(manifest.repository);
				const approvedSpdx = assertApprovedRepositoryLicense(repository);
				if (approvedSpdx !== manifest.licenseSpdx) {
					throw new Error(
						`License changed from ${manifest.licenseSpdx} to ${approvedSpdx}.`,
					);
				}
				if (repository.defaultBranch !== manifest.defaultBranch) {
					throw new Error(
						`Default branch changed from ${manifest.defaultBranch} to ${repository.defaultBranch}.`,
					);
				}

				await cloneGithubRepository(repository, clonePath);
				const source = new LocalGitGithubSource(api, repository, clonePath);
				const pipeline = new GithubIngestionPipeline({
					github: source,
					store,
				});
				const result = await pipeline.ingest({
					repository: manifest.repository,
					defaultDialect: config.defaultDialect,
					pathDialects: config.pathDialects,
					sourcePaths: [...manifest.sourcePaths],
					trusted: false,
				});
				const skipped = countSkips(result.skipped.map((item) => item.code));
				if (options.showSkips) {
					for (const item of result.skipped) {
						console.log(`  skip ${item.code}: ${item.path}`);
					}
				}
				imported.push({
					repository: result.repository,
					commitSha: result.commitSha,
					licenseSpdx: result.licenseSpdx,
					manifestPaths: manifest.sourcePaths.size,
					candidateFiles: result.candidateFiles,
					acceptedQueries: result.acceptedQueries,
					insertedVersions: result.write.inserted,
					unchangedVersions: result.write.unchanged,
					skipped,
				});
				console.log(
					`  accepted ${result.acceptedQueries}; inserted ${result.write.inserted}; unchanged ${result.write.unchanged}; skipped ${result.skipped.length}`,
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				failures.push({ repository: manifest.repository, message });
				console.error(`  failed: ${message}`);
			} finally {
				await rm(clonePath, { recursive: true, force: true });
			}
		}

		const totals = await readDatabaseTotals(database);
		console.log(
			JSON.stringify(
				{
					manifest: basename(manifestPath),
					imported,
					failures,
					database: totals,
				},
				null,
				2,
			),
		);

		if (failures.length > 0) {
			process.exitCode = 1;
		}
	} finally {
		database.close();
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

function parseArguments(args: readonly string[]): {
	manifest?: string;
	database?: string;
	repository?: string;
	showSkips: boolean;
} {
	const result: {
		manifest?: string;
		database?: string;
		repository?: string;
		showSkips: boolean;
	} = { showSkips: false };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		const [name, inlineValue] = argument.split("=", 2);
		if (name === "--show-skips") {
			if (inlineValue) {
				throw new Error("--show-skips does not accept a value.");
			}
			result.showSkips = true;
			continue;
		}
		const value = inlineValue ?? args[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`Missing value for ${name}.`);
		}
		if (!inlineValue) {
			index += 1;
		}
		switch (name) {
			case "--manifest":
				result.manifest = resolve(value);
				break;
			case "--database":
				result.database = resolve(value);
				break;
			case "--repository":
				result.repository = value;
				break;
			default:
				throw new Error(`Unknown argument: ${name}`);
		}
	}
	return result;
}

async function findDefaultManifest(): Promise<string> {
	const parent = resolve(process.cwd(), "..");
	const candidates = (await readdir(parent))
		.filter((name) => /^kqlsearch_queries_metadata_\d{4}-\d{2}-\d{2}\.csv$/.test(name))
		.sort()
		.reverse();
	if (!candidates[0]) {
		throw new Error("No kqlsearch query manifest CSV was found.");
	}
	return join(parent, candidates[0]);
}

async function findLocalDatabase(): Promise<string> {
	const directory = resolve(
		process.cwd(),
		".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
	);
	const candidates = [];
	for (const name of await readdir(directory)) {
		if (!name.endsWith(".sqlite") || name === "metadata.sqlite") {
			continue;
		}
		const path = join(directory, name);
		if ((await stat(path)).isFile()) {
			candidates.push(path);
		}
	}
	if (candidates.length !== 1) {
		throw new Error(
			`Expected one local D1 database in ${directory}; found ${candidates.length}. Use --database.`,
		);
	}
	return candidates[0];
}

async function readManifest(path: string): Promise<ManifestRepository[]> {
	const rows = parseCsv(await readFile(path, "utf8"));
	const header = rows.shift();
	if (!header) {
		throw new Error("The manifest CSV is empty.");
	}
	const columns = new Map(header.map((name, index) => [name, index]));
	const required = [
		"upstream_source_url",
		"upstream_repository",
		"repository_default_branch",
		"repository_license_spdx",
		"ingestion_license_status",
	];
	for (const column of required) {
		if (!columns.has(column)) {
			throw new Error(`The manifest is missing column ${column}.`);
		}
	}

	const groups = new Map<string, ManifestRepository>();
	for (const row of rows) {
		if (
			value(row, columns, "ingestion_license_status") !==
			ELIGIBLE_STATUS
		) {
			continue;
		}
		const repository = value(row, columns, "upstream_repository");
		const defaultBranch = value(
			row,
			columns,
			"repository_default_branch",
		);
		const licenseSpdx = value(
			row,
			columns,
			"repository_license_spdx",
		) as ApprovedIngestionLicense;
		const sourcePath = parseGithubSourcePath(
			value(row, columns, "upstream_source_url"),
			repository,
			defaultBranch,
		);
		const key = repository.toLocaleLowerCase("en-US");
		const existing = groups.get(key);
		if (existing) {
			if (
				existing.defaultBranch !== defaultBranch ||
				existing.licenseSpdx !== licenseSpdx
			) {
				throw new Error(
					`Manifest metadata is inconsistent for ${repository}.`,
				);
			}
			existing.sourcePaths.add(sourcePath);
		} else {
			groups.set(key, {
				repository,
				defaultBranch,
				licenseSpdx,
				sourcePaths: new Set([sourcePath]),
			});
		}
	}
	return [...groups.values()].sort((left, right) =>
		left.repository.localeCompare(right.repository),
	);
}

function parseGithubSourcePath(
	sourceUrl: string,
	repository: string,
	branch: string,
): string {
	const url = new URL(sourceUrl);
	if (url.protocol !== "https:" || url.hostname !== "github.com") {
		throw new Error(`Unsupported source URL: ${sourceUrl}`);
	}
	const segments = url.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => decodeURIComponent(segment));
	const [owner, name, marker, ...remainder] = segments;
	const expected = repository.split("/");
	if (
		marker !== "blob" ||
		owner.toLocaleLowerCase("en-US") !==
			expected[0].toLocaleLowerCase("en-US") ||
		name.toLocaleLowerCase("en-US") !==
			expected[1].toLocaleLowerCase("en-US")
	) {
		throw new Error(`Source URL does not match ${repository}: ${sourceUrl}`);
	}
	const branchSegments = branch.split("/");
	if (
		branchSegments.some(
			(segment, index) => remainder[index] !== segment,
		)
	) {
		throw new Error(`Source URL does not use branch ${branch}: ${sourceUrl}`);
	}
	const path = remainder.slice(branchSegments.length).join("/");
	if (!path) {
		throw new Error(`Source URL has no repository path: ${sourceUrl}`);
	}
	return path;
}

function parseCsv(input: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;

	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		if (quoted) {
			if (character === '"' && input[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (character === '"') {
				quoted = false;
			} else {
				field += character;
			}
		} else if (character === '"') {
			quoted = true;
		} else if (character === ",") {
			row.push(field);
			field = "";
		} else if (character === "\n") {
			row.push(field.replace(/\r$/, ""));
			rows.push(row);
			row = [];
			field = "";
		} else {
			field += character;
		}
	}
	if (quoted) {
		throw new Error("The manifest CSV has an unterminated quoted field.");
	}
	if (field || row.length > 0) {
		row.push(field.replace(/\r$/, ""));
		rows.push(row);
	}
	return rows;
}

function value(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
	column: string,
): string {
	const index = columns.get(column);
	const result = index === undefined ? "" : row[index];
	if (!result) {
		throw new Error(`An eligible manifest row has no ${column}.`);
	}
	return result;
}

function countSkips(codes: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const code of codes) {
		counts[code] = (counts[code] ?? 0) + 1;
	}
	return counts;
}

async function assertDatabaseSchema(database: LocalD1Database): Promise<void> {
	const row = await database
		.prepare(
			`SELECT count(*) AS count
			FROM sqlite_master
			WHERE type IN ('table', 'view')
				AND name IN (
					'queries', 'query_versions', 'query_provenance',
					'source_repositories', 'licenses', 'query_search',
					'embedding_outbox'
				)`,
		)
		.first<{ count: number }>();
	if (Number(row?.count ?? 0) !== 7) {
		throw new Error(
			"The local D1 database is missing required ingestion tables. Run the local migrations first.",
		);
	}
}

async function readDatabaseTotals(
	database: LocalD1Database,
): Promise<Record<string, number>> {
	const row = await database
		.prepare(
			`SELECT
				(SELECT count(*) FROM queries) AS queries,
				(SELECT count(*) FROM query_versions) AS versions,
				(SELECT count(*) FROM source_repositories) AS sources,
				(SELECT count(*) FROM source_repositories WHERE provider = 'github') AS github_sources,
				(SELECT count(*) FROM query_provenance) AS provenance,
				(SELECT count(*) FROM query_search) AS fts,
				(SELECT count(*) FROM embedding_outbox) AS outbox`,
		)
		.first<Record<string, number>>();
	if (!row) {
		throw new Error("Could not read local D1 totals.");
	}
	return Object.fromEntries(
		Object.entries(row).map(([key, amount]) => [key, Number(amount)]),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 1;
});
