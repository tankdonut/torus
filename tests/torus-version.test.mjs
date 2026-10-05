import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const enginePin = repoPkg.devDependencies["@earendil-works/pi-coding-agent"];

// Ambient TORUS_* exports from a running torus session must not leak in: the
// launcher resolves root/engine from them, so scrub before every spawn.
function launcherEnv() {
	const env = { ...process.env };
	for (const key of ["TORUS_ROOT", "TORUS_ENGINE", "TORUS_ENGINE_BIN", "TORUS_PI_BIN"]) {
		delete env[key];
	}
	return env;
}

function runLauncher(args, envOverride = {}) {
	return spawnSync(process.execPath, [path.join(root, "runtime", "bin", "torus.mjs"), ...args], {
		encoding: "utf8",
		env: { ...launcherEnv(), ...envOverride },
	});
}

test("torus --version reports the torus version and engine pin (source mode)", () => {
	const run = runLauncher(["--version"]);
	assert.equal(run.status, 0, `--version failed: ${run.stderr}`);
	assert.equal(
		run.stdout.trim(),
		`torus ${repoPkg.version} (pi@${enginePin})`,
		"--version must report the repo version and the devDependencies engine pin",
	);
});

test("torus --version never reaches engine resolution", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-version-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const marker = path.join(dir, "engine-ran");
	const sentinel = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		sentinel,
		`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
	);
	chmodSync(sentinel, 0o755);

	const run = runLauncher(["--version"], { TORUS_PI_BIN: sentinel });
	assert.equal(run.status, 0, `--version failed: ${run.stderr}`);
	assert.ok(
		!existsSync(marker),
		"--version must exit before resolveBinary() ever spawns the engine",
	);
});
