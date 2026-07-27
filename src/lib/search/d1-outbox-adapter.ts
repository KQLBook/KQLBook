import {
	claimEmbeddingOutbox,
	completeEmbeddingOutbox,
	loadCurrentEmbeddingDocument,
	retryEmbeddingOutbox,
} from "@/lib/db/repository";

import type {
	EmbeddingDocument,
	EmbeddingOutboxJob,
	EmbeddingOutboxStore,
} from "./outbox";

export class D1EmbeddingOutboxStore implements EmbeddingOutboxStore {
	readonly #db: D1Database;
	readonly #workerId: string;
	readonly #retryDelaySeconds: number;

	constructor(
		db: D1Database,
		options: {
			workerId?: string;
			retryDelaySeconds?: number;
		} = {},
	) {
		this.#db = db;
		this.#workerId = options.workerId ?? crypto.randomUUID();
		this.#retryDelaySeconds = Math.max(
			1,
			Math.trunc(options.retryDelaySeconds ?? 30),
		);
	}

	async claim(limit: number): Promise<EmbeddingOutboxJob[]> {
		const jobs = await claimEmbeddingOutbox(
			this.#db,
			this.#workerId,
			limit,
		);
		return jobs.map((job) => ({
			id: job.id,
			queryId: job.queryId,
			versionId: job.versionId,
			operation: job.operation,
			namespaceKind: job.namespaceKind,
			ownerId: job.ownerId,
			attempts: job.attempts,
		}));
	}

	async loadCurrentDocument(
		queryId: string,
	): Promise<EmbeddingDocument | null> {
		return loadCurrentEmbeddingDocument(this.#db, queryId);
	}

	complete(jobId: string): Promise<void> {
		return completeEmbeddingOutbox(this.#db, jobId, this.#workerId);
	}

	retry(jobId: string, failureCode: string): Promise<void> {
		return retryEmbeddingOutbox(
			this.#db,
			jobId,
			this.#workerId,
			failureCode,
			this.#retryDelaySeconds,
		);
	}
}

