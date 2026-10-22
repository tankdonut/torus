import assert from "node:assert/strict";
import { test } from "node:test";

const { gateExtension, resetPlatformRegistryForTests } = await import("../extensions/platform.ts");
const { platformCheck } = await import("../extensions/doctor/index.ts");

function captureStderr(run) {
	const chunks = [];
	const original = process.stderr.write;
	process.stderr.write = (chunk) => {
		chunks.push(String(chunk));
		return true;
	};
	try {
		run();
	} finally {
		process.stderr.write = original;
	}
	return chunks.join("");
}

function withPlatform(value, run) {
	const had = Object.hasOwn(process.env, "TORUS_PLATFORM");
	const saved = process.env["TORUS_PLATFORM"];
	if (value === undefined) delete process.env["TORUS_PLATFORM"];
	else process.env["TORUS_PLATFORM"] = value;
	try {
		return run();
	} finally {
		if (had) process.env["TORUS_PLATFORM"] = saved;
		else delete process.env["TORUS_PLATFORM"];
	}
}

test("all decisions loaded: ok with zero skips and the decision platform", () => {
	resetPlatformRegistryForTests();
	withPlatform("linux", () => {
		gateExtension("memory", {
			platforms: ["linux", "darwin", "win32"],
			deps: [{ name: "git", required: true }],
		});
		gateExtension("work", { platforms: ["linux", "darwin", "win32"] });
	});
	const result = platformCheck();
	assert.equal(result.name, "platform");
	assert.equal(result.status, "ok");
	assert.match(result.detail, /0 skipped/);
	assert.match(result.detail, /\(linux\)/);
});

test("no gate decisions: ok with a no-decisions detail", () => {
	resetPlatformRegistryForTests();
	const result = platformCheck();
	assert.equal(result.name, "platform");
	assert.equal(result.status, "ok");
	assert.match(result.detail, /no gate decisions recorded/);
});

test("skip plus missing required dep: warn naming both", () => {
	resetPlatformRegistryForTests();
	withPlatform("win32", () => {
		captureStderr(() =>
			gateExtension("interactive", { platforms: ["linux"], note: "needs a pty" }),
		);
		gateExtension("memory", {
			platforms: ["linux", "darwin", "win32"],
			deps: [{ name: "definitely-not-a-real-binary-xyz", required: true }],
		});
	});
	const result = platformCheck();
	assert.equal(result.name, "platform");
	assert.equal(result.status, "warn");
	assert.ok(
		result.detail.includes("1 skipped on win32: interactive"),
		`names the skip: ${result.detail}`,
	);
	assert.ok(
		result.detail.includes("definitely-not-a-real-binary-xyz (memory)"),
		`names the missing dep with its extension: ${result.detail}`,
	);
});
