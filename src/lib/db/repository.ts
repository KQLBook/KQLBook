import type {
	KqlDialect,
	QueryVisibility,
	SearchProvenance,
	SearchRequest,
	SearchResult,
} from "../search/types";
import { assertValidKqlSyntax } from "../kql/syntax-validation";

import {
	asBoolean,
	clampLimit,
	cleanStringList,
	type D1Client,
	hashQueryContent,
	makeListCursor,
	makeRankedListCursor,
	newId,
	parseJsonArray,
	parseJsonObject,
	QUERY_DIALECTS,
	readListCursor,
	readRankedListCursor,
	sqliteErrorMessage,
} from "./helpers";
import { RepositoryError } from "./repository-error";
import type {
	AdminUnpublishInput,
	CreateQueryInput,
	CreateReportInput,
	CursorPage,
	EmbeddingDocumentRecord,
	EmbeddingOutboxItem,
	ListOptions,
	ListOwnedQueryOptions,
	QueryListItem,
	QueryProvenance,
	QueryRecord,
	QueryReport,
	QueryVersion,
	RecordSearchHistoryInput,
	SearchHistoryRecord,
	StarRecord,
	UpdateQueryInput,
} from "./types";
import { findQueryWarnings } from "./validation";

export { RepositoryError, isRepositoryError } from "./repository-error";
export { rebuildQuerySearchIndex } from "./fts";
export type * from "./types";

interface QueryRow {
	id: string;
	owner_id: string | null;
	visibility: QueryVisibility;
	moderation_status: QueryRecord["moderationStatus"];
	current_version_id: string;
	star_count: number;
	starred_by_viewer: number;
	query_created_at: string;
	query_updated_at: string;
	published_at: string | null;
	version_id: string;
	version_number: number;
	title: string;
	kql: string;
	description: string;
	explanation: string;
	dialect: KqlDialect;
	tables_json: string;
	operators_json: string;
	tags_json: string;
	assumptions_json: string;
	validation_warnings_json: string;
	ai_generated: number;
	generation_model: string | null;
	content_hash: string;
	created_by_user_id: string | null;
	version_created_at: string;
	source_repository_id: string | null;
	source_path: string | null;
	commit_sha: string | null;
	original_author: string | null;
	provenance_source_url: string | null;
	required_notice: string | null;
	repository: string | null;
	repository_provider: "github" | "local" | null;
	repository_source_url: string | null;
	license_spdx: string | null;
	trusted: number | null;
}

interface QueryListRow {
	id: string;
	owner_id: string | null;
	visibility: QueryVisibility;
	moderation_status: QueryRecord["moderationStatus"];
	current_version_id: string;
	title: string;
	description: string;
	dialect: KqlDialect;
	tables_json: string;
	tags_json: string;
	star_count: number;
	starred_by_viewer: number;
	updated_at: string;
	repository: string | null;
	repository_provider: "github" | "local" | null;
	repository_source_url: string | null;
	provenance_source_url: string | null;
	license_spdx: string | null;
	trusted: number | null;
}

interface PublicQueryListRow extends QueryListRow {
	kql_preview: string;
}

const QUERY_SELECT = `
SELECT
  q.id,
  q.owner_id,
  q.visibility,
  q.moderation_status,
  q.current_version_id,
  q.star_count,
  CASE
    WHEN ? IS NOT NULL AND EXISTS (
      SELECT 1 FROM stars
      WHERE stars.query_id = q.id AND stars.user_id = ?
    ) THEN 1
    ELSE 0
  END AS starred_by_viewer,
  q.created_at AS query_created_at,
  q.updated_at AS query_updated_at,
  q.published_at,
  v.id AS version_id,
  v.version_number,
  v.title,
  v.kql,
  v.description,
  v.explanation,
  v.dialect,
  v.tables_json,
  v.operators_json,
  v.tags_json,
  v.assumptions_json,
  v.validation_warnings_json,
  v.ai_generated,
  v.generation_model,
  v.content_hash,
  v.created_by_user_id,
  v.created_at AS version_created_at,
  p.source_repository_id,
  p.source_path,
  p.commit_sha,
  p.original_author,
  p.source_url AS provenance_source_url,
  p.required_notice,
  s.repository,
  s.provider AS repository_provider,
  s.source_url AS repository_source_url,
  l.spdx_id AS license_spdx,
  s.trusted
FROM queries AS q
JOIN query_versions AS v ON v.id = q.current_version_id
LEFT JOIN query_provenance AS p ON p.query_id = q.id
LEFT JOIN source_repositories AS s ON s.id = p.source_repository_id
LEFT JOIN licenses AS l ON l.id = p.license_id
`;

const LIST_SELECT = `
SELECT
  q.id,
  q.owner_id,
  q.visibility,
  q.moderation_status,
  q.current_version_id,
  v.title,
  v.description,
  v.dialect,
  v.tables_json,
  v.tags_json,
  q.star_count,
  CASE
    WHEN ? IS NOT NULL AND EXISTS (
      SELECT 1 FROM stars
      WHERE stars.query_id = q.id AND stars.user_id = ?
    ) THEN 1
    ELSE 0
  END AS starred_by_viewer,
  q.updated_at,
  s.repository,
  s.provider AS repository_provider,
  s.source_url AS repository_source_url,
  p.source_url AS provenance_source_url,
  l.spdx_id AS license_spdx,
  s.trusted
FROM queries AS q
JOIN query_versions AS v ON v.id = q.current_version_id
LEFT JOIN query_provenance AS p ON p.query_id = q.id
LEFT JOIN source_repositories AS s ON s.id = p.source_repository_id
LEFT JOIN licenses AS l ON l.id = p.license_id
`;

const PUBLIC_LIST_SELECT = `
SELECT
  q.id,
  q.owner_id,
  q.visibility,
  q.moderation_status,
  q.current_version_id,
  v.title,
  v.description,
  substr(v.kql, 1, 480) AS kql_preview,
  v.dialect,
  v.tables_json,
  v.tags_json,
  q.star_count,
  0 AS starred_by_viewer,
  q.updated_at,
  s.repository,
  s.provider AS repository_provider,
  s.source_url AS repository_source_url,
  p.source_url AS provenance_source_url,
  l.spdx_id AS license_spdx,
  s.trusted
FROM queries AS q
JOIN query_versions AS v ON v.id = q.current_version_id
LEFT JOIN query_provenance AS p ON p.query_id = q.id
LEFT JOIN source_repositories AS s ON s.id = p.source_repository_id
LEFT JOIN licenses AS l ON l.id = p.license_id
`;

function mapProvenance(row: QueryRow): QueryProvenance | null {
	if (
		!row.source_repository_id ||
		!row.source_path ||
		!row.commit_sha ||
		!row.original_author ||
		!row.provenance_source_url ||
		!row.repository ||
		!row.license_spdx
	) {
		return null;
	}

	return {
		sourceName: row.repository,
		sourceUrl: row.provenance_source_url,
		repository: row.repository,
		repositoryUrl: row.repository_source_url ?? undefined,
		provider: row.repository_provider ?? undefined,
		licenseSpdx: row.license_spdx,
		trusted: asBoolean(row.trusted ?? 0),
		sourceRepositoryId: row.source_repository_id,
		sourcePath: row.source_path,
		commitSha: row.commit_sha,
		originalAuthor: row.original_author,
		requiredNotice: row.required_notice ?? "",
	};
}

function mapSearchProvenance(row: QueryListRow): SearchProvenance | null {
	if (!row.repository) {
		return null;
	}

	return {
		sourceName: row.repository,
		sourceUrl: row.provenance_source_url ?? undefined,
		repository: row.repository,
		repositoryUrl: row.repository_source_url ?? undefined,
		provider: row.repository_provider ?? undefined,
		licenseSpdx: row.license_spdx ?? undefined,
		trusted: asBoolean(row.trusted ?? 0),
	};
}

function mapVersion(row: QueryRow): QueryVersion {
	return {
		id: row.version_id,
		queryId: row.id,
		versionNumber: row.version_number,
		title: row.title,
		kql: row.kql,
		description: row.description,
		explanation: row.explanation,
		dialect: row.dialect,
		tables: parseJsonArray(row.tables_json),
		operators: parseJsonArray(row.operators_json),
		tags: parseJsonArray(row.tags_json),
		assumptions: parseJsonArray(row.assumptions_json),
		validationWarnings: parseJsonArray(row.validation_warnings_json),
		aiGenerated: asBoolean(row.ai_generated),
		generationModel: row.generation_model,
		contentHash: row.content_hash,
		createdByUserId: row.created_by_user_id,
		createdAt: row.version_created_at,
	};
}

function mapQuery(row: QueryRow): QueryRecord {
	return {
		id: row.id,
		ownerId: row.owner_id,
		visibility: row.visibility,
		moderationStatus: row.moderation_status,
		currentVersionId: row.current_version_id,
		starCount: row.star_count,
		sourceRepository: row.repository,
		sourceRepositoryUrl: row.repository_source_url,
		starredByViewer: asBoolean(row.starred_by_viewer),
		createdAt: row.query_created_at,
		updatedAt: row.query_updated_at,
		publishedAt: row.published_at,
		currentVersion: mapVersion(row),
		provenance: mapProvenance(row),
	};
}

function mapListItem(row: QueryListRow): QueryListItem {
	return {
		id: row.id,
		ownerId: row.owner_id,
		visibility: row.visibility,
		moderationStatus: row.moderation_status,
		currentVersionId: row.current_version_id,
		title: row.title,
		description: row.description,
		dialect: row.dialect,
		tables: parseJsonArray(row.tables_json),
		tags: parseJsonArray(row.tags_json),
		starCount: row.star_count,
		sourceRepository: row.repository,
		sourceRepositoryUrl: row.repository_source_url,
		starredByViewer: asBoolean(row.starred_by_viewer),
		updatedAt: row.updated_at,
		provenance: mapSearchProvenance(row),
	};
}

function mapPublicListItem(row: PublicQueryListRow): QueryListItem {
	const item = mapListItem(row);
	const kqlPreview = row.kql_preview.replace(/\s+/g, " ").trim();

	return {
		...item,
		description: item.description.trim() || kqlPreview,
	};
}

function assertDialect(value: KqlDialect): void {
	if (!QUERY_DIALECTS.includes(value)) {
		throw new RepositoryError(
			400,
			"INVALID_DIALECT",
			"The selected KQL dialect is not supported.",
		);
	}
}

function requireText(
	value: string,
	field: "title" | "kql",
	maxLength: number,
): string {
	const cleaned = value.trim();
	if (!cleaned || cleaned.length > maxLength) {
		throw new RepositoryError(
			400,
			"INVALID_QUERY",
			`${field} must contain between 1 and ${maxLength} characters.`,
		);
	}
	return cleaned;
}

async function getOwnedQuery(
	db: D1Client,
	id: string,
	ownerId: string,
): Promise<QueryRecord> {
	const row = await db
		.prepare(
			`${QUERY_SELECT}
       WHERE q.id = ?
         AND q.owner_id = ?
         AND q.deleted_at IS NULL`,
		)
		.bind(ownerId, ownerId, id, ownerId)
		.first<QueryRow>();

	if (!row) {
		throw new RepositoryError(
			404,
			"QUERY_NOT_FOUND",
			"The query was not found.",
		);
	}

	return mapQuery(row);
}

export async function getQueryById(
	db: D1Client,
	id: string,
	viewerId: string | null,
): Promise<QueryRecord> {
	const row = await db
		.prepare(
			`${QUERY_SELECT}
       WHERE q.id = ?
         AND q.deleted_at IS NULL
         AND (
           (
             q.visibility = 'public'
             AND q.moderation_status = 'visible'
           )
           OR (? IS NOT NULL AND q.owner_id = ?)
         )`,
		)
		.bind(viewerId, viewerId, id, viewerId, viewerId)
		.first<QueryRow>();

	if (!row) {
		throw new RepositoryError(
			404,
			"QUERY_NOT_FOUND",
			"The query was not found.",
		);
	}

	return mapQuery(row);
}

export async function createQuery(
	db: D1Client,
	input: CreateQueryInput,
): Promise<QueryRecord> {
	const queryId = newId();
	const versionId = newId();
	const title = requireText(input.title, "title", 180);
	const kql = requireText(input.kql, "kql", 100_000);
	const description = (input.description ?? "").trim().slice(0, 10_000);
	const explanation = (input.explanation ?? "").trim().slice(0, 20_000);
	const visibility = input.visibility ?? "private";
	const tables = cleanStringList(input.tables, 64);
	const operators = cleanStringList(input.operators, 64);
	const tags = cleanStringList(input.tags, 32, 64);
	const assumptions = cleanStringList(input.assumptions, 32, 500);
	const validationWarnings = findQueryWarnings(kql);

	assertDialect(input.dialect);
	assertValidKqlSyntax(kql, { dialect: input.dialect });

	const contentHash = await hashQueryContent({
		title,
		kql,
		description,
		explanation,
		dialect: input.dialect,
		tables,
		operators,
		tags,
		assumptions,
		validationWarnings,
	});

	try {
		const results = await db.batch([
			db
				.prepare(
					`INSERT INTO queries (
             id,
             owner_id,
             visibility,
             published_at
           )
           SELECT ?, u.id, ?, CASE
             WHEN ? = 'public'
             THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             ELSE NULL
           END
           FROM user AS u
           WHERE u.id = ?`,
				)
				.bind(
					queryId,
					visibility,
					visibility,
					input.ownerId,
				),
			db
				.prepare(
					`INSERT INTO query_versions (
             id,
             query_id,
             version_number,
             title,
             kql,
             description,
             explanation,
             dialect,
             tables_json,
             operators_json,
             tags_json,
             assumptions_json,
             validation_warnings_json,
             ai_generated,
             generation_model,
             content_hash,
             created_by_user_id
           )
           SELECT
             ?,
             q.id,
             1,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             ?,
             q.owner_id
           FROM queries AS q
           WHERE q.id = ? AND q.owner_id = ? AND q.deleted_at IS NULL`,
				)
				.bind(
					versionId,
					title,
					kql,
					description,
					explanation,
					input.dialect,
					JSON.stringify(tables),
					JSON.stringify(operators),
					JSON.stringify(tags),
					JSON.stringify(assumptions),
					JSON.stringify(validationWarnings),
					input.aiGenerated ? 1 : 0,
					input.generationModel ?? null,
					contentHash,
					queryId,
					input.ownerId,
				),
			db
				.prepare(
					`UPDATE queries
           SET current_version_id = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
				)
				.bind(versionId, queryId, input.ownerId),
		]);

		if ((results[0]?.meta.changes ?? 0) !== 1) {
			throw new RepositoryError(
				403,
				"OWNER_NOT_FOUND",
				"The query owner does not exist.",
			);
		}
	} catch (error) {
		if (error instanceof RepositoryError) {
			throw error;
		}
		throw mapWriteError(error);
	}

	return getOwnedQuery(db, queryId, input.ownerId);
}

export async function updateQuery(
	db: D1Client,
	id: string,
	ownerId: string,
	patch: UpdateQueryInput,
): Promise<QueryRecord> {
	const existing = await getOwnedQuery(db, id, ownerId);
	const current = existing.currentVersion;
	const title = requireText(patch.title ?? current.title, "title", 180);
	const kql = requireText(patch.kql ?? current.kql, "kql", 100_000);
	const description = (patch.description ?? current.description)
		.trim()
		.slice(0, 10_000);
	const explanation = (patch.explanation ?? current.explanation)
		.trim()
		.slice(0, 20_000);
	const dialect = patch.dialect ?? current.dialect;
	const tables =
		patch.tables === undefined
			? current.tables
			: cleanStringList(patch.tables, 64);
	const operators =
		patch.operators === undefined
			? current.operators
			: cleanStringList(patch.operators, 64);
	const tags =
		patch.tags === undefined
			? current.tags
			: cleanStringList(patch.tags, 32, 64);
	const assumptions =
		patch.assumptions === undefined
			? current.assumptions
			: cleanStringList(patch.assumptions, 32, 500);
	const validationWarnings = findQueryWarnings(kql);

	assertDialect(dialect);
	assertValidKqlSyntax(kql, { dialect });

	const contentHash = await hashQueryContent({
		title,
		kql,
		description,
		explanation,
		dialect,
		tables,
		operators,
		tags,
		assumptions,
		validationWarnings,
	});

	if (contentHash === current.contentHash) {
		return existing;
	}

	const versionId = newId();
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO query_versions (
           id,
           query_id,
           version_number,
           title,
           kql,
           description,
           explanation,
           dialect,
           tables_json,
           operators_json,
           tags_json,
           assumptions_json,
           validation_warnings_json,
           ai_generated,
           generation_model,
           content_hash,
           created_by_user_id
         )
         SELECT
           ?,
           q.id,
           coalesce(max(v.version_number), 0) + 1,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           ?,
           q.owner_id
         FROM queries AS q
         LEFT JOIN query_versions AS v ON v.query_id = q.id
         WHERE q.id = ? AND q.owner_id = ? AND q.deleted_at IS NULL
         GROUP BY q.id`,
			)
			.bind(
				versionId,
				title,
				kql,
				description,
				explanation,
				dialect,
				JSON.stringify(tables),
				JSON.stringify(operators),
				JSON.stringify(tags),
				JSON.stringify(assumptions),
				JSON.stringify(validationWarnings),
				current.aiGenerated ? 1 : 0,
				current.generationModel,
				contentHash,
				id,
				ownerId,
			),
		db
			.prepare(
				`UPDATE queries
         SET current_version_id = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
			)
			.bind(versionId, id, ownerId),
	]);

	if ((results[0]?.meta.changes ?? 0) !== 1) {
		throw new RepositoryError(
			404,
			"QUERY_NOT_FOUND",
			"The query was not found.",
		);
	}

	return getOwnedQuery(db, id, ownerId);
}

export async function setQueryVisibility(
	db: D1Client,
	id: string,
	ownerId: string,
	visibility: QueryVisibility,
): Promise<QueryRecord> {
	if (visibility === "public") {
		const existing = await getOwnedQuery(db, id, ownerId);
		assertValidKqlSyntax(existing.currentVersion.kql, {
			dialect: existing.currentVersion.dialect,
		});
	}

	const result = await db
		.prepare(
			`UPDATE queries
       SET visibility = ?,
           published_at = CASE
             WHEN ? = 'public' THEN coalesce(
               published_at,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             )
             ELSE published_at
           END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
		)
		.bind(visibility, visibility, id, ownerId)
		.run();

	if (result.meta.changes !== 1) {
		throw new RepositoryError(
			404,
			"QUERY_NOT_FOUND",
			"The query was not found.",
		);
	}

	return getOwnedQuery(db, id, ownerId);
}

export async function deleteQuery(
	db: D1Client,
	id: string,
	ownerId: string,
): Promise<void> {
	const result = await db
		.prepare(
			`UPDATE queries
       SET visibility = 'private',
           deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND owner_id = ? AND deleted_at IS NULL`,
		)
		.bind(id, ownerId)
		.run();

	if (result.meta.changes !== 1) {
		throw new RepositoryError(
			404,
			"QUERY_NOT_FOUND",
			"The query was not found.",
		);
	}
}

export async function listOwnedQueries(
	db: D1Client,
	ownerId: string,
	options: ListOwnedQueryOptions = {},
): Promise<CursorPage<QueryListItem>> {
	const limit = clampLimit(options.limit);
	const cursor = readListCursor(options.cursor);
	const conditions = [
		"q.owner_id = ?",
		"q.deleted_at IS NULL",
		"q.current_version_id IS NOT NULL",
	];
	const bindings: unknown[] = [ownerId, ownerId, ownerId];

	if (options.visibility) {
		conditions.push("q.visibility = ?");
		bindings.push(options.visibility);
	}
	if (cursor) {
		conditions.push(
			"(q.updated_at < ? OR (q.updated_at = ? AND q.id < ?))",
		);
		bindings.push(cursor.timestamp, cursor.timestamp, cursor.id);
	}
	bindings.push(limit + 1);

	const result = await db
		.prepare(
			`${LIST_SELECT}
       WHERE ${conditions.join(" AND ")}
       ORDER BY q.updated_at DESC, q.id DESC
       LIMIT ?`,
		)
		.bind(...bindings)
		.all<QueryListRow>();
	const rows = result.results;
	const hasMore = rows.length > limit;
	const visibleRows = hasMore ? rows.slice(0, limit) : rows;
	const last = visibleRows.at(-1);

	return {
		items: visibleRows.map(mapListItem),
		...(hasMore && last
			? { nextCursor: makeListCursor(last.updated_at, last.id) }
			: {}),
	};
}

export async function listPublicQueries(
	db: D1Client,
	options: ListOptions = {},
): Promise<CursorPage<QueryListItem>> {
	const limit = clampLimit(options.limit, 20);
	const cursor = readRankedListCursor(options.cursor);
	const conditions = [
		"q.visibility = 'public'",
		"q.moderation_status = 'visible'",
		"q.deleted_at IS NULL",
		"q.current_version_id IS NOT NULL",
		"(q.owner_id IS NOT NULL OR s.provider = 'github')",
	];
	const bindings: unknown[] = [];

	if (cursor) {
		conditions.push(
			`(
			 q.star_count < ?
			 OR (
			   q.star_count = ?
			   AND (
			     q.updated_at < ?
			     OR (q.updated_at = ? AND q.id < ?)
			   )
			 )
			)`,
		);
		bindings.push(
			cursor.starCount,
			cursor.starCount,
			cursor.timestamp,
			cursor.timestamp,
			cursor.id,
		);
	}
	bindings.push(limit + 1);

	const result = await db
		.prepare(
			`${PUBLIC_LIST_SELECT}
       WHERE ${conditions.join(" AND ")}
       ORDER BY q.star_count DESC, q.updated_at DESC, q.id DESC
       LIMIT ?`,
		)
		.bind(...bindings)
		.all<PublicQueryListRow>();
	const rows = result.results;
	const hasMore = rows.length > limit;
	const visibleRows = hasMore ? rows.slice(0, limit) : rows;
	const last = visibleRows.at(-1);

	return {
		items: visibleRows.map(mapPublicListItem),
		...(hasMore && last
			? {
					nextCursor: makeRankedListCursor(
						last.star_count,
						last.updated_at,
						last.id,
					),
				}
			: {}),
	};
}

export async function listStarredQueries(
	db: D1Client,
	userId: string,
	options: ListOptions = {},
): Promise<CursorPage<QueryListItem>> {
	const limit = clampLimit(options.limit);
	const cursor = readListCursor(options.cursor);
	const conditions = [
		"st.user_id = ?",
		"q.visibility = 'public'",
		"q.moderation_status = 'visible'",
		"q.deleted_at IS NULL",
	];
	const bindings: unknown[] = [userId, userId, userId];

	if (cursor) {
		conditions.push(
			"(q.updated_at < ? OR (q.updated_at = ? AND q.id < ?))",
		);
		bindings.push(cursor.timestamp, cursor.timestamp, cursor.id);
	}
	bindings.push(limit + 1);

	const result = await db
		.prepare(
			`${LIST_SELECT}
       JOIN stars AS st ON st.query_id = q.id
       WHERE ${conditions.join(" AND ")}
       ORDER BY q.updated_at DESC, q.id DESC
       LIMIT ?`,
		)
		.bind(...bindings)
		.all<QueryListRow>();
	const rows = result.results;
	const hasMore = rows.length > limit;
	const visibleRows = hasMore ? rows.slice(0, limit) : rows;
	const last = visibleRows.at(-1);

	return {
		items: visibleRows.map(mapListItem),
		...(hasMore && last
			? { nextCursor: makeListCursor(last.updated_at, last.id) }
			: {}),
	};
}

export async function starQuery(
	db: D1Client,
	queryId: string,
	userId: string,
): Promise<StarRecord> {
	try {
		await db
			.prepare(
				`INSERT OR IGNORE INTO stars (user_id, query_id)
         SELECT u.id, q.id
         FROM user AS u
         JOIN queries AS q ON q.id = ?
         WHERE u.id = ?
           AND q.visibility = 'public'
           AND q.moderation_status = 'visible'
           AND q.deleted_at IS NULL`,
			)
			.bind(queryId, userId)
			.run();
	} catch (error) {
		throw mapWriteError(error);
	}

	const row = await db
		.prepare(
			`SELECT
         st.query_id,
         st.user_id,
         st.created_at,
         q.star_count
       FROM stars AS st
       JOIN queries AS q ON q.id = st.query_id
       WHERE st.query_id = ?
         AND st.user_id = ?
         AND q.visibility = 'public'
         AND q.moderation_status = 'visible'
         AND q.deleted_at IS NULL`,
		)
		.bind(queryId, userId)
		.first<{
			query_id: string;
			user_id: string;
			created_at: string;
			star_count: number;
		}>();

	if (!row) {
		throw new RepositoryError(
			404,
			"PUBLIC_QUERY_NOT_FOUND",
			"The public query was not found.",
		);
	}

	return {
		queryId: row.query_id,
		userId: row.user_id,
		createdAt: row.created_at,
		starCount: row.star_count,
	};
}

export async function unstarQuery(
	db: D1Client,
	queryId: string,
	userId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM stars WHERE query_id = ? AND user_id = ?")
		.bind(queryId, userId)
		.run();
}

export async function createReport(
	db: D1Client,
	input: CreateReportInput,
): Promise<QueryReport> {
	const reportId = newId();

	try {
		const result = await db
			.prepare(
				`INSERT INTO reports (
           id,
           query_id,
           reporter_id,
           reason,
           details
         )
         SELECT ?, q.id, u.id, ?, ?
         FROM user AS u
         JOIN queries AS q ON q.id = ?
         WHERE u.id = ?
           AND q.visibility = 'public'
           AND q.moderation_status = 'visible'
           AND q.deleted_at IS NULL`,
			)
			.bind(
				reportId,
				input.reason,
				(input.details ?? "").trim().slice(0, 2_000),
				input.queryId,
				input.reporterId,
			)
			.run();

		if (result.meta.changes !== 1) {
			throw new RepositoryError(
				404,
				"PUBLIC_QUERY_NOT_FOUND",
				"The public query was not found.",
			);
		}
	} catch (error) {
		if (error instanceof RepositoryError) {
			throw error;
		}

		if (sqliteErrorMessage(error).includes("unique")) {
			throw new RepositoryError(
				409,
				"REPORT_ALREADY_OPEN",
				"You already have an open report for this query.",
			);
		}
		throw mapWriteError(error);
	}

	const row = await db
		.prepare(
			`SELECT id, query_id, reporter_id, reason, details, status, created_at
       FROM reports
       WHERE id = ? AND reporter_id = ?`,
		)
		.bind(reportId, input.reporterId)
		.first<{
			id: string;
			query_id: string;
			reporter_id: string;
			reason: QueryReport["reason"];
			details: string;
			status: QueryReport["status"];
			created_at: string;
		}>();

	if (!row) {
		throw new RepositoryError(
			500,
			"REPORT_WRITE_FAILED",
			"The report could not be saved.",
		);
	}

	return {
		id: row.id,
		queryId: row.query_id,
		reporterId: row.reporter_id,
		reason: row.reason,
		details: row.details,
		status: row.status,
		createdAt: row.created_at,
	};
}

export async function adminUnpublishQuery(
	db: D1Client,
	input: AdminUnpublishInput,
): Promise<QueryRecord> {
	const actionId = newId();
	const results = await db.batch([
		db
			.prepare(
				`INSERT INTO moderation_actions (
           id,
           query_id,
           admin_id,
           action,
           reason,
           previous_visibility
         )
         SELECT ?, q.id, u.id, 'unpublish', ?, q.visibility
         FROM queries AS q
         JOIN user AS u ON u.id = ? AND u.role = 'admin'
         WHERE q.id = ?
           AND q.visibility = 'public'
           AND q.moderation_status = 'visible'
           AND q.deleted_at IS NULL`,
			)
			.bind(
				actionId,
				(input.reason ?? "").trim().slice(0, 2_000),
				input.adminId,
				input.queryId,
			),
		db
			.prepare(
				`UPDATE queries
         SET moderation_status = 'unpublished',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?
           AND visibility = 'public'
           AND moderation_status = 'visible'
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM user
             WHERE id = ? AND role = 'admin'
           )`,
			)
			.bind(input.queryId, input.adminId),
		db
			.prepare(
				`UPDATE reports
         SET status = 'actioned',
             reviewed_by = ?,
             reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE query_id = ? AND status = 'open'`,
			)
			.bind(input.adminId, input.queryId),
	]);

	if ((results[0]?.meta.changes ?? 0) !== 1) {
		const isAdmin = await db
			.prepare("SELECT 1 FROM user WHERE id = ? AND role = 'admin'")
			.bind(input.adminId)
			.first<number>("1");
		throw new RepositoryError(
			isAdmin ? 404 : 403,
			isAdmin ? "PUBLIC_QUERY_NOT_FOUND" : "ADMIN_REQUIRED",
			isAdmin
				? "The public query was not found."
				: "Administrator access is required.",
		);
	}

	return getQueryForAdmin(db, input.queryId, input.adminId);
}

async function getQueryForAdmin(
	db: D1Client,
	queryId: string,
	adminId: string,
): Promise<QueryRecord> {
	const row = await db
		.prepare(
			`${QUERY_SELECT}
       WHERE q.id = ?
         AND q.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM user
           WHERE id = ? AND role = 'admin'
         )`,
		)
		.bind(adminId, adminId, queryId, adminId)
		.first<QueryRow>();

	if (!row) {
		throw new RepositoryError(
			404,
			"QUERY_NOT_FOUND",
			"The query was not found.",
		);
	}

	return mapQuery(row);
}

export async function recordSearchHistory(
	db: D1Client,
	input: RecordSearchHistoryInput,
): Promise<SearchHistoryRecord> {
	const id = newId();
	const filters = JSON.stringify(input.filters);
	const result = await db
		.prepare(
			`INSERT INTO search_history (
         id,
         user_id,
         raw_request,
         normalized_request,
         filters_json,
         retrieval_mode,
         result_count
       )
       SELECT ?, u.id, ?, ?, ?, ?, ?
       FROM user AS u
       WHERE u.id = ?`,
		)
		.bind(
			id,
			input.rawRequest,
			input.normalizedRequest,
			filters,
			input.retrievalMode,
			Math.max(0, Math.trunc(input.resultCount)),
			input.userId,
		)
		.run();

	if (result.meta.changes !== 1) {
		throw new RepositoryError(
			403,
			"USER_NOT_FOUND",
			"The search history owner does not exist.",
		);
	}

	const row = await db
		.prepare(
			`SELECT
         id,
         raw_request,
         normalized_request,
         filters_json,
         retrieval_mode,
         result_count,
         clicked_query_id,
         created_at
       FROM search_history
       WHERE id = ? AND user_id = ?`,
		)
		.bind(id, input.userId)
		.first<HistoryRow>();

	if (!row) {
		throw new RepositoryError(
			500,
			"HISTORY_WRITE_FAILED",
			"The search history could not be saved.",
		);
	}

	return mapHistory(row);
}

interface HistoryRow {
	id: string;
	raw_request: string;
	normalized_request: string;
	filters_json: string;
	retrieval_mode: SearchHistoryRecord["retrievalMode"];
	result_count: number;
	clicked_query_id: string | null;
	created_at: string;
}

function mapHistory(row: HistoryRow): SearchHistoryRecord {
	return {
		id: row.id,
		rawRequest: row.raw_request,
		normalizedRequest: row.normalized_request,
		filters: parseJsonObject(row.filters_json),
		retrievalMode: row.retrieval_mode,
		resultCount: row.result_count,
		clickedQueryId: row.clicked_query_id,
		createdAt: row.created_at,
	};
}

export async function listHistory(
	db: D1Client,
	userId: string,
	options: ListOptions = {},
): Promise<CursorPage<SearchHistoryRecord>> {
	const limit = clampLimit(options.limit);
	const cursor = readListCursor(options.cursor);
	const conditions = ["user_id = ?"];
	const bindings: unknown[] = [userId];

	if (cursor) {
		conditions.push(
			"(created_at < ? OR (created_at = ? AND id < ?))",
		);
		bindings.push(cursor.timestamp, cursor.timestamp, cursor.id);
	}
	bindings.push(limit + 1);

	const result = await db
		.prepare(
			`SELECT
         id,
         raw_request,
         normalized_request,
         filters_json,
         retrieval_mode,
         result_count,
         clicked_query_id,
         created_at
       FROM search_history
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
		)
		.bind(...bindings)
		.all<HistoryRow>();
	const rows = result.results;
	const hasMore = rows.length > limit;
	const visibleRows = hasMore ? rows.slice(0, limit) : rows;
	const last = visibleRows.at(-1);

	return {
		items: visibleRows.map(mapHistory),
		...(hasMore && last
			? { nextCursor: makeListCursor(last.created_at, last.id) }
			: {}),
	};
}

export async function setHistoryClickedQuery(
	db: D1Client,
	historyId: string,
	userId: string,
	queryId: string,
): Promise<void> {
	const result = await db
		.prepare(
			`UPDATE search_history
       SET clicked_query_id = (
         SELECT q.id
         FROM queries AS q
         WHERE q.id = ?
           AND q.deleted_at IS NULL
           AND (
             (
               q.visibility = 'public'
               AND q.moderation_status = 'visible'
             )
             OR q.owner_id = ?
           )
       )
       WHERE id = ? AND user_id = ?
         AND EXISTS (
           SELECT 1
           FROM queries AS q
           WHERE q.id = ?
             AND q.deleted_at IS NULL
             AND (
               (
                 q.visibility = 'public'
                 AND q.moderation_status = 'visible'
               )
               OR q.owner_id = ?
             )
         )`,
		)
		.bind(queryId, userId, historyId, userId, queryId, userId)
		.run();

	if (result.meta.changes !== 1) {
		throw new RepositoryError(
			404,
			"HISTORY_NOT_FOUND",
			"The history item or selected query was not found.",
		);
	}
}

export async function clearHistory(
	db: D1Client,
	userId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM search_history WHERE user_id = ?")
		.bind(userId)
		.run();
}

interface SearchRow {
	query_id: string;
	version_id: string;
	title: string;
	snippet: string;
	dialect: KqlDialect;
	tables_json: string;
	star_count: number;
	score: number;
	visibility: QueryVisibility;
	repository: string | null;
	repository_provider: "github" | "local" | null;
	repository_source_url: string | null;
	provenance_source_url: string | null;
	license_spdx: string | null;
	trusted: number | null;
}

function mapSearchResult(
	row: SearchRow,
	matchType: "lexical" | "semantic",
): SearchResult {
	return {
		queryId: row.query_id,
		versionId: row.version_id,
		title: row.title,
		snippet: row.snippet,
		dialect: row.dialect,
		tables: parseJsonArray(row.tables_json),
		starCount: row.star_count,
		sourceRepository: row.repository,
		sourceRepositoryUrl: row.repository_source_url,
		matchType,
		score: Math.min(1, Math.max(0, row.score)),
		provenance: row.repository
			? {
					sourceName: row.repository,
						sourceUrl: row.provenance_source_url ?? undefined,
						repository: row.repository,
						repositoryUrl: row.repository_source_url ?? undefined,
						provider: row.repository_provider ?? undefined,
					licenseSpdx: row.license_spdx ?? undefined,
					trusted: asBoolean(row.trusted ?? 0),
				}
			: null,
		visibility: row.visibility,
	};
}

function lexicalMatchExpression(input: string): string | null {
	const tokens = input
		.normalize("NFKC")
		.toLocaleLowerCase()
		.match(/[\p{L}\p{N}_]+/gu)
		?.filter((token) => token.length > 1)
		.slice(0, 16);

	if (!tokens?.length) {
		return null;
	}

	return [...new Set(tokens)]
		.map((token) => `"${token.replaceAll('"', '""')}"*`)
		.join(" OR ");
}

function appendSearchFilters(
	conditions: string[],
	bindings: unknown[],
	request: SearchRequest | undefined,
): void {
	if (!request) {
		return;
	}

	appendInFilter(conditions, bindings, "v.dialect", request.dialects);
	appendJsonFilter(
		conditions,
		bindings,
		"v.tables_json",
		request.tables,
	);
	appendJsonFilter(
		conditions,
		bindings,
		"v.operators_json",
		request.operators,
	);
	appendJsonFilter(conditions, bindings, "v.tags_json", request.tags);
	appendInFilter(
		conditions,
		bindings,
		"lower(p.original_author)",
		request.authors.map((value) => value.toLocaleLowerCase()),
	);
	appendInFilter(
		conditions,
		bindings,
		"lower(s.repository)",
		request.sources.map((value) => value.toLocaleLowerCase()),
	);
}

function appendInFilter(
	conditions: string[],
	bindings: unknown[],
	column: string,
	values: readonly string[],
): void {
	if (!values.length) {
		return;
	}

	conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
	bindings.push(...values);
}

function appendJsonFilter(
	conditions: string[],
	bindings: unknown[],
	column: string,
	values: readonly string[],
): void {
	if (!values.length) {
		return;
	}

	conditions.push(
		`EXISTS (
       SELECT 1
       FROM json_each(${column}) AS filter_value
       WHERE lower(CAST(filter_value.value AS TEXT))
         IN (${values.map(() => "?").join(", ")})
     )`,
	);
	bindings.push(...values.map((value) => value.toLocaleLowerCase()));
}

export async function searchQueriesLexical(
	db: D1Client,
	request: SearchRequest,
	viewerId: string | null,
): Promise<SearchResult[]> {
	const match = lexicalMatchExpression(request.q);
	if (!match) {
		return [];
	}

	const conditions = [
		"q.deleted_at IS NULL",
		"q.current_version_id = ranked.version_id",
		`(
       (
         q.visibility = 'public'
         AND q.moderation_status = 'visible'
       )
       OR (? IS NOT NULL AND q.owner_id = ?)
     )`,
	];
	const whereBindings: unknown[] = [viewerId, viewerId];
	appendSearchFilters(conditions, whereBindings, request);
	const bindings: unknown[] = [
		match,
		request.q.trim(),
		request.q.trim(),
		...whereBindings,
		clampLimit(request.limit, 20),
	];

	const result = await db
		.prepare(
			`WITH ranked AS (
         SELECT
           query_id,
           version_id,
           bm25(
             query_search,
             0.0,
             0.0,
             12.0,
             8.0,
             4.0,
             1.0,
             6.0,
             5.0,
             3.0,
             3.0
           ) AS raw_rank
         FROM query_search
         WHERE query_search MATCH ?
       )
       SELECT
         q.id AS query_id,
         v.id AS version_id,
         v.title,
         CASE
           WHEN length(trim(v.description)) > 0
             THEN substr(v.description, 1, 360)
           ELSE substr(v.kql, 1, 360)
         END AS snippet,
         v.dialect,
         v.tables_json,
         q.star_count,
         min(
           1.0,
           (
             abs(ranked.raw_rank) / (1.0 + abs(ranked.raw_rank))
           )
           + CASE WHEN lower(v.title) = lower(?) THEN 0.22 ELSE 0.0 END
           + CASE WHEN EXISTS (
               SELECT 1
               FROM json_each(v.tables_json) AS exact_table
               WHERE lower(CAST(exact_table.value AS TEXT)) = lower(?)
             ) THEN 0.12 ELSE 0.0 END
           + CASE WHEN s.trusted = 1 THEN 0.03 ELSE 0.0 END
           + CASE
               WHEN q.star_count >= 100 THEN 0.05
               WHEN q.star_count >= 20 THEN 0.035
               WHEN q.star_count >= 5 THEN 0.02
               ELSE 0.0
             END
           + CASE
               WHEN julianday('now') - julianday(q.updated_at) <= 30
                 THEN 0.015
               ELSE 0.0
             END
         ) AS score,
         q.visibility,
	         s.repository,
	         s.provider AS repository_provider,
	         s.source_url AS repository_source_url,
	         p.source_url AS provenance_source_url,
         l.spdx_id AS license_spdx,
         s.trusted
       FROM ranked
       JOIN queries AS q ON q.id = ranked.query_id
       JOIN query_versions AS v ON v.id = ranked.version_id
       LEFT JOIN query_provenance AS p ON p.query_id = q.id
       LEFT JOIN source_repositories AS s ON s.id = p.source_repository_id
       LEFT JOIN licenses AS l ON l.id = p.license_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY score DESC, q.star_count DESC, q.updated_at DESC, q.id
       LIMIT ?`,
		)
		.bind(...bindings)
		.all<SearchRow>();

	return result.results.map((row) => mapSearchResult(row, "lexical"));
}

export async function getAuthorizedQueriesByIds(
	db: D1Client,
	candidateIds: readonly string[],
	viewerId: string | null,
	request?: SearchRequest,
): Promise<SearchResult[]> {
	const uniqueIds = [...new Set(candidateIds)].slice(0, 200);
	if (!uniqueIds.length) {
		return [];
	}

	const conditions = [
		`q.id IN (${uniqueIds.map(() => "?").join(", ")})`,
		"q.deleted_at IS NULL",
		`(
       (
         q.visibility = 'public'
         AND q.moderation_status = 'visible'
       )
       OR (? IS NOT NULL AND q.owner_id = ?)
     )`,
	];
	const bindings: unknown[] = [...uniqueIds, viewerId, viewerId];
	appendSearchFilters(conditions, bindings, request);

	const result = await db
		.prepare(
			`SELECT
         q.id AS query_id,
         v.id AS version_id,
         v.title,
         CASE
           WHEN length(trim(v.description)) > 0
             THEN substr(v.description, 1, 360)
           ELSE substr(v.kql, 1, 360)
         END AS snippet,
         v.dialect,
         v.tables_json,
         q.star_count,
         0.0 AS score,
         q.visibility,
	         s.repository,
	         s.provider AS repository_provider,
	         s.source_url AS repository_source_url,
	         p.source_url AS provenance_source_url,
         l.spdx_id AS license_spdx,
         s.trusted
       FROM queries AS q
       JOIN query_versions AS v ON v.id = q.current_version_id
       LEFT JOIN query_provenance AS p ON p.query_id = q.id
       LEFT JOIN source_repositories AS s ON s.id = p.source_repository_id
       LEFT JOIN licenses AS l ON l.id = p.license_id
       WHERE ${conditions.join(" AND ")}`,
		)
		.bind(...bindings)
		.all<SearchRow>();

	const byId = new Map(
		result.results.map((row) => [
			row.query_id,
			mapSearchResult(row, "semantic"),
		]),
	);

	return uniqueIds.flatMap((id) => {
		const row = byId.get(id);
		return row ? [row] : [];
	});
}

interface OutboxRow {
	id: string;
	query_id: string;
	version_id: string | null;
	operation: EmbeddingOutboxItem["operation"];
	namespace_kind: EmbeddingOutboxItem["namespaceKind"];
	owner_id: string | null;
	attempts: number;
	locked_by: string;
	created_at: string;
}

function mapOutbox(row: OutboxRow): EmbeddingOutboxItem {
	return {
		id: row.id,
		queryId: row.query_id,
		versionId: row.version_id,
		operation: row.operation,
		namespaceKind: row.namespace_kind,
		ownerId: row.owner_id,
		attempts: row.attempts,
		lockedBy: row.locked_by,
		createdAt: row.created_at,
	};
}

export async function claimEmbeddingOutbox(
	db: D1Client,
	workerId: string,
	limit = 10,
): Promise<EmbeddingOutboxItem[]> {
	const claimLimit = clampLimit(limit, 10);
	const result = await db
		.prepare(
			`UPDATE embedding_outbox
       SET status = 'processing',
           attempts = attempts + 1,
           locked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           locked_by = ?,
           last_error = NULL
       WHERE id IN (
         SELECT id
         FROM embedding_outbox
         WHERE available_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           AND (
             status IN ('pending', 'failed')
             OR (
               status = 'processing'
               AND locked_at < strftime(
                 '%Y-%m-%dT%H:%M:%fZ',
                 'now',
                 '-5 minutes'
               )
             )
           )
         ORDER BY available_at ASC, created_at ASC
         LIMIT ?
       )
       AND (
         status IN ('pending', 'failed')
         OR (
           status = 'processing'
           AND locked_at < strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             'now',
             '-5 minutes'
           )
         )
       )
       RETURNING
         id,
         query_id,
         version_id,
         operation,
         namespace_kind,
         owner_id,
         attempts,
         locked_by,
         created_at`,
		)
		.bind(workerId, claimLimit)
		.all<OutboxRow>();

	return result.results.map(mapOutbox);
}

export async function loadCurrentEmbeddingDocument(
	db: D1Client,
	queryId: string,
): Promise<EmbeddingDocumentRecord | null> {
	const row = await db
		.prepare(
			`SELECT
         q.id AS query_id,
         v.id AS version_id,
         q.owner_id,
         q.visibility,
         v.title,
         v.kql,
         v.description,
         v.explanation,
         v.dialect,
         v.tables_json,
         v.operators_json,
         v.tags_json
       FROM queries AS q
       JOIN query_versions AS v ON v.id = q.current_version_id
       WHERE q.id = ?
         AND q.deleted_at IS NULL
         AND q.moderation_status = 'visible'`,
		)
		.bind(queryId)
		.first<{
			query_id: string;
			version_id: string;
			owner_id: string | null;
			visibility: QueryVisibility;
			title: string;
			kql: string;
			description: string;
			explanation: string;
			dialect: KqlDialect;
			tables_json: string;
			operators_json: string;
			tags_json: string;
		}>();

	if (!row) {
		return null;
	}

	return {
		queryId: row.query_id,
		versionId: row.version_id,
		ownerId: row.owner_id,
		visibility: row.visibility,
		title: row.title,
		kql: row.kql,
		description: row.description,
		explanation: row.explanation,
		dialect: row.dialect,
		tables: parseJsonArray(row.tables_json),
		operators: parseJsonArray(row.operators_json),
		tags: parseJsonArray(row.tags_json),
	};
}

export async function completeEmbeddingOutbox(
	db: D1Client,
	jobId: string,
	workerId: string,
): Promise<void> {
	const result = await db
		.prepare(
			`UPDATE embedding_outbox
       SET status = 'completed',
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           locked_at = NULL,
           locked_by = NULL
       WHERE id = ? AND status = 'processing' AND locked_by = ?`,
		)
		.bind(jobId, workerId)
		.run();

	if (result.meta.changes !== 1) {
		throw new RepositoryError(
			409,
			"OUTBOX_LEASE_LOST",
			"The embedding job lease is no longer held by this worker.",
		);
	}
}

export async function retryEmbeddingOutbox(
	db: D1Client,
	jobId: string,
	workerId: string,
	failureCode: string,
	delaySeconds = 60,
): Promise<void> {
	const safeDelay = Math.min(Math.max(Math.trunc(delaySeconds), 1), 86_400);
	const result = await db
		.prepare(
			`UPDATE embedding_outbox
       SET status = 'failed',
           available_at = strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             'now',
             '+' || ? || ' seconds'
           ),
           locked_at = NULL,
           locked_by = NULL,
           last_error = ?
       WHERE id = ? AND status = 'processing' AND locked_by = ?`,
		)
		.bind(
			safeDelay,
			failureCode.trim().slice(0, 256),
			jobId,
			workerId,
		)
		.run();

	if (result.meta.changes !== 1) {
		throw new RepositoryError(
			409,
			"OUTBOX_LEASE_LOST",
			"The embedding job lease is no longer held by this worker.",
		);
	}
}

function mapWriteError(error: unknown): RepositoryError {
	const message = sqliteErrorMessage(error);

	if (message.includes("foreign key")) {
		return new RepositoryError(
			409,
			"RELATED_RECORD_NOT_FOUND",
			"A related database record no longer exists.",
		);
	}
	if (message.includes("unique")) {
		return new RepositoryError(
			409,
			"WRITE_CONFLICT",
			"The record conflicts with an existing value.",
		);
	}
	if (message.includes("check constraint")) {
		return new RepositoryError(
			400,
			"INVALID_RECORD",
			"The record failed a database validation rule.",
		);
	}

	return new RepositoryError(
		500,
		"DATABASE_WRITE_FAILED",
		"The database write could not be completed.",
	);
}
