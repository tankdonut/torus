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
const approvalExtension = (await import("../extensions/approval/index.ts")).default;
const sandboxExtension = (await import("../extensions/sandbox/index.ts")).default;

after(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Stub engine: records every on/registerCommand call a guard would make. */
function recordingPi() {
	const calls = { on: [], registerCommand: [] };
	const pi = {
		on: (name) => calls.on.push(name),
		registerCommand: (name) => calls.registerCommand.push(name),
	};
	return { pi, calls };
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

test("bypass mode: cc-safety-net shim, approval, and sandbox all register nothing", () => {
	withMode("bypass", () => {
		for (const register of [ccsnShim, approvalExtension, sandboxExtension]) {
			const { pi, calls } = recordingPi();
			register(pi);
			assert.deepEqual(
				{ on: calls.on, registerCommand: calls.registerCommand },
				{ on: [], registerCommand: [] },
			);
		}
	});
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

test("default mode still registers the approval extension", () => {
	withMode(undefined, () => {
		const { pi, calls } = recordingPi();
		approvalExtension(pi);
		assert.ok(calls.on.includes("session_start"), "approval subscribes when not bypassing");
	});
});
