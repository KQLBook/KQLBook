import { describe, expect, it, vi } from "vitest";

import {
	EmbeddingOutboxProcessor,
	vectorIdForVersion,
	type EmbeddingDocument,
	type EmbeddingOutboxJob,
} from "./outbox";

const job: EmbeddingOutboxJob = {
	id: "job-1",
	queryId: "query-1",
	versionId: "11111111-1111-4111-8111-111111111111",
	operation: "upsert",
	namespaceKind: "private",
	ownerId: "22222222-2222-4222-8222-222222222222",
	attempts: 0,
};

const document: EmbeddingDocument = {
	queryId: job.queryId,
	versionId: job.versionId!,
	ownerId: job.ownerId,
	visibility: "private",
	title: "Failed sign-ins",
	kql: "SigninLogs | where ResultType != 0",
	description: "Find failed Entra sign-ins.",
	explanation: "",
	dialect: "sentinel",
	tables: ["SigninLogs"],
	operators: ["where"],
	tags: ["identity"],
};

function setup(overrides: Partial<EmbeddingDocument> = {}) {
	const store = {
		claim: vi.fn().mockResolvedValue([job]),
		loadCurrentDocument: vi.fn().mockResolvedValue({
			...document,
			...overrides,
		}),
		complete: vi.fn().mockResolvedValue(undefined),
		retry: vi.fn().mockResolvedValue(undefined),
	};
	const embedding = {
		embed: vi.fn().mockResolvedValue([0.1, 0.2]),
	};
	const vectors = {
		upsert: vi.fn().mockResolvedValue(undefined),
		upsertMany: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
		deleteMany: vi.fn().mockResolvedValue(undefined),
	};
	return { store, embedding, vectors };
}

describe("embedding outbox", () => {
	it("uses a deterministic Vectorize-safe ID", async () => {
		const first = await vectorIdForVersion("public", document.versionId);
		const second = await vectorIdForVersion("public", document.versionId);
		const privateId = await vectorIdForVersion(
			`private:${job.ownerId}`,
			document.versionId,
		);

		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
		expect(privateId).not.toBe(first);
	});

	it("embeds the current D1 version and writes required metadata", async () => {
		const { store, embedding, vectors } = setup();
		const processor = new EmbeddingOutboxProcessor({
			store,
			embedding,
			vectors,
		});

		await expect(processor.process()).resolves.toEqual({
			claimed: 1,
			completed: 1,
			retried: 0,
		});
		expect(embedding.embed).toHaveBeenCalledWith(
			expect.stringContaining("SigninLogs | where ResultType != 0"),
			undefined,
		);
		expect(vectors.upsertMany).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					namespace: `private:${job.ownerId}`,
					queryId: job.queryId,
					versionId: job.versionId,
				}),
			]),
		);
		expect(store.complete).toHaveBeenCalledWith(job.id);
	});

	it("deletes the stale vector instead of embedding a superseded version", async () => {
		const { store, embedding, vectors } = setup({
			versionId: "33333333-3333-4333-8333-333333333333",
		});
		const processor = new EmbeddingOutboxProcessor({
			store,
			embedding,
			vectors,
		});

		await processor.process();

		expect(embedding.embed).not.toHaveBeenCalled();
		expect(vectors.upsertMany).not.toHaveBeenCalled();
		expect(vectors.deleteMany).toHaveBeenCalledOnce();
		expect(store.complete).toHaveBeenCalledWith(job.id);
	});

	it("retries a claimed batch when the Vectorize mutation fails", async () => {
		const secondJob = {
			...job,
			id: "job-2",
			queryId: "query-2",
			versionId: "33333333-3333-4333-8333-333333333333",
		};
		const { store, embedding, vectors } = setup();
		store.claim.mockResolvedValue([job, secondJob]);
		store.loadCurrentDocument.mockImplementation(async (queryId: string) => ({
			...document,
			queryId,
			versionId:
				queryId === job.queryId ? job.versionId : secondJob.versionId,
		}));
		vectors.upsertMany.mockRejectedValue(new Error("rate limited"));
		const processor = new EmbeddingOutboxProcessor({
			store,
			embedding,
			vectors,
		});

		await expect(processor.process()).resolves.toEqual({
			claimed: 2,
			completed: 0,
			retried: 2,
		});
		expect(vectors.upsertMany).toHaveBeenCalledOnce();
		expect(vectors.upsertMany.mock.calls[0][0]).toHaveLength(2);
		expect(store.retry).toHaveBeenCalledWith(job.id, "Error");
		expect(store.retry).toHaveBeenCalledWith(secondJob.id, "Error");
	});
});
