// Usage: node scripts/shots.mjs <outDir> [urls...]
// Shots both themes at 1440x900, 1024, 820, 768, and 390x844 with reduced
// motion, for the site-design verify pass. Needs the built site on a server
// (npm run preview -w site -- --host 127.0.0.1).
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const outDir = process.argv[2];
if (!outDir) {
	console.error("usage: node shots.mjs <outDir> [urls...]");
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const urls = process.argv.slice(3);
if (urls.length === 0) urls.push("http://127.0.0.1:4323/");

const sizes = [
	[1440, 900],
	[1024, 900],
	[820, 1180],
	[768, 1024],
	[390, 844],
];

const browser = await chromium.launch({
	executablePath: process.env.CHROME_BIN ?? "/usr/bin/chromium",
	// --hide-scrollbars is a playwright default; keep scrollbars on so the
	// themed scrollbar surface is provable from shots.
	ignoreDefaultArgs: ["--hide-scrollbars"],
});
for (const url of urls) {
	const name =
		new URL(url).pathname.replace(/^\//, "").replace(/\/$/, "").replaceAll("/", "-") || "index";
	for (const [w, h] of sizes) {
		for (const theme of ["light", "dark"]) {
			const ctx = await browser.newContext({
				viewport: { width: w, height: h },
				reducedMotion: "reduce",
				colorScheme: theme,
			});
			// Pin the theme through the site's own storage path so the head
			// script applies it before first paint. Pinning after load leaves
			// below-fold subtrees serving stale inherited colors until a later
			// restyle, and a fullPage shot paints exactly that stale state (seen
			// as phantom dark ink on the light page); born-in-theme rendering has
			// no race.
			await ctx.addInitScript((t) => {
				try {
					localStorage.setItem("torus-theme", t);
				} catch {}
			}, theme);
			const page = await ctx.newPage();
			await page.goto(url, { waitUntil: "networkidle" });
			// Force the settled reveal state: IntersectionObserver timing and
			// the staggered segment boot must never decide what an audit shot
			// shows; the class change also restyles every reveal subtree ahead of
			// the fullPage paint.
			await page.evaluate(() => {
				for (const el of document.querySelectorAll("[data-reveal]")) el.classList.add("is-visible");
			});
			await page.waitForTimeout(150);
			await page.screenshot({ path: `${outDir}/${name}-${w}x${h}-${theme}.png`, fullPage: true });
			await ctx.close();
		}
	}
	console.log(`shot ${name}`);
}
await browser.close();
