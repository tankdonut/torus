import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { parseMarkdown, renderDocument, slugifyGithub, contrastRatio } = await import(
	"../skills/torus-research/bin/render-report.mjs"
);

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(here, "../skills/torus-research/bin/render-report.mjs");
const cssPath = join(here, "../skills/torus-research/assets/report.css");
const cssText = readFileSync(cssPath, "utf8");

const render = (markdown, options = {}) =>
	renderDocument(markdown, { renderedAt: new Date("2026-10-06T12:00:00Z"), ...options });

const mainOf = (html) => /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? "";

const mediaPrintBlock = (css) => {
	const start = css.indexOf("@media print");
	assert.ok(start !== -1, "no @media print block");
	let depth = 0;
	for (let i = start; i < css.length; i++) {
		if (css[i] === "{") {
			depth++;
		} else if (css[i] === "}") {
			depth--;
			if (depth === 0) {
				return css.slice(start, i + 1);
			}
		}
	}
	assert.fail("unbalanced braces in @media print");
};

test("slugifyGithub: github-compatible ids for authored anchors", () => {
	assert.equal(slugifyGithub("1. Landscape overview"), "1-landscape-overview");
	assert.equal(slugifyGithub("torus × pi engine"), "torus--pi-engine");
	assert.equal(
		slugifyGithub("3. torus comparison (ahead / behind / unique)"),
		"3-torus-comparison-ahead--behind--unique",
	);
	assert.equal(slugifyGithub("  Spaced  out  heading "), "spaced--out--heading");
});

test("inline parsing escapes raw html, never passes it through", () => {
	const html = render("# T\n\nuses <b>tags</b>, 1 < 2 && 3 > 2, already &amp; here");
	assert.ok(html.includes("&lt;b&gt;tags&lt;/b&gt;"));
	assert.ok(html.includes("1 &lt; 2 &amp;&amp; 3 &gt; 2"));
	assert.ok(html.includes("&amp;amp;"));
	assert.ok(!html.includes("<b>tags</b>"));
});

test("parseMarkdown consumes h1 + first paragraph as the masthead", () => {
	const parsed = parseMarkdown("# Title here\n\nMeta line one.\n\nBody stays.\n\n## Section");
	assert.equal(parsed.title, "Title here");
	assert.equal(parsed.meta, "Meta line one.");

	const html = render("# Title here\n\nMeta line one.\n\nBody stays.\n\n## Section");
	const main = mainOf(html);
	assert.ok(html.includes('<h1 class="report-title">Title here</h1>'));
	assert.ok(html.includes('class="meta"'));
	assert.ok(!main.includes("<h1"));
	assert.ok(!main.includes("Meta line one"));
	assert.ok(main.includes("Body stays"));
});

test("table cells carry inline links, bold, and alignment", () => {
	const html = render(
		"| Name | Stars |\n|---|---:|\n| [pi](https://example.com/pi) | **112,944** |",
	);
	assert.ok(html.includes('<a href="https://example.com/pi">pi</a>'));
	assert.ok(html.includes("<strong>112,944</strong>"));
	assert.ok(html.includes('style="text-align:right"'));
});

test("heading ids match toc anchors", () => {
	const html = render(
		"# T\n\nmeta\n\n## 1. Alpha\n\ntext\n\n### 1.1 Beta × gamma\n\nmore\n\n## Two",
	);
	const nav = /<nav class="toc"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
	const hrefs = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(hrefs, ["1-alpha", "11-beta--gamma", "two"]);
	for (const href of hrefs) {
		assert.ok(mainOf(html).includes(`id="${href}"`), href);
	}
});

test("typographic normalization hits text nodes only", () => {
	const html = render(
		'# T\n\nmeta\n\nHe said "ok"... it\'s fine, and **"kept"** too; see ["raw" q](https://e.com/x) and code `"x"...` now',
	);
	assert.ok(html.includes("“ok”…"));
	assert.ok(html.includes("it’s"));
	assert.ok(html.includes("<strong>“kept”</strong>"));
	assert.ok(html.includes('<code>"x"...</code>'));
	const anchor = /<a [^>]*>[\s\S]*?<\/a>/.exec(mainOf(html))?.[0] ?? "";
	assert.ok(anchor.includes('"raw" q'));
	assert.ok(!anchor.includes("“"));
});

test("[S<n>] becomes a cite span outside links, stays literal inside them", () => {
	const html = render("# T\n\nmeta\n\nClaim [S3] holds; see [[S3] the source](https://e.com/s3).");
	assert.equal((html.match(/<span class="cite">\[S3\]<\/span>/g) ?? []).length, 1);
	const anchor = /<a [^>]*>[\s\S]*?<\/a>/.exec(mainOf(html))?.[0] ?? "";
	assert.ok(anchor.includes("[S3]"));
	assert.ok(!anchor.includes("cite"));
});

test("output is standalone and carries the theme machinery", () => {
	const html = render("# T\n\nmeta\n\n## S\n\nbody", {
		date: "2026-10-06",
		sourcePath: "/journal/2026-10-06-scan/REPORT.md",
	});
	assert.ok(html.startsWith("<!DOCTYPE html>"));
	assert.ok(html.includes('lang="en"'));
	assert.ok(!html.includes("<link"));
	const style = /<style>[\s\S]*?<\/style>/.exec(html)?.[0] ?? "";
	assert.ok(style);
	assert.ok(!style.includes("url("));
	assert.ok(html.includes('data-theme="light"'));
	assert.ok(style.includes("html[data-theme="));
	assert.ok(style.includes("color-scheme: light"));
	assert.ok(style.includes("color-scheme: dark"));
	assert.equal((html.match(/<meta name="theme-color"/g) ?? []).length, 2);
	assert.ok(style.includes(":focus-visible"));
	assert.ok(style.includes("prefers-reduced-motion"));
	assert.ok(style.includes("@media print"));
	assert.ok(html.includes(">2026-10-06</p>"));
	assert.ok(html.includes("/journal/2026-10-06-scan/REPORT.md"));
});

test("theme token pairs clear 4.5:1 in both themes", () => {
	const themes = {};
	for (const block of cssText.matchAll(/html\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
		const tokens = {};
		for (const decl of block[2].matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) {
			tokens[decl[1]] = decl[2];
		}
		themes[block[1]] = tokens;
	}
	for (const theme of ["light", "dark"]) {
		const tokens = themes[theme];
		assert.ok(tokens, `missing ${theme} token block`);
		for (const [fg, bg] of [
			["ink", "paper"],
			["muted", "paper"],
			["accent", "paper"],
			["accent-ink", "accent"],
		]) {
			const ratio = contrastRatio(tokens[fg], tokens[bg]);
			assert.ok(
				ratio >= 4.5,
				`${theme}: ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} = ${ratio.toFixed(2)}`,
			);
		}
	}
});

test("print stylesheet carries the pagination rules", () => {
	const print = mediaPrintBlock(cssText);
	assert.ok(print.includes("@page"));
	assert.ok(print.includes("margin: 18mm 16mm"));
	assert.ok(print.includes("display: table-header-group"));
	assert.ok(print.includes("break-inside: avoid"));
	assert.ok(print.includes("orphans: 3"));
	assert.ok(print.includes("widows: 3"));
	assert.ok(print.includes("font-size: 11pt"));
	assert.ok(print.includes("font-size: 9.5pt"));
	assert.ok(print.includes("overflow-wrap: anywhere"));
	assert.ok(/\.theme-toggle[\s\S]{0,120}display:\s*none/.test(print));
	assert.ok(cssText.includes("ul:has(> li > strong:first-child)"));
	assert.ok(
		/ul:has\(> li > strong:first-child\) > li\s*\{[^}]*break-inside:\s*avoid/.test(cssText),
	);
});

test("evidence and citation selectors match the emitted markup", () => {
	const markdown = [
		"# Fixture report",
		"",
		"**Owner**: scout",
		"",
		"## Findings",
		"",
		"| Key | Says |",
		"|---|---|",
		"| [S3] | holds [S3] |",
		"",
		"- **Claim**: the pin holds.",
		"- **Evidence**: the feed confirms it.",
		"- **Explanation**: keep the pin.",
		"",
		"Plain bullet without a label stays out of the group when alone.",
	].join("\n");
	const html = render(markdown, { date: "2026-10-06", sourcePath: "/j/REPORT.md" });

	assert.ok(cssText.includes("ul:has(> li > strong:first-child)"));
	assert.ok(/<ul>\s*<li><strong>Claim<\/strong>: the pin holds\.<\/li>/.test(html));
	assert.ok(html.includes("<li><strong>Evidence</strong>: the feed confirms it.</li>"));

	assert.ok(cssText.includes(".cite"));
	assert.ok(html.includes('<span class="cite">[S3]</span>'));

	assert.ok(cssText.includes("thead"));
	assert.ok(html.includes("<thead>"));

	const styledClasses = [
		...new Set([...cssText.matchAll(/\.([a-z][a-z0-9-]+)/g)].map((m) => m[1])),
	];
	assert.ok(styledClasses.length >= 8, styledClasses.join(" "));
	for (const cls of styledClasses) {
		assert.ok(
			new RegExp(`class="[^"]*\\b${cls}\\b`).test(html),
			`css class .${cls} matches nothing in the rendered output`,
		);
	}
});

test("full fixture: 6-col table, bold-label bullets, anchor round-trip", () => {
	const markdown = [
		"# Harness landscape",
		"",
		"**Owner**: scout · scan 2026-10-06",
		"",
		"[Jump](#1-overview)",
		"",
		"| # | Harness | Lang | Stars | Latest | Cadence |",
		"|---|---------|------|-------:|--------|---------|",
		"| 1 | [pi](https://e.com/pi) | TS | 112,944 | v1.0.4 | steady |",
		"| 2 | torus | TS | 0 | — | day-2 |",
		"",
		"- **Claim**: the engine pin holds.",
		"- **Evidence**: the feed [S3] confirms cadence.",
		"- **Explanation**: keep the pin.",
		"",
		"## 1. Overview",
		"",
		'Intro with "quotes"... and `code`.',
		"",
		"### 1.1 Detail",
		"",
		"More.",
	].join("\n");
	const html = render(markdown, { date: "2026-10-06", sourcePath: "/j/REPORT.md" });
	const main = mainOf(html);
	assert.ok(main.includes("<table"));
	assert.equal((main.match(/<th[\s>]/g) ?? []).length, 6);
	assert.ok(main.includes("<li><strong>Claim</strong>: the engine pin holds.</li>"));
	assert.ok(main.includes('<span class="cite">[S3]</span>'));
	assert.ok(main.includes('<a href="#1-overview">Jump</a>'));
	assert.ok(main.includes('id="1-overview"'));
	assert.ok(main.includes('id="11-detail"'));
	assert.ok(html.includes('<h1 class="report-title">Harness landscape</h1>'));
	assert.ok(html.includes('class="meta"'));
	assert.ok(!main.includes("<h1"));
});

test("cli: date falls out of the journal dirname", () => {
	const dir = mkdtempSync(join(tmpdir(), "2026-03-09-report-"));
	try {
		writeFileSync(join(dir, "REPORT.md"), "# Dated\n\nmeta line\n\n## Section\n\nBody.");
		const run = spawnSync(process.execPath, [scriptPath, dir], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.ok(run.stdout.trim().endsWith(join(dir, "REPORT.html")), run.stdout);
		assert.ok(readFileSync(join(dir, "REPORT.html"), "utf8").includes("2026-03-09"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cli: missing input and dir without REPORT.md fail loudly", () => {
	const missing = spawnSync(process.execPath, [scriptPath, "/nonexistent-xyz.md"], {
		encoding: "utf8",
	});
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /\/nonexistent-xyz\.md/);

	const dir = mkdtempSync(join(tmpdir(), "plain-dir-"));
	try {
		const noReport = spawnSync(process.execPath, [scriptPath, dir], { encoding: "utf8" });
		assert.notEqual(noReport.status, 0);
		assert.match(noReport.stderr, /REPORT\.md/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
