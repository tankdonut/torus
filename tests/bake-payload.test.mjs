import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAYLOAD_LOCK_ENV } from "../scripts/generate-payload-lock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal payload-shaped lock written to a temp dir; bake reads it via the env override, so no network is needed. */
function writeFixtureLock(t) {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-bake-lock-fixture-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fixture = path.join(dir, "payload-lock.json");
	writeFileSync(
		fixture,
		`${JSON.stringify(
			{
				name: "torus-payload",
				version: "0.0.0",
				lockfileVersion: 3,
				requires: true,
				packages: {
					"": {
						name: "torus-payload",
						version: "0.0.0",
						dependencies: { example: "1.0.0" },
					},
					"node_modules/example": {
						version: "1.0.0",
						resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
						integrity:
							"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);
	return fixture;
}

test("bake-payload: writes the payload tree carrying the shared runtime manifest", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-bake-"));
	const fixture = writeFixtureLock(t);
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const run = spawnSync("node", [path.join(root, "scripts", "bake-payload.mjs"), dir], {
		encoding: "utf8",
		env: { ...process.env, [PAYLOAD_LOCK_ENV]: fixture },
	});
	assert.equal(run.status, 0, `bake-payload failed: ${run.stderr}`);

	for (const entry of ["extensions", "agents", "skills", "package.json", "package-lock.json"]) {
		assert.ok(existsSync(path.join(dir, entry)), `baked tree missing ${entry}`);
	}
	const repoHasNpmrc = existsSync(path.join(root, ".npmrc"));
	assert.equal(
		existsSync(path.join(dir, ".npmrc")),
		repoHasNpmrc,
		repoHasNpmrc ? "baked tree missing .npmrc" : "baked tree must not invent an .npmrc",
	);

	assert.equal(
		readFileSync(path.join(dir, "package-lock.json"), "utf8"),
		readFileSync(fixture, "utf8"),
		"baked lockfile must be the generated payload-native lock — its dep set (engine promoted) differs from the repo's, so the repo lock would leave npm re-resolving at install time",
	);

	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi, pkg.pi, "payload manifest must mirror the repo pi manifest");
	assert.equal(manifest.version, pkg.version, "payload manifest must carry the repo version");
	assert.deepEqual(
		manifest.dependencies,
		{
			...pkg.dependencies,
			"@earendil-works/pi-coding-agent": pkg.devDependencies["@earendil-works/pi-coding-agent"],
		},
		"payload manifest must promote the engine pin from devDependencies and mirror runtime deps",
	);
	assert.deepEqual(
		manifest.overrides,
		pkg.overrides,
		"payload manifest must carry the repo overrides — the payload lock's override-forced resolutions install consistently only with them",
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
