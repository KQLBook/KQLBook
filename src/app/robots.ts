import type { MetadataRoute } from "next";

const SITE_URL = "https://kqlbook.com";

export default function robots(): MetadataRoute.Robots {
	return {
		rules: {
			userAgent: "*",
			allow: ["/", "/queries/"],
			disallow: ["/api/", "/history", "/my-queries", "/new", "/saved", "/starred"],
		},
		sitemap: `${SITE_URL}/sitemap.xml`,
		host: SITE_URL,
	};
}
