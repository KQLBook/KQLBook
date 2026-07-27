import { getCloudflareContext } from "@opennextjs/cloudflare";

import { AppFrame } from "@/components/kql/app-frame";
import { SearchWorkspace } from "@/components/kql/search-workspace";
import { listPublicQueries } from "@/lib/db/repository";
import type { CursorPage, QueryListItem } from "@/lib/db/types";

type HomeSearchParams = {
	q?: string | string[];
	dialect?: string | string[];
	table?: string | string[];
	operator?: string | string[];
	author?: string | string[];
	tag?: string | string[];
	source?: string | string[];
};

function firstValue(value: string | string[] | undefined): string {
	return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export const dynamic = "force-dynamic";

async function loadInitialPopularPage(): Promise<CursorPage<QueryListItem> | null> {
	try {
		const { env } = getCloudflareContext();
		return await listPublicQueries(env.DB, { limit: 20 });
	} catch {
		return null;
	}
}

export default async function Home({
	searchParams,
}: {
	searchParams: Promise<HomeSearchParams>;
}) {
	const params = await searchParams;
	const initialQuery = firstValue(params.q);
	const initialPopularPage = initialQuery
		? null
		: await loadInitialPopularPage();

	return (
		<AppFrame>
			<SearchWorkspace
				initialQuery={initialQuery}
				initialFilters={{
					dialect: firstValue(params.dialect),
					table: firstValue(params.table),
					operator: firstValue(params.operator),
					author: firstValue(params.author),
					tag: firstValue(params.tag),
					source: firstValue(params.source),
				}}
				initialPopularPage={initialPopularPage}
			/>
		</AppFrame>
	);
}
