import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MARKER_NAME, shouldSkipInstall } from "../runtime/bin/payload-extract.mjs";
import { extractPermissionMode } from "../runtime/bin/permission-mode.mjs";

test("equals spelling: --permission-mode=auto yields mode auto and strips the flag", () => {
	const result = extractPermissionMode(["--permission-mode=auto", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "auto" });
});

test("two-token spelling: --permission-mode auto consumes the value token", () => {
	const result = extractPermissionMode(["--permission-mode", "auto", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "auto" });
});

test("value default is accepted for both spellings", () => {
	assert.deepEqual(extractPermissionMode(["--permission-mode=default"]), {
		argv: [],
		mode: "default",
	});
	assert.deepEqual(extractPermissionMode(["--permission-mode", "default"]), {
		argv: [],
		mode: "default",
	});
});

test("flag anywhere in argv: start, middle, and end positions all work", () => {
	const middle = extractPermissionMode(["--model", "big", "--permission-mode=auto", "--version"]);
	assert.deepEqual(middle, { argv: ["--model", "big", "--version"], mode: "auto" });
	const end = extractPermissionMode(["--version", "--permission-mode=auto"]);
	assert.deepEqual(end, { argv: ["--version"], mode: "auto" });
	const twoTokenEnd = extractPermissionMode(["--version", "--permission-mode", "auto"]);
	assert.deepEqual(twoTokenEnd, { argv: ["--version"], mode: "auto" });
});

test("repeated flags: the last occurrence wins", () => {
	const result = extractPermissionMode(["--permission-mode=auto", "--permission-mode=default"]);
	assert.deepEqual(result, { argv: [], mode: "default" });
	assert.deepEqual(
		extractPermissionMode(["--permission-mode", "default", "--permission-mode=auto"]),
		{
			argv: [],
			mode: "auto",
		},
	);
});

test("unknown value: error names the bad value and both valid ones, mode undefined", () => {
	const result = extractPermissionMode(["--permission-mode=bogus", "--version"]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /bogus/);
	assert.match(result.error ?? "", /auto/);
	assert.match(result.error ?? "", /default/);
});

test("an invalid occurrence wins over valid ones; the first error is reported", () => {
	const result = extractPermissionMode([
		"--permission-mode=auto",
		"--permission-mode=nope",
		"--permission-mode=worse",
	]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /nope/);
	assert.doesNotMatch(result.error ?? "", /worse/);
	assert.deepEqual(result.argv, []);
});

test("both spellings stripped in one argv, other args keep order", () => {
	const result = extractPermissionMode([
		"--permission-mode=auto",
		"@file.txt",
		"--permission-mode",
		"default",
		"--",
		"-x",
	]);
	assert.deepEqual(result, { argv: ["@file.txt", "--", "-x"], mode: "default" });
});

test("no flag: passthrough identity (same array reference, no mode, no error)", () => {
	const argv = ["serve", "--help", "--permission"];
	const result = extractPermissionMode(argv);
	assert.equal(result.argv, argv);
	assert.equal(result.mode, undefined);
	assert.equal(result.error, undefined);
	assert.deepEqual(extractPermissionMode([]), { argv: [] });
});

test("case-sensitive: --permission-mode=Auto is an error", () => {
	const result = extractPermissionMode(["--permission-mode=Auto"]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /Auto/);
	assert.match(result.error ?? "", /auto/);
});

test("final token with no value: error, not silent passthrough", () => {
	const equals = extractPermissionMode(["--permission-mode"]);
	assert.equal(equals.mode, undefined);
	assert.match(equals.error ?? "", /missing value/);
	assert.match(equals.error ?? "", /auto/);
	assert.deepEqual(equals.argv, []);
});

test("empty value after = is an error naming it", () => {
	const result = extractPermissionMode(["--permission-mode="]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /unknown value/);
});

test("similar flags are not the flag: --permission-modex=auto passes through", () => {
	const result = extractPermissionMode(["--permission-modex=auto"]);
	assert.equal(result.mode, undefined);
	assert.equal(result.error, undefined);
	assert.deepEqual(result.argv, ["--permission-modex=auto"]);
});

test("equals spelling: --permission-mode=bypass yields mode bypass and strips the flag", () => {
	const result = extractPermissionMode(["--permission-mode=bypass", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "bypass" });
});

test("two-token spelling: --permission-mode bypass consumes the value token", () => {
	const result = extractPermissionMode(["--permission-mode", "bypass", "--version"]);
	assert.deepEqual(result, { argv: ["--version"], mode: "bypass" });
});

test("repeated flags: a later default overrides an earlier bypass", () => {
	const result = extractPermissionMode([
		"--permission-mode=bypass",
		"--permission-mode",
		"default",
	]);
	assert.deepEqual(result, { argv: [], mode: "default" });
});

test("unknown value error names all three valid modes", () => {
	const result = extractPermissionMode(["--permission-mode=yolo"]);
	assert.equal(result.mode, undefined);
	assert.match(result.error ?? "", /"auto", "default", or "bypass"/);
});

// --- launcher integration: pin-drift verdict cache and deps-hash install skip ---

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(repoRoot, "runtime", "bin", "torus.mjs");
const PIN = "1.2.3";

// Logs every argv it is spawned with, then prints a configurable version: a
// stand-in engine binary for driving the launcher's probe and child spawns.
const STUB_ENGINE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const log = process.env.STUB_ARGV_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write((process.env.STUB_VERSION ?? "stub") + "\\n");
`;

// Ambient TORUS_* exports from a running torus session must not leak in: the
// launcher resolves root/engine from them, so scrub before every spawn.
function scrubbedEnv() {
	const env = { ...process.env };
	for (const key of ["TORUS_ROOT", "TORUS_ENGINE", "TORUS_ENGINE_BIN", "TORUS_PI_BIN"]) {
		delete env[key];
	}
	return env;
}

function launcherFixture(t) {
	const home = mkdtempSync(path.join(tmpdir(), "torus-drift-home-"));
	const payloadRoot = mkdtempSync(path.join(tmpdir(), "torus-drift-root-"));
	mkdirSync(path.join(payloadRoot, "extensions"), { recursive: true });
	writeFileSync(
		path.join(payloadRoot, "package.json"),
		JSON.stringify({
			name: "drift-fixture",
			version: "0.0.0",
			dependencies: { "@earendil-works/pi-coding-agent": PIN },
		}),
	);
	const stub = path.join(home, "stub-pi.mjs");
	writeFileSync(stub, STUB_ENGINE);
	chmodSync(stub, 0o755);
	const argvLog = path.join(home, "stub-argv.log");
	t.after(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(payloadRoot, { recursive: true, force: true });
	});
	return {
		home,
		payloadRoot,
		stub,
		argvLog,
		marker: path.join(home, ".torus", "runtime", ".pin-drift"),
	};
}

function runLauncher(fx, { version = PIN } = {}) {
	writeFileSync(fx.argvLog, "");
	return spawnSync(process.execPath, [launcher, "prompt"], {
		encoding: "utf8",
		env: {
			...scrubbedEnv(),
			HOME: fx.home,
			TORUS_ROOT: fx.payloadRoot,
			TORUS_PI_BIN: fx.stub,
			STUB_ARGV_LOG: fx.argvLog,
			STUB_VERSION: version,
		},
	});
}

function stubCalls(fx) {
	return readFileSync(fx.argvLog, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

function wasProbed(fx) {
	return stubCalls(fx).some((args) => args.length === 1 && args[0] === "--version");
}

function markerLines(fx) {
	return readFileSync(fx.marker, "utf8").split("\n");
}

test("pin-drift probe: first run probes and caches, second run skips the probe", (t) => {
	const fx = launcherFixture(t);

	const first = runLauncher(fx);
	assert.equal(first.status, 0, `launcher failed: ${first.stderr}`);
	assert.ok(wasProbed(fx), "uncached run must probe the engine version");
	assert.ok(!first.stderr.includes("pin drift"), "matching version must not warn");
	const lines = markerLines(fx);
	assert.equal(lines.length, 3, "marker holds key + version + trailing newline");
	assert.equal(lines[1], PIN, "marker records the probed version");

	const second = runLauncher(fx);
	assert.equal(second.status, 0, `launcher failed: ${second.stderr}`);
	assert.ok(!wasProbed(fx), "cached no-drift verdict must skip the probe spawn");
	assert.ok(!second.stderr.includes("pin drift"));
	assert.deepEqual(
		stubCalls(fx),
		[["--extension", fx.payloadRoot, "prompt"]],
		"engine child still runs",
	);
	assert.equal(markerLines(fx)[0], lines[0], "skip must not rewrite the marker");
});

test("pin-drift probe: cached drift verdict warns without spawning", (t) => {
	const fx = launcherFixture(t);
	assert.equal(runLauncher(fx).status, 0);
	const [key] = markerLines(fx);
	writeFileSync(fx.marker, `${key}\n0.0.0-drifted\n`);

	const run = runLauncher(fx);
	assert.equal(run.status, 0, "drift is a warning, not a failure");
	assert.match(run.stderr, /engine pin drift.*0\.0\.0-drifted/);
	assert.ok(!wasProbed(fx), "cached drift must not re-spawn the probe");
});

test("pin-drift probe: stale key re-probes and rewrites the cache", (t) => {
	const fx = launcherFixture(t);
	assert.equal(runLauncher(fx).status, 0);

	const [, actual] = markerLines(fx);
	writeFileSync(fx.marker, `${"0".repeat(64)}\n${actual}\n`);
	let run = runLauncher(fx);
	assert.ok(wasProbed(fx), "edited key line must re-probe");
	assert.ok(!run.stderr.includes("pin drift"), "matching re-probe must not warn");
	assert.notEqual(markerLines(fx)[0], "0".repeat(64), "probe rewrites the marker");

	const staleKey = markerLines(fx)[0];
	const later = new Date(Date.now() + 5000);
	utimesSync(fx.stub, later, later);
	run = runLauncher(fx);
	assert.ok(wasProbed(fx), "binary mtime change must re-probe");
	assert.notEqual(markerLines(fx)[0], staleKey, "new binary identity gets a new key");
	assert.ok(!run.stderr.includes("pin drift"));
});

test("pin-drift probe: no pin means no probe at all", (t) => {
	const fx = launcherFixture(t);
	writeFileSync(
		path.join(fx.payloadRoot, "package.json"),
		JSON.stringify({ name: "drift-fixture", version: "0.0.0" }),
	);
	const run = runLauncher(fx);
	assert.equal(run.status, 0);
	assert.ok(!wasProbed(fx), "the probe stays pin-gated");
});

test("shouldSkipInstall: matching deps-hash keeps the engine after a payload refresh", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-deps-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const local = path.join(dir, "node_modules", ".bin", "pi");
	mkdirSync(path.dirname(local), { recursive: true });
	writeFileSync(local, "engine");
	writeFileSync(path.join(dir, MARKER_NAME), "contenthash\ndepshash\n");

	assert.equal(
		shouldSkipInstall(dir, local, true, "depshash"),
		true,
		"unchanged deps skip npm install",
	);
	assert.equal(
		shouldSkipInstall(dir, local, false, null),
		true,
		"unrefreshed runs keep today's reuse",
	);
	assert.equal(shouldSkipInstall(dir, local, true, "other"), false, "deps change must reinstall");
	assert.equal(
		shouldSkipInstall(dir, local, true, null),
		false,
		"no embedded deps-hash to compare must reinstall",
	);
});

test("shouldSkipInstall: missing engine binary always reinstalls", (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-deps-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const local = path.join(dir, "node_modules", ".bin", "pi");
	writeFileSync(path.join(dir, MARKER_NAME), "contenthash\ndepshash\n");
	assert.equal(shouldSkipInstall(dir, local, false, null), false);
	assert.equal(shouldSkipInstall(dir, local, true, "depshash"), false);
});
