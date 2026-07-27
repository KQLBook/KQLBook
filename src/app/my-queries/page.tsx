import type { Metadata } from "next";

import { AppFrame } from "@/components/kql/app-frame";
import { CollectionPage } from "@/components/kql/collection-page";

export const metadata: Metadata = {
	title: "My Queries",
	robots: { index: false, follow: false },
};

export default function MyQueriesPage() {
	return (
		<AppFrame>
			<CollectionPage kind="owned" />
		</AppFrame>
	);
}
