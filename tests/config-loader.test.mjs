import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-config-"));
process.env.TORUS_HOME = home;

const {
	CONFIG_FILE_NAME,
	configFilePath,
	loadConfigFile,
	readSection,
	configOverEnv,
	parseEnvBoolean,
	effectiveConfigSnapshot,
} = await import("../extensions/config/loader.ts");
const { torusHome } = await import("../extensions/fsutil.ts");

const configPath = path.join(home, CONFIG_FILE_NAME);

const setConfig = (data) => writeFileSync(configPath, JSON.stringify(data));
const setRawConfig = (raw) => writeFileSync(configPath, raw);
const clearConfig = () => {
	try {
		rmSync(configPath);
	} catch {}
};

test("loadConfigFile: missing file means empty config, no warning", () => {
	clearConfig();
	assert.deepEqual(loadConfigFile(), { config: {} });
	assert.deepEqual(loadConfigFile(path.join(home, "elsewhere.json")), { config: {} });
});

test("loadConfigFile: malformed JSON degrades to empty config with one warning naming the path", () => {
	setRawConfig("{not json");
	const got = loadConfigFile();
	assert.deepEqual(got.config, {});
	assert.equal(got.warning?.includes("not valid JSON"), true);
	assert.equal(got.warning?.includes(configPath), true);
});

test("loadConfigFile: non-object root degrades to empty config with one warning", () => {
	for (const raw of ["[1, 2]", '"chains"', "3", "null"]) {
		setRawConfig(raw);
		const got = loadConfigFile();
		assert.deepEqual(got.config, {}, `root ${raw}`);
		assert.equal(got.warning?.includes(configPath), true, `root ${raw}`);
	}
});

test("loadConfigFile: valid object file loads as-is", () => {
	setConfig({ chains: { default: "gpt" }, extra: 1 });
	assert.deepEqual(loadConfigFile(), { config: { chains: { default: "gpt" }, extra: 1 } });
});

test("readSection: missing config.json falls back to the legacy loader", () => {
	clearConfig();
	assert.deepEqual(
		readSection("chains", () => ({ default: "claude" })),
		{
			value: { default: "claude" },
			source: "legacy",
		},
	);
});

test("readSection: missing config.json with no legacy loader yields the default source", () => {
	clearConfig();
	assert.deepEqual(readSection("chains"), { value: undefined, source: "default" });
	assert.deepEqual(
		readSection("chains", () => undefined),
		{ value: undefined, source: "default" },
	);
});

test("readSection: malformed config.json still loads legacy with a warning, no throw", () => {
	setRawConfig("{not json");
	const got = readSection("automode", () => ({ mode: "auto" }));
	assert.deepEqual(got.value, { mode: "auto" });
	assert.equal(got.source, "legacy");
	assert.ok(got.warning?.includes("not valid JSON"));
});

test("readSection: config section wins over legacy with one shadow warning naming both", () => {
	setConfig({ chains: { default: "gpt" } });
	const got = readSection("chains", {
		load: () => ({ default: "claude" }),
		sourceHint: "chains.json",
	});
	assert.deepEqual(got.value, { default: "gpt" });
	assert.equal(got.source, "config");
	assert.equal(
		got.warning,
		'config: "chains" is set in config.json and shadowed from chains.json; run torus config migrate',
	);
});

test("readSection: config shadow warning falls back to the plain 'legacy file' hint", () => {
	setConfig({ chains: { default: "gpt" } });
	const got = readSection("chains", () => ({ default: "claude" }));
	assert.equal(got.source, "config");
	assert.equal(
		got.warning,
		'config: "chains" is set in config.json and shadowed from legacy file; run torus config migrate',
	);
});

test("readSection: config section with no legacy value wins silently", () => {
	setConfig({ chains: { default: "gpt" } });
	assert.deepEqual(
		readSection("chains", () => undefined),
		{
			value: { default: "gpt" },
			source: "config",
		},
	);
});

test("readSection: non-object config section warns, names the section, and falls to legacy", () => {
	for (const section of [3, "fast", [""], null]) {
		setConfig({ chains: section });
		const got = readSection("chains", () => ({ default: "claude" }));
		assert.deepEqual(got.value, { default: "claude" }, `section ${JSON.stringify(section)}`);
		assert.equal(got.source, "legacy", `section ${JSON.stringify(section)}`);
		assert.ok(got.warning?.includes('"chains"'), `section ${JSON.stringify(section)}`);
		assert.ok(got.warning?.includes("not an object"), `section ${JSON.stringify(section)}`);
	}
	setConfig({ chains: 3 });
	const got = readSection("chains");
	assert.equal(got.value, undefined);
	assert.equal(got.source, "default");
	assert.ok(got.warning?.includes('"chains"'));
});

test("readSection: explicit parsed config is used without touching disk", () => {
	clearConfig();
	const got = readSection("chains", () => ({ default: "claude" }), { chains: { default: "gpt" } });
	assert.deepEqual(got.value, { default: "gpt" });
	assert.equal(got.source, "config");
	assert.ok(got.warning?.includes('"chains"'));
});

test("configOverEnv: env beats config beats default; defined values always win over undefined", () => {
	assert.deepEqual(configOverEnv("env", "cfg", "def"), { value: "env", source: "env" });
	assert.deepEqual(configOverEnv(undefined, "cfg", "def"), { value: "cfg", source: "config" });
	assert.deepEqual(configOverEnv(undefined, undefined, "def"), { value: "def", source: "default" });
	assert.deepEqual(configOverEnv(false, true, true), { value: false, source: "env" });
	assert.deepEqual(configOverEnv(0, 7, 7), { value: 0, source: "env" });
});

test("parseEnvBoolean: only 0/false/1/true parse; anything else falls through", () => {
	assert.equal(parseEnvBoolean("0"), false);
	assert.equal(parseEnvBoolean("false"), false);
	assert.equal(parseEnvBoolean("1"), true);
	assert.equal(parseEnvBoolean("true"), true);
	assert.equal(parseEnvBoolean("yes"), undefined);
	assert.equal(parseEnvBoolean("TRUE"), undefined);
	assert.equal(parseEnvBoolean(""), undefined);
	assert.equal(parseEnvBoolean(undefined), undefined);
});

test("configFilePath: resolves inside the sandboxed TORUS_HOME", () => {
	assert.equal(configFilePath(), path.join(home, CONFIG_FILE_NAME));
});

test('configFilePath: identical to fsutil torusHome() under TORUS_HOME="" and a normal home', () => {
	for (const value of ["", home]) {
		process.env.TORUS_HOME = value;
		assert.equal(
			configFilePath(),
			path.join(torusHome(), CONFIG_FILE_NAME),
			`TORUS_HOME=${JSON.stringify(value)}`,
		);
	}
	process.env.TORUS_HOME = home;
	assert.equal(configFilePath(), path.join(home, CONFIG_FILE_NAME));
});

test("effectiveConfigSnapshot: normalizes entries and preserves order", () => {
	const got = effectiveConfigSnapshot([
		{ name: "chains", source: "config", summary: "default=gpt" },
		{ name: "   ", source: "legacy", summary: "dropped" },
		{ name: "", source: "env", summary: "dropped" },
		{ name: "automode", source: "junk", summary: "mode=auto" },
		{ name: "logs", source: "env", summary: 3 },
		null,
		undefined,
	]);
	assert.deepEqual(got, [
		{ name: "chains", source: "config", summary: "default=gpt" },
		{ name: "automode", source: "absent", summary: "mode=auto" },
		{ name: "logs", source: "env", summary: "" },
	]);
});

test("effectiveConfigSnapshot: empty input yields empty output", () => {
	assert.deepEqual(effectiveConfigSnapshot([]), []);
});
