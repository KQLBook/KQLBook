"use client";

import Link from "next/link";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { kqlBookTheme } from "@/styles/kql-book";

export function Providers({ children }: { children: React.ReactNode }) {
	return (
		<Theme theme={kqlBookTheme} mode="light">
			<LayerProvider toast={{ position: "bottomEnd", maxVisible: 3 }}>
				<LinkProvider component={Link}>{children}</LinkProvider>
			</LayerProvider>
		</Theme>
	);
}
