import { describe, expect, it, vi } from "vitest";

import { GithubIngestionPipeline } from "../../src/lib/ingest/pipeline";
import type {
	GithubSourcePort,
	IngestionStorePort,
	RepositoryIngestionBatch,
} from "../../src/lib/ingest/types";

const sha = "1".repeat(40);

function github(
	licenseSpdx = "MIT",
	kql = "DeviceProcessEvents\r\n| where FileName == \"powershell.exe\"\r\n",
	commitSha = sha,
): GithubSourcePort {
	const blobs: Record<string, string> = {
		kql,
		md: "# Risk events\n\n```kql\nAADUserRiskEvents\n| take 10\n```\n",
		yaml: `id: rule-one
name: Sign-in failure rule
severity: Medium
query: |
  SigninLogs
  | where ResultType != 0
`,
		notice: "Copyright Example Contributors",
	};
	return {
		getRepository: vi.fn().mockResolvedValue({
			fullName: "example/kql",
			owner: "example",
			name: "kql",
			defaultBranch: "main",
			htmlUrl: "https://github.com/example/kql",
			license: {
				spdxId: licenseSpdx,
				name: licenseSpdx,
				apiUrl: "https://api.github.com/licenses/example",
			},
		}),
		getLicenseFile: vi.fn().mockResolvedValue({
			spdxId: licenseSpdx,
			name: licenseSpdx,
			path: "LICENSE",
			htmlUrl: "https://github.com/example/kql/blob/main/LICENSE",
			text: "Copyright Example\nPermission is granted.",
		}),
		resolveCommit: vi.fn().mockResolvedValue({
			sha: commitSha,
			author: "Repository Maintainer",
		}),
		listTree: vi.fn().mockResolvedValue([
			{ path: "Defender/process.kql", sha: "kql", type: "blob", size: 75 },
			{ path: "docs/risk.md", sha: "md", type: "blob", size: 70 },
			{ path: "rules/signin.yaml", sha: "yaml", type: "blob", size: 130 },
			{ path: "notes/query.txt", sha: "txt", type: "blob", size: 40 },
			{ path: "NOTICE", sha: "notice", type: "blob", size: 30 },
		]),
		getBlobText: vi.fn(
			async (_repository: string, blobSha: string) => blobs[blobSha] ?? "",
		),
		getPathAuthor: vi.fn().mockResolvedValue("File Author"),
	};
}

function store(): IngestionStorePort & {
	writeBatch: ReturnType<typeof vi.fn>;
} {
	return {
		writeBatch: vi.fn().mockImplementation(async (batch) => ({
			inserted: batch.queries.length,
			unchanged: 0,
		})),
	};
}

describe("GitHub ingestion pipeline", () => {
	it("rejects a disallowed repository before fetching content or writing", async () => {
		const source = github("GPL-3.0");
		const destination = store();

		await expect(
			new GithubIngestionPipeline({
				github: source,
				store: destination,
			}).ingest({
				repository: "example/kql",
				defaultDialect: "sentinel",
			}),
		).rejects.toMatchObject({
			code: "LICENSE_DISALLOWED",
		});

		expect(source.resolveCommit).not.toHaveBeenCalled();
		expect(source.listTree).not.toHaveBeenCalled();
		expect(source.getBlobText).not.toHaveBeenCalled();
		expect(destination.writeBatch).not.toHaveBeenCalled();
	});

	it("parses approved source shapes and writes complete immutable provenance", async () => {
		const source = github();
		const destination = store();
		const pipeline = new GithubIngestionPipeline({
			github: source,
			store: destination,
		});

		const result = await pipeline.ingest({
			repository: "example/kql",
			defaultDialect: "sentinel",
			pathDialects: [{ prefix: "Defender", dialect: "defender-xdr" }],
			trusted: true,
		});

		expect(result).toMatchObject({
			repository: "example/kql",
			commitSha: sha,
			licenseSpdx: "MIT",
			discoveredFiles: 5,
			candidateFiles: 3,
			acceptedQueries: 3,
			write: { inserted: 3, unchanged: 0 },
		});

		const batch = destination.writeBatch.mock.calls[0][0];
		expect(batch.repository).toMatchObject({
			fullName: "example/kql",
			trusted: true,
		});
		expect(batch.license.requiredNotice).toContain("Example Contributors");
		expect(batch.queries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: "process",
					dialect: "defender-xdr",
					source: expect.objectContaining({
						path: "Defender/process.kql",
						commitSha: sha,
						originalAuthor: "File Author",
						sourceUrl: `https://github.com/example/kql/blob/${sha}/Defender/process.kql`,
					}),
				}),
				expect.objectContaining({
					title: "Sign-in failure rule",
					dialect: "sentinel",
					source: expect.objectContaining({
						path: "rules/signin.yaml",
					}),
				}),
			]),
		);
		for (const query of batch.queries) {
			expect(query.dedupeKey).toMatch(/^[0-9a-f]{64}$/);
			expect(query.contentHash).toMatch(/^[0-9a-f]{64}$/);
			expect(query.license.spdxId).toBe("MIT");
			expect(query.description).not.toBe("");
			expect(query.explanation).toBe(query.description);
			expect(query.tags.length).toBeGreaterThan(0);
		}
	});

	it("cleans an Intune prose wrapper and enriches its metadata", async () => {
		const source = github(
			"MIT",
			`Use Case: Monitoring application hang events in Windows systems over the past 7 days.

Query:

WindowsEvent('Application', 7d)
| where tostring(EventId) == '1002'`,
		);
		const destination = store();

		await new GithubIngestionPipeline({
			github: source,
			store: destination,
		}).ingest({
			repository: "example/kql",
			defaultDialect: "intune-device-query",
			sourcePaths: ["Defender/process.kql"],
		});

		const query = destination.writeBatch.mock.calls[0][0].queries[0];
		expect(query).toMatchObject({
			kql:
				"WindowsEvent('Application', 7d)\n| where tostring(EventId) == '1002'",
			description:
				"Monitoring application hang events in Windows systems over the past 7 days.",
			tables: ["WindowsEvent"],
			tags: expect.arrayContaining([
				"intune",
				"windows-event",
				"application-hang",
				"event-id-1002",
			]),
		});
	});

	it("limits ingestion to exact manifest paths and reports missing paths", async () => {
		const source = github();
		const destination = store();
		const result = await new GithubIngestionPipeline({
			github: source,
			store: destination,
		}).ingest({
			repository: "example/kql",
			defaultDialect: "sentinel",
			sourcePaths: [
				"Defender/process.kql",
				"missing/query.kql",
				"notes/query.txt",
			],
		});

		expect(result.candidateFiles).toBe(1);
		expect(result.acceptedQueries).toBe(1);
		expect(result.skipped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "missing/query.kql",
					code: "source-not-found",
				}),
				expect.objectContaining({
					path: "notes/query.txt",
					code: "unsupported-file",
				}),
			]),
		);
		const batch = destination.writeBatch.mock.calls[0][0];
		expect(batch.queries).toHaveLength(1);
		expect(batch.queries[0]).toMatchObject({
			tables: ["DeviceProcessEvents"],
			operators: ["where"],
		});
		expect(batch.emptySourcePaths).toEqual([]);
	});

	it("marks an inspected path with no KQL for reconciliation but preserves missing paths", async () => {
		const source = github(
			"MIT",
			'{"version":"Notebook/1.0","items":[{"type":"KqlItem"}]}',
		);
		const destination = store();

		const result = await new GithubIngestionPipeline({
			github: source,
			store: destination,
		}).ingest({
			repository: "example/kql",
			defaultDialect: "sentinel",
			sourcePaths: [
				"Defender/process.kql",
				"missing/query.kql",
			],
		});

		expect(result.acceptedQueries).toBe(0);
		expect(result.skipped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "Defender/process.kql",
					code: "no-kql-found",
				}),
				expect.objectContaining({
					path: "missing/query.kql",
					code: "source-not-found",
				}),
			]),
		);
		const batch = destination.writeBatch.mock.calls[0][0];
		expect(batch.emptySourcePaths).toEqual(["Defender/process.kql"]);
	});

	it("does not reconcile a multi-block document when any block is accepted", async () => {
		const source = github(
			"MIT",
			`# Mixed examples

\`\`\`json
{"query":"documentation only"}
\`\`\`

\`\`\`kql
DeviceEvents
| take 10
\`\`\`
`,
		);
		const destination = store();

		await new GithubIngestionPipeline({
			github: source,
			store: destination,
		}).ingest({
			repository: "example/kql",
			defaultDialect: "defender-xdr",
			sourcePaths: ["Defender/process.kql"],
		});

		const batch = destination.writeBatch.mock.calls[0][0];
		expect(batch.queries).toHaveLength(1);
		expect(batch.emptySourcePaths).toEqual([]);
	});

	it("disambiguates repeated titles within one source and dialect", async () => {
		const source = github();
		vi.mocked(source.getBlobText).mockImplementation(
			async (_repository: string, blobSha: string) => {
				if (blobSha === "md") {
					return `# Device audit

## Defender XDR

\`\`\`kql
CloudAppEvents
| where ActionType == "DownloadFile"
\`\`\`

## Microsoft Defender

\`\`\`kql
CloudAppEvents
| where ActionType == "IsolateDevice"
\`\`\`
`;
				}
				if (blobSha === "notice") {
					return "Notice";
				}
				return "";
			},
		);
		const destination = store();

		await new GithubIngestionPipeline({
			github: source,
			store: destination,
		}).ingest({
			repository: "example/kql",
			defaultDialect: "defender-xdr",
			sourcePaths: ["docs/risk.md"],
		});

		const titles = destination.writeBatch.mock.calls[0][0].queries.map(
			(query: { title: string }) => query.title,
		);
		expect(titles).toEqual([
			"risk - Defender XDR",
			"risk: Find Isolate Device events - Part 2 - Defender XDR",
		]);
	});

	it("disambiguates repeated titles across files in one repository", async () => {
		const source = github();
		vi.mocked(source.listTree).mockResolvedValue([
			{ path: "one.md", sha: "one", type: "blob", size: 100 },
			{ path: "two.md", sha: "two", type: "blob", size: 100 },
			{ path: "NOTICE", sha: "notice", type: "blob", size: 30 },
		]);
		vi.mocked(source.getBlobText).mockImplementation(
			async (_repository: string, blobSha: string) => {
				if (blobSha === "one") {
					return `# Audit device actions

\`\`\`kql
CloudAppEvents
| where ActionType == "DownloadFile"
\`\`\`
`;
				}
				if (blobSha === "two") {
					return `# Audit device actions

\`\`\`kql
CloudAppEvents
| where ActionType == "IsolateDevice"
\`\`\`
`;
				}
				if (blobSha === "notice") {
					return "Notice";
				}
				return "";
			},
		);
		const destination = store();

		await new GithubIngestionPipeline({
			github: source,
			store: destination,
		}).ingest({
			repository: "example/kql",
			defaultDialect: "defender-xdr",
		});

		const titles = destination.writeBatch.mock.calls[0][0].queries.map(
			(query: { title: string }) => query.title,
		);
		expect(titles).toEqual([
			"Audit device actions",
			"Audit device actions: Find Isolate Device events - Part 1",
		]);
	});

	it("skips a file whose SPDX header conflicts with the repository", async () => {
		const source = github();
		vi.mocked(source.getBlobText).mockImplementation(
			async (_repository: string, blobSha: string) => {
				if (blobSha === "kql") {
					return "// SPDX-License-Identifier: GPL-3.0\nDeviceEvents | take 10";
				}
				if (blobSha === "notice") {
					return "Notice";
				}
				return "not a supported query";
			},
		);
		const destination = store();

		const result = await new GithubIngestionPipeline({
			github: source,
			store: destination,
		}).ingest({
			repository: "example/kql",
			defaultDialect: "sentinel",
		});

		expect(result.skipped).toContainEqual(
			expect.objectContaining({
				path: "Defender/process.kql",
				code: "file-license-mismatch",
			}),
		);
	});

	it("keeps imported query identity stable when later source content changes", async () => {
		const firstDestination = store();
		const secondDestination = store();
		const firstPipeline = new GithubIngestionPipeline({
			github: github(),
			store: firstDestination,
		});
		const secondPipeline = new GithubIngestionPipeline({
			github: github(
				"MIT",
				`DeviceProcessEvents
| where FileName == "powershell.exe"
| take 100
`,
				"2".repeat(40),
			),
			store: secondDestination,
		});

		await firstPipeline.ingest({
			repository: "example/kql",
			defaultDialect: "defender-xdr",
		});
		await secondPipeline.ingest({
			repository: "example/kql",
			defaultDialect: "defender-xdr",
		});

		const firstBatch = firstDestination.writeBatch.mock
			.calls[0][0] as RepositoryIngestionBatch;
		const secondBatch = secondDestination.writeBatch.mock
			.calls[0][0] as RepositoryIngestionBatch;
		const firstQuery = firstBatch.queries.find(
			(query) => query.source.path === "Defender/process.kql",
		);
		const secondQuery = secondBatch.queries.find(
			(query) => query.source.path === "Defender/process.kql",
		);

		expect(firstQuery?.id).toBe(secondQuery?.id);
		expect(firstQuery?.dedupeKey).not.toBe(secondQuery?.dedupeKey);
		expect(firstQuery?.contentHash).not.toBe(secondQuery?.contentHash);
	});
});
