import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Agent Skills open standard, machine-enforced subset for every packaged
// skill. Rules inlined from https://agentskills.io/specification — consumers
// silently drop malformed skills, so this test is the error message:
//   1. each skills/<dir>/ contains SKILL.md (the only required file; extra
//      files and directories — scripts/, references/, assets/, agents/… —
//      are conventions, never violations)
//   2. SKILL.md is `---`-delimited YAML frontmatter followed by a non-empty
//      markdown body
//   3. frontmatter `name`: required, non-empty, 1–64 chars
//   4. `name` charset: ^[a-z0-9]+(-[a-z0-9]+)*$ — lowercase alphanumerics and
//      single hyphens; no leading/trailing hyphen, no `--`, no underscores
//   5. `name` must equal the parent directory name
//   6. frontmatter `description`: required, non-empty, 1–1024 chars
//   7. optional fields are exactly: license (string), compatibility
//      (1–500 chars), metadata (string→string map), allowed-tools
//      (space-separated string). Any other frontmatter key is rejected —
//      unknown fields fail closed, like the spec's own validator.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = path.join(root, "skills");

const SKILLS = readdirSync(skillsDir, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort()
	.map((dir) => {
		let raw = null;
		try {
			raw = readFileSync(path.join(skillsDir, dir, "SKILL.md"), "utf8");
		} catch {
			raw = null; // rule 1 owns this failure
		}
		return { dir, raw };
	});

const OPTIONAL_FIELDS = new Set(["license", "compatibility", "metadata", "allowed-tools"]);

function splitSkillFile(raw) {
	const lines = raw.split(/\r?\n/);
	if (lines[0] !== "---") return null;
	const end = lines.indexOf("---", 1);
	if (end === -1) return null;
	return { fmLines: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

// Top-level `key: value` scalars (bare or quoted), block scalars (`|`, `>`),
// and one nesting level for `metadata`. Not a general YAML parser — anything
// it cannot shape surfaces as a rule violation below.
function parseFrontmatter(fmLines) {
	const entries = [];
	let cur = null;
	for (const line of fmLines) {
		if (cur?.block && (line === "" || /^[ \t]/.test(line))) {
			cur.block.lines.push(line);
			continue;
		}
		const header = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
		if (header && !/^[ \t]/.test(line)) {
			const block = /^([|>])[+-]?$/.exec(header[2]);
			cur = block
				? { key: header[1], value: "", nested: [], block: { folded: block[1] === ">", lines: [] } }
				: { key: header[1], value: header[2], nested: [], block: null };
			entries.push(cur);
			continue;
		}
		if (line === "") continue;
		if (cur) {
			const text = line.trim();
			const colon = text.indexOf(":");
			cur.nested.push(
				colon > 0 ? [text.slice(0, colon).trim(), text.slice(colon + 1).trim()] : [text, ""],
			);
		}
	}
	for (const e of entries) {
		if (!e.block) continue;
		const indents = e.block.lines
			.filter((l) => l.trim() !== "")
			.map((l) => (/^[ \t]*/.exec(l) ?? [""])[0].length);
		const strip = indents.length > 0 ? Math.min(...indents) : 0;
		e.value = e.block.lines
			.map((l) => (l.trim() === "" ? "" : l.slice(strip)))
			.join(e.block.folded ? " " : "\n")
			.trim();
	}
	return entries;
}

function scalar(value) {
	const t = value.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
		return t.slice(1, -1);
	}
	return t;
}

function field(entries, key) {
	return entries.find((e) => e.key === key) ?? null;
}

test("every skill directory contains SKILL.md, the only required file", () => {
	assert.ok(SKILLS.length >= 7, `expected >=7 packaged skills, got ${SKILLS.length}`);
	for (const { dir, raw } of SKILLS) {
		assert.ok(
			raw !== null,
			`skills/${dir}: SKILL.md missing — the Agent Skills format requires exactly this file (everything else in the directory is optional)`,
		);
	}
});

test("SKILL.md is `---`-delimited frontmatter plus a non-empty markdown body", () => {
	for (const { dir, raw } of SKILLS) {
		if (raw === null) continue; // flagged by the required-file rule
		const split = splitSkillFile(raw);
		assert.ok(
			split,
			`skills/${dir}: SKILL.md must open with a \`---\` line and close the frontmatter with a second \`---\``,
		);
		assert.ok(
			split.fmLines.length > 0,
			`skills/${dir}: frontmatter block between the \`---\` markers is empty`,
		);
		assert.ok(
			split.body.trim().length > 0,
			`skills/${dir}: markdown body below the frontmatter must be non-empty`,
		);
	}
});

test("frontmatter name: required, 1-64 chars, lowercase charset, equals directory name", () => {
	for (const { dir, raw } of SKILLS) {
		if (raw === null) continue;
		const split = splitSkillFile(raw);
		if (!split) continue; // flagged by the structure rule
		const entry = field(parseFrontmatter(split.fmLines), "name");
		assert.ok(entry, `skills/${dir}: required frontmatter field "name" is missing`);
		const name = scalar(entry.value);
		assert.ok(
			name.length >= 1 && name.length <= 64,
			`skills/${dir}: name must be 1-64 chars, got ${name.length === 0 ? "empty" : `${name.length} chars`}`,
		);
		assert.match(
			name,
			/^[a-z0-9]+(-[a-z0-9]+)*$/,
			`skills/${dir}: name "${name}" violates the charset rule ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumerics with single hyphens — no leading/trailing/doubled hyphen, no underscores)`,
		);
		assert.equal(name, dir, `skills/${dir}: frontmatter name must equal the skill directory name`);
	}
});

test("frontmatter description: required, 1-1024 chars", () => {
	for (const { dir, raw } of SKILLS) {
		if (raw === null) continue;
		const split = splitSkillFile(raw);
		if (!split) continue;
		const entry = field(parseFrontmatter(split.fmLines), "description");
		assert.ok(entry, `skills/${dir}: required frontmatter field "description" is missing`);
		const description = scalar(entry.value);
		assert.ok(
			description.length >= 1 && description.length <= 1024,
			`skills/${dir}: description must be 1-1024 chars, got ${description.length === 0 ? "empty" : `${description.length} chars`} — shorten it and move detail into the body`,
		);
	}
});

test("frontmatter fields are name/description plus the spec's optional set only", () => {
	for (const { dir, raw } of SKILLS) {
		if (raw === null) continue;
		const split = splitSkillFile(raw);
		if (!split) continue;
		const entries = parseFrontmatter(split.fmLines);
		const keys = entries.map((e) => e.key);
		assert.equal(
			new Set(keys).size,
			keys.length,
			`skills/${dir}: duplicate frontmatter key — YAML forbids duplicate mappings`,
		);
		for (const key of keys) {
			assert.ok(
				key === "name" || key === "description" || OPTIONAL_FIELDS.has(key),
				`skills/${dir}: unknown frontmatter field "${key}" — the spec allows only name, description, license, compatibility, metadata, allowed-tools`,
			);
		}
		const license = field(entries, "license");
		if (license) {
			assert.ok(
				scalar(license.value).length > 0,
				`skills/${dir}: license must be a non-empty string`,
			);
		}
		const compatibility = field(entries, "compatibility");
		if (compatibility) {
			const value = scalar(compatibility.value);
			assert.ok(
				value.length >= 1 && value.length <= 500,
				`skills/${dir}: compatibility must be 1-500 chars, got ${value.length}`,
			);
		}
		const metadata = field(entries, "metadata");
		if (metadata) {
			assert.ok(
				scalar(metadata.value) === "",
				`skills/${dir}: metadata must be a nested string→string map, not an inline value`,
			);
			for (const [key, value] of metadata.nested) {
				assert.ok(
					key.length > 0 && scalar(value).length > 0,
					`skills/${dir}: metadata entry "${key}" must map a non-empty key to a non-empty string`,
				);
			}
		}
		const allowedTools = field(entries, "allowed-tools");
		if (allowedTools) {
			const value = scalar(allowedTools.value);
			assert.ok(
				value.length > 0,
				`skills/${dir}: allowed-tools must be a non-empty space-separated string`,
			);
			assert.ok(
				value.split(" ").every((t) => t.length > 0),
				`skills/${dir}: allowed-tools must be single-space separated — found an empty token`,
			);
		}
	}
});
