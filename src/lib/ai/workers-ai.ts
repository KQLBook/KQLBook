import type { EmbeddingPort } from "../search/ports";
import { AiServiceError, OperationTimeoutError } from "./errors";
import { runWithTimeout } from "./timeout";
import {
	EMBEDDING_DIMENSIONS,
	WORKERS_AI_EMBEDDING_MODEL,
} from "./types";

interface WorkersAiEmbeddingOutput {
	data?: unknown;
}

export interface WorkersAiLike {
	run(
		model: typeof WORKERS_AI_EMBEDDING_MODEL,
		input: { text: string; truncate_inputs: true },
		options?: { signal?: AbortSignal },
	): Promise<WorkersAiEmbeddingOutput>;
}

export class WorkersAiEmbedder implements EmbeddingPort {
	readonly #ai: WorkersAiLike;
	readonly #timeoutMs: number;

	constructor(ai: WorkersAiLike, timeoutMs = 8_000) {
		this.#ai = ai;
		this.#timeoutMs = timeoutMs;
	}

	async embed(text: string, signal?: AbortSignal): Promise<number[]> {
		try {
			const output = await runWithTimeout(
				(innerSignal) =>
					this.#ai.run(
						WORKERS_AI_EMBEDDING_MODEL,
						{ text, truncate_inputs: true },
						{ signal: innerSignal },
					),
				this.#timeoutMs,
				signal,
			);
			const embedding =
				Array.isArray(output.data) && Array.isArray(output.data[0])
					? output.data[0]
					: undefined;

			if (
				!embedding ||
				embedding.length !== EMBEDDING_DIMENSIONS ||
				embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
			) {
				throw new AiServiceError(
					"invalid_response",
					"Workers AI returned an invalid embedding.",
					{ status: 502, retryable: true },
				);
			}

			return embedding;
		} catch (error) {
			if (error instanceof AiServiceError) {
				throw error;
			}
			if (error instanceof OperationTimeoutError) {
				throw new AiServiceError("timeout", "Embedding generation timed out.", {
					status: 504,
					retryable: true,
					cause: error,
				});
			}
			throw new AiServiceError("service_unavailable", "Embedding search is unavailable.", {
				status: 503,
				retryable: true,
				cause: error,
			});
		}
	}
}

