import { createRequire } from "node:module";
import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import rehypeSlug from "rehype-slug";
import { rehypeRewriteDocLinks } from "./src/lib/md-links.mjs";

// The root workspace hoists cookie@0.7.x for express while astro needs its own
// cookie@2. Resolving the alias from astro's own install makes the prerender
// bundle inline the correct copy instead of grabbing the hoisted one at runtime.
const astroRequire = createRequire(new URL("../node_modules/astro/package.json", import.meta.url));

const siteBase = "/torus";

export default defineConfig({
	site: "https://tankdonut.github.io",
	base: siteBase,
	output: "static",
	integrations: [sitemap()],
	markdown: {
		// Astro 7's default satteri processor cannot run function-form rehype
		// plugins (its visitor API is incompatible with rehype-slug), so the site
		// pins the classic unified pipeline from @astrojs/markdown-remark.
		processor: unified({
			rehypePlugins: [
				rehypeSlug,
				[rehypeRewriteDocLinks, { siteBase, repoRoot: new URL("../", import.meta.url) }],
			],
		}),
	},
	vite: {
		resolve: {
			alias: {
				cookie: astroRequire.resolve("cookie"),
			},
		},
	},
});
