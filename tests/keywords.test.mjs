import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// TORUS_HOME must land before the prompts import — registry and fsutil derive
// state dirs at module load.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-keywords-test-"));
process.env.TORUS_HOME = HOME;

const prompts = await import("../extensions/prompts/index.ts");

const configPath = path.join(HOME, "config.json");

const setConfig = (data) => writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8");
const setRawConfig = (raw) => writeFileSync(configPath, raw, "utf8");
const clearConfig = () => rmSync(configPath, { force: true });

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
	rmSync(HOME, { recursive: true, force: true });
});

test("no config.json yields the default keywords", () => {
	prompts.resetKeywordsWarningForTesting();
	clearConfig();
	const got = prompts.loadKeywords();
	assert.deepEqual(got, prompts.DEFAULT_KEYWORDS);
	assert.equal(prompts.detectKeyword("let us deepwork on this", got), "deepwork");
});

test("config.json keywords section merges over the defaults", () => {
	prompts.resetKeywordsWarningForTesting();
	clearConfig();
	setConfig({ keywords: { focus: "Stay on one task." } });
	const got = captureStderr(() => prompts.loadKeywords());
	assert.equal(got.result.focus, "Stay on one task.", "the config row is read");
	assert.equal(got.result.deepwork, prompts.DEFAULT_KEYWORDS.deepwork, "defaults stay merged in");
	assert.equal(got.output, "", "a clean load warns about nothing");
	assert.equal(prompts.detectKeyword("focus please", got.result), "focus");
});

test("a malformed config warns once per process and degrades to the defaults", () => {
	prompts.resetKeywordsWarningForTesting();
	setRawConfig("{not json");
	const first = captureStderr(() => prompts.loadKeywords());
	assert.deepEqual(first.result, prompts.DEFAULT_KEYWORDS);
	assert.match(first.output, /not valid JSON/);
	const second = captureStderr(() => prompts.loadKeywords());
	assert.equal(second.output, "", "the warning prints once per process");
	assert.deepEqual(second.result, prompts.DEFAULT_KEYWORDS);
});

test("a non-object keywords section warns once and falls back to the defaults", () => {
	prompts.resetKeywordsWarningForTesting();
	setConfig({ keywords: ["deepwork"] });
	const got = captureStderr(() => prompts.loadKeywords());
	assert.deepEqual(got.result, prompts.DEFAULT_KEYWORDS);
	assert.match(got.output, /"keywords" in config\.json is not an object; using the default/);
});

test("a pre-unification standalone keywords file is not a source", () => {
	prompts.resetKeywordsWarningForTesting();
	clearConfig();
	// The pre-unification keywords file is gone as a config source: planted
	// under TORUS_HOME or the real HOME, it must not reach the keyword rows.
	const preUnified = ["keywords", ".json"].join("");
	writeFileSync(path.join(HOME, preUnified), JSON.stringify({ focus: "file text" }), "utf8");
	const fakeHome = mkdtempSync(path.join(tmpdir(), "torus-keywords-fakehome-"));
	mkdirSync(path.join(fakeHome, ".torus"), { recursive: true });
	writeFileSync(
		path.join(fakeHome, ".torus", preUnified),
		JSON.stringify({ impostor: "leaked from the home dir" }),
		"utf8",
	);
	const prevHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		const got = captureStderr(() => prompts.loadKeywords());
		assert.deepEqual(got.result, prompts.DEFAULT_KEYWORDS);
		assert.equal("focus" in got.result, false, "the TORUS_HOME file is never consulted");
		assert.equal("impostor" in got.result, false, "the HOME file is never consulted");
		assert.equal(got.output, "", "inert files warn about nothing");
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(fakeHome, { recursive: true, force: true });
	}
});
