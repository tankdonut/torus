/**
 * Sandbox drift fixture — env-gated checks over REAL wrapped commands.
 *
 * The unit suite (sandbox.test.mjs) drives fake managers, so it cannot see the
 * sandbox runtime itself drift away from the documented failure classes. This
 * file initializes the real srt singleton with the production config shape
 * (buildSandboxConfig with an empty policy, ask callback denies) and A/B-runs
 * commands that historically broke: tmp handling, agent sockets, proxy env,
 * config-read tools, and writes outside allowWrite.
 *
 * Opt-in: plain `npm test` shows every test here as skipped. Set
 * TORUS_SANDBOX_DRIFT=1 to enable; the run stays local and needs bwrap,
 * ripgrep, and the real binaries under test (each skips with a reason when its
 * binary is absent). Per-command SIGKILL after 15s bounds a wedged wrap; the
 * enabled file finishes in seconds on a healthy host.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const { buildSandboxConfig, parseSandboxEnv, resolveAdditionalWritableRoots } = await import(
	"../extensions/sandbox/index.ts"
);
const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");

const gateValue = process.env["TORUS_SANDBOX_DRIFT"] ?? "";
const ENABLED = gateValue !== "" && gateValue !== "0" && gateValue !== "false";

const RUN_TIMEOUT_MS = 15_000;
const savedClaudeTmpdir = process.env["CLAUDE_CODE_TMPDIR"];
const harness = { active: false, skipReason: null, scratchDir: "" };

/** Filesystem-errno signature that would indicate a deny on an allowed read. */
const FS_ERRNO =
	/EROFS|Read-only file system|EACCES|Permission denied|EPERM|Operation not permitted/i;

/**
 * srt creates empty host-side stub files as bwrap mount points for deny paths
 * (dangerous dotfiles). cleanupAfterCommand() removes them, but a killed run
 * can leak them; after() sweeps exactly these names from git's untracked list.
 */
const STUB_BASENAMES = new Set([
	".gitconfig",
	".gitmodules",
	".bashrc",
	".bash_profile",
	".zshrc",
	".zprofile",
	".profile",
	".ripgreprc",
	".mcp.json",
]);
const STUB_DIR_PREFIXES = [".vscode", ".idea"];

function run(cmd, timeoutMs = RUN_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", cmd], { env: process.env });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
		});
	});
}

/** Wraps like the extension's tool_call handler: real wrap, run, annotate, cleanup. */
async function wrappedRun(cmd, timeoutMs = RUN_TIMEOUT_MS) {
	const commandId = randomBytes(16).toString("base64url");
	const wrappedCmd = await SandboxManager.wrapWithSandbox(cmd, undefined, undefined, undefined, {
		commandId,
	});
	const result = await run(wrappedCmd, timeoutMs);
	const annotated = SandboxManager.annotateStderrWithSandboxFailures(commandId, result.stderr);
	SandboxManager.cleanupAfterCommand();
	return { ...result, stderr: annotated };
}

function gate(t) {
	if (!ENABLED) {
		t.skip("TORUS_SANDBOX_DRIFT not set — opt-in real-sandbox drift checks stay skipped");
		return false;
	}
	if (!harness.active) {
		t.skip(harness.skipReason ?? "sandbox unavailable on this host");
		return false;
	}
	return true;
}

function hasBinary(name) {
	return spawnSync("bash", ["-c", `command -v ${name}`]).status === 0;
}

before(async () => {
	if (!ENABLED) return;
	const depCheck = await SandboxManager.checkDependenciesAsync();
	const errors = depCheck.errors ?? [];
	if (errors.length > 0) {
		harness.skipReason = `sandbox dependencies missing: ${errors.join(", ")}`;
		return;
	}
	// srt injects CLAUDE_CODE_TMPDIR as TMPDIR at wrap time but never creates
	// the dir (a fresh initialize does not create its /tmp/claude default
	// either), so claim a private scratch first — exactly what the extension's
	// activation does.
	harness.scratchDir = mkdtempSync(path.join(tmpdir(), "torus-sbx-drift-"));
	process.env["CLAUDE_CODE_TMPDIR"] = harness.scratchDir;
	const config = buildSandboxConfig(
		process.cwd(),
		parseSandboxEnv({}), // empty policy: curated allowlist, no extras, no widening
		resolveAdditionalWritableRoots(process.cwd()),
	);
	try {
		// Deny every ask, as the extension does when no approval slot is live.
		await SandboxManager.initialize(config, async () => false);
		harness.active = true;
	} catch (error) {
		harness.skipReason = `sandbox initialize failed: ${error instanceof Error ? error.message : String(error)}`;
	}
});

after(async () => {
	if (!ENABLED) return;
	if (harness.active) {
		try {
			await SandboxManager.reset();
		} catch {
			// Best-effort teardown; the sweep below is the backstop.
		}
	}
	sweepStubs();
	if (harness.scratchDir !== "") rmSync(harness.scratchDir, { recursive: true, force: true });
	if (savedClaudeTmpdir === undefined) delete process.env["CLAUDE_CODE_TMPDIR"];
	else process.env["CLAUDE_CODE_TMPDIR"] = savedClaudeTmpdir;
});

/** Remove bwrap mount-point stubs leaked by killed wrapped runs (untracked only). */
function sweepStubs() {
	const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
	if (status.status !== 0) return;
	for (const line of status.stdout.split("\n")) {
		if (!line.startsWith("??")) continue;
		const entry = line.slice(2).trim().replace(/\/+$/, "");
		if (entry === "") continue;
		const segments = entry.split(path.sep);
		if (
			STUB_BASENAMES.has(segments[segments.length - 1] ?? "") ||
			STUB_DIR_PREFIXES.includes(segments[0] ?? "")
		) {
			rmSync(entry, { recursive: true, force: true });
			process.stderr.write(`[torus: sandbox-drift] swept leaked stub ${entry}\n`);
		}
	}
}

test("wrapped mktemp exits 0 under the activation-created private scratch", async (t) => {
	if (!gate(t)) return;
	const result = await wrappedRun("mktemp");
	assert.equal(result.timedOut, false, "mktemp must not hang");
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const outPath = result.stdout.trim();
	assert.ok(outPath !== "", "mktemp prints a path");
	assert.ok(
		outPath.startsWith(`${harness.scratchDir}${path.sep}`),
		`mktemp path ${outPath} not under the CLAUDE_CODE_TMPDIR scratch ${harness.scratchDir} (which sits under ${tmpdir()})`,
	);
});

test("wrapped ssh-add -l fails with the socket class (Operation not permitted)", async (t) => {
	if (!process.env["SSH_AUTH_SOCK"]) {
		t.skip("SSH_AUTH_SOCK unset — no agent socket to reach");
		return;
	}
	if (!gate(t)) return;
	const result = await wrappedRun("ssh-add -l");
	assert.equal(result.timedOut, false);
	assert.notEqual(result.code, 0, "agent socket access must not succeed inside the sandbox");
	assert.match(result.stderr, /Operation not permitted/, `stderr: ${result.stderr}`);
});

test("wrapped env carries the localhost https proxy, link-local NO_PROXY, and scratch TMPDIR", async (t) => {
	if (!gate(t)) return;
	const result = await wrappedRun("printenv NO_PROXY HTTPS_PROXY TMPDIR");
	assert.equal(result.timedOut, false);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
	const lines = result.stdout.trimEnd().split("\n");
	assert.equal(lines.length, 3, `stdout: ${result.stdout}`);
	const [noProxy, httpsProxy, wrappedTmpdir] = lines;
	assert.ok(
		(noProxy ?? "").includes("169.254.0.0/16"),
		`NO_PROXY missing the srt-hardcoded link-local CIDR: ${noProxy}`,
	);
	const withoutAuth = (httpsProxy ?? "").replace(/^http:\/\/[^@/]+@/, "http://");
	assert.match(
		withoutAuth,
		/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/,
		`HTTPS_PROXY is not a localhost http proxy: ${httpsProxy}`,
	);
	assert.ok(
		(wrappedTmpdir ?? "").startsWith(`${tmpdir()}${path.sep}`),
		`TMPDIR ${wrappedTmpdir} is not under os.tmpdir()`,
	);
	assert.equal(wrappedTmpdir, harness.scratchDir, "TMPDIR should be the private scratch dir");
});

test("wrapped kubectl version --client=true exits 0 (config reads stay allowed)", async (t) => {
	if (!hasBinary("kubectl")) {
		t.skip("kubectl not installed");
		return;
	}
	if (!gate(t)) return;
	const result = await wrappedRun("kubectl version --client=true");
	assert.equal(result.timedOut, false);
	assert.doesNotMatch(
		result.stderr,
		FS_ERRNO,
		`config read hit a filesystem-errno signature: ${result.stderr}`,
	);
	assert.equal(result.code, 0, `stderr: ${result.stderr}`);
});

test("wrapped gh auth status reads config without a filesystem-errno failure", async (t) => {
	if (!hasBinary("gh")) {
		t.skip("gh not installed");
		return;
	}
	if (!gate(t)) return;
	const result = await wrappedRun("gh auth status");
	assert.equal(result.timedOut, false);
	assert.doesNotMatch(
		result.stderr,
		FS_ERRNO,
		`config read hit a filesystem-errno signature: ${result.stderr}`,
	);
	// Token validity varies per host; only the read-not-denied class is asserted.
	t.diagnostic(`gh auth status wrapped exit code: ${result.code}`);
});

test("wrapped home write is denied while the unwrapped control creates and removes", async (t) => {
	if (!gate(t)) return;
	const marker = path.join(homedir(), ".torus-sbx-drift-marker");
	rmSync(marker, { force: true });
	try {
		const result = await wrappedRun(`touch ${marker}`);
		assert.equal(result.timedOut, false);
		assert.notEqual(result.code, 0, "a write outside allowWrite must fail inside the sandbox");
		assert.match(
			result.stderr,
			/EROFS|Read-only file system|Read-only/i,
			`stderr: ${result.stderr}`,
		);
		assert.equal(existsSync(marker), false, "the denied marker must not exist host-side");
		const control = await run(`touch ${marker} && rm -f ${marker} && echo control-ok`);
		assert.equal(control.timedOut, false);
		assert.equal(control.code, 0, `unwrapped control failed: ${control.stderr}`);
		assert.equal(control.stdout.trim(), "control-ok");
		assert.equal(existsSync(marker), false, "control run must clean up after itself");
	} finally {
		rmSync(marker, { force: true });
	}
});
