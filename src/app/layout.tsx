import type { Metadata } from "next";
import "@stylexswc/webpack-plugin/stylex.css";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
	metadataBase: new URL("https://kqlbook.com"),
	title: {
		default: "KQL Book - Search Microsoft KQL Queries",
		template: "%s | KQL Book",
	},
	description:
		"Find, study, and share Microsoft KQL across Sentinel, Defender XDR, Azure Data Explorer, Resource Graph, and Intune.",
	applicationName: "KQL Book",
	keywords: ["KQL", "Microsoft Sentinel", "Defender XDR", "Azure Data Explorer"],
	openGraph: {
		type: "website",
		url: "/",
		siteName: "KQL Book",
		title: "KQL Book - Search Microsoft KQL Queries",
		description:
			"Find, study, and share Microsoft KQL across Sentinel, Defender XDR, Azure Data Explorer, Resource Graph, and Intune.",
		images: [
			{
				url: "/og-kql-book.png",
				width: 1200,
				height: 630,
				alt: "KQL Book with a query search interface and KQL concepts",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "KQL Book - Search Microsoft KQL Queries",
		description:
			"Find, study, and share Microsoft KQL across Microsoft security and data products.",
		images: ["/og-kql-book.png"],
	},
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" data-theme="light" suppressHydrationWarning>
			<head>
				<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
				<script
					type="application/ld+json"
					dangerouslySetInnerHTML={{
						__html: JSON.stringify({
							"@context": "https://schema.org",
							"@type": "WebSite",
							name: "KQL Book",
							alternateName: ["KQLBook", "kqlbook.com"],
							url: "https://kqlbook.com/",
						}).replace(/</g, "\\u003c"),
					}}
				/>
			</head>
			<body>
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
