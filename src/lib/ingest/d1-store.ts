import { normalizeKql, stableId } from "./normalize";
import type {
	IngestedQuery,
	IngestionStorePort,
	IngestionWriteResult,
	RepositoryIngestionBatch,
} from "./types";

export type D1IngestionClient = Pick<D1Database, "prepare" | "batch">;

const QUERIES_PER_BATCH = 20;
const PROVENANCE_RELOCATION_BASE = 1_000_000_000_000;
const PROVENANCE_RELOCATION_STRIDE = 1_000_000;

interface ExistingImportedQuery {
	id: string;
	path: string;
	blockIndex: number;
	kql: string;
	ownerId: string | null;
	deletedAt: string | null;
}

export class D1IngestionStore implements IngestionStorePort {
	constructor(private readonly database: D1IngestionClient) {}

	async writeBatch(
		batch: RepositoryIngestionBatch,
		signal?: AbortSignal,
	): Promise<IngestionWriteResult> {
		throwIfAborted(signal);
		const licenseId = await stableId(
			"license",
			batch.license.spdxId.toLocaleLowerCase("en-US"),
		);
		const reviewedAt = new Date().toISOString();
		let inserted = 0;
		const existingQueries = await this.readExistingQueries(
			batch.repository.id,
		);
		const resolvedQueries = await resolveQueryIds(
			batch.queries,
			existingQueries,
		);
		await this.relocateProcessedProvenance(
			batch,
			existingQueries,
			signal,
		);

		const chunks =
			resolvedQueries.length === 0
				? [[]]
				: chunk(resolvedQueries, QUERIES_PER_BATCH);

		for (const queries of chunks) {
			throwIfAborted(signal);
			const statements: D1PreparedStatement[] = [
				this.database
					.prepare(
						`INSERT INTO licenses (
							id, spdx_id, name, license_url, required_notice,
							ingestion_allowed, reviewed_at
						) VALUES (?, ?, ?, ?, ?, 1, ?)
						ON CONFLICT(spdx_id) DO UPDATE SET
							name = excluded.name,
							license_url = excluded.license_url,
							required_notice = excluded.required_notice,
							ingestion_allowed = 1,
							reviewed_at = excluded.reviewed_at`,
					)
					.bind(
						licenseId,
						batch.license.spdxId,
						batch.license.name,
						batch.license.licenseUrl,
						batch.license.requiredNotice,
						reviewedAt,
					),
				this.database
					.prepare(
						`INSERT INTO source_repositories (
							id, provider, repository, default_branch, source_url,
							license_id, trusted
						) VALUES (?, 'github', ?, ?, ?, ?, ?)
						ON CONFLICT(provider, repository) DO UPDATE SET
							default_branch = excluded.default_branch,
							source_url = excluded.source_url,
							license_id = excluded.license_id,
							trusted = excluded.trusted,
							updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
					)
					.bind(
						batch.repository.id,
						batch.repository.fullName,
						batch.repository.defaultBranch,
						batch.repository.sourceUrl,
						licenseId,
						batch.repository.trusted ? 1 : 0,
					),
			];
			const versionInsertIndexes: number[] = [];

			for (const query of queries) {
				const versionId = await stableId(
					"imported_version",
					`${query.id}\u0000${query.contentHash}`,
				);
				const publishedAt = new Date().toISOString();

				statements.push(
					this.database
						.prepare(
							`INSERT OR IGNORE INTO queries (
								id, owner_id, visibility, moderation_status,
								current_version_id, star_count, published_at
							) VALUES (?, NULL, 'public', 'visible', NULL, 0, ?)`,
						)
						.bind(query.id, publishedAt),
				);
				versionInsertIndexes.push(statements.length);
				statements.push(
					this.database
						.prepare(
							`INSERT OR IGNORE INTO query_versions (
								id, query_id, version_number, title, kql, description,
								explanation, dialect, tables_json, operators_json,
								tags_json, assumptions_json, validation_warnings_json,
								ai_generated, generation_model, content_hash,
								created_by_user_id
							) VALUES (
								?, ?,
								(
									SELECT coalesce(max(version_number), 0) + 1
									FROM query_versions
									WHERE query_id = ?
								),
								?, ?, ?, ?, ?, ?, ?, ?, '[]',
								'[]', 0, NULL, ?, NULL
							)`,
						)
						.bind(
							versionId,
							query.id,
							query.id,
							query.title,
							query.kql,
							query.description,
							query.explanation,
							query.dialect,
							JSON.stringify(query.tables),
							JSON.stringify(query.operators),
							JSON.stringify(query.tags),
							query.contentHash,
						),
					this.database
						.prepare(
							`UPDATE queries
							SET
								current_version_id = ?,
								updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
								deleted_at = NULL,
								published_at = coalesce(published_at, ?)
							WHERE id = ?
								AND (
									deleted_at IS NOT NULL
									OR current_version_id IS NULL
									OR current_version_id != ?
								)
								AND (
									deleted_at IS NOT NULL
									OR current_version_id IS NULL
									OR (
										SELECT version_number
										FROM query_versions
										WHERE id = ?
									) > (
										SELECT version_number
										FROM query_versions
										WHERE id = current_version_id
									)
								)`,
						)
						.bind(
							versionId,
							publishedAt,
							query.id,
							versionId,
							versionId,
						),
					this.database
						.prepare(
							`INSERT INTO query_provenance (
								query_id, source_repository_id, source_path, commit_sha,
								query_block_index, original_author, source_url,
								license_id, required_notice
							) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
							ON CONFLICT(query_id) DO UPDATE SET
								source_repository_id = excluded.source_repository_id,
								source_path = excluded.source_path,
								commit_sha = excluded.commit_sha,
								query_block_index = excluded.query_block_index,
								original_author = excluded.original_author,
								source_url = excluded.source_url,
								license_id = excluded.license_id,
								required_notice = excluded.required_notice
							WHERE (
								SELECT current_version_id
								FROM queries
								WHERE id = excluded.query_id
							) = ?`,
						)
						.bind(
							query.id,
							batch.repository.id,
							query.source.path,
							query.source.commitSha,
							query.source.blockIndex,
							query.source.originalAuthor,
							query.source.sourceUrl,
							licenseId,
							query.license.requiredNotice,
							versionId,
						),
				);
			}

			const results = await this.database.batch(statements);
			for (const index of versionInsertIndexes) {
				inserted += Number(results[index]?.meta?.changes ?? 0) > 0 ? 1 : 0;
			}
		}

		await this.deactivateObsoleteImportedBlocks(
			batch,
			resolvedQueries,
			existingQueries,
			signal,
		);

		return {
			inserted,
			unchanged: resolvedQueries.length - inserted,
		};
	}

	private async relocateProcessedProvenance(
		batch: RepositoryIngestionBatch,
		existingQueries: readonly ExistingImportedQuery[],
		signal?: AbortSignal,
	): Promise<void> {
		const processedPaths = new Set(batch.processedSourcePaths);
		const paths = [
			...new Set(
				existingQueries
					.filter(
						(existing) =>
							existing.ownerId === null &&
							processedPaths.has(existing.path),
					)
					.map((existing) => existing.path),
			),
		];

		// Moving every existing block out of the physical-index range prevents
		// the provenance uniqueness guard from failing during shifts such as
		// 0 -> 1, 1 -> 2. rowid makes the temporary value unique and a retry
		// computes the same value before accepted blocks are restored below.
		// The original index remains in the low digits so a retry can recover
		// it even if upstream KQL changed after an interrupted run.
		for (const pathsChunk of chunk(paths, QUERIES_PER_BATCH)) {
			throwIfAborted(signal);
			await this.database.batch(
				pathsChunk.map((path) =>
					this.database
						.prepare(
							`UPDATE query_provenance
							SET query_block_index = ? + (rowid * ?) + query_block_index
							WHERE source_repository_id = ?
								AND source_path = ?
								AND query_block_index < ?
								AND EXISTS (
									SELECT 1
									FROM queries
									WHERE queries.id = query_provenance.query_id
										AND queries.owner_id IS NULL
								)`,
						)
						.bind(
							PROVENANCE_RELOCATION_BASE,
							PROVENANCE_RELOCATION_STRIDE,
							batch.repository.id,
							path,
							PROVENANCE_RELOCATION_BASE,
						),
				),
			);
		}
	}

	private async deactivateObsoleteImportedBlocks(
		batch: RepositoryIngestionBatch,
		acceptedQueries: readonly IngestedQuery[],
		existingQueries: readonly ExistingImportedQuery[],
		signal?: AbortSignal,
	): Promise<void> {
		const processedPaths = new Set(batch.processedSourcePaths);
		const acceptedIds = new Set(
			acceptedQueries.map((query) => query.id),
		);
		const obsolete = existingQueries.filter(
			(existing) =>
				existing.ownerId === null &&
				existing.deletedAt === null &&
				processedPaths.has(existing.path) &&
				!acceptedIds.has(existing.id),
		);

		for (const obsoleteChunk of chunk(obsolete, QUERIES_PER_BATCH)) {
			throwIfAborted(signal);
			await this.database.batch(
				obsoleteChunk.map((existing) =>
					this.database
						.prepare(
							`UPDATE queries
							SET
								deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
								updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
							WHERE id = ?
								AND owner_id IS NULL
								AND deleted_at IS NULL
								AND EXISTS (
									SELECT 1
									FROM query_provenance AS provenance
									WHERE provenance.query_id = queries.id
										AND provenance.source_repository_id = ?
										AND provenance.source_path = ?
								)`,
						)
						.bind(
							existing.id,
							batch.repository.id,
							existing.path,
						),
				),
			);
		}
	}

	private async readExistingQueries(
		sourceRepositoryId: string,
	): Promise<ExistingImportedQuery[]> {
		const rows = await this.database
			.prepare(
				`SELECT
					provenance.query_id,
					provenance.source_path,
					provenance.query_block_index,
					coalesce(version.kql, '') AS kql,
					queries.owner_id,
					queries.deleted_at
				FROM query_provenance AS provenance
				JOIN queries ON queries.id = provenance.query_id
				LEFT JOIN query_versions AS version
					ON version.id = queries.current_version_id
				WHERE provenance.source_repository_id = ?`,
			)
			.bind(sourceRepositoryId)
			.all<{
				query_id: string;
				source_path: string;
				query_block_index: number;
				kql: string;
				owner_id: string | null;
				deleted_at: string | null;
			}>();
		return (rows.results ?? []).map((row) => ({
			id: row.query_id,
			path: row.source_path,
			blockIndex: restoreProvenanceBlockIndex(
				Number(row.query_block_index),
			),
			kql: row.kql,
			ownerId: row.owner_id,
			deletedAt: row.deleted_at,
		}));
	}
}

function restoreProvenanceBlockIndex(value: number): number {
	return value >= PROVENANCE_RELOCATION_BASE
		? value % PROVENANCE_RELOCATION_STRIDE
		: value;
}

async function resolveQueryIds(
	queries: readonly IngestedQuery[],
	existingQueries: readonly ExistingImportedQuery[],
): Promise<IngestedQuery[]> {
	const eligibleExisting = existingQueries.filter(
		(existing) => existing.ownerId === null,
	);
	const usedExistingIds = new Set<string>();
	const resolvedIds = new Map<number, string>();

	// Match the complete new path before falling back to physical indexes. This
	// preserves IDs when an earlier rejected Markdown fence used to collapse
	// the accepted-block numbering for every later query in the file.
	for (let index = 0; index < queries.length; index += 1) {
		const query = queries[index];
		const normalized = normalizeKql(query.kql);
		const match = chooseExistingQuery(
			eligibleExisting.filter(
				(existing) =>
					!usedExistingIds.has(existing.id) &&
					existing.path === query.source.path &&
					normalizeKql(existing.kql) === normalized,
			),
			query.source.blockIndex,
		);
		if (match) {
			resolvedIds.set(index, match.id);
			usedExistingIds.add(match.id);
		}
	}

	for (let index = 0; index < queries.length; index += 1) {
		if (resolvedIds.has(index)) {
			continue;
		}
		const query = queries[index];
		const match = chooseExistingQuery(
			eligibleExisting.filter(
				(existing) =>
					!usedExistingIds.has(existing.id) &&
					sourceKey(existing.path, existing.blockIndex) ===
						sourceKey(query.source.path, query.source.blockIndex),
			),
			query.source.blockIndex,
		);
		if (match) {
			resolvedIds.set(index, match.id);
			usedExistingIds.add(match.id);
		}
	}

	const occupiedIds = new Set(existingQueries.map((existing) => existing.id));
	const assignedIds = new Set(resolvedIds.values());
	for (let index = 0; index < queries.length; index += 1) {
		if (resolvedIds.has(index)) {
			continue;
		}
		const query = queries[index];
		let id = query.id;
		let collision = 0;
		while (occupiedIds.has(id) || assignedIds.has(id)) {
			id = await stableId(
				"imported_query_reconciled",
				`${query.sourceIdentity}\u0000${collision}`,
			);
			collision += 1;
		}
		resolvedIds.set(index, id);
		assignedIds.add(id);
	}

	return queries.map((query, index) => ({
		...query,
		id: resolvedIds.get(index) ?? query.id,
	}));
}

function chooseExistingQuery(
	candidates: readonly ExistingImportedQuery[],
	targetBlockIndex: number,
): ExistingImportedQuery | undefined {
	return [...candidates].sort((left, right) => {
		const leftSameIndex = left.blockIndex === targetBlockIndex ? 0 : 1;
		const rightSameIndex = right.blockIndex === targetBlockIndex ? 0 : 1;
		if (leftSameIndex !== rightSameIndex) {
			return leftSameIndex - rightSameIndex;
		}
		const leftDeleted = left.deletedAt === null ? 0 : 1;
		const rightDeleted = right.deletedAt === null ? 0 : 1;
		if (leftDeleted !== rightDeleted) {
			return leftDeleted - rightDeleted;
		}
		const leftDistance = Math.abs(left.blockIndex - targetBlockIndex);
		const rightDistance = Math.abs(right.blockIndex - targetBlockIndex);
		if (leftDistance !== rightDistance) {
			return leftDistance - rightDistance;
		}
		if (left.blockIndex !== right.blockIndex) {
			return left.blockIndex - right.blockIndex;
		}
		return left.id.localeCompare(right.id, "en-US");
	})[0];
}

function chunk<T>(values: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function sourceKey(path: string, blockIndex: number): string {
	return `${path}\u0000${blockIndex}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
	}
}
