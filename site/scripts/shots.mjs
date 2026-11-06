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
			const page = await ctx.newPage();
			await page.goto(url, { waitUntil: "networkidle" });
			// Pin the theme so the shot matches the emulated scheme even if the
			// system preference disagrees; reveal rules never hide content under
			// reduced motion, so fullPage needs no scroll prepass.
			await page.evaluate((t) => {
				document.documentElement.dataset.theme = t;
			}, theme);
			await page.waitForTimeout(150);
			await page.screenshot({ path: `${outDir}/${name}-${w}x${h}-${theme}.png`, fullPage: true });
			await ctx.close();
		}
	}
	console.log(`shot ${name}`);
}
await browser.close();
