import type { Metadata } from "next";

import { AppFrame } from "@/components/kql/app-frame";
import { NewQueryForm } from "@/components/kql/new-query-form";

export const metadata: Metadata = {
	title: "New Query",
	description: "Create a private or public Microsoft KQL query.",
};

export default function NewQueryPage() {
	return (
		<AppFrame>
			<NewQueryForm />
		</AppFrame>
	);
}
