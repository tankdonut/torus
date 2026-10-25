import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

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
	writeSection,
	_resetConfigCache,
	_peekConfigCache,
	_configFileReads,
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

test("loadConfigFile memo: unchanged file is served from memory with one underlying read", () => {
	clearConfig();
	_resetConfigCache();
	setConfig({ chains: { default: "gpt" } });
	const first = loadConfigFile();
	assert.equal(_configFileReads(), 1);
	const second = loadConfigFile();
	assert.equal(_configFileReads(), 1, "a hit performs no second read");
	assert.strictEqual(second, first, "a hit hands back the memoized result object");
	const peek = _peekConfigCache();
	assert.equal(peek.size, 1);
	const stats = statSync(configPath);
	assert.deepEqual(peek.get(configPath), { mtimeMs: stats.mtimeMs, size: stats.size });
});

test("loadConfigFile memo: failure loads are never memoized", () => {
	clearConfig();
	_resetConfigCache();
	assert.deepEqual(loadConfigFile(), { config: {} });
	assert.equal(_peekConfigCache().has(configPath), false, "missing file is not memoized");

	setRawConfig("{not json");
	assert.ok(loadConfigFile().warning?.includes("not valid JSON"));
	assert.ok(_configFileReads() >= 1, "the malformed read still hits the disk");
	assert.equal(_peekConfigCache().has(configPath), false, "malformed file is not memoized");

	setRawConfig("[1, 2]");
	assert.ok(loadConfigFile().warning?.includes("not a JSON object"));
	assert.equal(_peekConfigCache().has(configPath), false, "non-object root is not memoized");
});

test("loadConfigFile memo: an edit invalidates the entry and returns the new value", async () => {
	clearConfig();
	_resetConfigCache();
	setConfig({ chains: { default: "gpt" } });
	const before = loadConfigFile();
	assert.equal(before.config.chains.default, "gpt");

	// Same byte size, different value: only the mtime half of the key can catch it.
	const statsBefore = statSync(configPath);
	writeFileSync(configPath, '{"chains":{"default":"zmx"}}');
	for (let i = 0; i < 50 && statSync(configPath).mtimeMs === statsBefore.mtimeMs; i++) {
		await sleep(2);
	}
	assert.notEqual(statSync(configPath).mtimeMs, statsBefore.mtimeMs, "coarse mtime waited out");

	const after = loadConfigFile();
	assert.equal(after.config.chains.default, "zmx", "the edit is visible without a restart");
	assert.notStrictEqual(after, before, "a new parse, not the memoized result");
	assert.deepEqual(_peekConfigCache().get(configPath), {
		mtimeMs: statSync(configPath).mtimeMs,
		size: statSync(configPath).size,
	});
	assert.equal(_configFileReads(), 2, "one read per content version");
});

test("readSection: missing config.json yields the default source", () => {
	clearConfig();
	assert.deepEqual(readSection("chains"), { value: undefined, source: "default" });
});

test("readSection: malformed config.json resolves to the default with its warning, no throw", () => {
	setRawConfig("{not json");
	const got = readSection("automode");
	assert.deepEqual(got.value, undefined);
	assert.equal(got.source, "default");
	assert.ok(got.warning?.includes("not valid JSON"));
});

test("readSection: present object section is served verbatim with the config source", () => {
	setConfig({ chains: { default: "gpt" } });
	assert.deepEqual(readSection("chains"), {
		value: { default: "gpt" },
		source: "config",
	});
});

test("readSection: non-object section warns, names the section, and reads as absent", () => {
	for (const section of [3, "fast", [""], null]) {
		setConfig({ chains: section });
		const got = readSection("chains");
		assert.deepEqual(got.value, undefined, `section ${JSON.stringify(section)}`);
		assert.equal(got.source, "default", `section ${JSON.stringify(section)}`);
		assert.ok(got.warning?.includes('"chains"'), `section ${JSON.stringify(section)}`);
		assert.ok(got.warning?.includes("not an object"), `section ${JSON.stringify(section)}`);
	}
});

test("readSection: an empty object section is the config source, not the default", () => {
	setConfig({ chains: {} });
	const got = readSection("chains");
	assert.deepEqual(got.value, {});
	assert.equal(got.source, "config");
});

test("readSection: explicit parsed config is used without touching disk", () => {
	clearConfig();
	const got = readSection("chains", { chains: { default: "gpt" } });
	assert.deepEqual(got.value, { default: "gpt" });
	assert.equal(got.source, "config");
});

test("readSection: a pre-unification standalone section file is not a source", () => {
	clearConfig();
	// The pre-unification per-section files are gone as config sources: one
	// planted beside config.json must not reach the section at all.
	const preUnified = ["chains", ".json"].join("");
	writeFileSync(path.join(home, preUnified), JSON.stringify({ fast: ["zai/x"] }), "utf8");
	const got = readSection("chains");
	assert.deepEqual(got, { value: undefined, source: "default" });
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

test("writeSection: drops the memo for the file it writes, so the next load is fresh", () => {
	clearConfig();
	_resetConfigCache();
	setConfig({ chains: { default: "gpt" } });
	assert.equal(loadConfigFile().config.automode, undefined);
	const written = writeSection("automode", { ask: ["b"] });
	assert.equal(written.ok, true);
	assert.equal(_peekConfigCache().has(configPath), false, "the write drops the memo entry");
	const after = loadConfigFile();
	assert.deepEqual(after.config.automode, { ask: ["b"] });
	assert.deepEqual(after.config.chains, { default: "gpt" });
});

test("project config: inherits the memo; the allowlist shaping stays per-call", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-project-cfg-"));
	mkdirSync(path.join(dir, ".torus"), { recursive: true });
	writeFileSync(
		projectConfigPath(dir),
		JSON.stringify({ ui: { banner: false }, serve: { port: 1 } }),
	);
	_resetConfigCache();
	const first = loadProjectConfig(dir);
	const second = loadProjectConfig(dir);
	assert.deepEqual(first.config, { ui: { banner: false } });
	assert.deepEqual(first.ignored, ["serve"]);
	assert.notStrictEqual(second.config, first.config, "shaping rebuilds its result per call");
	assert.ok(_peekConfigCache().has(projectConfigPath(dir)), "the underlying read is memoized");
	assert.equal(_configFileReads(), 1, "two project loads, one underlying read");
	const raw = loadConfigFile(projectConfigPath(dir));
	assert.notStrictEqual(raw.config, first.config, "the shaped result is not the memoized object");
	const again = loadConfigFile(projectConfigPath(dir));
	assert.strictEqual(raw.config, again.config, "hits share identity");
});
