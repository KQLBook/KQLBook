import type { KqlDialect } from "../search/types";

export const APPROVED_INGESTION_LICENSES = [
	"MIT",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"Apache-2.0",
	"ISC",
	"Unlicense",
	"CC0-1.0",
] as const;

export type ApprovedIngestionLicense =
	(typeof APPROVED_INGESTION_LICENSES)[number];

export type GithubTreeEntryType = "blob" | "tree" | "commit";

export interface GithubRepository {
	fullName: string;
	owner: string;
	name: string;
	defaultBranch: string;
	htmlUrl: string;
	license: {
		spdxId: string;
		name: string;
		apiUrl: string | null;
	} | null;
}

export interface GithubLicenseFile {
	spdxId: string;
	name: string;
	path: string;
	htmlUrl: string;
	text: string;
}

export interface GithubCommit {
	sha: string;
	author: string | null;
}

export interface GithubTreeEntry {
	path: string;
	sha: string;
	type: GithubTreeEntryType;
	size?: number;
}

export interface GithubSourcePort {
	getRepository(repository: string, signal?: AbortSignal): Promise<GithubRepository>;
	getLicenseFile(
		repository: string,
		ref: string,
		signal?: AbortSignal,
	): Promise<GithubLicenseFile>;
	resolveCommit(
		repository: string,
		ref: string,
		signal?: AbortSignal,
	): Promise<GithubCommit>;
	listTree(
		repository: string,
		commitSha: string,
		signal?: AbortSignal,
	): Promise<GithubTreeEntry[]>;
	getBlobText(
		repository: string,
		blobSha: string,
		signal?: AbortSignal,
	): Promise<string>;
	getPathAuthor(
		repository: string,
		path: string,
		commitSha: string,
		signal?: AbortSignal,
	): Promise<string | null>;
}

export interface PathDialectRule {
	/**
	 * A repository-relative path prefix. Matching is case-insensitive and the
	 * longest matching prefix wins.
	 */
	prefix: string;
	dialect: KqlDialect;
}

export interface RepositoryIngestionRequest {
	repository: string;
	ref?: string;
	defaultDialect: KqlDialect;
	pathDialects?: readonly PathDialectRule[];
	/**
	 * Optional exact repository-relative paths. When supplied, the pipeline
	 * imports only these files from the resolved commit.
	 */
	sourcePaths?: readonly string[];
	trusted?: boolean;
	signal?: AbortSignal;
}

export type ExtractionKind = "standalone-kql" | "markdown-fence" | "yaml-rule";

export interface ParsedKqlBlock {
	title: string;
	kql: string;
	description: string;
	author: string | null;
	dialectHint?: KqlDialect;
	blockIndex: number;
	kind: ExtractionKind;
}

export interface IngestionLicense {
	spdxId: ApprovedIngestionLicense;
	name: string;
	licenseUrl: string;
	requiredNotice: string;
}

export interface IngestedQuerySource {
	repository: string;
	path: string;
	commitSha: string;
	blockIndex: number;
	originalAuthor: string;
	sourceUrl: string;
}

export interface IngestedQuery {
	id: string;
	dedupeKey: string;
	sourceIdentity: string;
	title: string;
	kql: string;
	description: string;
	explanation: string;
	dialect: KqlDialect;
	tables: readonly string[];
	operators: readonly string[];
	tags: readonly string[];
	extractionKind: ExtractionKind;
	contentHash: string;
	source: IngestedQuerySource;
	license: IngestionLicense;
}

export interface RepositoryIngestionBatch {
	repository: {
		id: string;
		fullName: string;
		defaultBranch: string;
		sourceUrl: string;
		trusted: boolean;
	};
	commitSha: string;
	license: IngestionLicense;
	queries: IngestedQuery[];
	/**
	 * Source paths whose content was fetched, license-checked, and parsed during
	 * this run. Stores may reconcile obsolete imported blocks for only these
	 * exact paths. Missing, unsafe, oversized, and license-rejected paths are
	 * intentionally excluded.
	 */
	processedSourcePaths: readonly string[];
	/**
	 * Successfully fetched and inspected source paths that produced no accepted
	 * queries. Stores may deactivate prior imports for these exact paths.
	 *
	 * Paths that were missing, too large, unsafe, or otherwise not fully
	 * inspected must not be included.
	 */
	emptySourcePaths: readonly string[];
}

export interface IngestionWriteResult {
	inserted: number;
	unchanged: number;
}

export interface IngestionStorePort {
	writeBatch(
		batch: RepositoryIngestionBatch,
		signal?: AbortSignal,
	): Promise<IngestionWriteResult>;
}

export interface IngestionSkip {
	path: string;
	code:
		| "unsupported-file"
		| "source-not-found"
		| "unsafe-path"
		| "file-too-large"
		| "empty-file"
		| "no-kql-found"
		| "invalid-kql"
		| "file-license-mismatch"
		| "duplicate";
	message: string;
}

export interface RepositoryIngestionResult {
	repository: string;
	commitSha: string;
	licenseSpdx: ApprovedIngestionLicense;
	discoveredFiles: number;
	candidateFiles: number;
	acceptedQueries: number;
	skipped: IngestionSkip[];
	write: IngestionWriteResult;
}
