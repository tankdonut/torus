import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-config-"));
process.env.TORUS_HOME = home;

const {
	CONFIG_FILE_NAME,
	configFilePath,
	loadConfigFile,
	loadProjectConfig,
	projectConfigPath,
	readSection,
	configOverEnv,
	parseEnvBoolean,
	effectiveConfigSnapshot,
	writeSection,
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

test("writeSection: creates the config file and home dir, pretty 2-space JSON with a trailing newline", () => {
	const nested = path.join(home, "nested", "deeper");
	process.env.TORUS_HOME = nested;
	try {
		const got = writeSection("automode", { ask: ["git push *"] });
		assert.deepEqual(got, { ok: true, path: path.join(nested, CONFIG_FILE_NAME) });
		const file = path.join(nested, CONFIG_FILE_NAME);
		assert.equal(
			readFileSync(file, "utf8"),
			`${JSON.stringify({ automode: { ask: ["git push *"] } }, null, 2)}\n`,
		);
		assert.deepEqual(readdirSync(nested), [CONFIG_FILE_NAME], "no temp file left behind");
	} finally {
		process.env.TORUS_HOME = home;
	}
});

test("writeSection: preserves other sections and replaces the target section wholesale", () => {
	clearConfig();
	setConfig({ chains: { default: "gpt" }, automode: { ask: ["a"], deny: ["d"] } });
	const got = writeSection("automode", { ask: ["b"] });
	assert.equal(got.ok, true);
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		chains: { default: "gpt" },
		automode: { ask: ["b"] },
	});
	assert.ok(readFileSync(configPath, "utf8").endsWith("}\n"), "trailing newline kept on rewrite");
});

test("writeSection: refuses an existing malformed file, keeps the bytes, leaves no temp file", () => {
	for (const raw of ["{not json", "[1, 2]", '"chains"', "null"]) {
		setRawConfig(raw);
		const got = writeSection("automode", { ask: ["b"] });
		assert.equal(got.ok, false, `root ${raw}`);
		assert.equal(got.error.includes(configPath), true, `root ${raw} names the path`);
		assert.match(got.error, /not (valid JSON|a JSON object)/, `root ${raw} names the reason`);
		assert.equal(readFileSync(configPath, "utf8"), raw, `root ${raw} bytes survive`);
		assert.deepEqual(
			readdirSync(home).filter((name) => name.startsWith(".")),
			[],
			`root ${raw} leaves no temp file`,
		);
	}
});

test("project config: path honors cwd; a missing file is empty with no warning", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-project-cfg-"));
	assert.equal(projectConfigPath(dir), path.join(dir, ".torus", "config.json"));
	const loaded = loadProjectConfig(dir);
	assert.deepEqual(loaded.config, {});
	assert.deepEqual(loaded.ignored, []);
	assert.equal(loaded.warning, undefined);
});

test("project config: allowlist keeps knob sections and automode whole; the rest is refused", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-project-cfg-"));
	mkdirSync(path.join(dir, ".torus"), { recursive: true });
	writeFileSync(
		projectConfigPath(dir),
		JSON.stringify({
			ui: { banner: false },
			automode: { deny: ["sudo *"], allow: ["curl *"] },
			chains: { fast: ["zai/x"] },
			keywords: { hi: "there" },
			serve: { port: 1 },
			permissionMode: "auto",
			guards: 3,
		}),
	);
	const loaded = loadProjectConfig(dir);
	assert.deepEqual(Object.keys(loaded.config).sort(), ["automode", "ui"]);
	assert.deepEqual(loaded.config.automode, { deny: ["sudo *"], allow: ["curl *"] });
	for (const refused of ["chains", "keywords", "serve", "permissionMode", "guards"]) {
		assert.ok(loaded.ignored.includes(refused), `refused: ${refused}`);
	}
	assert.match(loaded.warning ?? "", /ignoring chains/);
});

test("project config: malformed file degrades to empty with a warning, no throw", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-project-cfg-"));
	mkdirSync(path.join(dir, ".torus"), { recursive: true });
	writeFileSync(projectConfigPath(dir), "{not json");
	const loaded = loadProjectConfig(dir);
	assert.deepEqual(loaded.config, {});
	assert.match(loaded.warning ?? "", /not valid JSON/);
});
