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
const { askNetworkTrust } = await import("../extensions/sandbox/approval.ts");

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
