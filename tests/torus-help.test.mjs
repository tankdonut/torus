import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
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

// --help, -h, help, and auth --help boot the real engine, which writes
// models-store.json/auth.json under its agent dir at startup and dies when
// that dir is unwritable. Point PI_CODING_AGENT_DIR at a temp home so the
// spawns stay hermetic and never touch the real ~/.pi/agent.
const agentDir = mkdtempSync(path.join(tmpdir(), "torus-help-agent-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));

function runLauncher(args, envOverride = {}) {
	return spawnSync(process.execPath, [path.join(root, "runtime", "bin", "torus.mjs"), ...args], {
		encoding: "utf8",
		env: { ...launcherEnv(), PI_CODING_AGENT_DIR: agentDir, ...envOverride },
	});
}

test("torus --help leads with torus-native surfaces, then engine help", () => {
	const run = runLauncher(["--help"]);
	assert.equal(run.status, 0, `--help failed: ${run.stderr}`);
	assert.ok(
		run.stdout.startsWith(`torus ${repoPkg.version}`),
		"--help must open with the torus version line, not pi's",
	);
	for (const expected of ["serve", "acp-agent", "TORUS_SERVE=0", "pi engine (passthrough)"]) {
		assert.ok(run.stdout.includes(expected), `--help output must mention ${expected}`);
	}
	assert.ok(
		run.stdout.includes("Usage:"),
		"--help must include the engine's usage block after the torus section",
	);
});

test("torus -h and torus help match torus --help", () => {
	const baseline = runLauncher(["--help"]);
	for (const alias of ["-h", "help"]) {
		const run = runLauncher([alias]);
		assert.equal(run.status, 0, `${alias} failed: ${run.stderr}`);
		assert.equal(run.stdout, baseline.stdout, `${alias} must print the same help as --help`);
	}
});

test("torus serve --help prints surface help without starting the server", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-serve-help-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const marker = path.join(dir, "engine-ran");
	const sentinel = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		sentinel,
		`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
	);
	chmodSync(sentinel, 0o755);

	const run = runLauncher(["serve", "--help"], { TORUS_PI_BIN: sentinel });
	assert.equal(run.status, 0, `serve --help failed: ${run.stderr}`);
	assert.ok(run.stdout.includes("torus serve"), "serve --help must name the surface");
	assert.ok(run.stdout.includes("docs/serve.md"), "serve --help must point at the docs");
	assert.ok(!existsSync(marker), "serve --help must never spawn the engine or start the server");
	assert.ok(!run.stdout.includes("serve token:"), "serve --help must not mint a token");
});

test("torus acp-agent --help prints surface help without entering the agent loop", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-acp-help-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const marker = path.join(dir, "engine-ran");
	const sentinel = path.join(dir, "fake-pi.mjs");
	writeFileSync(
		sentinel,
		`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
	);
	chmodSync(sentinel, 0o755);

	const run = runLauncher(["acp-agent", "--help"], { TORUS_PI_BIN: sentinel });
	assert.equal(run.status, 0, `acp-agent --help failed: ${run.stderr}`);
	assert.ok(run.stdout.includes("torus acp-agent"), "acp-agent --help must name the surface");
	assert.ok(run.stdout.includes("docs/serve.md"), "acp-agent --help must point at the docs");
	assert.ok(!existsSync(marker), "acp-agent --help must never spawn the engine");
});

test("torus --version and torus -v agree", () => {
	const expected = `torus ${repoPkg.version} (pi@${enginePin})`;
	for (const flag of ["--version", "-v"]) {
		const run = runLauncher([flag]);
		assert.equal(run.status, 0, `${flag} failed: ${run.stderr}`);
		assert.equal(run.stdout.trim(), expected, `${flag} must report the torus version + pin`);
	}
});

test("engine per-command help still passes through (torus auth --help)", () => {
	const run = runLauncher(["auth", "--help"]);
	assert.equal(run.status, 0, `auth --help failed: ${run.stderr}`);
	assert.ok(
		run.stdout.includes("print-api-key") && !run.stdout.includes("pi engine (passthrough)"),
		"per-command help must come from the engine, not the torus top-level help",
	);
});
