import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(path.join(root, "docs/extensions.md"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function collectTs(dir, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectTs(full, acc);
		else if (entry.name.endsWith(".ts")) acc.push(full);
	}
	return acc;
}

const sources = collectTs(path.join(root, "extensions"))
	.map((f) => readFileSync(f, "utf8"))
	.join("\n");

test("every pi.extensions entry appears in docs/extensions.md", () => {
	for (const entry of pkg.pi.extensions) {
		let name;
		if (entry.startsWith("./node_modules/")) {
			name = entry.split("/")[2];
		} else {
			name = path.basename(entry);
		}
		assert.ok(doc.includes(name), `docs/extensions.md missing extension: ${name} (${entry})`);
	}
});

test("every registered tool/check name in extensions/ appears in docs/extensions.md", () => {
	const names = [...sources.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
	assert.ok(names.length > 20, `tool-name extraction looks broken (found ${names.length})`);
	for (const name of new Set(names)) {
		assert.ok(doc.includes(name), `docs/extensions.md missing tool/check name: ${name}`);
	}
});

test("every TORUS_* env read in extensions/ appears in docs/extensions.md", () => {
	const vars = [...sources.matchAll(/process\.env\["(TORUS_[A-Z_]+)"\]/g)].map((m) => m[1]);
	assert.ok(vars.length > 15, `env-var extraction looks broken (found ${vars.length})`);
	for (const v of new Set(vars)) {
		assert.ok(doc.includes(v), `docs/extensions.md missing env var: ${v}`);
	}
});

test("docs/skills.md exists and documents Agent Skills portability", () => {
	const skillsDocPath = path.join(root, "docs/skills.md");
	assert.ok(existsSync(skillsDocPath), "docs/skills.md does not exist");
	const skillsDoc = readFileSync(skillsDocPath, "utf8");
	for (const token of ["~/.agents/skills/", "~/.claude/skills/", "agentskills.io"]) {
		assert.ok(skillsDoc.includes(token), `docs/skills.md missing token: ${token}`);
	}
});

test("docs/instructions.md exists and documents AGENTS.md discovery and precedence", () => {
	const instructionsDocPath = path.join(root, "docs/instructions.md");
	assert.ok(existsSync(instructionsDocPath), "docs/instructions.md does not exist");
	const instructionsDoc = readFileSync(instructionsDocPath, "utf8");
	for (const token of ["{{AGENTS}}", "CLAUDE.md", "subdirector"]) {
		assert.ok(instructionsDoc.includes(token), `docs/instructions.md missing token: ${token}`);
	}
});

test("SECURITY.md exists and documents trust handoffs and disclosure", () => {
	const securityDocPath = path.join(root, "SECURITY.md");
	assert.ok(existsSync(securityDocPath), "SECURITY.md does not exist");
	const securityDoc = readFileSync(securityDocPath, "utf8");
	for (const token of ["keywords.json", "Disclosure"]) {
		assert.ok(securityDoc.includes(token), `SECURITY.md missing token: ${token}`);
	}
});

test("MCP per-agent exposure policy is documented", () => {
	const start = doc.indexOf("### `mcp`");
	assert.ok(start !== -1, "docs/extensions.md missing the mcp section");
	const end = doc.indexOf("\n### ", start);
	const section = doc.slice(start, end === -1 ? undefined : end);
	for (const token of ['exposure: "direct"', 'exposure: "codemode"', "mcp__grep_app__*"]) {
		assert.ok(
			section.includes(token),
			`docs/extensions.md mcp section missing policy token: ${token}`,
		);
	}
});

test("MCP spec status and stateless-server smoke are documented", () => {
	for (const token of ["2025-11-25", "2026-07-28"]) {
		assert.ok(doc.includes(token), `docs/extensions.md missing MCP spec revision: ${token}`);
	}
	assert.ok(doc.includes("MCP spec status"), "docs/extensions.md missing the MCP spec status note");
	const smokeDocPath = path.join(root, "docs/smoke-checklist.md");
	assert.ok(existsSync(smokeDocPath), "docs/smoke-checklist.md does not exist");
	const smokeDoc = readFileSync(smokeDocPath, "utf8");
	assert.ok(smokeDoc.includes("stateless"), "docs/smoke-checklist.md missing stateless MCP smoke");
});
