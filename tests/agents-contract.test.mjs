import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// docs/agents.md contract, machine-enforced subset: frontmatter schema,
// name=filename, whitelist validity + body coupling, retired-name denylist,
// marker allowlist, body presence. The loader is silent on malformed files —
// this test is the error message.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, "agents");

const { parseAgentFile } = await import("../extensions/roster/index.ts");
const { parseFrontmatter } = await import("../extensions/frontmatter.ts");

// Real tool names a `tools:` whitelist may name. Verified against a spawned
// child's actual system prompt (see docs/agents.md); extend only after a live
// spawn proves a new name.
const KNOWN_TOOLS = new Set([
	// pi built-ins
	"read",
	"bash",
	"edit",
	"write",
	"find",
	"grep",
	"ls",
	// torus extension tools
	"look_at",
	"hashline_edit",
	"torus_astgrep",
	"work_note",
	// pi-web-access
	"web_search",
	"fetch_content",
	"get_search_content",
	"source_check",
	// MCP direct exposure (mcp__<server>__<tool>)
	"mcp__context7__resolve_library_id",
	"mcp__context7__query_docs",
	"mcp__grep_app__searchGitHub",
]);

const KNOWN_FIELDS = new Set(["name", "description", "chain", "mode", "tools", "aliases", "model"]);

// Port artifacts and phantom conventions from the OmO-era prompts
// (docs/agents.md "No phantom tools"), plus literal \uXXXX escape sequences —
// prompts must carry real characters, not escape-sequence text.
const DENYLIST = [
	/websearch_/,
	/webfetch/,
	/web fetch via curl/,
	/mcp\(\s*\{/,
	/mcp proxy tool/i,
	/\\u[0-9a-fA-F]{4}/,
];

const LIVE_MARKERS = new Set(["AGENTS", "DELEGATION"]);

const files = readdirSync(agentsDir)
	.filter((f) => f.endsWith(".md"))
	.sort()
	.map((f) => ({ file: f, raw: readFileSync(path.join(agentsDir, f), "utf8") }));

test("agents directory holds only parseable agents", () => {
	assert.ok(files.length >= 7, `expected >=7 agent files, got ${files.length}`);
	for (const { file, raw } of files) {
		const def = parseAgentFile(file, raw);
		assert.ok(
			def,
			`${file}: loader would silently drop this file (frontmatter/description missing)`,
		);
	}
});

test("frontmatter schema: known fields only, valid values, name = filename stem", () => {
	for (const { file, raw } of files) {
		const parsed = parseFrontmatter(raw);
		assert.ok(parsed, `${file}: frontmatter unparseable`);
		const stem = path.basename(file, ".md");
		for (const field of parsed.fields.keys()) {
			assert.ok(
				KNOWN_FIELDS.has(field),
				`${file}: unknown frontmatter field "${field}" — loader ignores it silently`,
			);
		}
		const def = parseAgentFile(file, raw);
		assert.ok(def, `${file}: parseAgentFile rejected it`);
		assert.equal(def.name, stem, `${file}: name "${def.name}" must equal filename stem "${stem}"`);
		if (parsed.fields.has("mode")) {
			assert.ok(
				["child", "session"].includes(def.mode ?? ""),
				`${file}: mode must be child|session (typos silently default to child)`,
			);
		}
		const description = def.description ?? "";
		assert.ok(
			description.length > 0 && description.length <= 200 && !description.includes("\n"),
			`${file}: description must be one line, 1-200 chars`,
		);
		if (parsed.fields.has("chain")) {
			assert.ok(
				["fast", "primary"].includes(def.chain),
				`${file}: chain must be fast|primary (typos silently default to primary)`,
			);
		}
		for (const alias of def.commandAliases ?? []) {
			assert.match(alias, /^[a-z0-9-]+$/, `${file}: alias "${alias}" must match ^[a-z0-9-]+$`);
		}
		for (const tool of def.tools ?? []) {
			assert.ok(
				KNOWN_TOOLS.has(tool),
				`${file}: tools entry "${tool}" is not a real tool name — verify in a live child, then extend KNOWN_TOOLS`,
			);
		}
	}
});

test("whitelisted agents teach every granted tool in the body", () => {
	for (const { file, raw } of files) {
		const def = parseAgentFile(file, raw);
		assert.ok(def);
		if (!def.tools) continue;
		const body = def.promptBody ?? "";
		for (const tool of def.tools) {
			assert.ok(
				body.includes(tool),
				`${file}: tool "${tool}" is granted by the whitelist but never mentioned in the body — teach it or drop it`,
			);
		}
	}
});

test("no phantom tool names or retired conventions in bodies", () => {
	for (const { file, raw } of files) {
		const body = parseFrontmatter(raw)?.body ?? "";
		for (const pattern of DENYLIST) {
			assert.ok(
				!pattern.test(body),
				`${file}: body matches retired/phantom pattern ${pattern} — real names: see docs/agents.md`,
			);
		}
	}
});

test("only live substitution markers appear in bodies", () => {
	for (const { file, raw } of files) {
		const body = parseFrontmatter(raw)?.body ?? "";
		for (const match of body.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
			assert.ok(
				LIVE_MARKERS.has(match[1] ?? ""),
				`${file}: marker {{${match[1]}}} is not live (substitutes to empty) — use {{AGENTS}} or {{DELEGATION}}`,
			);
		}
	}
});

test("every agent body carries real prompt content", () => {
	for (const { file, raw } of files) {
		const body = (parseFrontmatter(raw)?.body ?? "").trim();
		assert.ok(
			body.length >= 40,
			`${file}: body too thin to be a system prompt — loader fallback is not authoring`,
		);
	}
});

const MANDATORY_SECTIONS = ["Role", "Boundaries", "Tools", "Process", "Output"];

// docs/agents.md child skeleton: Role, Boundaries, Tools, Process, Output,
// (optional Failure), Discipline — in this order, no other H2s. Session
// personas (leader) are exempt: they use XML-style tags to match the host
// system prompt they are spliced into.
test("child agents follow the canonical skeleton section order", () => {
	for (const { file, raw } of files) {
		const parsed = parseFrontmatter(raw);
		assert.ok(parsed);
		const mode = parsed.fields.get("mode");
		if (mode === "session") continue;
		// strip fenced code blocks so example content cannot fake section headers
		const body = (parsed.body ?? "").replace(/^```[\s\S]*?^```/gm, "");
		const sections = [...body.matchAll(/^## ([A-Za-z]+)/gm)].map((m) => m[1]);
		const expected = [...MANDATORY_SECTIONS];
		if (sections.includes("Failure")) expected.push("Failure");
		expected.push("Discipline");
		assert.deepEqual(
			sections,
			expected,
			`${file}: H2 sections must be Role, Boundaries, Tools, Process, Output, (Failure,) Discipline — no other H2s (docs/agents.md)`,
		);
	}
});
