import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PAYLOAD_LOCK_ENV } from "../scripts/generate-payload-lock.mjs";

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

test("payload-assets: embeds the generated payload lock", (t) => {
	const fixture = writeFixtureLock(t);
	const run = spawnSync("node", [path.join(root, "scripts", "generate-payload-assets.mjs")], {
		encoding: "utf8",
		env: { ...process.env, [PAYLOAD_LOCK_ENV]: fixture },
	});
	assert.equal(run.status, 0, `generate-payload-assets failed: ${run.stderr}`);

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
