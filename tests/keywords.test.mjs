import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// TORUS_HOME must land before the prompts import — registry and fsutil derive
// state dirs at module load. The fake-home probe below additionally overrides
// HOME, which is exactly what the old hardcoded homedir() read bypassed.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-keywords-test-"));
process.env.TORUS_HOME = HOME;

const prompts = await import("../extensions/prompts/index.ts");

const configPath = path.join(HOME, "config.json");
const keywordsPath = path.join(HOME, "keywords.json");

const setConfig = (data) => writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8");
const setRawConfig = (raw) => writeFileSync(configPath, raw, "utf8");
const clearConfig = () => rmSync(configPath, { force: true });
const setKeywords = (rows) => writeFileSync(keywordsPath, JSON.stringify(rows), "utf8");
const clearKeywords = () => rmSync(keywordsPath, { force: true });

function captureStderr(fn) {
	// Tee, not mute: forward every write while recording, so nothing that
	// shares the stream is swallowed behind the capture window.
	const chunks = [];
	const orig = process.stderr.write;
	process.stderr.write = (chunk) => {
		chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
		return orig.call(process.stderr, chunk);
	};
	try {
		return { result: fn(), output: chunks.join("") };
	} finally {
		process.stderr.write = orig;
	}
}

after(() => {
	clearConfig();
	clearKeywords();
	rmSync(HOME, { recursive: true, force: true });
});

test("no config.json and no keywords.json yield the default keywords", () => {
	prompts.resetKeywordsWarningForTesting();
	clearConfig();
	clearKeywords();
	const got = prompts.loadKeywords();
	assert.deepEqual(got, prompts.DEFAULT_KEYWORDS);
	assert.equal(prompts.detectKeyword("let us deepwork on this", got), "deepwork");
});

test("legacy keywords.json under TORUS_HOME merges over the defaults", () => {
	prompts.resetKeywordsWarningForTesting();
	clearConfig();
	setKeywords({ focus: "Stay on one task." });
	const got = prompts.loadKeywords();
	assert.equal(got.focus, "Stay on one task.", "sandbox file row is read");
	assert.equal(got.deepwork, prompts.DEFAULT_KEYWORDS.deepwork, "defaults stay merged in");
	assert.equal(prompts.detectKeyword("focus please", got), "focus");
	clearKeywords();
});

test("the home dir is never consulted: a HOME keywords.json cannot leak in", () => {
	prompts.resetKeywordsWarningForTesting();
	clearConfig();
	// The pre-fix read was homedir()/.torus/keywords.json, and os.homedir()
	// honors HOME on POSIX — an impostor file there is exactly what the old
	// code loaded while TORUS_HOME pointed elsewhere.
	const fakeHome = mkdtempSync(path.join(tmpdir(), "torus-keywords-fakehome-"));
	mkdirSync(path.join(fakeHome, ".torus"), { recursive: true });
	writeFileSync(
		path.join(fakeHome, ".torus", "keywords.json"),
		JSON.stringify({ impostor: "leaked from the home dir" }),
		"utf8",
	);
	const prevHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		setKeywords({ sandbox: "from TORUS_HOME" });
		const got = prompts.loadKeywords();
		assert.equal(got.sandbox, "from TORUS_HOME", "the TORUS_HOME file wins");
		assert.equal("impostor" in got, false, "the HOME file is never consulted");
		clearKeywords();
		const bare = prompts.loadKeywords();
		assert.equal("impostor" in bare, false, "no HOME leak even without a sandbox file");
		assert.deepEqual(bare, prompts.DEFAULT_KEYWORDS);
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(fakeHome, { recursive: true, force: true });
	}
});

test("config.json keywords section wins over keywords.json, warning once per process", () => {
	prompts.resetKeywordsWarningForTesting();
	setKeywords({ focus: "file text", fileOnly: "legacy-only row" });
	setConfig({ keywords: { focus: "config text" } });
	const first = captureStderr(() => prompts.loadKeywords());
	assert.equal(first.result.focus, "config text", "the config row wins");
	assert.equal("fileOnly" in first.result, false, "the whole legacy section is shadowed");
	assert.equal(first.result.deepwork, prompts.DEFAULT_KEYWORDS.deepwork, "defaults stay merged in");
	assert.match(
		first.output,
		/"keywords" is set in config\.json and shadowed from keywords\.json; run torus config migrate/,
	);
	const second = captureStderr(() => prompts.loadKeywords());
	assert.equal(second.output, "", "the warning prints once per process");
	assert.equal(second.result.focus, "config text");
});

test("malformed config.json falls back to keywords.json with one warning", () => {
	prompts.resetKeywordsWarningForTesting();
	setKeywords({ focus: "file text" });
	setRawConfig("{not json");
	const got = captureStderr(() => prompts.loadKeywords());
	assert.equal(got.result.focus, "file text", "legacy file still supplies the rows");
	assert.match(got.output, /not valid JSON/);
});

test("a non-object keywords section in config.json warns and falls back", () => {
	prompts.resetKeywordsWarningForTesting();
	setKeywords({ focus: "file text" });
	setConfig({ keywords: ["deepwork"] });
	const got = captureStderr(() => prompts.loadKeywords());
	assert.equal(got.result.focus, "file text", "legacy file wins");
	assert.match(got.output, /"keywords" in config\.json is not an object; using keywords\.json/);
});

test("config.json keywords without a legacy file wins silently", () => {
	prompts.resetKeywordsWarningForTesting();
	clearKeywords();
	setConfig({ keywords: { solo: "config-only row" } });
	const got = captureStderr(() => prompts.loadKeywords());
	assert.equal(got.result.solo, "config-only row");
	assert.equal(prompts.detectKeyword("go solo", got.result), "solo");
	assert.equal(got.output, "", "no legacy value means no shadow warning");
});
