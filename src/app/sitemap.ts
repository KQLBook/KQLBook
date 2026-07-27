import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { MetadataRoute } from "next";

import { SAMPLE_QUERIES } from "@/components/kql/sample-data";

const SITE_URL = "https://kqlbook.com";

type PublicQueryRow = {
	id: string;
	updated_at: string;
};

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
	const queryPages = new Map<string, string>();

	try {
		const { env } = getCloudflareContext();
		const result = await env.DB.prepare(
			`SELECT id, updated_at
			 FROM queries
			 WHERE visibility = 'public'
			   AND moderation_status = 'visible'
			   AND deleted_at IS NULL
			 ORDER BY updated_at DESC
			 LIMIT 50000`,
		).all<PublicQueryRow>();

		for (const query of result.results) {
			queryPages.set(query.id, query.updated_at);
		}
	} catch {
		// Use the bundled demo only when D1 itself cannot be reached. When D1
		// responds, its visibility and moderation state remain authoritative.
		for (const query of SAMPLE_QUERIES) {
			if (query.visibility === "public") {
				queryPages.set(query.id, new Date().toISOString());
			}
		}
	}

	return [
		{
			url: SITE_URL,
			lastModified: new Date(),
			changeFrequency: "daily",
			priority: 1,
		},
		...Array.from(queryPages, ([id, updatedAt]) => ({
			url: `${SITE_URL}/queries/${id}`,
			lastModified: new Date(updatedAt),
			changeFrequency: "weekly" as const,
			priority: 0.7,
		})),
	];
}
