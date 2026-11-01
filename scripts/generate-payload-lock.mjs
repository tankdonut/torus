#!/usr/bin/env node
/**
 * Generates the payload-native package-lock.json: stages the synthesized
 * payload package.json plus the repo lock as a resolution seed in a temp dir,
 * runs `npm install --package-lock-only --legacy-peer-deps` there, and writes
 * the resulting lock to dist/payload-lock.json (override: CLI arg or
 * TORUS_PAYLOAD_LOCK_OUT). Lock generation requires the registry by design —
 * the binary must install pinned resolutions, never re-resolve on the user's
 * machine.
 *
 * Usage: node scripts/generate-payload-lock.mjs [outPath]
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { payloadNpmrc, payloadPackageJson, payloadPackageLock } from "./payload-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Env var every payload-lock consumer honors: explicit path for the generated lock. */
export const PAYLOAD_LOCK_ENV = "TORUS_PAYLOAD_LOCK_OUT";

/** Path the generated payload lock is written to and read from. */
export function payloadLockPath() {
	const override = process.env[PAYLOAD_LOCK_ENV];
	return override ? path.resolve(override) : path.join(root, "dist", "payload-lock.json");
}

/** Generated payload lock contents, or null when it has not been generated yet. */
export function readPayloadLock() {
	try {
		return readFileSync(payloadLockPath(), "utf8");
	} catch {
		return null;
	}
}

/**
 * Runs the staged resolution and writes the lock to `out`. Lockfile v3 carries
 * no timestamps, so unchanged inputs yield byte-identical output across runs.
 */
export function generatePayloadLock({ out = payloadLockPath() } = {}) {
	const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	const seed = payloadPackageLock();
	const npmrc = payloadNpmrc();
	const tmp = mkdtempSync(path.join(tmpdir(), "torus-payload-lock-"));
	try {
		writeFileSync(path.join(tmp, "package.json"), payloadPackageJson(pkg));
		if (npmrc !== null) {
			writeFileSync(path.join(tmp, ".npmrc"), npmrc);
		}
		if (seed !== null) {
			writeFileSync(path.join(tmp, "package-lock.json"), seed);
		}
		const run = spawnSync(
			"npm",
			["install", "--package-lock-only", "--legacy-peer-deps", "--no-audit", "--no-fund"],
			{ cwd: tmp, encoding: "utf8" },
		);
		if (run.status !== 0) {
			const detail = (run.stderr || run.stdout || "").trim();
			return {
				ok: false,
				error: `npm install --package-lock-only failed (exit ${run.status}) — lock generation requires registry access\n${detail}`,
			};
		}
		const lock = readFileSync(path.join(tmp, "package-lock.json"), "utf8");
		mkdirSync(path.dirname(out), { recursive: true });
		writeFileSync(out, lock);
		return { ok: true, out };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const out = process.argv[2] ? path.resolve(process.argv[2]) : payloadLockPath();
	const result = generatePayloadLock({ out });
	if (!result.ok) {
		process.stderr.write(`generate-payload-lock: ${result.error}\n`);
		process.exit(1);
	}
	process.stderr.write(`payload lock written to ${result.out}\n`);
}
