import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RETIRED_KEYWORDS = /\b(ultrawork|hyperplan)\b/i;
const FILLER = /\b(easy|simple|quick|just|very|really|simply)\b/i;
const EMDASH = /—/;

// CHANGELOG.md is release-please output; everything else under test is
// hand-written. docs/efficiency.md is hand-maintained (numbers pasted from
// bench runs), so its prose follows the rubric like any other page.
const GENERATED = new Set(["CHANGELOG.md"]);

// Lines whose em dash is an output-format grammar token rather than prose.
const EMDASH_ALLOWLIST = [
	{ file: path.join("agents", "dreamer.md"), pattern: /^DELETE: </ },
	{
		file: path.join("skills", "torus-roadmap", "assets", "ROADMAP.example.md"),
		pattern: /^(# Roadmap |- R\d+\. )/,
	},
];

// Quoted phrases are data (someone else's voice, counterexamples, marketing being
// criticized), not author voice; the rubric exempts them from the filler ban.
const FILLER_ALLOWLIST = [
	{
		pattern: /"[^"]*\b(just|quick|simple|easy|very|really|simply)\b[^"]*"/i,
	},
];

function collectMd(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = path.relative(root, path.join(dir, entry.name));
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
			collectMd(path.join(dir, entry.name), acc);
		} else if (entry.name.endsWith(".md")) {
			if (!GENERATED.has(rel)) acc.push(rel);
		}
	}
	return acc;
}

const files = collectMd(root);

function allowed(rel, line, list) {
	return list.some(
		(entry) =>
			(entry.file === undefined || rel === entry.file.split(path.sep).join(path.sep)) &&
			entry.pattern.test(line),
	);
}

test("retired keyword names never reappear in hand-written docs", () => {
	for (const rel of files) {
		const text = readFileSync(path.join(root, rel), "utf8");
		const hit = text.match(RETIRED_KEYWORDS);
		assert.ok(
			!hit,
			`${rel} contains retired keyword "${hit?.[1]}" (gates are deepwork, blueprint, team)`,
		);
	}
});

test("no em dashes in prose (code spans, fences, and grammar tokens exempt)", () => {
	for (const rel of files) {
		const lines = readFileSync(path.join(root, rel), "utf8").split("\n");
		let inFence = false;
		for (const line of lines) {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				continue;
			}
			if (inFence) continue;
			const bare = line.replace(/`[^`\n]*`/g, "");
			if (EMDASH.test(bare)) {
				assert.ok(
					allowed(rel, line, EMDASH_ALLOWLIST),
					`${rel}: em dash in prose: ${line.trim().slice(0, 80)}`,
				);
			}
		}
	}
});

test("no banned filler words in author voice (quotes exempt)", () => {
	for (const rel of files) {
		const lines = readFileSync(path.join(root, rel), "utf8").split("\n");
		let inFence = false;
		for (const line of lines) {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				continue;
			}
			if (inFence) continue;
			const bare = line.replace(/`[^`\n]*`/g, "");
			const hit = bare.match(FILLER);
			if (hit) {
				assert.ok(
					allowed(rel, line, FILLER_ALLOWLIST),
					`${rel}: banned filler "${hit[1]}": ${line.trim().slice(0, 80)}`,
				);
			}
		}
	}
});

test("every skill directory's SKILL.md opens with an H1 equal to the directory name", () => {
	const skillsDir = path.join(root, "skills");
	for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const text = readFileSync(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
		const h1 = text.match(/^# (.+)$/m)?.[1]?.trim();
		assert.equal(h1, entry.name, `skills/${entry.name}/SKILL.md H1 must be "# ${entry.name}"`);
	}
});

function githubAnchor(heading) {
	return heading
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-");
}

test("relative markdown links resolve to files and anchors", () => {
	const linkRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	for (const rel of files) {
		const text = readFileSync(path.join(root, rel), "utf8");
		const stripped = text.replace(/```[\s\S]*?```/g, "");
		for (const match of stripped.matchAll(linkRe)) {
			const target = match[2];
			if (/^(https?:|mailto:|#)/.test(target)) continue;
			const [filePart, anchor] = target.split("#");
			const resolved = path.resolve(root, path.dirname(rel), decodeURIComponent(filePart));
			assert.ok(
				existsSync(resolved),
				`${rel}: broken relative link target ${target} (resolved ${path.relative(root, resolved)})`,
			);
			if (!anchor) continue;
			const anchorFile = filePart ? resolved : path.join(root, rel);
			const headings = readFileSync(anchorFile, "utf8")
				.split("\n")
				.filter((line) => /^#{1,6} /.test(line));
			const anchors = new Set(headings.map((h) => githubAnchor(h.replace(/^#{1,6} /, ""))));
			assert.ok(
				anchors.has(anchor),
				`${rel}: link ${target} points at missing anchor "#${anchor}" (has: ${[...anchors].slice(0, 8).join(", ")})`,
			);
		}
	}
});

test("README quickstart: the pi-package install leads the from-source clone", () => {
	const readme = readFileSync(path.join(root, "README.md"), "utf8");
	const pkg = readme.indexOf("pi install git:");
	const clone = readme.indexOf("git clone");
	assert.ok(pkg !== -1, "README no longer shows the pi-package install command");
	assert.ok(clone !== -1, "README no longer shows the from-source clone");
	assert.ok(
		pkg < clone,
		"README ordering contract: pi install must appear before git clone (flip this test when npm publishing arrives)",
	);
});

test("node floor stays in sync with package.json engines", () => {
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const floor = pkg.engines.node.match(/(\d+)\.(\d+)/);
	assert.ok(floor, `package.json engines.node has no major.minor floor: ${pkg.engines.node}`);
	const [major, minor] = [floor[1], floor[2]];
	const floorRe = new RegExp(`Node[^\n]*${major}\\.${minor}`);
	for (const rel of ["README.md", path.join("site", "src", "pages", "index.astro")]) {
		// index.astro is not markdown, so the md-walker never collects it; read it directly
		const text = readFileSync(path.join(root, rel), "utf8");
		assert.ok(
			floorRe.test(text),
			`${rel}: expected Node floor ${major}.${minor} (package.json engines.node) near a Node mention`,
		);
	}
});

test("coverage-sliced headings in the extension reference exist exactly once", () => {
	const doc = readFileSync(path.join(root, "docs", "extensions.md"), "utf8");
	const guarded = [
		"### `mcp`",
		"### `providers`",
		"### `acp`",
		"## Ambient model calls",
		"## Configuration",
		"## `torus serve`",
	];
	for (const heading of guarded) {
		const count = doc.split("\n").filter((line) => line === heading).length;
		assert.equal(
			count,
			1,
			`docs/extensions.md heading "${heading}" must appear exactly once (got ${count})`,
		);
	}
	const serve = readFileSync(path.join(root, "docs", "serve.md"), "utf8");
	assert.equal(
		serve.split("\n").filter((line) => line === "## ACP agent (`torus acp-agent`)").length,
		1,
		'docs/serve.md heading "## ACP agent (`torus acp-agent`)" must appear exactly once',
	);
});
