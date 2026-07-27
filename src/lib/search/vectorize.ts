import type {
	SemanticSearchOptions,
	SemanticSearchPort,
} from "./ports";
import type { SemanticCandidate } from "./types";

interface VectorizeMetadata {
	queryId?: unknown;
	versionId?: unknown;
}

interface VectorizeMatchLike {
	id: string;
	score: number;
	metadata?: VectorizeMetadata | null;
}

export interface VectorizeIndexLike {
	query(
		vector: number[] | Float32Array | Float64Array,
		options: {
			topK: number;
			namespace: string;
			returnValues: false;
			returnMetadata: "all";
		},
	): Promise<{ matches: VectorizeMatchLike[]; count?: number }>;
}

export interface VectorizeMutationIndexLike {
	upsert(
		vectors: Array<{
			id: string;
			values: number[];
			namespace: string;
			metadata: {
				queryId: string;
				versionId: string;
			};
		}>,
	): Promise<{ mutationId?: string }>;
	deleteByIds(ids: string[]): Promise<{ mutationId?: string }>;
}

function metadataString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class CloudflareVectorSearch implements SemanticSearchPort {
	readonly #index: VectorizeIndexLike;

	constructor(index: VectorizeIndexLike) {
		this.#index = index;
	}

	async searchSemantic(
		embedding: readonly number[],
		options: SemanticSearchOptions,
	): Promise<SemanticCandidate[]> {
		const matches = await this.#index.query([...embedding], {
			topK: Math.min(Math.max(options.limit, 1), 50),
			namespace: options.namespace,
			returnValues: false,
			returnMetadata: "all",
		});

		return matches.matches
			.filter(
				(match) =>
					typeof match.id === "string" &&
					match.id.length > 0 &&
					Number.isFinite(match.score) &&
					Boolean(metadataString(match.metadata?.queryId)) &&
					Boolean(metadataString(match.metadata?.versionId)),
			)
			.map((match) => ({
				queryId: metadataString(match.metadata?.queryId)!,
				versionId: metadataString(match.metadata?.versionId)!,
				score: Math.max(0, Math.min(1, match.score)),
				namespace: options.namespace,
			}));
	}
}

export interface VectorMutation {
	upsert(options: {
		id: string;
		values: number[];
		namespace: string;
		queryId: string;
		versionId: string;
	}): Promise<void>;
	upsertMany(
		options: Array<{
			id: string;
			values: number[];
			namespace: string;
			queryId: string;
			versionId: string;
		}>,
	): Promise<void>;
	delete(id: string): Promise<void>;
	deleteMany(ids: string[]): Promise<void>;
}

export class CloudflareVectorMutation implements VectorMutation {
	readonly #index: VectorizeMutationIndexLike;

	constructor(index: VectorizeMutationIndexLike) {
		this.#index = index;
	}

	async upsert(options: {
		id: string;
		values: number[];
		namespace: string;
		queryId: string;
		versionId: string;
	}): Promise<void> {
		await this.upsertMany([options]);
	}

	async upsertMany(
		options: Array<{
			id: string;
			values: number[];
			namespace: string;
			queryId: string;
			versionId: string;
		}>,
	): Promise<void> {
		if (options.length === 0) {
			return;
		}
		await this.#index.upsert(
			options.map((item) => ({
				id: item.id,
				values: item.values,
				namespace: item.namespace,
				metadata: {
					queryId: item.queryId,
					versionId: item.versionId,
				},
			})),
		);
	}

	async delete(id: string): Promise<void> {
		await this.deleteMany([id]);
	}

	async deleteMany(ids: string[]): Promise<void> {
		if (ids.length === 0) {
			return;
		}
		await this.#index.deleteByIds(ids);
	}
}
