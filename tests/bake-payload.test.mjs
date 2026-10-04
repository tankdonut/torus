import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("bake-payload: writes the payload tree carrying the shared runtime manifest", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-bake-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const run = spawnSync("node", [path.join(root, "scripts", "bake-payload.mjs"), dir], {
		encoding: "utf8",
	});
	assert.equal(run.status, 0, `bake-payload failed: ${run.stderr}`);

	for (const entry of ["extensions", "agents", "skills", "package.json"]) {
		assert.ok(existsSync(path.join(dir, entry)), `baked tree missing ${entry}`);
	}
	const repoHasNpmrc = existsSync(path.join(root, ".npmrc"));
	assert.equal(
		existsSync(path.join(dir, ".npmrc")),
		repoHasNpmrc,
		repoHasNpmrc ? "baked tree missing .npmrc" : "baked tree must not invent an .npmrc",
	);

	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi, pkg.pi, "payload manifest must mirror the repo pi manifest");
	assert.deepEqual(
		manifest.dependencies,
		{
			...pkg.dependencies,
			"@earendil-works/pi-coding-agent": pkg.devDependencies["@earendil-works/pi-coding-agent"],
		},
		"payload manifest must promote the engine pin from devDependencies and mirror runtime deps",
	);
});

test("bake-payload: refuses to bake into the repo root", () => {
	const run = spawnSync("node", [path.join(root, "scripts", "bake-payload.mjs"), root], {
		encoding: "utf8",
	});
	assert.notEqual(
		run.status,
		0,
		"baking into the repo root must fail (would clobber package.json)",
	);
});

test("bake-payload: usage error without a target directory", () => {
	const run = spawnSync("node", [path.join(root, "scripts", "bake-payload.mjs")], {
		encoding: "utf8",
	});
	assert.notEqual(run.status, 0, "missing targetDir must fail with usage");
});
