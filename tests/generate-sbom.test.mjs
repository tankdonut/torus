import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runGenerator(lock, out) {
	return spawnSync("node", [path.join(root, "scripts", "generate-sbom.mjs"), lock, out], {
		encoding: "utf8",
	});
}

function fixtureLock() {
	return {
		name: "torus-payload",
		version: "0.18.0",
		lockfileVersion: 3,
		requires: true,
		packages: {
			"": { name: "torus-payload", version: "0.18.0", dependencies: { zod: "^4.6.6" } },
			"node_modules/zod": {
				name: "zod",
				version: "4.6.7",
				integrity: "sha512-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==",
			},
			"node_modules/@scope/pkg": { name: "@scope/pkg", version: "1.2.3" },
			"node_modules/workspace-link": { resolved: "site", link: true },
			"node_modules/no-version": { name: "no-version" },
		},
	};
}

test("generate-sbom: CycloneDX from the lock, links and versionless entries skipped", () => {
	const dir = mkdtempSync(path.join(root, "dist", "generate-sbom-test-"));
	try {
		mkdirSync(path.join(dir, "stage"), { recursive: true });
		const lock = path.join(dir, "payload-lock.json");
		writeFileSync(lock, `${JSON.stringify(fixtureLock())}\n`);
		const out = path.join(dir, "stage", "torus-sbom.cdx.json");

		const run = runGenerator(lock, out);
		assert.equal(run.status, 0, `generate-sbom failed: ${run.stderr}`);

		const sbom = JSON.parse(readFileSync(out, "utf8"));
		assert.equal(sbom.bomFormat, "CycloneDX");
		assert.equal(sbom.specVersion, "1.5");
		assert.equal(sbom.metadata.component.name, "torus-payload");
		assert.equal(sbom.metadata.component.version, "0.18.0");

		const names = sbom.components.map((c) => c.name);
		assert.deepEqual(
			[...names].sort(),
			["@scope/pkg", "zod"],
			"links and versionless entries must be skipped",
		);
		const zod = sbom.components.find((c) => c.name === "zod");
		assert.equal(zod.version, "4.6.7");
		assert.equal(zod.purl, "pkg:npm/zod@4.6.7");
		assert.equal(
			zod.hashes[0].content,
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==",
			"the sha512 body (after the algorithm prefix) must land in hashes",
		);
		assert.ok(!sbom.components.some((c) => c.name === "workspace-link"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("generate-sbom: runs offline against the real payload lock", () => {
	const lock = path.join(root, "dist", "payload-lock.json");
	if (!existsSync(lock)) return; // full builds generate it; unit runs skip
	const dir = mkdtempSync(path.join(root, "dist", "generate-sbom-live-"));
	try {
		const out = path.join(dir, "torus-sbom.cdx.json");
		const run = runGenerator(lock, out);
		assert.equal(run.status, 0, `generate-sbom failed: ${run.stderr}`);
		const sbom = JSON.parse(readFileSync(out, "utf8"));
		assert.ok(
			sbom.components.length > 100,
			`expected the full dependency inventory, got ${sbom.components.length}`,
		);
		assert.ok(
			sbom.components.every((c) => c.version),
			"every component must carry a version",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
