import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { resolveSkillPaths } = await import("../extensions/roster/index.ts");

function fixture(name) {
	const dir = mkdtempSync(path.join(tmpdir(), `skills-containment-${name}-`));
	return dir;
}

test("existing path outside every skill root is rejected, not silently loaded", () => {
	const base = fixture("outside");
	const evil = path.join(base, "secret.md");
	writeFileSync(evil, "x", "utf8");
	const { paths, missing, rejected } = resolveSkillPaths([evil], base);
	assert.deepEqual(paths, []);
	assert.deepEqual(missing, []);
	assert.deepEqual(rejected, [evil]);
});

test("relative traversal that escapes the cwd is rejected", () => {
	const base = fixture("traversal");
	const sibling = mkdtempSync(path.join(tmpdir(), "skills-containment-target-"));
	const target = path.join(sibling, "x.md");
	writeFileSync(target, "x", "utf8");
	const rel = path.relative(base, target);
	const { paths, rejected } = resolveSkillPaths([rel], base);
	assert.deepEqual(paths, []);
	assert.deepEqual(rejected, [rel]);
});

test("path under the cwd .agents/skills root is allowed", () => {
	const base = fixture("agents-root");
	const skillDir = path.join(base, ".agents", "skills");
	mkdirSync(skillDir, { recursive: true });
	const skill = path.join(skillDir, "mine.md");
	writeFileSync(skill, "x", "utf8");
	const { paths, rejected, missing } = resolveSkillPaths([skill], base);
	assert.deepEqual(paths, [skill]);
	assert.deepEqual(rejected, []);
	assert.deepEqual(missing, []);
});

test("subdirectory of an allowed root is allowed; unknown names stay missing", () => {
	const base = fixture("subdir");
	const skillDir = path.join(base, ".agents", "skills", "pack");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(path.join(skillDir, "SKILL.md"), "x", "utf8");
	const { paths, missing } = resolveSkillPaths(["pack", "no-such-skill"], base);
	assert.deepEqual(paths, [skillDir]);
	assert.deepEqual(missing, ["no-such-skill"]);
});

test("payload-manifest pi.skills are discoverable and pass containment", () => {
	const base = fixture("payload");
	const skillDir = path.join(base, "project-skills", "packed");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		path.join(skillDir, "SKILL.md"),
		"---\nname: packed\ndescription: payload fixture skill\n---\nbody\n",
		"utf8",
	);
	writeFileSync(
		path.join(base, "package.json"),
		JSON.stringify({ name: "fixture", pi: { skills: ["./project-skills"] } }),
		"utf8",
	);
	const prevRoot = process.env.TORUS_ROOT;
	process.env.TORUS_ROOT = base;
	try {
		const byName = resolveSkillPaths(["packed"], base);
		assert.deepEqual(byName.missing, []);
		assert.equal(byName.paths.length, 1);
		assert.ok(
			byName.paths[0]?.startsWith(skillDir),
			`resolves under the payload dir: ${byName.paths[0]}`,
		);
		const byPath = resolveSkillPaths([path.join(skillDir, "SKILL.md")], base);
		assert.deepEqual(byPath.rejected, []);
		assert.deepEqual(byPath.paths, [path.join(skillDir, "SKILL.md")]);
	} finally {
		if (prevRoot === undefined) delete process.env.TORUS_ROOT;
		else process.env.TORUS_ROOT = prevRoot;
	}
});

test("delegation-cwd manifests are ignored — parity is with the loaded payload", () => {
	const base = fixture("cwd-manifest");
	const straySkill = path.join(base, "stray-skills", "not-loaded");
	mkdirSync(straySkill, { recursive: true });
	writeFileSync(
		path.join(straySkill, "SKILL.md"),
		"---\nname: not-loaded\ndescription: must stay invisible\n---\nbody\n",
		"utf8",
	);
	writeFileSync(
		path.join(base, "package.json"),
		JSON.stringify({ name: "stray", pi: { skills: ["./stray-skills"] } }),
		"utf8",
	);
	const { paths, missing } = resolveSkillPaths(["not-loaded"], base);
	assert.deepEqual(paths, []);
	assert.deepEqual(missing, ["not-loaded"]);
});

test("the torus repo's own payload manifest exposes git-ops to delegates", () => {
	const repoRoot = path.resolve(import.meta.dirname, "..");
	const { paths, missing } = resolveSkillPaths(["git-ops"], repoRoot);
	assert.deepEqual(missing, []);
	assert.equal(paths.length, 1);
	assert.ok(
		paths[0]?.includes(path.join("skills", "git-ops")),
		`resolves the packaged skill: ${paths[0]}`,
	);
});
