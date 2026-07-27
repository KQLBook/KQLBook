import type { Metadata } from "next";

import { AppFrame } from "@/components/kql/app-frame";
import { CollectionPage } from "@/components/kql/collection-page";

export const metadata: Metadata = {
	title: "Saved",
	robots: { index: false, follow: false },
};

export default function SavedPage() {
	return (
		<AppFrame>
			<CollectionPage kind="starred" />
		</AppFrame>
	);
}
