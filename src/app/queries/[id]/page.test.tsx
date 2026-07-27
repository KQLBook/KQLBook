import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCloudflareContext: vi.fn(),
	getCurrentUser: vi.fn(),
	getQueryById: vi.fn(),
	headers: vi.fn(),
	mapStoredQuery: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({
	getCloudflareContext: mocks.getCloudflareContext,
}));

vi.mock("next/headers", () => ({
	headers: mocks.headers,
}));

vi.mock("@/components/kql/app-frame", () => ({
	AppFrame: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/components/kql/query-inspector", () => ({
	QueryInspector: () => null,
}));

vi.mock("@/components/kql/sample-data", () => ({
	findSampleQuery: vi.fn(),
	mapStoredQuery: mocks.mapStoredQuery,
}));

vi.mock("@/lib/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@/lib/db/repository", () => ({
	getQueryById: mocks.getQueryById,
	isRepositoryError: vi.fn().mockReturnValue(false),
}));

import PublicQueryPage, { generateMetadata } from "./page";

describe("public query page viewer state", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps metadata anonymous while loading the signed-in viewer's saved state", async () => {
		const database = { name: "test-db" };
		const queryId = "query-1";
		const viewerId = "viewer-1";
		const requestHeaders = new Headers({ cookie: "session=test" });

		mocks.headers.mockResolvedValue(requestHeaders);
		mocks.getCurrentUser.mockResolvedValue({ id: viewerId });
		mocks.getCloudflareContext.mockReturnValue({
			env: { DB: database },
		});
		mocks.getQueryById.mockImplementation(
			async (_database: unknown, id: string, currentViewerId: string | null) => ({
				id,
				visibility: "public",
				moderationStatus: "visible",
				starredByViewer: currentViewerId === viewerId,
			}),
		);
		mocks.mapStoredQuery.mockImplementation((record: Record<string, unknown>) => ({
			id: record.id,
			title: "Saved query",
			snippet: "Saved query description",
			visibility: "public",
			starredByViewer: record.starredByViewer,
		}));

		await generateMetadata({
			params: Promise.resolve({ id: queryId }),
		});
		const page = await PublicQueryPage({
			params: Promise.resolve({ id: queryId }),
		});

		expect(mocks.getQueryById).toHaveBeenNthCalledWith(
			1,
			database,
			queryId,
			null,
		);
		expect(mocks.getQueryById).toHaveBeenNthCalledWith(
			2,
			database,
			queryId,
			viewerId,
		);
		expect(mocks.getCurrentUser).toHaveBeenCalledWith(requestHeaders);

		const inspector = page.props.children;
		expect(inspector.props.query.starredByViewer).toBe(true);
	});
});
