"use client";

import Link from "next/link";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { LinkProvider } from "@astryxdesign/core/Link";
import { KqlThemeProvider } from "@/components/kql/theme-provider";

export function Providers({ children }: { children: React.ReactNode }) {
	return (
		<KqlThemeProvider>
			<LayerProvider toast={{ position: "bottomEnd", maxVisible: 3 }}>
				<LinkProvider component={Link}>{children}</LinkProvider>
			</LayerProvider>
		</KqlThemeProvider>
	);
}
