import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const {
	parseSandboxEnv,
	buildSandboxConfig,
	activateSandbox,
	registerSandbox,
	getSandboxState,
	resolveAdditionalWritableRoots,
	parseNetEntries,
	CURATED_NET_ALLOWLIST,
	INSTALL_CACHE_ROOTS,
	classifyDenial,
} = await import("../extensions/sandbox/index.ts");

function fakeManager() {
	const calls = { initialize: 0 };
	const captured = { config: null };
	return {
		calls,
		captured,
		async initialize(config) {
			calls.initialize += 1;
			captured.config = config;
		},
	};
}

function fakeDeps(manager, probeResult = { errors: [] }) {
	const calls = { probe: 0 };
	return {
		calls,
		manager,
		async probe() {
			calls.probe += 1;
			return probeResult;
		},
	};
}

test("parseSandboxEnv: unset defaults to off; on-family opts in; explicit 0/off stays off", () => {
	assert.deepEqual(parseSandboxEnv({}), {
		mode: "off",
		requested: "",
		writableExtras: [],
		netOnly: false,
		netAdd: [],
		netDropped: [],
		policyWritable: [],
		policyHostsAdd: [],
		policyHostsOnly: [],
		policyHostsDeny: [],
		credentialsFiles: [],
		credentialsEnvVars: [],
	});
	for (const value of ["0", "off"]) {
		assert.equal(parseSandboxEnv({ TORUS_SANDBOX: value }).mode, "off");
	}
	for (const value of ["1", "on", "full", "FULL"]) {
		assert.equal(parseSandboxEnv({ TORUS_SANDBOX: value }).mode, "full");
	}
});

test("parseSandboxEnv: unknown values default to off, keeping the raw request", () => {
	for (const value of ["fs", "jail", "true", "0"]) {
		const parsed = parseSandboxEnv({ TORUS_SANDBOX: value });
		assert.equal(parsed.mode, "off");
		assert.equal(parsed.requested, value);
	}
});

test("parseSandboxEnv: TORUS_SANDBOX_WRITABLE splits on :, trims, drops empties", () => {
	const parsed = parseSandboxEnv({
		TORUS_SANDBOX: "full",
		TORUS_SANDBOX_WRITABLE: " /a : /b ::/c ",
	});
	assert.deepEqual(parsed.writableExtras, ["/a", "/b", "/c"]);
});

test("buildSandboxConfig: writes allowed only in cwd, tmp, and extras; curated allowlist applies by default", () => {
	const config = buildSandboxConfig("/ws", {
		mode: "full",
		requested: "full",
		writableExtras: ["/extra"],
	});
	assert.deepEqual(config.filesystem.allowWrite.sort(), ["/extra", "/ws", tmpdir()].sort());
	assert.deepEqual(config.filesystem.denyWrite, []);
	assert.deepEqual(config.filesystem.denyRead, []);
	assert.deepEqual(config.network.allowedDomains, [...CURATED_NET_ALLOWLIST]);
	assert.deepEqual(config.network.deniedDomains, []);
});

test("activateSandbox: unknown mode value notices and stays off without probing", async () => {
	const manager = fakeManager();
	const deps = fakeDeps(manager);
	const notices = [];
	const state = await activateSandbox(parseSandboxEnv({ TORUS_SANDBOX: "fs" }), deps, (m) =>
		notices.push(m),
	);
	assert.deepEqual(state, { mode: "off", active: false });
	assert.equal(deps.calls.probe, 0);
	assert.equal(manager.calls.initialize, 0);
	assert.match(notices[0] ?? "", /not a recognized mode.*defaulting to off/);
});

test("activateSandbox: dependency errors degrade with a notice listing them", async () => {
	const manager = fakeManager();
	const deps = fakeDeps(manager, {
		errors: ["bubblewrap (bwrap) not installed", "socat not installed"],
	});
	const notices = [];
	const state = await activateSandbox(
		{ mode: "full", requested: "full", writableExtras: [] },
		deps,
		(m) => notices.push(m),
	);
	assert.equal(state.active, false);
	assert.equal(manager.calls.initialize, 0);
	assert.match(notices[0] ?? "", /unavailable: bubblewrap.*socat/s);
});

test("activateSandbox: successful init activates with workspace in allowWrite", async () => {
	const manager = fakeManager();
	const deps = fakeDeps(manager);
	const notices = [];
	const extra = mkdtempSync(path.join(tmpdir(), "sbx-extra-"));
	const state = await activateSandbox(
		{ mode: "full", requested: "full", writableExtras: [extra] },
		deps,
		(m) => notices.push(m),
	);
	assert.equal(state.active, true);
	assert.equal(deps.calls.probe, 1);
	assert.equal(manager.calls.initialize, 1);
	assert.ok(manager.captured.config.filesystem.allowWrite.includes(process.cwd()));
	assert.ok(manager.captured.config.filesystem.allowWrite.includes(extra));
	assert.deepEqual(notices, []);
});

test("activateSandbox: creates missing writable roots (0700) before initialize", async () => {
	const base = mkdtempSync(path.join(tmpdir(), "sbx-create-"));
	const missing = path.join(base, "deep", "extra-root");
	const manager = fakeManager();
	const deps = fakeDeps(manager);
	const notices = [];
	try {
		const state = await activateSandbox(
			{ mode: "full", requested: "full", writableExtras: [missing] },
			deps,
			(m) => notices.push(m),
		);
		assert.equal(state.active, true);
		assert.ok(existsSync(missing), "missing writable root is created by activation");
		assert.equal(statSync(missing).mode & 0o777, 0o700);
		assert.deepEqual(notices, []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("activateSandbox: CLAUDE_CODE_TMPDIR points at a fresh private 0700 dir under tmpdir", async () => {
	const previous = process.env.CLAUDE_CODE_TMPDIR;
	try {
		const manager = fakeManager();
		await activateSandbox(
			{ mode: "full", requested: "full", writableExtras: [] },
			fakeDeps(manager),
		);
		const first = process.env.CLAUDE_CODE_TMPDIR;
		assert.ok(first, "activation sets CLAUDE_CODE_TMPDIR");
		assert.ok(first.startsWith(`${tmpdir()}${path.sep}`), "scratch dir lives under os.tmpdir()");
		assert.ok(existsSync(first), "scratch dir is created");
		assert.equal(statSync(first).mode & 0o777, 0o700);
		assert.ok(
			!manager.captured.config.filesystem.allowWrite.includes(first),
			"scratch dir is covered by the tmpdir() allowWrite entry, not added explicitly",
		);

		await activateSandbox(
			{ mode: "full", requested: "full", writableExtras: [] },
			fakeDeps(fakeManager()),
		);
		const second = process.env.CLAUDE_CODE_TMPDIR;
		assert.ok(second && second !== first, "each activation claims a distinct scratch dir");
		assert.ok(existsSync(second) && (statSync(second).mode & 0o777) === 0o700);
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
		else process.env.CLAUDE_CODE_TMPDIR = previous;
	}
});

test("activateSandbox: uncreatable writable root degrades with a notice, activation still succeeds", async () => {
	const base = mkdtempSync(path.join(tmpdir(), "sbx-blocked-"));
	const blocker = path.join(base, "blocker");
	writeFileSync(blocker, "a plain file standing in as a parent directory\n");
	const doomed = path.join(blocker, "child");
	const manager = fakeManager();
	const deps = fakeDeps(manager);
	const notices = [];
	const previous = process.env.CLAUDE_CODE_TMPDIR;
	try {
		const state = await activateSandbox(
			{ mode: "full", requested: "full", writableExtras: [doomed] },
			deps,
			(m) => notices.push(m),
		);
		assert.deepEqual(state, { mode: "full", active: true });
		assert.equal(manager.calls.initialize, 1, "initialize still runs");
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /could not create writable root/);
		assert.ok(notices[0]?.includes(doomed), "notice names the root");
	} finally {
		rmSync(base, { recursive: true, force: true });
		if (previous === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
		else process.env.CLAUDE_CODE_TMPDIR = previous;
	}
});

test("activateSandbox: initialize failure degrades with init-failed notice", async () => {
	const manager = {
		async initialize() {
			throw new Error("boom");
		},
	};
	const deps = fakeDeps(manager);
	const notices = [];
	const state = await activateSandbox(
		{ mode: "full", requested: "full", writableExtras: [] },
		deps,
		(m) => notices.push(m),
	);
	assert.equal(state.active, false);
	assert.match(notices[0] ?? "", /init failed: boom/);
});

test("registerSandbox: unset defaults to off; explicit full subscribes bash interception", async () => {
	const previous = process.env.TORUS_SANDBOX;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const isolatedAgentDir = mkdtempSync(path.join(tmpdir(), "sbx-register-agent-"));
	try {
		delete process.env.TORUS_SANDBOX;
		process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
		const manager = fakeManager();
		const deps = fakeDeps(manager);
		const pi = handlerPi();
		await registerSandbox(pi, deps);
		assert.deepEqual(getSandboxState(), { mode: "off", active: false });
		assert.equal(manager.calls.initialize, 0);
		assert.equal(pi.handlers.tool_call, undefined, "off mode never intercepts");
		assert.ok(pi.handlers.session_start, "off mode still shows the chip");

		process.env.TORUS_SANDBOX = "full";
		const fullPi = handlerPi();
		await registerSandbox(fullPi, deps);
		assert.deepEqual(getSandboxState(), { mode: "full", active: true });
		assert.equal(manager.calls.initialize, 1);
		assert.ok(fullPi.handlers.tool_call, "full mode subscribes bash interception");
	} finally {
		if (previous === undefined) delete process.env.TORUS_SANDBOX;
		else process.env.TORUS_SANDBOX = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(isolatedAgentDir, { recursive: true, force: true });
	}
});

function handlerPi() {
	const handlers = {};
	return {
		handlers,
		on(event, handler) {
			handlers[event] = handler;
			return () => delete handlers[event];
		},
	};
}

function sandboxManagerFake({ wrapImpl } = {}) {
	const calls = {
		initialize: 0,
		wrap: 0,
		annotate: 0,
		cleanup: 0,
		reset: 0,
		registerNetwork: 0,
		unregisterNetwork: 0,
	};
	return {
		calls,
		capturedAsk: null,
		updatedConfigs: [],
		wrappedCommands: [],
		wrapOptions: [],
		customConfigs: [],
		registeredNetworkLists: [],
		unregisteredCommandIds: [],
		async initialize(_config, ask) {
			calls.initialize += 1;
			this.capturedAsk = ask ?? null;
		},
		updateConfig(config) {
			this.updatedConfigs.push(config);
		},
		registerCommandNetworkLists(commandId, lists) {
			calls.registerNetwork += 1;
			this.registeredNetworkLists.push({ commandId, lists });
		},
		unregisterCommandNetworkLists(commandId) {
			calls.unregisterNetwork += 1;
			this.unregisteredCommandIds.push(commandId);
		},
		async wrapWithSandbox(command, _binShell, customConfig, _abortSignal, options) {
			calls.wrap += 1;
			this.wrappedCommands.push(command);
			this.customConfigs.push(customConfig);
			this.wrapOptions.push(options);
			if (wrapImpl) return wrapImpl(command);
			return `bwrap --ro-bind / / -- ${command}`;
		},
		annotateStderrWithSandboxFailures(_command, stderr) {
			calls.annotate += 1;
			return stderr.includes("denied") ? `${stderr}\n[torus:sandbox] write denied` : stderr;
		},
		cleanupAfterCommand() {
			calls.cleanup += 1;
		},
		async reset() {
			calls.reset += 1;
		},
	};
}

async function activateHandlers(manager) {
	const pi = handlerPi();
	const previous = process.env.TORUS_SANDBOX;
	process.env.TORUS_SANDBOX = "full";
	try {
		await registerSandbox(pi, {
			manager,
			async probe() {
				return { errors: [] };
			},
		});
	} finally {
		if (previous === undefined) delete process.env.TORUS_SANDBOX;
		else process.env.TORUS_SANDBOX = previous;
	}
	return pi;
}

test("tool_call: active sandbox rewrites bash commands, tracks them, annotates result, cleans up", async () => {
	const manager = sandboxManagerFake();
	const pi = await activateHandlers(manager);
	const input = { command: "npm test" };
	const result = await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "tc1",
		input,
	});
	assert.equal(result, undefined);
	assert.equal(
		input.command,
		"bwrap --ro-bind / / -- env CHECKPOINT_DISABLE=1 GH_NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1 npm test",
	);
	assert.equal(manager.calls.wrap, 1);
	const res = await pi.handlers.tool_result({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "tc1",
		input: { command: "npm test" },
		content: [{ type: "text", text: "write denied" }],
	});
	assert.match(res.content[0].text, /\[torus:sandbox\] write denied/);
	assert.equal(manager.calls.annotate, 1);
	assert.equal(manager.calls.cleanup, 1);
	const res2 = await pi.handlers.tool_result({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "tc1",
		input: { command: "npm test" },
		content: [{ type: "text", text: "x" }],
	});
	assert.equal(res2, undefined, "command already cleaned up");
	assert.equal(manager.calls.cleanup, 1);
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
	assert.equal(manager.calls.reset, 1);
});

test("tool_call: wrap failure blocks with actionable reason (fail-closed)", async () => {
	const manager = sandboxManagerFake({
		wrapImpl: () => {
			throw new Error("seccomp rejected");
		},
	});
	const pi = await activateHandlers(manager);
	const input = { command: "curl example.com" };
	const result = await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "tc2",
		input,
	});
	assert.equal(result.block, true);
	assert.match(result.reason, /wrap failed: seccomp rejected/);
	assert.match(result.reason, /TORUS_SANDBOX=off/);
	assert.equal(input.command, "curl example.com");
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
});

test("tool_call: non-bash tools pass through untouched", async () => {
	const manager = sandboxManagerFake();
	const pi = await activateHandlers(manager);
	const input = { path: "/etc/hosts", content: "x" };
	const result = await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "write",
		toolCallId: "tc3",
		input,
	});
	assert.equal(result, undefined);
	assert.equal(manager.calls.wrap, 0);
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
});

test("session_shutdown: reset runs once and the sandbox goes inert", async () => {
	const manager = sandboxManagerFake();
	const pi = await activateHandlers(manager);
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
	const input = { command: "ls" };
	const result = await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "tc4",
		input,
	});
	assert.equal(result, undefined);
	assert.equal(manager.calls.wrap, 0);
	assert.equal(manager.calls.reset, 1);
});

test("resolveAdditionalWritableRoots: git common dir + worktrees root, absent pieces skipped", () => {
	const repo = mkdtempSync(path.join(tmpdir(), "torus-sbx-repo-"));
	const outside = mkdtempSync(path.join(tmpdir(), "torus-sbx-out-"));
	const previousWt = process.env.TORUS_WORKTREES_ROOT;
	process.env.TORUS_WORKTREES_ROOT = outside;
	try {
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (key.startsWith("GIT_")) delete env[key];
		}
		spawnSync("git", ["-C", repo, "init", "-q"], { env });
		const inRepo = resolveAdditionalWritableRoots(repo);
		assert.ok(inRepo.includes(path.resolve(repo, ".git")));
		assert.ok(inRepo.includes(outside));
		const plain = mkdtempSync(path.join(tmpdir(), "torus-sbx-plain-"));
		const notRepo = resolveAdditionalWritableRoots(plain);
		assert.ok(!notRepo.some((root) => root.startsWith(plain)));
		assert.ok(notRepo.includes(outside));
		process.env.TORUS_WORKTREES_ROOT = path.join(outside, "does-not-exist");
		assert.deepEqual(resolveAdditionalWritableRoots(plain), []);
	} finally {
		if (previousWt === undefined) delete process.env.TORUS_WORKTREES_ROOT;
		else process.env.TORUS_WORKTREES_ROOT = previousWt;
	}
});

test("buildSandboxConfig: additional roots (git plumbing, worktrees) are writable", () => {
	const config = buildSandboxConfig(
		"/ws",
		{ mode: "full", requested: "full", writableExtras: [] },
		["/main/.git", "/home/u/.torus/worktrees"],
	);
	assert.deepEqual(
		config.filesystem.allowWrite.sort(),
		["/home/u/.torus/worktrees", "/main/.git", "/ws", tmpdir()].sort(),
	);
});

test("parseNetEntries: trims/lowercases, drops over-broad patterns, keeps strict subdomains", () => {
	const { entries, dropped } = parseNetEntries(
		" Docker.IO , *.golang.org ,* , *.com,,example.com ",
	);
	assert.deepEqual(entries, ["docker.io", "*.golang.org", "example.com"]);
	assert.deepEqual(dropped, ["*", "*.com"]);
});

test("parseSandboxEnv: NET_ADD appends, NET_ONLY replaces, drops surface", () => {
	const parsed = parseSandboxEnv({
		TORUS_SANDBOX: "full",
		TORUS_SANDBOX_NET_ADD: " internal.corp , *.com ",
		TORUS_SANDBOX_NET_ONLY: "0",
	});
	assert.equal(parsed.netOnly, false);
	assert.deepEqual(parsed.netAdd, ["internal.corp"]);
	assert.deepEqual(parsed.netDropped, ["*.com"]);
	const only = parseSandboxEnv({ TORUS_SANDBOX: "full", TORUS_SANDBOX_NET_ONLY: "a.dev,b.dev" });
	assert.equal(only.netOnly, true);
	assert.deepEqual(only.netAdd, ["a.dev", "b.dev"]);
});

test("buildSandboxConfig: curated by default, NET_ADD unions and dedupes, NET_ONLY replaces", () => {
	const base = { mode: "full", requested: "full", writableExtras: [] };
	assert.deepEqual(buildSandboxConfig("/ws", base).network.allowedDomains, [
		...CURATED_NET_ALLOWLIST,
	]);
	const added = buildSandboxConfig("/ws", { ...base, netAdd: ["internal.corp", "github.com"] });
	assert.ok(added.network.allowedDomains.includes("internal.corp"));
	assert.equal(added.network.allowedDomains.filter((h) => h === "github.com").length, 1);
	const only = buildSandboxConfig("/ws", { ...base, netOnly: true, netAdd: ["a.dev"] });
	assert.deepEqual(only.network.allowedDomains, ["a.dev"]);
});

test("activateSandbox: over-broad net entries produce a notice", async () => {
	const manager = { async initialize() {} };
	const deps = {
		manager,
		async probe() {
			return { errors: [] };
		},
	};
	const notices = [];
	await activateSandbox(
		{
			mode: "full",
			requested: "full",
			writableExtras: [],
			netOnly: false,
			netAdd: [],
			netDropped: ["*.com"],
		},
		deps,
		(m) => notices.push(m),
	);
	assert.match(notices[0] ?? "", /dropped over-broad network entries.*\*\.com/);
});

test("tool_call during async init waits for activation (no unwrapped slip-through)", async () => {
	const pi = handlerPi();
	const previous = process.env.TORUS_SANDBOX;
	process.env.TORUS_SANDBOX = "full";
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const calls = { wrap: 0 };
	const manager = {
		async initialize() {
			await gate;
		},
		async wrapWithSandbox(command) {
			calls.wrap += 1;
			return `bwrap -- ${command}`;
		},
		annotateStderrWithSandboxFailures(_command, stderr) {
			return stderr;
		},
		cleanupAfterCommand() {},
		async reset() {},
	};
	let registered;
	try {
		registered = registerSandbox(pi, {
			manager,
			async probe() {
				return { errors: [] };
			},
		});
	} finally {
		if (previous === undefined) delete process.env.TORUS_SANDBOX;
		else process.env.TORUS_SANDBOX = previous;
	}
	const input = { command: "echo early" };
	const handled = pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "race1",
		input,
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.wrap, 0, "must not wrap before activation settles");
	release();
	await registered;
	await handled;
	assert.equal(calls.wrap, 1);
	assert.equal(
		input.command,
		"bwrap -- env CHECKPOINT_DISABLE=1 GH_NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1 echo early",
	);
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
});

test("statusline chip: set on session_start, updated after activation, cleared on shutdown", async () => {
	const manager = sandboxManagerFake();
	const pi = await activateHandlers(manager);
	const chip = [];
	const ctx = {
		ui: {
			setStatus(key, text) {
				chip.push([key, text]);
			},
			theme: { fg: (_color, text) => text },
		},
	};
	await pi.handlers.session_start({ type: "session_start" }, ctx);
	assert.deepEqual(chip.at(-1), ["torus:sandbox", "sbx:on"]);
	await pi.handlers.session_shutdown({ type: "session_shutdown" }, ctx);
	assert.deepEqual(chip.at(-1), ["torus:sandbox", undefined]);
});

test("stale ctx after session replacement must not crash registerSandbox", async () => {
	// Reproduces the pi uncaughtException on resume: the ctx captured by
	// session_start is invalidated when the session is replaced, and its
	// ui getter throws; the post-activation chip write must swallow it.
	const manager = sandboxManagerFake();
	const pi = handlerPi();
	const previous = process.env.TORUS_SANDBOX;
	process.env.TORUS_SANDBOX = "full";
	let registered;
	try {
		registered = registerSandbox(pi, {
			manager,
			async probe() {
				return { errors: [] };
			},
		});
		const staleCtx = {
			get ui() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
				);
			},
		};
		await pi.handlers.session_start({ type: "session_start" }, staleCtx);
	} finally {
		if (previous === undefined) delete process.env.TORUS_SANDBOX;
		else process.env.TORUS_SANDBOX = previous;
	}
	await assert.doesNotReject(registered);
	assert.equal(getSandboxState().active, true);
});

test("doctor sandboxCheck: reflects the shared globalThis slot", async () => {
	const { sandboxCheck } = await import("../extensions/doctor/index.ts");
	const slot = globalThis[Symbol.for("torus.sandbox.v1")];
	const original = slot.state;
	try {
		slot.state = { mode: "off", active: false };
		assert.equal(sandboxCheck().status, "ok");
		assert.match(sandboxCheck().detail, /off \(opt-in: TORUS_SANDBOX=full\)/);
		slot.state = { mode: "full", active: true };
		assert.equal(sandboxCheck().status, "ok");
		assert.match(sandboxCheck().detail, /curated network allowlist/);
		slot.state = { mode: "full", active: false };
		assert.equal(sandboxCheck().status, "warn");
		assert.match(sandboxCheck().detail, /running unsandboxed/);
	} finally {
		slot.state = original;
	}
});

test("CURATED_NET_ALLOWLIST: 31 dev-workflow hosts incl. release-assets fix and the AWS API wildcard; no generic CDNs", () => {
	assert.equal(CURATED_NET_ALLOWLIST.length, 31);
	assert.ok(CURATED_NET_ALLOWLIST.includes("*.amazonaws.com"), "AWS API endpoints are curated");
	for (const host of [
		"release-assets.githubusercontent.com",
		"rubygems.org",
		"repo.maven.apache.org",
		"api.nuget.org",
		"static.rust-lang.org",
	]) {
		assert.ok(CURATED_NET_ALLOWLIST.includes(host), `missing ${host}`);
	}
	for (const cdn of ["cdn.jsdelivr.net", "unpkg.com"]) {
		assert.ok(!CURATED_NET_ALLOWLIST.includes(cdn), `${cdn} must stay opt-in via NET_ADD`);
	}
});

test("ask callback wiring: absent slot denies; always grants and updateConfig appends the host", async () => {
	const manager = sandboxManagerFake();
	const pi = await activateHandlers(manager);
	const ask = manager.capturedAsk;
	assert.equal(typeof ask, "function", "initialize receives the ask callback");
	assert.equal(await ask({ host: "nope.dev", port: 443 }), false, "no approval slot ⇒ deny");
	assert.equal(manager.updatedConfigs.length, 0);

	const SLOT = Symbol.for("torus.approval.v1");
	const previousSlot = globalThis[SLOT];
	globalThis[SLOT] = {
		async askNetworkTrust(host) {
			return host === "granted.dev" ? { kind: "always" } : { kind: "deny" };
		},
	};
	try {
		assert.equal(await ask({ host: "granted.dev", port: 443 }), true);
		assert.equal(manager.updatedConfigs.length, 1);
		assert.ok(
			manager.updatedConfigs[0].network.allowedDomains.includes("granted.dev"),
			"updateConfig appends the granted host",
		);
		assert.equal(await ask({ host: "nope.dev", port: 443 }), false, "deny decisions stay deny");
	} finally {
		if (previousSlot === undefined) delete globalThis[SLOT];
		else globalThis[SLOT] = previousSlot;
	}
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
});

test("ask callback wiring: allow-once registers on the in-flight commandId; custom also appends", async () => {
	const manager = sandboxManagerFake();
	const pi = await activateHandlers(manager);
	const ask = manager.capturedAsk;
	const SLOT = Symbol.for("torus.approval.v1");
	const previousSlot = globalThis[SLOT];
	const decisions = [
		{ kind: "allow" },
		{ kind: "custom", text: "*.internal.corp", host: "*.internal.corp" },
	];
	globalThis[SLOT] = {
		async askNetworkTrust() {
			return decisions.shift();
		},
	};
	try {
		const input = { command: "curl https://once.example" };
		await pi.handlers.tool_call({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "once1",
			input,
		});
		const commandId = manager.wrapOptions[0].commandId;
		assert.equal(manager.calls.registerNetwork, 0);
		assert.equal(await ask({ host: "once.dev", port: 443 }), true);
		assert.equal(manager.updatedConfigs.length, 0, "allow-once does not touch config");
		assert.equal(manager.calls.registerNetwork, 1, "allow-once registers on the current command");
		assert.equal(manager.registeredNetworkLists[0].commandId, commandId);
		assert.deepEqual(manager.registeredNetworkLists[0].lists, { allowedDomains: ["once.dev"] });
		assert.equal(await ask({ host: "anything.internal.corp", port: 443 }), true);
		assert.equal(manager.updatedConfigs.length, 1);
		assert.ok(manager.updatedConfigs[0].network.allowedDomains.includes("*.internal.corp"));
		assert.equal(manager.calls.registerNetwork, 2, "custom host also widens the current command");
		assert.deepEqual(manager.registeredNetworkLists[1].lists, {
			allowedDomains: ["*.internal.corp"],
		});
		await pi.handlers.tool_result({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "once1",
			input,
			content: [{ type: "text", text: "ok" }],
		});
		assert.deepEqual(manager.unregisteredCommandIds, [commandId]);
	} finally {
		if (previousSlot === undefined) delete globalThis[SLOT];
		else globalThis[SLOT] = previousSlot;
	}
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
});

function emptyPolicy(overrides = {}) {
	return {
		mode: undefined,
		writable: [],
		hostsAdd: [],
		hostsOnly: [],
		hostsDeny: [],
		credentialsFiles: [],
		credentialsEnvVars: [],
		exempt: [],
		env: {},
		signRelay: false,
		...overrides,
	};
}

test("parseSandboxEnv: user policy mode applies when env is unset; explicit env beats policy", () => {
	assert.equal(parseSandboxEnv({}, emptyPolicy({ mode: "full" })).mode, "full");
	assert.equal(
		parseSandboxEnv({ TORUS_SANDBOX: "off" }, emptyPolicy({ mode: "full" })).mode,
		"off",
	);
	assert.equal(
		parseSandboxEnv({ TORUS_SANDBOX: "wibble" }, emptyPolicy({ mode: "full" })).mode,
		"full",
	);
	assert.equal(parseSandboxEnv({}, emptyPolicy()).mode, "off");
});

test("parseSandboxEnv: TORUS_SANDBOX_DEFAULT trials default-on without shipping it", () => {
	assert.equal(parseSandboxEnv({}).mode, "off", "unset stays off");
	assert.equal(parseSandboxEnv({ TORUS_SANDBOX_DEFAULT: "full" }).mode, "full");
	assert.equal(parseSandboxEnv({ TORUS_SANDBOX_DEFAULT: "FULL" }).mode, "full");
	assert.equal(
		parseSandboxEnv({ TORUS_SANDBOX: "off", TORUS_SANDBOX_DEFAULT: "full" }).mode,
		"off",
		"explicit off beats the trial default",
	);
	assert.equal(
		parseSandboxEnv({ TORUS_SANDBOX: "full", TORUS_SANDBOX_DEFAULT: "off" }).mode,
		"full",
		"explicit full beats the trial default",
	);
	assert.equal(
		parseSandboxEnv({ TORUS_SANDBOX: "wibble", TORUS_SANDBOX_DEFAULT: "full" }).mode,
		"full",
		"unknown falls back to the effective default",
	);
	assert.equal(
		parseSandboxEnv({ TORUS_SANDBOX_DEFAULT: "off" }, emptyPolicy({ mode: "full" })).mode,
		"full",
		"a non-on knob value leaves the policy mode in charge",
	);
});

test("buildSandboxConfig: policy writable/hosts/credentials and seeded trust shape the config", () => {
	const env = {
		mode: "full",
		requested: "full",
		writableExtras: [],
		netOnly: false,
		netAdd: [],
		netDropped: [],
		policyWritable: [{ path: "/opt/extra", literal: true }],
		policyHostsAdd: ["example.org"],
		policyHostsOnly: [],
		policyHostsDeny: ["evil.example"],
		credentialsFiles: ["/home/u/.aws/credentials"],
		credentialsEnvVars: ["AWS_SESSION_TOKEN"],
	};
	const config = buildSandboxConfig("/repo", env, [], ["granted.example"]);
	assert.deepEqual(config.filesystem.allowWrite.at(-1), { path: "/opt/extra", literal: true });
	assert.ok(config.network.allowedDomains.includes("example.org"));
	assert.ok(config.network.allowedDomains.includes("granted.example"));
	assert.ok(
		config.network.allowedDomains.includes("*.amazonaws.com"),
		"AWS API endpoints are curated",
	);
	assert.ok(!config.network.allowedDomains.includes("*.com"), "bare TLD wildcards stay rejected");
	assert.deepEqual(config.network.deniedDomains, ["evil.example"]);
	assert.deepEqual(config.credentials, {
		files: [{ path: "/home/u/.aws/credentials", mode: "deny" }],
		envVars: [{ name: "AWS_SESSION_TOKEN", mode: "deny" }],
	});
});

test("buildSandboxConfig: user-layer hosts.only replaces the curated allowlist but keeps additions", () => {
	const env = {
		mode: "full",
		requested: "full",
		writableExtras: [],
		netOnly: false,
		netAdd: ["env.example"],
		netDropped: [],
		policyWritable: [],
		policyHostsAdd: ["policy.example"],
		policyHostsOnly: ["only.example"],
		policyHostsDeny: [],
		credentialsFiles: [],
		credentialsEnvVars: [],
	};
	const config = buildSandboxConfig("/repo", env, [], ["granted.example"]);
	assert.ok(config.network.allowedDomains.includes("only.example"));
	assert.ok(
		config.network.allowedDomains.includes("env.example"),
		"env additions survive a policy replacement",
	);
	assert.ok(config.network.allowedDomains.includes("policy.example"));
	assert.ok(
		config.network.allowedDomains.includes("granted.example"),
		"persisted trust survives a policy replacement",
	);
	assert.ok(
		!config.network.allowedDomains.includes("registry.npmjs.org"),
		"curated list is replaced",
	);
});

test("registerSandbox: seeded trusted hosts flow into the initial allowlist", async () => {
	const previous = process.env.TORUS_SANDBOX;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.TORUS_SANDBOX = "full";
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "sbx-seed-agent-"));
		const manager = fakeManager();
		const deps = { ...fakeDeps(manager), seededHosts: () => ["seeded.example"] };
		await registerSandbox(handlerPi(), deps);
		assert.ok(
			manager.captured.config.network.allowedDomains.includes("seeded.example"),
			"persisted trust is seeded without an ask round-trip",
		);
	} finally {
		if (previous === undefined) delete process.env.TORUS_SANDBOX;
		else process.env.TORUS_SANDBOX = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});

async function activateHandlersWithPolicy(manager, sandboxPolicy = null) {
	const agentDir = mkdtempSync(path.join(tmpdir(), "sbx-policy-agent-"));
	if (sandboxPolicy !== null) {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ torus: { sandbox: sandboxPolicy } }),
		);
	}
	const pi = handlerPi();
	const previous = process.env.TORUS_SANDBOX;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.TORUS_SANDBOX = "full";
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await registerSandbox(pi, {
			manager,
			async probe() {
				return { errors: [] };
			},
		});
	} finally {
		if (previous === undefined) delete process.env.TORUS_SANDBOX;
		else process.env.TORUS_SANDBOX = previous;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	return { pi, agentDir };
}

function shutdownCtx() {
	return { ui: { setStatus() {}, theme: { fg: (_c, t) => t } } };
}

test("tool_call: install commands pass the merged allowWrite; plain commands pass none", async () => {
	const manager = sandboxManagerFake();
	const previousHome = process.env.HOME;
	const home = mkdtempSync(path.join(tmpdir(), "sbx-home-"));
	process.env.HOME = home;
	try {
		const { pi } = await activateHandlersWithPolicy(manager);
		const input = { command: "npm install left-pad" };
		await pi.handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "ins1", input });
		const custom = manager.customConfigs[0];
		assert.ok(custom, "install wrap passes customConfig");
		const allow = custom.filesystem.allowWrite;
		assert.ok(
			allow.some((entry) => entry.path === path.join(home, ".npm") && entry.literal === true),
			"npm cache root is a literal writable entry",
		);
		assert.ok(allow.includes(process.cwd()), "session entries survive the whole-section override");
		assert.ok(allow.includes(tmpdir()), "tmpdir stays writable");
		assert.ok(
			existsSync(path.join(home, ".cache", "pnpm")),
			"missing cache roots are pre-created (srt drops non-existent paths)",
		);

		const plain = { command: "node script.js" };
		await pi.handlers.tool_call({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "ins2",
			input: plain,
		});
		assert.equal(manager.customConfigs[1], undefined, "non-install commands get no customConfig");
		await pi.handlers.session_shutdown(undefined, shutdownCtx());
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("tool_call: go install widening follows $GOPATH", async () => {
	const manager = sandboxManagerFake();
	const previousHome = process.env.HOME;
	const previousGopath = process.env.GOPATH;
	const home = mkdtempSync(path.join(tmpdir(), "sbx-go-home-"));
	process.env.HOME = home;
	process.env.GOPATH = path.join(home, "custom-go");
	try {
		const { pi } = await activateHandlersWithPolicy(manager);
		const input = { command: "go build ./..." };
		await pi.handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "go1", input });
		const allow = manager.customConfigs[0].filesystem.allowWrite;
		assert.ok(
			allow.some(
				(entry) =>
					entry.path === path.join(home, "custom-go", "pkg", "mod") && entry.literal === true,
			),
			"the go module cache is resolved under $GOPATH",
		);
		await pi.handlers.session_shutdown(undefined, shutdownCtx());
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousGopath === undefined) delete process.env.GOPATH;
		else process.env.GOPATH = previousGopath;
		rmSync(home, { recursive: true, force: true });
	}
});

test("INSTALL_CACHE_ROOTS: managers map to $HOME-relative cache roots", () => {
	assert.deepEqual(INSTALL_CACHE_ROOTS.npm, [".npm", ".cache/pnpm", ".cache/yarn"]);
	assert.deepEqual(INSTALL_CACHE_ROOTS.pip, [".cache/pip", ".cache/uv"]);
	assert.deepEqual(INSTALL_CACHE_ROOTS.cargo, [".cargo/registry", ".cargo/git"]);
	assert.deepEqual(INSTALL_CACHE_ROOTS.gradle, [".gradle/caches"]);
	assert.deepEqual(INSTALL_CACHE_ROOTS.mvn, [".m2/repository"]);
	assert.deepEqual(INSTALL_CACHE_ROOTS.go, []);
});

test("tool_call: commandIds are random base64url and unregistered on tool_result", async () => {
	const manager = sandboxManagerFake();
	const pi = await activateHandlers(manager);
	const first = { command: "echo one" };
	const second = { command: "echo two" };
	await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "cmd-a",
		input: first,
	});
	await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "cmd-b",
		input: second,
	});
	const ids = manager.wrapOptions.map((options) => options.commandId);
	for (const id of ids) {
		assert.match(id, /^[A-Za-z0-9_-]{22,}$/);
	}
	assert.notEqual(ids[0], ids[1], "each wrap gets a fresh id");
	await pi.handlers.tool_result({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "cmd-a",
		input: first,
		content: [{ type: "text", text: "ok" }],
	});
	assert.deepEqual(manager.unregisteredCommandIds, [ids[0]]);
	await pi.handlers.tool_result({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "cmd-b",
		input: second,
		content: [{ type: "text", text: "ok" }],
	});
	assert.deepEqual(manager.unregisteredCommandIds, ids);
	await pi.handlers.session_shutdown(undefined, shutdownCtx());
});

test("tool_call: exempt policy prefixes skip wrapping entirely", async () => {
	const manager = sandboxManagerFake();
	const { pi, agentDir } = await activateHandlersWithPolicy(manager, {
		exempt: ["docker ", "terraform apply"],
	});
	try {
		const input = { command: "docker version" };
		const result = await pi.handlers.tool_call({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "ex1",
			input,
		});
		assert.equal(result, undefined);
		assert.equal(manager.calls.wrap, 0, "exempt command is never wrapped");
		assert.equal(input.command, "docker version", "the raw command is left untouched");
		const other = { command: "terraform version" };
		await pi.handlers.tool_call({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "ex2",
			input: other,
		});
		assert.equal(manager.calls.wrap, 1, "a non-matching command still wraps");
		await pi.handlers.session_shutdown(undefined, shutdownCtx());
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("tool_call: telemetry opt-outs and policy env are prepended unless already set", async () => {
	const manager = sandboxManagerFake();
	const { pi } = await activateHandlersWithPolicy(manager, {
		env: { TORUS_SANDBOX_TEST_FLAG: "on" },
	});
	const input = { command: "terraform version" };
	await pi.handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "env1", input });
	const wrapped = manager.wrappedCommands[0];
	const prefix = wrapped.slice(0, wrapped.indexOf(" terraform"));
	assert.deepEqual(
		prefix.split(" ").slice(1).sort(),
		[
			"CHECKPOINT_DISABLE=1",
			"DO_NOT_TRACK=1",
			"GH_NO_UPDATE_NOTIFIER=1",
			"TORUS_SANDBOX_TEST_FLAG=on",
		].sort(),
	);
	assert.ok(wrapped.endsWith(" terraform version"), "the original command survives verbatim");

	const preset = { command: "CHECKPOINT_DISABLE=0 terraform version" };
	await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "env2",
		input: preset,
	});
	const wrapped2 = manager.wrappedCommands[1];
	assert.ok(!wrapped2.includes("CHECKPOINT_DISABLE=1"), "an already-set var is not duplicated");
	assert.ok(wrapped2.includes("GH_NO_UPDATE_NOTIFIER=1"), "the remaining vars are still prepended");
	assert.ok(wrapped2.endsWith(" CHECKPOINT_DISABLE=0 terraform version"));
	await pi.handlers.session_shutdown(undefined, shutdownCtx());
});

function fakeSignRelay() {
	return {
		started: 0,
		stopped: 0,
		options: null,
		wrapperScriptPath: "/tmp/torus-fake-sign-wrapper.mjs",
		async start() {
			this.started += 1;
		},
		async stop() {
			this.stopped += 1;
		},
	};
}

function relayTestEnv(agentDir) {
	process.env.TORUS_SANDBOX = "full";
	process.env.TORUS_SANDBOX_SIGN = "relay";
	process.env.SSH_AUTH_SOCK = "/run/user/1000/agent.sock";
	process.env.PI_CODING_AGENT_DIR = agentDir;
}

function restoreEnv(saved) {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

test("sign relay: starts on the session scratch, seeds git config, stops on shutdown", async () => {
	const saved = {
		TORUS_SANDBOX: process.env.TORUS_SANDBOX,
		TORUS_SANDBOX_SIGN: process.env.TORUS_SANDBOX_SIGN,
		SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR,
	};
	try {
		relayTestEnv(mkdtempSync(path.join(tmpdir(), "sbx-relay-agent-")));
		const manager = sandboxManagerFake();
		const relay = fakeSignRelay();
		const deps = {
			...fakeDeps(manager),
			startSignRelay: async (options) => {
				relay.options = options;
				return relay;
			},
		};
		const pi = handlerPi();
		await registerSandbox(pi, deps);
		assert.equal(relay.started, 1);
		assert.equal(
			relay.options.scratchDir,
			process.env.CLAUDE_CODE_TMPDIR,
			"relay lives on the session scratch dir",
		);
		await pi.handlers.tool_call({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "sign-1",
			input: { command: "git commit --allow-empty -m probe" },
		});
		const wrapped = manager.wrappedCommands[0];
		assert.ok(wrapped.includes("GIT_CONFIG_KEY_0=gpg.ssh.program"));
		assert.ok(wrapped.includes(relay.wrapperScriptPath));
		assert.ok(wrapped.includes("GIT_CONFIG_VALUE_1=ssh"));
		await pi.handlers.tool_call({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "sign-2",
			input: { command: "node script.js" },
		});
		assert.ok(
			!manager.wrappedCommands[1].includes("GIT_CONFIG"),
			"non-git commands are not seeded",
		);
		pi.handlers.tool_result({ type: "tool_result", toolCallId: "sign-1", content: [] });
		pi.handlers.tool_result({ type: "tool_result", toolCallId: "sign-2", content: [] });
		await pi.handlers.session_shutdown(undefined, shutdownCtx());
		assert.equal(relay.stopped, 1);
	} finally {
		restoreEnv(saved);
	}
});

test("sign relay: enabled without a host agent it stays off", async () => {
	const saved = {
		TORUS_SANDBOX: process.env.TORUS_SANDBOX,
		TORUS_SANDBOX_SIGN: process.env.TORUS_SANDBOX_SIGN,
		SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR,
	};
	try {
		relayTestEnv(mkdtempSync(path.join(tmpdir(), "sbx-relay-agent-")));
		delete process.env.SSH_AUTH_SOCK;
		const manager = sandboxManagerFake();
		const relay = fakeSignRelay();
		const deps = {
			...fakeDeps(manager),
			startSignRelay: async (options) => {
				relay.options = options;
				return relay;
			},
		};
		await registerSandbox(handlerPi(), deps);
		assert.equal(relay.started, 0, "no agent on the host means no relay");
	} finally {
		restoreEnv(saved);
	}
});

test("sign relay: off unless the knob or policy asks for it", async () => {
	const saved = {
		TORUS_SANDBOX: process.env.TORUS_SANDBOX,
		TORUS_SANDBOX_SIGN: process.env.TORUS_SANDBOX_SIGN,
		SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR,
	};
	try {
		process.env.TORUS_SANDBOX = "full";
		delete process.env.TORUS_SANDBOX_SIGN;
		process.env.SSH_AUTH_SOCK = "/run/user/1000/agent.sock";
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(path.join(tmpdir(), "sbx-relay-agent-"));
		const manager = sandboxManagerFake();
		const relay = fakeSignRelay();
		const deps = {
			...fakeDeps(manager),
			startSignRelay: async (options) => {
				relay.options = options;
				return relay;
			},
		};
		const pi = handlerPi();
		await registerSandbox(pi, deps);
		assert.equal(relay.started, 0);
		await pi.handlers.tool_call({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "nosign-1",
			input: { command: "git commit --allow-empty -m probe" },
		});
		assert.ok(!manager.wrappedCommands[0].includes("GIT_CONFIG"), "no relay means no git seeding");
		await pi.handlers.session_shutdown(undefined, shutdownCtx());
	} finally {
		restoreEnv(saved);
	}
});

test("classifyDenial: each class fires on its signature, ordinary failures stay null", () => {
	const saved = { CLAUDE_CODE_TMPDIR: process.env.CLAUDE_CODE_TMPDIR };
	const scratch = mkdtempSync(path.join(tmpdir(), "sbx-classify-"));
	try {
		process.env.CLAUDE_CODE_TMPDIR = scratch;
		const table = [
			{
				name: "EROFS write denial",
				text: "cp: cannot create regular file '/etc/resolv.conf': Read-only file system",
				expect: /write denied outside allowed roots.*TORUS_SANDBOX_WRITABLE/,
			},
			{
				name: "ENOENT under the session scratch (hidden parent)",
				text: `cp: cannot stat '${scratch}/out/data.json': No such file or directory`,
				expect: /path hidden from the sandbox namespace.*writable roots/,
			},
			{
				name: "ENOENT via mktemp template shape",
				text: "mktemp: failed to create file via template '/var/folders/t/tmp.XXXXXXXXXX': No such file or directory",
				expect: /path hidden from the sandbox namespace/,
			},
			{
				name: "EPERM connecting to an agent socket",
				text: "Error connecting to agent: Operation not permitted",
				expect: /unix sockets are blocked in the sandbox.*interactive_bash/,
			},
			{
				name: "EPERM on the docker socket",
				text: "dial unix /var/run/docker.sock: connect: operation not permitted",
				expect: /unix sockets are blocked in the sandbox/,
			},
			{
				name: "srt proxy violation line",
				text: "deny network-outbound example.com:443 (denied by sandbox policy)",
				expect: /host not allowed.*TORUS_SANDBOX_NET_ADD/,
			},
			{
				name: "client-visible 403 line carrying a URL",
				text: "npm ERR! 403 Forbidden - GET https://example.com/pkg",
				expect: /host not allowed/,
			},
			{
				name: "ordinary grep read failure",
				text: "grep: unable to read missing.txt",
				expect: null,
			},
			{
				name: "ordinary ENOENT outside the scratch",
				text: "cat: missing.txt: No such file or directory",
				expect: null,
			},
			{
				name: "ordinary chmod EPERM without socket context",
				text: "chmod: changing permissions of '/root/secret': Operation not permitted",
				expect: null,
			},
			{
				name: "403 without a host on the line",
				text: "curl: (22) The requested URL returned error: 403",
				expect: null,
			},
			{ name: "empty text", text: "", expect: null },
		];
		for (const { name, text, expect } of table) {
			const line = classifyDenial(text);
			if (expect === null) assert.equal(line, null, `${name}: expected no classification`);
			else assert.ok(expect.test(line ?? ""), `${name}: expected ${expect} in "${line}"`);
		}
		assert.match(
			classifyDenial("touch: cannot touch '/x': Read-only file system"),
			/^\[torus: sandbox\] .+ — .+$/,
			"ready-to-append class — remedy shape",
		);
		assert.match(
			classifyDenial(
				"deny network-outbound example.com:443 (denied by sandbox policy)\ncp: '/x': Read-only file system",
			),
			/write denied outside allowed roots/,
			"table order wins: EROFS outranks a proxy denial later in the text",
		);
		delete process.env.CLAUDE_CODE_TMPDIR;
		assert.match(
			classifyDenial("ls: cannot access '/tmp/claude/tmp.XXXXXXXXXX': No such file or directory"),
			/path hidden from the sandbox namespace/,
			"default scratch fallback when CLAUDE_CODE_TMPDIR is unset",
		);
	} finally {
		restoreEnv(saved);
	}
});

test("tool_result: EROFS stderr plus srt violations gains a single appended class line", async () => {
	const manager = sandboxManagerFake();
	// The stock fake annotates only the word "denied"; srt's real annotate wraps
	// recorded violations in a <sandbox_violations> block, so drive the
	// classifier path with that shape.
	manager.annotateStderrWithSandboxFailures = (_command, stderr) =>
		`${stderr}\n<sandbox_violations>\ndeny network-outbound example.com:443 (denied by sandbox policy)\n</sandbox_violations>`;
	const pi = await activateHandlers(manager);
	const command = "curl https://example.com && cp a /etc";
	await pi.handlers.tool_call({
		type: "tool_call",
		toolName: "bash",
		toolCallId: "cls-1",
		input: { command },
	});
	const res = await pi.handlers.tool_result({
		type: "tool_result",
		toolName: "bash",
		toolCallId: "cls-1",
		input: { command },
		content: [
			{ type: "text", text: "cp: cannot create regular file '/etc/a': Read-only file system" },
		],
	});
	const text = res.content[0].text;
	assert.match(text, /<sandbox_violations>/, "annotation survived");
	assert.match(text, /\[torus: sandbox\] write denied outside allowed roots — /);
	assert.equal(
		text.split("[torus: sandbox] write denied outside allowed roots").length - 1,
		1,
		"single class append even though a proxy signature is also present",
	);
	assert.ok(
		text.endsWith(
			"[torus: sandbox] write denied outside allowed roots — add the path's parent to TORUS_SANDBOX_WRITABLE or the sandbox policy's writable list",
		),
		"class line is the final append on the same text block",
	);
	await pi.handlers.session_shutdown(undefined, shutdownCtx());
});
