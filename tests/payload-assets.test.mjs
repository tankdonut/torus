import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAYLOAD_LOCK_ENV } from "../scripts/generate-payload-lock.mjs";
import { writeTar } from "../scripts/lib/tar.mjs";
import { PAYLOAD_TREE_ENV } from "../scripts/pack-payload-tree.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * payload-assets.mjs carries bun-only file-loader imports, so it is asserted
 * as text — the PAYLOAD_* constants are JSON.stringify'd single-line exports.
 */
function generatedConstant(name) {
	const text = readFileSync(path.join(root, "runtime", "bin", "payload-assets.mjs"), "utf8");
	const at = text.indexOf(`export const ${name} = `);
	assert.ok(at >= 0, `generated payload-assets.mjs must export ${name}`);
	const line = text.slice(at, text.indexOf("\n", at));
	return JSON.parse(line.slice(line.indexOf(" = ") + 3).replace(/;$/, ""));
}

/** Minimal payload-shaped lock written to a temp dir; the generator reads it via the env override, so no network is needed. */
function writeFixtureLock(t) {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-payload-lock-fixture-"));
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

function generateAssets(env) {
	const run = spawnSync("node", [path.join(root, "scripts", "generate-payload-assets.mjs")], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	assert.equal(run.status, 0, `generate-payload-assets failed: ${run.stderr}`);
	return run;
}

/** Small tar fixture under dist/ (gitignored): the tree override points at it. */
function writeFixtureTree(t) {
	const dir = mkdtempSync(path.join(root, "dist", "payload-assets-tree-fixture-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fixture = path.join(dir, "payload-tree.tar.gz");
	writeFileSync(
		fixture,
		writeTar([
			{ path: "node_modules", typeflag: "5", mode: 0o755 },
			{
				path: "node_modules/example/package.json",
				typeflag: "0",
				mode: 0o644,
				bytes: Buffer.from('{"name":"example"}\n'),
			},
		]),
	);
	return fixture;
}

/** Parks the real packed tree away so a lock-only run cannot pick it up. */
function parkDistTree(t) {
	const distTree = path.join(root, "dist", "payload-tree.tar.gz");
	if (existsSync(distTree)) {
		const parked = `${distTree}.parked`;
		renameSync(distTree, parked);
		t.after(() => renameSync(parked, distTree));
	}
}

test("payload-assets: embeds the generated payload lock", (t) => {
	const fixture = writeFixtureLock(t);
	generateAssets({ [PAYLOAD_LOCK_ENV]: fixture });

	const embedded = generatedConstant("PAYLOAD_PACKAGE_LOCK");
	assert.equal(
		embedded,
		readFileSync(fixture, "utf8"),
		"embedded PAYLOAD_PACKAGE_LOCK must be byte-identical to the generated payload lock at the resolved path",
	);

	const lock = JSON.parse(embedded);
	assert.equal(
		lock.name,
		"torus-payload",
		"embedded lock must be the payload-native lock, not the repo's",
	);
	assert.equal(
		typeof lock.lockfileVersion,
		"number",
		"embedded lockfile must carry a numeric lockfileVersion",
	);

	const hash = generatedConstant("PAYLOAD_HASH");
	assert.match(hash, /^[0-9a-f]{64}$/, "payload hash must be a sha256 hex digest");
});

test("payload-assets: embeds the packed payload tree from an explicit override", (t) => {
	const lock = writeFixtureLock(t);
	const tree = writeFixtureTree(t);
	generateAssets({ [PAYLOAD_LOCK_ENV]: lock, [PAYLOAD_TREE_ENV]: tree });

	const text = readFileSync(path.join(root, "runtime", "bin", "payload-assets.mjs"), "utf8");
	const treeHashLine = text
		.split("\n")
		.find((line) => line.startsWith("export const PAYLOAD_HASH = "));
	const importLine = text
		.split("\n")
		.find((line) => line.startsWith("import t0 from ") && line.endsWith(' with { type: "file" };'));
	assert.ok(importLine, "the tree must be imported as a file-loader asset");
	assert.ok(importLine.includes(path.basename(tree)), "the import must point at the override path");

	const expectedSha = createHash("sha256").update(readFileSync(tree)).digest("hex");
	const treeExport = text.match(
		/export const PAYLOAD_TREE = \{ virtual: t0, sha256: "([0-9a-f]{64})" \};/,
	);
	assert.ok(treeExport, "PAYLOAD_TREE must export { virtual: t0, sha256 }");
	assert.equal(treeExport[1], expectedSha, "PAYLOAD_TREE.sha256 must be the tree's sha256");

	const withTreeHash = generatedConstant("PAYLOAD_HASH");
	const diskHash = generatedConstant("PAYLOAD_DISK_HASH");
	assert.match(diskHash, /^[0-9a-f]{64}$/, "the disk-side hash must be a sha256 hex digest");
	assert.notEqual(diskHash, withTreeHash, "the packed tree must stay out of the disk-side hash");

	generateAssets({ [PAYLOAD_LOCK_ENV]: lock });
	assert.notEqual(
		generatedConstant("PAYLOAD_HASH"),
		JSON.parse(treeHashLine.replace(";", "").split(" = ")[1]),
		"the tree bytes must participate in the payload hash",
	);
});

test("payload-assets: embeds no .npmrc", (t) => {
	const fixture = writeFixtureLock(t);
	generateAssets({ [PAYLOAD_LOCK_ENV]: fixture });

	const text = readFileSync(path.join(root, "runtime", "bin", "payload-assets.mjs"), "utf8");
	assert.ok(!text.includes("PAYLOAD_NPMRC"), "the generated module must not export PAYLOAD_NPMRC");
	assert.ok(
		!text.includes("min-release-age") && !text.includes("before=null"),
		"the payload must not embed cooldown-clearing .npmrc bytes even when the repo carries a dev .npmrc",
	);
});

test("payload-assets: stays lock-only when no tree is available", (t) => {
	parkDistTree(t);
	const env = { ...process.env };
	delete env[PAYLOAD_LOCK_ENV];
	delete env[PAYLOAD_TREE_ENV];
	const run = spawnSync("node", [path.join(root, "scripts", "generate-payload-assets.mjs")], {
		encoding: "utf8",
		env,
	});
	assert.equal(run.status, 0, `generate-payload-assets failed: ${run.stderr}`);
	assert.ok(run.stderr.includes("lock-only"), "the absent tree must be reported");

	const text = readFileSync(path.join(root, "runtime", "bin", "payload-assets.mjs"), "utf8");
	assert.ok(!text.includes("import t0 from "), "no tree import may be generated");
	assert.ok(
		text.includes("export const PAYLOAD_TREE = null;"),
		"PAYLOAD_TREE must be null without a packed tree",
	);
	assert.match(generatedConstant("PAYLOAD_HASH"), /^[0-9a-f]{64}$/);
	assert.equal(
		generatedConstant("PAYLOAD_DISK_HASH"),
		generatedConstant("PAYLOAD_HASH"),
		"lock-only builds keep the disk-side hash equal to the full payload hash",
	);
});
