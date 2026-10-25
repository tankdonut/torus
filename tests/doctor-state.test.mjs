import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { runDoctorChecks, formatDoctorReport } = await import("../extensions/doctor/index.ts");

const CHECK_ORDER = [
	"torus",
	"engine",
	"provider auth",
	"default provider",
	"mcp servers",
	"lsp",
	"ast-grep",
	"tmux",
	"git identity",
	"torus state",
	"sandbox",
	"platform",
];

function fixture() {
	const base = mkdtempSync(path.join(tmpdir(), "doctor-state-"));
	const repoRoot = path.join(base, "repo");
	mkdirSync(path.join(repoRoot, "extensions", "mcp"), { recursive: true });
	writeFileSync(path.join(repoRoot, "extensions", "mcp", "index.ts"), "export {};\n");
	writeFileSync(path.join(base, "package.json"), JSON.stringify({ version: "9.9.9" }));
	const agentDir = path.join(base, "agent");
	mkdirSync(agentDir);
	writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "stub-provider" }),
	);
	const homeDir = path.join(base, "home");
	mkdirSync(homeDir);
	const stubBin = path.join(base, "bin");
	mkdirSync(stubBin);
	writeFileSync(path.join(stubBin, "which"), "#!/bin/sh\nexit 0\n");
	chmodSync(path.join(stubBin, "which"), 0o755);
	return { base, repoRoot, agentDir, homeDir, stubBin };
}

async function withEnv(overrides, run) {
	const saved = new Map();
	const unset = new Set();
	for (const [name, value] of Object.entries(overrides)) {
		if (Object.hasOwn(process.env, name)) saved.set(name, process.env[name]);
		else unset.add(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of saved) process.env[name] = value;
		for (const name of unset) delete process.env[name];
	}
}

function doctorEnv(fx) {
	return {
		TORUS_ROOT: fx.base,
		PI_CODING_AGENT_DIR: fx.agentDir,
		TORUS_HOME: fx.homeDir,
		PATH: `${fx.stubBin}${path.delimiter}${process.env.PATH ?? ""}`,
		TMUX: undefined,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
	};
}

test("full check set resolves in the documented order with stable statuses and details", async (t) => {
	const fx = fixture();
	t.after(() => rmSync(fx.base, { recursive: true, force: true }));
	const promise = withEnv(doctorEnv(fx), () =>
		runDoctorChecks(fx.repoRoot, process.execPath, "0.0.0-never"),
	);
	assert.ok(promise instanceof Promise, "runDoctorChecks is async");
	const checks = await promise;
	assert.deepEqual(
		checks.map((check) => check.name),
		CHECK_ORDER,
	);
	const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
	assert.equal(byName.torus.status, "ok");
	assert.equal(byName.torus.detail, "torus 9.9.9 (pi@0.0.0-never)");
	assert.equal(byName.engine.status, "warn");
	assert.match(byName.engine.detail, /^running v\S+, package\.json pins 0\.0\.0-never$/);
	assert.equal(byName["provider auth"].status, "ok");
	assert.equal(byName["provider auth"].detail, "auth.json present");
	assert.equal(byName["default provider"].status, "ok");
	assert.equal(byName["default provider"].detail, "stub-provider");
	assert.equal(byName["mcp servers"].status, "ok");
	assert.equal(byName["mcp servers"].detail, "context7 + grep_app registered in-session");
	assert.equal(byName.lsp.status, "ok");
	assert.equal(byName.lsp.detail, "typescript-language-server on PATH");
	assert.equal(byName["ast-grep"].status, "ok");
	assert.equal(byName["ast-grep"].detail, "sg on PATH");
	assert.equal(byName.tmux.status, "warn");
	assert.equal(byName.tmux.detail, "installed but not in a tmux session (no live panes)");
	assert.equal(byName["git identity"].status, "warn");
	assert.equal(byName["git identity"].detail, "no user.email in this repo");
	assert.equal(byName["torus state"].status, "ok");
	assert.equal(byName["torus state"].detail, `${fx.homeDir} writable`);
	assert.equal(byName.sandbox.status, "warn");
	assert.equal(byName.sandbox.detail, "extension not loaded");
	assert.equal(byName.platform.status, "ok");
	assert.equal(byName.platform.detail, "no gate decisions recorded");
	const report = formatDoctorReport(checks);
	assert.match(report, /^torus doctor — 12 checks: 0 fail, 4 warn/);
	assert.equal(report.split("\n").length, 13);
});

test("engine check reports ok when the pin matches the running version", async (t) => {
	const fx = fixture();
	t.after(() => rmSync(fx.base, { recursive: true, force: true }));
	const running = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
	const checks = await withEnv(doctorEnv(fx), () =>
		runDoctorChecks(fx.repoRoot, process.execPath, running),
	);
	const engine = checks.find((check) => check.name === "engine");
	assert.equal(engine.status, "ok");
	assert.equal(engine.detail, running);
});

test("failure paths: missing engine binary, missing mcp dir, empty agent dir, unwritable state", async (t) => {
	const fx = fixture();
	t.after(() => rmSync(fx.base, { recursive: true, force: true }));
	const emptyRepo = path.join(fx.base, "empty-repo");
	mkdirSync(emptyRepo);
	const emptyAgent = path.join(fx.base, "empty-agent");
	mkdirSync(emptyAgent);
	const blockedFile = path.join(fx.base, "blocked");
	writeFileSync(blockedFile, "not a directory\n");
	const engineBin = path.join(fx.base, "no-such-engine");
	const checks = await withEnv(
		{ ...doctorEnv(fx), PI_CODING_AGENT_DIR: emptyAgent, TORUS_HOME: blockedFile },
		() => runDoctorChecks(emptyRepo, engineBin, "0.0.0-never"),
	);
	const byName = Object.fromEntries(checks.map((check) => [check.name, check]));
	assert.equal(byName.engine.status, "fail");
	assert.equal(byName.engine.detail, `could not run ${engineBin} --version`);
	assert.equal(byName["provider auth"].status, "fail");
	assert.equal(byName["provider auth"].detail, "auth.json missing — run /login zai");
	assert.equal(byName["default provider"].status, "warn");
	assert.equal(byName["default provider"].detail, "settings.json unreadable");
	assert.equal(byName["mcp servers"].status, "fail");
	assert.equal(byName["mcp servers"].detail, "extensions/mcp missing");
	assert.equal(byName["torus state"].status, "fail");
	assert.match(byName["torus state"].detail, /^.*not writable: /);
});
