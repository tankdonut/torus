import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
	const state = await activateSandbox(
		{ mode: "full", requested: "full", writableExtras: ["/extra"] },
		deps,
		(m) => notices.push(m),
	);
	assert.equal(state.active, true);
	assert.equal(deps.calls.probe, 1);
	assert.equal(manager.calls.initialize, 1);
	assert.ok(manager.captured.config.filesystem.allowWrite.includes(process.cwd()));
	assert.ok(manager.captured.config.filesystem.allowWrite.includes("/extra"));
	assert.deepEqual(notices, []);
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
	try {
		delete process.env.TORUS_SANDBOX;
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
	const calls = { initialize: 0, wrap: 0, annotate: 0, cleanup: 0, reset: 0 };
	return {
		calls,
		capturedAsk: null,
		updatedConfigs: [],
		async initialize(_config, ask) {
			calls.initialize += 1;
			this.capturedAsk = ask ?? null;
		},
		updateConfig(config) {
			this.updatedConfigs.push(config);
		},
		async wrapWithSandbox(command, _binShell, _customConfig, _abortSignal, _options) {
			calls.wrap += 1;
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
	assert.equal(input.command, "bwrap --ro-bind / / -- npm test");
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
		spawnSync("git", ["-C", repo, "init", "-q"]);
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
	assert.equal(input.command, "bwrap -- echo early");
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

test("CURATED_NET_ALLOWLIST: 30 dev-workflow hosts incl. release-assets fix; no generic CDNs", () => {
	assert.equal(CURATED_NET_ALLOWLIST.length, 30);
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

test("ask callback wiring: allow-once grants without updateConfig; custom host grants + appends", async () => {
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
		assert.equal(await ask({ host: "once.dev", port: 443 }), true);
		assert.equal(manager.updatedConfigs.length, 0, "allow-once does not touch config");
		assert.equal(await ask({ host: "anything.internal.corp", port: 443 }), true);
		assert.equal(manager.updatedConfigs.length, 1);
		assert.ok(manager.updatedConfigs[0].network.allowedDomains.includes("*.internal.corp"));
	} finally {
		if (previousSlot === undefined) delete globalThis[SLOT];
		else globalThis[SLOT] = previousSlot;
	}
	await pi.handlers.session_shutdown(undefined, {
		ui: { setStatus() {}, theme: { fg: (_c, t) => t } },
	});
});
