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
