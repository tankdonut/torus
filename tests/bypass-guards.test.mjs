import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Registration-time checks read the live env, so TORUS_HOME is sandboxed and
// the permission mode starts unset; each test sets and restores it itself.
const home = mkdtempSync(path.join(tmpdir(), "torus-bypass-guards-"));
process.env.TORUS_HOME = home;
delete process.env.TORUS_PERMISSION_MODE;

const ccsnShim = (await import("../extensions/cc-safety-net/index.ts")).default;
const sandboxExtension = (await import("../extensions/sandbox/index.ts")).default;
const { parseSandboxEnv } = await import("../extensions/sandbox/index.ts");
const { askNetworkTrust } = await import("../extensions/sandbox/approval.ts");
const guardsExtension = (await import("../extensions/guards/index.ts")).default;
const automodeExtension = (await import("../extensions/automode/index.ts")).default;

after(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Stub engine: records every on/registerCommand call a guard would make. */
function recordingPi() {
	const calls = { on: [], registerCommand: [], handlers: {}, shortcuts: [] };
	const pi = {
		on: (name, handler) => {
			calls.on.push(name);
			calls.handlers[name] = handler;
		},
		registerCommand: (name) => calls.registerCommand.push(name),
		// automode's shortcut registration, unused by the guards' assertions.
		registerShortcut: (name) => calls.shortcuts.push(name),
	};
	return { pi, calls };
}

/** Shuts down a sandbox registered with a recordingPi so no runtime outlives the test. */
async function shutdownRecorded(calls) {
	// Let the activation promise settle first: the shutdown handler resets a
	// manager that may still be initializing.
	await new Promise((resolve) => setTimeout(resolve, 300));
	const handler = calls.handlers["session_shutdown"];
	if (handler) await handler(undefined, { ui: { notify: () => {} } });
	await new Promise((resolve) => setTimeout(resolve, 300));
}

function withMode(mode, run) {
	const prev = process.env.TORUS_PERMISSION_MODE;
	if (mode === undefined) delete process.env.TORUS_PERMISSION_MODE;
	else process.env.TORUS_PERMISSION_MODE = mode;
	try {
		return run();
	} finally {
		if (prev === undefined) delete process.env.TORUS_PERMISSION_MODE;
		else process.env.TORUS_PERMISSION_MODE = prev;
	}
}

function withProfile(profile, run) {
	const prev = process.env.TORUS_AUTOMODE_PROFILE;
	if (profile === undefined) delete process.env.TORUS_AUTOMODE_PROFILE;
	else process.env.TORUS_AUTOMODE_PROFILE = profile;
	try {
		return run();
	} finally {
		if (prev === undefined) delete process.env.TORUS_AUTOMODE_PROFILE;
		else process.env.TORUS_AUTOMODE_PROFILE = prev;
	}
}

function withModeAndProfile(mode, profile, run) {
	return withMode(mode, () => withProfile(profile, run));
}

test("bypass mode: cc-safety-net shim and sandbox register nothing", () => {
	withMode("bypass", () => {
		for (const register of [ccsnShim, sandboxExtension]) {
			const { pi, calls } = recordingPi();
			register(pi);
			assert.deepEqual(
				{ on: calls.on, registerCommand: calls.registerCommand },
				{ on: [], registerCommand: [] },
			);
		}
	});
});

test("bypass + ci profile: guards, cc-safety-net, sandbox, and automode all register", async () => {
	const { pi, calls } = recordingPi();
	try {
		withModeAndProfile("bypass", "ci", () => {
			ccsnShim(pi);
			sandboxExtension(pi);
			guardsExtension(pi);
			automodeExtension(pi);
			assert.ok(
				calls.on.includes("session_start"),
				"sandbox registers its activation handler under bypass + ci",
			);
			assert.ok(
				calls.on.includes("tool_call"),
				"a tool_call handler registers under bypass + ci (automode gate and/or sandbox enforcement)",
			);
			assert.ok(
				calls.registerCommand.includes("cc-safety-net"),
				"cc-safety-net registers under bypass + ci",
			);
			assert.ok(calls.on.length > 0, "guards stay registered under bypass + ci");
		});
	} finally {
		await shutdownRecorded(calls);
	}
});

test("bypass + ci profile: a bash tool_call stays gated end to end", () => {
	withModeAndProfile("bypass", "ci", () => {
		const { pi, calls } = recordingPi();
		automodeExtension(pi);
		assert.ok(
			calls.on.includes("tool_call"),
			"automode's tool_call gate registers under bypass + ci",
		);
	});
	// The ci profile forces the sandbox to full isolation regardless of the
	// bypass mode, resolved from the env the tool_call path would see.
	const env = parseSandboxEnv({
		TORUS_PERMISSION_MODE: "bypass",
		TORUS_AUTOMODE_PROFILE: "ci",
	});
	assert.equal(env.mode, "full", "the ci profile forces full sandbox mode under bypass");
});

test("bypass + unrecognized profile stays fail-closed: every guard still registers", () => {
	withModeAndProfile("bypass", "CII", () => {
		const { pi, calls } = recordingPi();
		ccsnShim(pi);
		guardsExtension(pi);
		automodeExtension(pi);
		assert.ok(calls.on.includes("tool_call"), "a typo'd profile does not silence the bash gate");
		assert.ok(
			calls.registerCommand.includes("cc-safety-net"),
			"a typo'd profile does not silence cc-safety-net",
		);
	});
});

test("bypass + unrecognized profile: the sandbox resolves off, not forced-full", () => {
	const env = parseSandboxEnv({
		TORUS_PERMISSION_MODE: "bypass",
		TORUS_AUTOMODE_PROFILE: "CII",
	});
	assert.equal(env.profile, "off", "a typo'd profile is not the ci profile");
	assert.equal(
		env.mode,
		"off",
		"no forced isolation on a typo; the resolution error is the loud path",
	);
	assert.ok(env.profileError, "the typo surfaces as a resolution error");
});

test("default mode still loads cc-safety-net through the shim", () => {
	withMode(undefined, () => {
		const { pi, calls } = recordingPi();
		ccsnShim(pi);
		assert.ok(
			calls.registerCommand.includes("cc-safety-net"),
			"the package's command registers when not bypassing",
		);
	});
});

test("default mode: the trust dialog folds into sandbox, no Symbol.for slot", async () => {
	withMode(undefined, () => {
		const { pi, calls } = recordingPi();
		sandboxExtension(pi);
		assert.ok(
			calls.on.includes("session_start"),
			"sandbox subscribes session_start to capture the trust ctx",
		);
	});
	const SLOT = Symbol.for("torus.approval.v1");
	assert.equal(globalThis[SLOT], undefined, "no slot indirection survives the fold");
	assert.deepEqual(
		await askNetworkTrust("folded.dev", 443),
		{ kind: "deny" },
		"trust path denies without an interactive ctx",
	);
});
