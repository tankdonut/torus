import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runConfigCli } from "../extensions/config/cli.ts";

// torus config status|migrate: the unified config.json under TORUS_HOME and
// the legacy standalone files beside it. Both subcommands resolve the home
// from TORUS_HOME at call time, so each test points it at a fresh sandbox:
// seeded legacy chains.json + automode.json plus a config.json carrying an
// unknown "ui" key (kept verbatim by every migrate), an empty home, and a
// config.json section that must win over a stale legacy twin.
//
// runConfigCli writes straight to process.stdout/stderr, so each call is
// wrapped to capture both streams; migrate's own assertions never depend on
// print order, only on the plan buckets and the bytes on disk.

const ORIGINAL_HOME = process.env.TORUS_HOME;

const CHAINS = { primary: ["zai/glm-5.3"], fast: ["zai/glm-5.3-flash"] };
const AUTOMODE = { enabled: true, rules: [] };

function sandboxHome() {
	const home = mkdtempSync(path.join(tmpdir(), "torus-config-cli-test-"));
	process.env.TORUS_HOME = home;
	return home;
}

function seedLegacy(home) {
	writeFileSync(path.join(home, "chains.json"), `${JSON.stringify(CHAINS, null, 2)}\n`, "utf8");
	writeFileSync(path.join(home, "automode.json"), `${JSON.stringify(AUTOMODE)}\n`, "utf8");
}

function seedConfig(home, config) {
	writeFileSync(path.join(home, "config.json"), JSON.stringify(config), "utf8");
}

async function captureRun(args) {
	const stdout = [];
	const stderr = [];
	const realOut = process.stdout.write;
	const realErr = process.stderr.write;
	process.stdout.write = (chunk) => {
		stdout.push(String(chunk));
		return true;
	};
	process.stderr.write = (chunk) => {
		stderr.push(String(chunk));
		return true;
	};
	try {
		const code = await runConfigCli(args);
		return { code, stdout: stdout.join(""), stderr: stderr.join("") };
	} finally {
		process.stdout.write = realOut;
		process.stderr.write = realErr;
	}
}

test("status: legacy files, config.json sections, and unknown keys each report their source", async () => {
	const home = sandboxHome();
	try {
		seedLegacy(home);
		seedConfig(home, { ui: { theme: "dark" } });
		const { code, stdout } = await captureRun(["status"]);
		assert.equal(code, 0);
		assert.match(stdout, new RegExp(`^chains: ${home}/chains\\.json \\(legacy\\)$`, "m"));
		assert.match(stdout, new RegExp(`^automode: ${home}/automode\\.json \\(legacy\\)$`, "m"));
		assert.match(stdout, /^serve: default$/m);
		assert.match(stdout, /^keywords: default$/m);
		assert.match(stdout, /^permissionMode: default$/m);
		assert.match(stdout, /^ui: config\.json$/m);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("status: a config.json section wins over a legacy twin", async () => {
	const home = sandboxHome();
	try {
		seedLegacy(home);
		seedConfig(home, { chains: { primary: ["other/model"] } });
		const { code, stdout } = await captureRun(["status"]);
		assert.equal(code, 0);
		assert.match(stdout, /^chains: config\.json$/m);
		assert.match(stdout, new RegExp(`^automode: ${home}/automode\\.json \\(legacy\\)$`, "m"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("migrate without --yes prints the plan and leaves config.json byte-identical", async () => {
	const home = sandboxHome();
	try {
		seedLegacy(home);
		seedConfig(home, { ui: { theme: "dark" } });
		const before = readFileSync(path.join(home, "config.json"), "utf8");
		const { code, stdout } = await captureRun(["migrate"]);
		assert.equal(code, 0);
		assert.match(stdout, /^will write sections: chains, automode$/m);
		assert.match(stdout, /^kept \(already in config\.json\): ui$/m);
		assert.match(stdout, /^no legacy file: serve, keywords, permissionMode$/m);
		assert.match(stdout, /dry run: nothing written/);
		assert.equal(readFileSync(path.join(home, "config.json"), "utf8"), before);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("migrate --yes folds legacy sections, preserves unknown keys, never touches legacy files", async () => {
	const home = sandboxHome();
	try {
		seedLegacy(home);
		seedConfig(home, { ui: { theme: "dark" } });
		const chainsBefore = readFileSync(path.join(home, "chains.json"), "utf8");
		const automodeBefore = readFileSync(path.join(home, "automode.json"), "utf8");
		const { code, stdout } = await captureRun(["migrate", "--yes"]);
		assert.equal(code, 0);
		assert.match(
			stdout,
			new RegExp(`migrated 2 sections into ${home}/config\\.json; legacy files left in place`),
		);
		assert.match(stdout, new RegExp(`${home}/chains\\.json, ${home}/automode\\.json`));

		const raw = readFileSync(path.join(home, "config.json"), "utf8");
		assert.ok(raw.endsWith("\n"), "config.json gets a trailing newline");
		assert.ok(!raw.endsWith("\n\n"), "exactly one trailing newline");
		const merged = JSON.parse(raw);
		assert.deepEqual(merged.chains, CHAINS);
		assert.deepEqual(merged.automode, AUTOMODE);
		assert.deepEqual(merged.ui, { theme: "dark" });

		assert.equal(readFileSync(path.join(home, "chains.json"), "utf8"), chainsBefore);
		assert.equal(readFileSync(path.join(home, "automode.json"), "utf8"), automodeBefore);

		// Second run: everything already folded — "kept" semantics, no
		// duplication, no rewrite drift.
		const again = await captureRun(["migrate", "--yes"]);
		assert.equal(again.code, 0);
		assert.match(again.stdout, /^kept \(already in config\.json\): ui, chains, automode$/m);
		assert.match(again.stdout, /^nothing to migrate$/m);
		assert.equal(readFileSync(path.join(home, "config.json"), "utf8"), raw);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("unknown subcommand and stray flags: usage on stderr, exit 2", async () => {
	const home = sandboxHome();
	try {
		for (const args of [["bogus"], [], ["migrate", "--force"], ["status", "extra"]]) {
			const { code, stderr } = await captureRun(args);
			assert.equal(code, 2, `args ${JSON.stringify(args)} exit 2`);
			assert.match(stderr, /usage: torus config status\|migrate \[--yes\]/);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("empty home: status reports all defaults and migrate --yes creates no config.json", async () => {
	const home = sandboxHome();
	try {
		const status = await captureRun(["status"]);
		assert.equal(status.code, 0);
		assert.equal(
			status.stdout,
			[
				"chains: default",
				"automode: default",
				"serve: default",
				"keywords: default",
				"permissionMode: default",
				"",
			].join("\n"),
		);

		const migrate = await captureRun(["migrate", "--yes"]);
		assert.equal(migrate.code, 0);
		assert.match(migrate.stdout, /^nothing to migrate$/m);
		assert.ok(
			!existsSync(path.join(home, "config.json")),
			"no config.json created when nothing folds",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

after(() => {
	if (ORIGINAL_HOME === undefined) {
		delete process.env.TORUS_HOME;
	} else {
		process.env.TORUS_HOME = ORIGINAL_HOME;
	}
});
