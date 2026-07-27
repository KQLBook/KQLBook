import type {
	KqlDialect,
	QueryVisibility,
	RetrievalMode,
	SearchProvenance,
} from "../search/types";

export type ModerationStatus = "visible" | "unpublished" | "removed";

export interface QueryVersion {
	id: string;
	queryId: string;
	versionNumber: number;
	title: string;
	kql: string;
	description: string;
	explanation: string;
	dialect: KqlDialect;
	tables: string[];
	operators: string[];
	tags: string[];
	assumptions: string[];
	validationWarnings: string[];
	aiGenerated: boolean;
	generationModel: string | null;
	contentHash: string;
	createdByUserId: string | null;
	createdAt: string;
}

export interface QueryProvenance extends SearchProvenance {
	sourceRepositoryId: string;
	sourcePath: string;
	commitSha: string;
	originalAuthor: string;
	requiredNotice: string;
}

export interface QueryRecord {
	id: string;
	ownerId: string | null;
	visibility: QueryVisibility;
	moderationStatus: ModerationStatus;
	currentVersionId: string;
	starCount: number;
	sourceRepository: string | null;
	sourceRepositoryUrl: string | null;
	starredByViewer: boolean;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	currentVersion: QueryVersion;
	provenance: QueryProvenance | null;
}

export interface QueryListItem {
	id: string;
	ownerId: string | null;
	visibility: QueryVisibility;
	moderationStatus: ModerationStatus;
	currentVersionId: string;
	title: string;
	description: string;
	dialect: KqlDialect;
	tables: string[];
	tags: string[];
	starCount: number;
	sourceRepository: string | null;
	sourceRepositoryUrl: string | null;
	starredByViewer: boolean;
	updatedAt: string;
	provenance: SearchProvenance | null;
}

export interface CursorPage<T> {
	items: T[];
	nextCursor?: string;
}

export interface ListOptions {
	cursor?: string;
	limit?: number;
}

export interface ListOwnedQueryOptions extends ListOptions {
	visibility?: QueryVisibility;
}

export interface CreateQueryInput {
	ownerId: string;
	title: string;
	kql: string;
	description?: string;
	explanation?: string;
	dialect: KqlDialect;
	visibility?: QueryVisibility;
	tables?: string[];
	operators?: string[];
	tags?: string[];
	assumptions?: string[];
	validationWarnings?: string[];
	aiGenerated?: boolean;
	generationModel?: string | null;
}

export type UpdateQueryInput = Partial<
	Pick<
		CreateQueryInput,
		| "title"
		| "kql"
		| "description"
		| "explanation"
		| "dialect"
		| "tables"
		| "operators"
		| "tags"
		| "assumptions"
		| "validationWarnings"
	>
>;

export type ReportReason =
	| "spam"
	| "malicious-content"
	| "copyright"
	| "exposed-secret"
	| "other";

export interface CreateReportInput {
	queryId: string;
	reporterId: string;
	reason: ReportReason;
	details?: string;
}

export interface QueryReport {
	id: string;
	queryId: string;
	reporterId: string;
	reason: ReportReason;
	details: string;
	status: "open" | "reviewed" | "dismissed" | "actioned";
	createdAt: string;
}

export interface StarRecord {
	queryId: string;
	userId: string;
	createdAt: string;
	starCount: number;
}

export interface RecordSearchHistoryInput {
	userId: string;
	rawRequest: string;
	normalizedRequest: string;
	filters: Record<string, unknown>;
	retrievalMode: RetrievalMode | "generated";
	resultCount: number;
}

export interface SearchHistoryRecord {
	id: string;
	rawRequest: string;
	normalizedRequest: string;
	filters: Record<string, unknown>;
	retrievalMode: RetrievalMode | "generated";
	resultCount: number;
	clickedQueryId: string | null;
	createdAt: string;
}

export interface AdminUnpublishInput {
	queryId: string;
	adminId: string;
	reason?: string;
}

export type EmbeddingOutboxOperation = "upsert" | "delete";
export type EmbeddingNamespaceKind = "public" | "private";

export interface EmbeddingOutboxItem {
	id: string;
	queryId: string;
	versionId: string | null;
	operation: EmbeddingOutboxOperation;
	namespaceKind: EmbeddingNamespaceKind;
	ownerId: string | null;
	attempts: number;
	lockedBy: string;
	createdAt: string;
}

export interface EmbeddingDocumentRecord {
	queryId: string;
	versionId: string;
	ownerId: string | null;
	visibility: QueryVisibility;
	title: string;
	kql: string;
	description: string;
	explanation: string;
	dialect: KqlDialect;
	tables: string[];
	operators: string[];
	tags: string[];
}
