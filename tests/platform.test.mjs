import assert from "node:assert/strict";
import { test } from "node:test";

const { currentPlatform, gateExtension, platformDecisions, resetPlatformRegistryForTests } =
	await import("../extensions/platform.ts");

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

test("currentPlatform: no override returns process.platform", () => {
	resetPlatformRegistryForTests();
	withPlatform(undefined, () => {
		assert.equal(currentPlatform(), process.platform);
	});
});

test("currentPlatform: valid override is returned", () => {
	resetPlatformRegistryForTests();
	withPlatform("win32", () => {
		assert.equal(currentPlatform(), "win32");
	});
});

test("currentPlatform: invalid override warns once and falls back to process.platform", () => {
	resetPlatformRegistryForTests();
	const output = captureStderr(() => {
		withPlatform("templeos", () => {
			assert.equal(currentPlatform(), process.platform);
			assert.equal(currentPlatform(), process.platform);
		});
	});
	assert.match(output, /TORUS_PLATFORM="templeos"/);
	assert.match(output, new RegExp(`using ${process.platform}`));
	assert.equal(output.split("\n").filter((line) => line.includes("templeos")).length, 1);
});

test("currentPlatform: empty override counts as unset", () => {
	resetPlatformRegistryForTests();
	const output = captureStderr(() => {
		withPlatform("", () => {
			assert.equal(currentPlatform(), process.platform);
		});
	});
	assert.ok(!output.includes("TORUS_PLATFORM"), `no warning for empty override: ${output}`);
});

test("gateExtension: supported platform loads and records the decision", () => {
	resetPlatformRegistryForTests();
	withPlatform("linux", () => {
		const support = {
			platforms: ["linux", "darwin", "win32"],
			deps: [{ name: "git", required: true }],
		};
		assert.equal(gateExtension("memory", support), true);
	});
	const [decision] = platformDecisions();
	assert.equal(decision.name, "memory");
	assert.equal(decision.loaded, true);
	assert.equal(decision.platform, "linux");
	assert.equal(decision.support.deps[0].name, "git");
});

test("gateExtension: unsupported platform skips, notices once per name, records deps", () => {
	resetPlatformRegistryForTests();
	const support = {
		platforms: ["linux"],
		deps: [{ name: "script", required: true, note: "util-linux only" }],
		note: "script -qec is util-linux-only",
	};
	let firstNotice = "";
	let secondNotice = "";
	withPlatform("darwin", () => {
		firstNotice = captureStderr(() => assert.equal(gateExtension("interactive", support), false));
		secondNotice = captureStderr(() => assert.equal(gateExtension("interactive", support), false));
	});
	assert.match(
		firstNotice,
		/\[torus: platform\] interactive skipped on darwin \(script -qec is util-linux-only\)/,
	);
	assert.equal(secondNotice, "");
	assert.equal(platformDecisions().length, 2);
	assert.ok(platformDecisions().every((decision) => decision.loaded === false));
	assert.ok(platformDecisions().every((decision) => decision.platform === "darwin"));
});

test("platformDecisions reflects gate-call order and reset clears the slot", () => {
	resetPlatformRegistryForTests();
	withPlatform("linux", () => {
		gateExtension("first", { platforms: ["linux"] });
		gateExtension("second", { platforms: ["win32"] });
	});
	assert.deepEqual(
		platformDecisions().map((decision) => `${decision.name}:${decision.loaded}`),
		["first:true", "second:false"],
	);
	resetPlatformRegistryForTests();
	assert.equal(platformDecisions().length, 0);
});

test("gateExtension never throws for malformed-free but empty descriptor shapes", () => {
	resetPlatformRegistryForTests();
	withPlatform("linux", () => {
		assert.equal(gateExtension("bare", { platforms: [] }), false);
	});
	const [decision] = platformDecisions();
	assert.equal(decision.name, "bare");
	assert.equal(decision.loaded, false);
});
