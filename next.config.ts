import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import withStyleX from "@stylexswc/nextjs-plugin";

const nextConfig: NextConfig = {
	transpilePackages: ["@astryxdesign/core", "@astryxdesign/theme-neutral"],
};

// Enable calling `getCloudflareContext()` in `next dev`.
// See https://opennext.js.org/cloudflare/bindings#local-access-to-bindings.
initOpenNextCloudflareForDev({
	configPath: "wrangler.local.jsonc",
	remoteBindings: false,
});

export default withStyleX({
	rsOptions: {
		dev: process.env.NODE_ENV !== "production",
	},
})(nextConfig);
