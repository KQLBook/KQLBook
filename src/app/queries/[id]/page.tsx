import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";

import { AppFrame } from "@/components/kql/app-frame";
import { QueryInspector } from "@/components/kql/query-inspector";
import {
	findSampleQuery,
	mapStoredQuery,
	type QueryRecord,
} from "@/components/kql/sample-data";
import { getCurrentUser } from "@/lib/auth/session";
import { getQueryById, isRepositoryError } from "@/lib/db/repository";

type QueryPageProps = {
	params: Promise<{ id: string }>;
};

export const dynamic = "force-dynamic";

const loadPublicQuery = cache(
	async (
		id: string,
		viewerId: string | null,
	): Promise<QueryRecord | null> => {
		try {
			const { env } = getCloudflareContext();
			const stored = await getQueryById(env.DB, id, viewerId);
			if (
				stored.visibility !== "public" ||
				stored.moderationStatus !== "visible"
			) {
				return null;
			}
			return mapStoredQuery(stored);
		} catch (error) {
			if (isRepositoryError(error) && error.status === 404) {
				return null;
			}

			// Local previews can still render the bundled demo if D1 itself cannot
			// be reached. A D1 404 never falls back, so unpublished or deleted seed
			// records cannot be exposed by the demo copy.
			const sample = findSampleQuery(id);
			return sample?.visibility === "public" ? sample : null;
		}
	},
);

export async function generateMetadata({
	params,
}: QueryPageProps): Promise<Metadata> {
	const { id } = await params;
	const query = await loadPublicQuery(id, null);

	if (!query) {
		return {
			title: "Query not found",
			robots: { index: false, follow: false },
		};
	}

	return {
		title: query.title,
		description: query.snippet,
		alternates: {
			canonical: `/queries/${query.id}`,
		},
		openGraph: {
			title: query.title,
			description: query.snippet,
			type: "article",
			url: `/queries/${query.id}`,
		},
		robots: {
			index: true,
			follow: true,
		},
	};
}

export default async function PublicQueryPage({ params }: QueryPageProps) {
	const { id } = await params;
	const viewer = await getCurrentUser(await headers());
	const query = await loadPublicQuery(id, viewer?.id ?? null);

	if (!query) {
		notFound();
	}

	return (
		<AppFrame>
			<QueryInspector query={query} isPublicPage />
		</AppFrame>
	);
}
