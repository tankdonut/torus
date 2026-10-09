import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

test("payload-assets: embeds the repo lockfile verbatim", () => {
	const run = spawnSync("node", [path.join(root, "scripts", "generate-payload-assets.mjs")], {
		encoding: "utf8",
	});
	assert.equal(run.status, 0, `generate-payload-assets failed: ${run.stderr}`);

	const repoLock = readFileSync(path.join(root, "package-lock.json"), "utf8");
	assert.equal(
		generatedConstant("PAYLOAD_PACKAGE_LOCK"),
		repoLock,
		"embedded PAYLOAD_PACKAGE_LOCK must be byte-identical to the repo lockfile (first-run bootstrap pins to repo resolutions)",
	);

	const lock = JSON.parse(generatedConstant("PAYLOAD_PACKAGE_LOCK"));
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	assert.equal(lock.name, pkg.name, "embedded lockfile must be the repo's, not a foreign one");
	assert.equal(
		typeof lock.lockfileVersion,
		"number",
		"embedded lockfile must carry a numeric lockfileVersion",
	);

	const hash = generatedConstant("PAYLOAD_HASH");
	assert.match(hash, /^[0-9a-f]{64}$/, "payload hash must be a sha256 hex digest");
});
