import { createRequire } from "node:module";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// The root workspace hoists cookie@0.7.x for express while astro needs its own
// cookie@2. Resolving the alias from astro's own install makes the prerender
// bundle inline the correct copy instead of grabbing the hoisted one at runtime.
const astroRequire = createRequire(new URL("../node_modules/astro/package.json", import.meta.url));

export default defineConfig({
	site: "https://tankdonut.github.io",
	base: "/torus",
	output: "static",
	integrations: [sitemap()],
	vite: {
		resolve: {
			alias: {
				cookie: astroRequire.resolve("cookie"),
			},
		},
	},
});
