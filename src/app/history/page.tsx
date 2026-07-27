import type { Metadata } from "next";

import { AppFrame } from "@/components/kql/app-frame";
import { CollectionPage } from "@/components/kql/collection-page";

export const metadata: Metadata = {
	title: "Search History",
	robots: { index: false, follow: false },
};

export default function HistoryPage() {
	return (
		<AppFrame>
			<CollectionPage kind="history" />
		</AppFrame>
	);
}
