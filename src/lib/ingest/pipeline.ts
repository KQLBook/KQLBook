import { hashQueryContent } from "../db/helpers";
import type { KqlDialect } from "../search/types";
import { IngestionError } from "./errors";
import {
	disambiguateSourceTitle,
	enrichQueryMetadata,
} from "./enrichment";
import {
	assertApprovedRepositoryLicense,
	assertFileLicenseCompatible,
	buildIngestionLicense,
} from "./license-policy";
import {
	makeDedupeKey,
	makeSourceIdentity,
	normalizeKql,
	stableId,
} from "./normalize";
import {
	applyDialectTableDefaults,
	extractKqlMetadata,
	inferSpecialDialect,
} from "./metadata";
import { candidateFileKind, parseCandidateFile } from "./parsers";
import type {
	GithubTreeEntry,
	IngestedQuery,
	IngestionSkip,
	IngestionStorePort,
	PathDialectRule,
	RepositoryIngestionRequest,
	RepositoryIngestionResult,
	RepositoryIngestionBatch,
	GithubSourcePort,
} from "./types";

const MAX_TREE_ENTRIES = 100_000;
const MAX_CANDIDATE_FILES = 10_000;
const MAX_SOURCE_FILE_BYTES = 1_000_000;

export interface GithubIngestionDependencies {
	github: GithubSourcePort;
	store: IngestionStorePort;
}

export class GithubIngestionPipeline {
	private readonly github: GithubSourcePort;
	private readonly store: IngestionStorePort;

	constructor(dependencies: GithubIngestionDependencies) {
		this.github = dependencies.github;
		this.store = dependencies.store;
	}

	async ingest(
		request: RepositoryIngestionRequest,
	): Promise<RepositoryIngestionResult> {
		const repository = await this.github.getRepository(
			request.repository,
			request.signal,
		);

		// This gate intentionally runs before commit, tree, blob, or history
		// requests so disallowed repositories never become content sources.
		const approvedSpdx = assertApprovedRepositoryLicense(repository);
		const ref = request.ref?.trim() || repository.defaultBranch;
		const commit = await this.github.resolveCommit(
			repository.fullName,
			ref,
			request.signal,
		);
		const licenseFile = await this.github.getLicenseFile(
			repository.fullName,
			commit.sha,
			request.signal,
		);
		licenseFile.htmlUrl = githubBlobUrl(
			repository.fullName,
			commit.sha,
			licenseFile.path,
		);

		const tree = await this.github.listTree(
			repository.fullName,
			commit.sha,
			request.signal,
		);
		if (tree.length > MAX_TREE_ENTRIES) {
			throw new IngestionError(
				"INGESTION_LIMIT_EXCEEDED",
				`${repository.fullName} exceeds the repository tree limit.`,
				{ entries: tree.length, limit: MAX_TREE_ENTRIES },
			);
		}

		const notice = await this.readNotice(
			repository.fullName,
			tree,
			request.signal,
		);
		const license = buildIngestionLicense(repository, licenseFile, notice);
		if (license.spdxId !== approvedSpdx) {
			throw new IngestionError(
				"LICENSE_METADATA_MISMATCH",
				`License changed while inspecting ${repository.fullName}.`,
			);
		}

		const blobEntries = tree.filter((entry) => entry.type === "blob");
		const requestedPaths = requestedPathSet(request.sourcePaths);
		const entriesByPath = new Map(
			blobEntries.map((entry) => [entry.path, entry]),
		);
		const candidateEntries = blobEntries.filter(
			(entry) =>
				Boolean(candidateFileKind(entry.path)) &&
				(!requestedPaths || requestedPaths.has(entry.path)),
		);
		if (candidateEntries.length > MAX_CANDIDATE_FILES) {
			throw new IngestionError(
				"INGESTION_LIMIT_EXCEEDED",
				`${repository.fullName} exceeds the candidate-file limit.`,
				{ files: candidateEntries.length, limit: MAX_CANDIDATE_FILES },
			);
		}

		const skipped: IngestionSkip[] = [];
		if (requestedPaths) {
			for (const path of requestedPaths) {
				if (!isSafeRepositoryPath(path)) {
					skipped.push(
						skip(path, "unsafe-path", "Repository path is unsafe."),
					);
				} else if (!entriesByPath.has(path)) {
					skipped.push(
						skip(
							path,
							"source-not-found",
							"Source path is absent from the resolved commit.",
						),
					);
				} else if (!candidateFileKind(path)) {
					skipped.push(
						skip(
							path,
							"unsupported-file",
							"Source path is not a recognized KQL, YAML, or Markdown file.",
						),
					);
				}
			}
		}
		const queries: IngestedQuery[] = [];
		const processedSourcePaths = new Set<string>();
		const emptySourcePaths = new Set<string>();
		const seen = new Set<string>();
		const usedTitles = new Set<string>();

		for (const entry of candidateEntries) {
			throwIfAborted(request.signal);
			if (!isSafeRepositoryPath(entry.path)) {
				skipped.push(skip(entry.path, "unsafe-path", "Repository path is unsafe."));
				continue;
			}
			if (
				entry.size !== undefined &&
				entry.size > MAX_SOURCE_FILE_BYTES
			) {
				skipped.push(
					skip(
						entry.path,
						"file-too-large",
						`File exceeds ${MAX_SOURCE_FILE_BYTES} bytes.`,
					),
				);
				continue;
			}

			const content = await this.github.getBlobText(
				repository.fullName,
				entry.sha,
				request.signal,
			);
			if (new TextEncoder().encode(content).byteLength > MAX_SOURCE_FILE_BYTES) {
				skipped.push(
					skip(
						entry.path,
						"file-too-large",
						`File exceeds ${MAX_SOURCE_FILE_BYTES} bytes.`,
					),
				);
				continue;
			}
			if (!content.trim()) {
				skipped.push(skip(entry.path, "empty-file", "File is empty."));
				processedSourcePaths.add(entry.path);
				emptySourcePaths.add(entry.path);
				continue;
			}

			try {
				assertFileLicenseCompatible(content, license.spdxId, entry.path);
			} catch (error) {
				if (
					error instanceof IngestionError &&
					error.code === "LICENSE_METADATA_MISMATCH"
				) {
					skipped.push(
						skip(entry.path, "file-license-mismatch", error.message),
					);
					continue;
				}
				throw error;
			}

			processedSourcePaths.add(entry.path);
			const parsed = parseCandidateFile(entry.path, content, {
				allowHeuristicFences: requestedPaths !== null,
			});
			if (parsed.length === 0) {
				skipped.push(
					skip(
						entry.path,
						"no-kql-found",
						"No supported KQL query was found.",
					),
				);
				emptySourcePaths.add(entry.path);
				continue;
			}

			const needsSourceAuthor = parsed.some((block) => !block.author);
			const sourceAuthor = needsSourceAuthor
				? await this.github.getPathAuthor(
						repository.fullName,
						entry.path,
						commit.sha,
						request.signal,
					)
				: null;
			const acceptedBefore = queries.length;

			for (const block of parsed) {
				const kql = normalizeKql(block.kql);
				if (!kql) {
					skipped.push(
						skip(entry.path, "invalid-kql", "Extracted query is empty."),
					);
					continue;
				}

				const extractedMetadata = extractKqlMetadata(kql);
				const dialect = resolveDialect(
					entry.path,
					block.kind === "yaml-rule",
					block.dialectHint,
					request.defaultDialect,
					request.pathDialects ?? [],
					extractedMetadata,
				);
				const metadata = applyDialectTableDefaults(
					extractedMetadata,
					dialect,
				);
				const enriched = enrichQueryMetadata({
					path: entry.path,
					title: block.title,
					kql,
					description: block.description,
					dialect,
					metadata,
				});
				let title = enriched.title;
				let titleKey = title.toLocaleLowerCase("en-US");
				let partNumber = block.blockIndex + 1;
				while (usedTitles.has(titleKey)) {
					title = disambiguateSourceTitle(
						enriched.title,
						kql,
						metadata,
						partNumber,
					);
					titleKey = title.toLocaleLowerCase("en-US");
					partNumber += 1;
				}
				usedTitles.add(titleKey);
				const sourceIdentity = makeSourceIdentity(
					repository.fullName,
					entry.path,
					block.blockIndex,
				);
				const dedupeKey = await makeDedupeKey(
					kql,
					dialect,
					sourceIdentity,
				);
				if (seen.has(dedupeKey)) {
					skipped.push(
						skip(
							entry.path,
							"duplicate",
							"Duplicate normalized query from the same source identity.",
						),
					);
					continue;
				}
				seen.add(dedupeKey);

				queries.push({
					// Keep the query row tied to its upstream location so content
					// changes become immutable versions of the same query.
					id: await stableId(
						"imported_query",
						`${dialect}\u0000${sourceIdentity}`,
					),
					dedupeKey,
					sourceIdentity,
					title,
					kql,
					description: enriched.description,
					explanation: enriched.description,
					dialect,
					tables: metadata.tables,
					operators: metadata.operators,
					tags: enriched.tags,
					extractionKind: block.kind,
					contentHash: await hashQueryContent({
						title,
						kql,
						description: enriched.description,
						explanation: enriched.description,
						dialect,
						tables: metadata.tables,
						operators: metadata.operators,
						tags: enriched.tags,
						assumptions: [],
						validationWarnings: [],
					}),
					source: {
						repository: repository.fullName,
						path: entry.path,
						commitSha: commit.sha,
						blockIndex: block.blockIndex,
						originalAuthor:
							block.author?.trim() ||
							sourceAuthor ||
							commit.author ||
							repository.owner,
						sourceUrl: githubBlobUrl(
							repository.fullName,
							commit.sha,
							entry.path,
						),
					},
					license,
				});
			}
			if (queries.length === acceptedBefore) {
				emptySourcePaths.add(entry.path);
			}
		}

		const batch: RepositoryIngestionBatch = {
			repository: {
				id: await stableId(
					"source_repository",
					repository.fullName.toLocaleLowerCase("en-US"),
				),
				fullName: repository.fullName,
				defaultBranch: repository.defaultBranch,
				sourceUrl: repository.htmlUrl,
				trusted: request.trusted === true,
			},
			commitSha: commit.sha,
			license,
			queries,
			processedSourcePaths: [...processedSourcePaths].sort((left, right) =>
				left.localeCompare(right, "en-US"),
			),
			emptySourcePaths: [...emptySourcePaths].sort((left, right) =>
				left.localeCompare(right, "en-US"),
			),
		};
		const write = await this.store.writeBatch(batch, request.signal);

		return {
			repository: repository.fullName,
			commitSha: commit.sha,
			licenseSpdx: license.spdxId,
			discoveredFiles: blobEntries.length,
			candidateFiles: candidateEntries.length,
			acceptedQueries: queries.length,
			skipped,
			write,
		};
	}

	private async readNotice(
		repository: string,
		tree: readonly GithubTreeEntry[],
		signal?: AbortSignal,
	): Promise<string | null> {
		const entry = tree.find(
			(item) =>
				item.type === "blob" &&
				/^NOTICE(?:\.(?:txt|md))?$/i.test(item.path) &&
				(item.size === undefined || item.size <= MAX_SOURCE_FILE_BYTES),
		);
		return entry
			? this.github.getBlobText(repository, entry.sha, signal)
			: null;
	}
}

function resolveDialect(
	path: string,
	isYamlRule: boolean,
	blockDialectHint: KqlDialect | undefined,
	defaultDialect: KqlDialect,
	rules: readonly PathDialectRule[],
	metadata: ReturnType<typeof extractKqlMetadata>,
): KqlDialect {
	const normalizedPath = path.toLocaleLowerCase("en-US");
	const matching = rules
		.map((rule) => ({
			...rule,
			normalizedPrefix: normalizePrefix(rule.prefix),
		}))
		.filter(
			(rule) =>
				rule.normalizedPrefix &&
				(normalizedPath === rule.normalizedPrefix ||
					normalizedPath.startsWith(`${rule.normalizedPrefix}/`)),
		)
		.sort(
			(left, right) =>
				right.normalizedPrefix.length - left.normalizedPrefix.length,
		);

	if (matching[0]) {
		return matching[0].dialect;
	}
	if (isYamlRule) {
		return "sentinel";
	}
	const inferred = inferSpecialDialect(metadata, defaultDialect);
	if (inferred !== defaultDialect) {
		return inferred;
	}
	return blockDialectHint ?? defaultDialect;
}

function requestedPathSet(
	paths: readonly string[] | undefined,
): ReadonlySet<string> | null {
	if (!paths) {
		return null;
	}
	return new Set(paths.map((path) => path.replace(/\\/g, "/")));
}

function normalizePrefix(value: string): string {
	return value
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.toLocaleLowerCase("en-US");
}

function isSafeRepositoryPath(path: string): boolean {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\u0000")
	) {
		return false;
	}
	const segments = path.split("/");
	return segments.every(
		(segment) => Boolean(segment) && segment !== "." && segment !== "..",
	);
}

function githubBlobUrl(
	repository: string,
	commitSha: string,
	path: string,
): string {
	const encodedPath = path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `https://github.com/${repository}/blob/${commitSha}/${encodedPath}`;
}

function skip(
	path: string,
	code: IngestionSkip["code"],
	message: string,
): IngestionSkip {
	return { path, code, message };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
}
