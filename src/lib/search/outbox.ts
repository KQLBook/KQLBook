import type { EmbeddingPort } from "./ports";
import {
	privateSearchNamespace,
	publicSearchNamespace,
} from "./namespaces";
import type { QueryVisibility } from "./types";
import type { VectorMutation } from "./vectorize";

export type EmbeddingOutboxOperation = "upsert" | "delete";
export type EmbeddingNamespaceKind = "public" | "private";

export interface EmbeddingOutboxJob {
	id: string;
	queryId: string;
	versionId: string | null;
	operation: EmbeddingOutboxOperation;
	namespaceKind: EmbeddingNamespaceKind;
	ownerId: string | null;
	attempts: number;
}

export interface EmbeddingDocument {
	queryId: string;
	versionId: string;
	ownerId: string | null;
	visibility: QueryVisibility;
	title: string;
	kql: string;
	description: string;
	explanation: string;
	dialect: string;
	tables: string[];
	operators: string[];
	tags: string[];
}

export interface EmbeddingOutboxStore {
	claim(limit: number): Promise<EmbeddingOutboxJob[]>;
	loadCurrentDocument(queryId: string): Promise<EmbeddingDocument | null>;
	complete(jobId: string): Promise<void>;
	retry(jobId: string, failureCode: string): Promise<void>;
}

export interface EmbeddingOutboxProcessorOptions {
	store: EmbeddingOutboxStore;
	embedding: EmbeddingPort;
	vectors: VectorMutation;
	batchSize?: number;
}

export interface EmbeddingOutboxBatchResult {
	claimed: number;
	completed: number;
	retried: number;
}

type PreparedMutation =
	| {
			kind: "delete";
			job: EmbeddingOutboxJob;
			vectorId: string;
	  }
	| {
			kind: "upsert";
			job: EmbeddingOutboxJob;
			vector: {
				id: string;
				values: number[];
				namespace: string;
				queryId: string;
				versionId: string;
			};
	  };

function jobNamespace(job: EmbeddingOutboxJob): string {
	if (job.namespaceKind === "public") {
		if (job.ownerId !== null) {
			throw new Error("A public embedding job cannot have an owner namespace.");
		}
		return publicSearchNamespace();
	}
	if (!job.ownerId) {
		throw new Error("A private embedding job requires an owner.");
	}
	return privateSearchNamespace(job.ownerId);
}

function documentMatchesJob(
	document: EmbeddingDocument | null,
	job: EmbeddingOutboxJob,
): document is EmbeddingDocument {
	if (
		!document ||
		!job.versionId ||
		document.queryId !== job.queryId ||
		document.versionId !== job.versionId
	) {
		return false;
	}
	if (job.namespaceKind === "public") {
		return document.visibility === "public";
	}
	return (
		document.visibility === "private" &&
		Boolean(job.ownerId) &&
		document.ownerId === job.ownerId
	);
}

function embeddingText(document: EmbeddingDocument): string {
	return [
		document.title,
		`Dialect: ${document.dialect}`,
		document.tables.length ? `Tables: ${document.tables.join(", ")}` : "",
		document.operators.length
			? `Operators: ${document.operators.join(", ")}`
			: "",
		document.tags.length ? `Tags: ${document.tags.join(", ")}` : "",
		document.description,
		document.explanation,
		document.kql,
	]
		.filter(Boolean)
		.join("\n\n");
}

function failureCode(error: unknown): string {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		/^[A-Za-z][A-Za-z0-9_]*$/.test(error.code)
	) {
		return error.code.slice(0, 64);
	}
	if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]*$/.test(error.name)) {
		return error.name.slice(0, 64);
	}
	return "EmbeddingOutboxError";
}

export async function vectorIdForVersion(
	namespace: string,
	versionId: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${namespace}\u0000${versionId}`),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export class EmbeddingOutboxProcessor {
	readonly #store: EmbeddingOutboxStore;
	readonly #embedding: EmbeddingPort;
	readonly #vectors: VectorMutation;
	readonly #batchSize: number;

	constructor(options: EmbeddingOutboxProcessorOptions) {
		this.#store = options.store;
		this.#embedding = options.embedding;
		this.#vectors = options.vectors;
		this.#batchSize = Math.min(Math.max(options.batchSize ?? 10, 1), 100);
	}

	async process(signal?: AbortSignal): Promise<EmbeddingOutboxBatchResult> {
		const jobs = await this.#store.claim(this.#batchSize);
		const result: EmbeddingOutboxBatchResult = {
			claimed: jobs.length,
			completed: 0,
			retried: 0,
		};
		const prepared: PreparedMutation[] = [];

		for (const [index, job] of jobs.entries()) {
			if (signal?.aborted) {
				for (const unprocessed of jobs.slice(index)) {
					await this.#store.retry(unprocessed.id, "Aborted");
					result.retried += 1;
				}
				break;
			}
			try {
				prepared.push(await this.#prepareJob(job, signal));
			} catch (error) {
				await this.#store.retry(job.id, failureCode(error));
				result.retried += 1;
			}
		}

		await this.#applyDeletes(
			prepared.filter(
				(item): item is Extract<PreparedMutation, { kind: "delete" }> =>
					item.kind === "delete",
			),
			result,
		);
		await this.#applyUpserts(
			prepared.filter(
				(item): item is Extract<PreparedMutation, { kind: "upsert" }> =>
					item.kind === "upsert",
			),
			result,
		);

		return result;
	}

	async #prepareJob(
		job: EmbeddingOutboxJob,
		signal?: AbortSignal,
	): Promise<PreparedMutation> {
		if (!job.versionId) {
			throw new Error("EmbeddingJobMissingVersion");
		}
		const namespace = jobNamespace(job);
		const vectorId = await vectorIdForVersion(namespace, job.versionId);

		if (job.operation === "delete") {
			return { kind: "delete", job, vectorId };
		}

		const document = await this.#store.loadCurrentDocument(job.queryId);
		if (!documentMatchesJob(document, job)) {
			// A newer D1 version or visibility state superseded this job. Remove
			// this exact namespace/version vector in case an earlier attempt wrote it.
			return { kind: "delete", job, vectorId };
		}

		const values = await this.#embedding.embed(embeddingText(document), signal);
		return {
			kind: "upsert",
			job,
			vector: {
				id: vectorId,
				values,
				namespace,
				queryId: document.queryId,
				versionId: document.versionId,
			},
		};
	}

	async #applyDeletes(
		items: Array<Extract<PreparedMutation, { kind: "delete" }>>,
		result: EmbeddingOutboxBatchResult,
	): Promise<void> {
		if (items.length === 0) {
			return;
		}
		try {
			await this.#vectors.deleteMany(items.map((item) => item.vectorId));
		} catch (error) {
			await this.#retry(items.map((item) => item.job), error, result);
			return;
		}
		await this.#complete(items.map((item) => item.job), result);
	}

	async #applyUpserts(
		items: Array<Extract<PreparedMutation, { kind: "upsert" }>>,
		result: EmbeddingOutboxBatchResult,
	): Promise<void> {
		if (items.length === 0) {
			return;
		}
		try {
			await this.#vectors.upsertMany(items.map((item) => item.vector));
		} catch (error) {
			await this.#retry(items.map((item) => item.job), error, result);
			return;
		}
		await this.#complete(items.map((item) => item.job), result);
	}

	async #complete(
		jobs: EmbeddingOutboxJob[],
		result: EmbeddingOutboxBatchResult,
	): Promise<void> {
		for (const job of jobs) {
			try {
				await this.#store.complete(job.id);
				result.completed += 1;
			} catch (error) {
				await this.#store.retry(job.id, failureCode(error));
				result.retried += 1;
			}
		}
	}

	async #retry(
		jobs: EmbeddingOutboxJob[],
		error: unknown,
		result: EmbeddingOutboxBatchResult,
	): Promise<void> {
		const code = failureCode(error);
		for (const job of jobs) {
			await this.#store.retry(job.id, code);
			result.retried += 1;
		}
	}
}
