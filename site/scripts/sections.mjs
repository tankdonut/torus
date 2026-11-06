// Usage: node scripts/sections.mjs [url] — prints each section's height in
// viewport units at the shipped widths, for the one-section-per-screen audit.
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://127.0.0.1:4323/";
const sizes = [
	[1440, 900],
	[1024, 900],
	[768, 1024],
	[390, 844],
];
const browser = await chromium.launch({
	executablePath: process.env.CHROME_BIN ?? "/usr/bin/chromium",
});
for (const [w, h] of sizes) {
	const ctx = await browser.newContext({ viewport: { width: w, height: h } });
	const page = await ctx.newPage();
	await page.goto(url, { waitUntil: "networkidle" });
	const rows = await page.evaluate(() => {
		const vh = window.innerHeight;
		const out = [];
		for (const el of document.querySelectorAll("main > section, main > .hero")) {
			const r = el.getBoundingClientRect();
			const label = el.querySelector(".section-label")?.textContent ?? el.className;
			out.push(`${label}: ${(r.height / vh).toFixed(2)}vh`);
		}
		return out;
	});
	console.log(`\n${w}x${h} (viewport ${h}px):`);
	for (const row of rows) console.log(`  ${row}`);
	await ctx.close();
}
await browser.close();
