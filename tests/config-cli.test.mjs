import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { runConfigCli } from "../extensions/config/cli.ts";

// torus config status: the unified config.json under TORUS_HOME. The
// subcommand resolves the home from TORUS_HOME at call time, so each test
// points it at a fresh sandbox: a config.json carrying registered sections
// plus an unknown "ui" key, an empty home, and a config whose sections read
// from the defaults.
//
// runConfigCli writes straight to process.stdout/stderr, so each call is
// wrapped to capture both streams; assertions never depend on print order,
// only on the section lines.

const ORIGINAL_HOME = process.env.TORUS_HOME;

const CHAINS = { primary: ["zai/glm-5.3"], fast: ["zai/glm-5.3-flash"] };

function sandboxHome() {
	const home = mkdtempSync(path.join(tmpdir(), "torus-config-cli-test-"));
	process.env.TORUS_HOME = home;
	return home;
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

test("status: sections, unknown keys, and defaults each report their source", async () => {
	const home = sandboxHome();
	try {
		seedConfig(home, { chains: CHAINS, ui: { theme: "dark" } });
		const { code, stdout } = await captureRun(["status"]);
		assert.equal(code, 0);
		assert.match(stdout, /^chains: config\.json$/m);
		assert.match(stdout, /^automode: default$/m);
		assert.match(stdout, /^serve: default$/m);
		assert.match(stdout, /^keywords: default$/m);
		assert.match(stdout, /^permissionMode: default$/m);
		assert.match(stdout, /^ui: config\.json$/m);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("status: a pre-unification standalone section file is not a source", async () => {
	const home = sandboxHome();
	try {
		const preUnified = ["automode", ".json"].join("");
		writeFileSync(path.join(home, preUnified), `${JSON.stringify({ deny: ["sudo *"] })}\n`, "utf8");
		const { code, stdout } = await captureRun(["status"]);
		assert.equal(code, 0);
		assert.match(stdout, /^automode: default$/m);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("unknown subcommand and stray flags: usage on stderr, exit 2", async () => {
	const home = sandboxHome();
	try {
		for (const args of [["bogus"], [], ["migrate"], ["status", "extra"], ["status", "--yes"]]) {
			const { code, stderr } = await captureRun(args);
			assert.equal(code, 2, `args ${JSON.stringify(args)} exit 2`);
			assert.match(stderr, /usage: torus config status/);
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("empty home: status reports all defaults", async () => {
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
				`project: none (${path.join(process.cwd(), ".torus", "config.json")})`,
				"",
			].join("\n"),
		);
		assert.ok(!existsSync(path.join(home, "config.json")), "status writes nothing");
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

test("status: project file line names readable sections and refused keys", async () => {
	sandboxHome();
	const cwd = mkdtempSync(path.join(tmpdir(), "torus-proj-cli-"));
	const prev = process.cwd();
	try {
		mkdirSync(path.join(cwd, ".torus"), { recursive: true });
		writeFileSync(
			path.join(cwd, ".torus", "config.json"),
			JSON.stringify({ ui: { banner: false }, chains: {} }),
		);
		process.chdir(cwd);
		const status = await captureRun(["status"]);
		assert.equal(status.code, 0);
		assert.match(status.stdout, /project: .*\.torus\/config\.json \(sections: ui\)/);
		assert.match(status.stdout, /project refused: chains/);
	} finally {
		process.chdir(prev);
		rmSync(cwd, { recursive: true, force: true });
	}
});
