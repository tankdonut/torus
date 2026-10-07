import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Env-hygiene contract, machine-enforced: torus's own code never reads
// launch-dir .env* files. The launcher (runtime/bin/torus.mjs) resolves the
// payload, bootstraps the engine, and spawns it with process.env passed
// through untouched; extensions/engine-child.ts gives spawned children
// process.env + TORUS_ENGINE_CHILD=1. Nothing in that chain may load dotenv
// or open a launch-dir .env file. The pinned ENGINE is a different story —
// its 1.0.4 standalone binaries autoload launch-dir .env*, and upstream main
// (commit 1ffb6bd6) removes that — so the behavior flips on an engine-pin
// bump. The docs coupling test pins the re-audit step into
// docs/release-workflow.md so every bump re-runs this suite.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_ROOTS = ["runtime/bin", "extensions"];

// dotenv by name, and ".env" strictly as a filename — delimited on the left
// by a quote or path separator and on the right by a quote, separator, or
// whitespace. Identifiers like TORUS_ENGINE_CHILD and words like
// ".environment" or "process.env" do not match.
const DENYLIST = [/dotenv/i, /["'/]\.env["'/\s]/];

function sourceFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFiles(full));
		} else if (entry.isFile() && !entry.name.endsWith(".md")) {
			files.push(full);
		}
	}
	return files.sort();
}

test("torus source never references dotenv or launch-dir .env files", () => {
	for (const dir of SCAN_ROOTS) {
		for (const file of sourceFiles(path.join(root, dir))) {
			const rel = path.relative(root, file);
			const lines = readFileSync(file, "utf8").split("\n");
			for (const [i, line] of lines.entries()) {
				for (const pattern of DENYLIST) {
					assert.ok(
						!pattern.test(line),
						`${rel}:${i + 1}: matches env-hygiene denylist pattern ${pattern} — torus passes the environment through untouched and must never read launch-dir .env*`,
					);
				}
			}
		}
	}
});

test("release workflow carries the engine-pin env audit step", () => {
	const doc = readFileSync(path.join(root, "docs", "release-workflow.md"), "utf8");
	assert.ok(
		doc.includes("env-hygiene"),
		"docs/release-workflow.md lost the env-hygiene audit step — every engine-pin bump must re-run tests/env-hygiene.test.mjs and re-verify the new engine's .env autoload behavior",
	);
});
