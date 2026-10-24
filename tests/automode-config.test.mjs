import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-automode-"));
process.env.TORUS_HOME = home;

const {
	resolveMode,
	loadRules,
	loadAutomodeRules,
	parseModelPin,
	appendAuditRow,
	rulesPath,
	auditPath,
	RULES_FILE_NAME,
	AUDIT_LOG_NAME,
} = await import("../extensions/automode/config.ts");
const { torusHome } = await import("../extensions/fsutil.ts");

// Live-env defaults below must resolve against the fake home even when the
// suite itself runs inside a torus session (which exports TORUS_STATE_DIR).
// The config import pulls in fsutil (via the unified loader), whose module
// load re-mirrors TORUS_STATE_DIR — clear it after the imports settle.
delete process.env.TORUS_STATE_DIR;

const configPath = path.join(home, "config.json");
const legacyRulesPath = path.join(home, RULES_FILE_NAME);

const setConfig = (value) => writeFileSync(configPath, JSON.stringify(value));
const clearConfig = () => rmSync(configPath, { force: true });
const setLegacyRules = (value) => writeFileSync(legacyRulesPath, JSON.stringify(value));
const clearLegacyRules = () => rmSync(legacyRulesPath, { force: true });

const rulesFile = (name, content) => {
	const file = path.join(home, "rules", name);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
};

const sampleRow = (over = {}) => ({
	ts: 1_761_000_000_000,
	mode: "auto",
	source: "test",
	verdict: "allow",
	reason: "unit test",
	command: "git status",
	...over,
});

test("resolveMode: unset, empty, 0/off/default keep default mode without warnings", () => {
	assert.deepEqual(resolveMode({}), { mode: "default" });
	for (const value of ["", "0", "off", "default", "OFF", "Default"]) {
		const got = resolveMode({ TORUS_PERMISSION_MODE: value });
		assert.deepEqual(got, { mode: "default" }, `value ${value}`);
	}
});

test("resolveMode: 1/on/auto (any case) select auto mode", () => {
	for (const value of ["1", "on", "auto", "ON", "Auto", " 1 "]) {
		const got = resolveMode({ TORUS_PERMISSION_MODE: value });
		assert.deepEqual(got, { mode: "auto" }, `value ${value}`);
	}
});

test("resolveMode: junk value falls back to default with a warning naming it and the accepted values", () => {
	const { mode, warning } = resolveMode({ TORUS_PERMISSION_MODE: "yolo" });
	assert.equal(mode, "default");
	assert.ok(warning?.includes("yolo"), "names the bad value");
	for (const accepted of ["1", "on", "auto", "0", "off", "default"]) {
		assert.ok(warning?.includes(accepted), `lists accepted value ${accepted}`);
	}
});

test("loadRules: missing file means empty rules, no warning", () => {
	assert.deepEqual(loadRules(path.join(home, "nope", "automode.json")), {
		rules: {},
		warnings: [],
	});
});

test("loadRules: malformed JSON degrades to empty rules with one warning, no throw", () => {
	const file = rulesFile("malformed.json", "{not json");
	const got = loadRules(file);
	assert.deepEqual(got.rules, {});
	assert.equal(got.warnings.length, 1);
	assert.ok(got.warnings[0].includes("not valid JSON"));
	assert.ok(got.warnings[0].includes(file));
});

test("loadRules: valid file loads allow/ask/deny arrays; unknown top-level keys warn", () => {
	const file = rulesFile(
		"valid.json",
		JSON.stringify({ allow: ["bash *"], ask: ["git push*"], deny: ["rm -rf*"], timeoutMs: 15 }),
	);
	const got = loadRules(file);
	assert.deepEqual(got.rules, { allow: ["bash *"], ask: ["git push*"], deny: ["rm -rf*"] });
	assert.equal(got.warnings.length, 1);
	assert.ok(got.warnings[0].includes("timeoutMs"));
});

test("loadRules: non-array rule fields are ignored with a warning each", () => {
	const file = rulesFile("non-array.json", JSON.stringify({ allow: "*", deny: null }));
	const got = loadRules(file);
	assert.deepEqual(got.rules, {});
	assert.equal(got.warnings.length, 2);
	assert.ok(got.warnings.some((w) => w.includes('"allow"')));
	assert.ok(got.warnings.some((w) => w.includes('"deny"')));
});

test("loadRules: non-string entries are dropped with a warning, strings kept", () => {
	const file = rulesFile(
		"junk-entries.json",
		JSON.stringify({ allow: ["bash *", 42, null, "git *"] }),
	);
	const got = loadRules(file);
	assert.deepEqual(got.rules, { allow: ["bash *", "git *"] });
	assert.equal(got.warnings.length, 1);
	assert.ok(got.warnings[0].includes("2 non-string entries"));
});

test("loadRules: non-object JSON root degrades to empty rules with one warning", () => {
	const file = rulesFile("array-root.json", "[1, 2]");
	const got = loadRules(file);
	assert.deepEqual(got.rules, {});
	assert.equal(got.warnings.length, 1);
});

test("parseModelPin: unset or empty yields no pin and no warning", () => {
	assert.deepEqual(parseModelPin({}), {});
	assert.deepEqual(parseModelPin({ TORUS_PERMISSION_MODEL: "" }), {});
	assert.deepEqual(parseModelPin({ TORUS_PERMISSION_MODEL: "   " }), {});
});

test("parseModelPin: provider/model-id parses into a pin", () => {
	assert.deepEqual(parseModelPin({ TORUS_PERMISSION_MODEL: "openai/gpt-4o" }), {
		pin: { provider: "openai", modelId: "gpt-4o" },
	});
});

test("parseModelPin: missing slash or empty part yields a warning instead of a pin", () => {
	for (const value of ["gpt-4o", "openai/", "/gpt-4o"]) {
		const got = parseModelPin({ TORUS_PERMISSION_MODEL: value });
		assert.equal(got.pin, undefined, `value ${value}`);
		assert.ok(got.warning?.includes(value), `warning names ${value}`);
		assert.ok(got.warning?.includes("provider/model-id"));
	}
});

test("appendAuditRow: appends valid JSON lines, creating parent directories", () => {
	const log = path.join(home, "deep", "nested", "audit.log");
	appendAuditRow(sampleRow(), log);
	appendAuditRow(sampleRow({ verdict: "deny", ms: 12, confidence: 0.9, model: "m" }), log);
	const lines = readFileSync(log, "utf8").trimEnd().split("\n");
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]), sampleRow());
	assert.deepEqual(
		JSON.parse(lines[1]),
		sampleRow({ verdict: "deny", ms: 12, confidence: 0.9, model: "m" }),
	);
});

test("appendAuditRow: default path honors TORUS_HOME", () => {
	appendAuditRow(sampleRow());
	const log = path.join(home, AUDIT_LOG_NAME);
	assert.ok(existsSync(log));
	assert.equal(JSON.parse(readFileSync(log, "utf8", "r")).command, "git status");
});

test("appendAuditRow: default path prefers TORUS_STATE_DIR when set", () => {
	const stateDir = path.join(home, "state");
	process.env.TORUS_STATE_DIR = stateDir;
	try {
		appendAuditRow(sampleRow({ command: "git log --oneline" }));
		const log = path.join(stateDir, AUDIT_LOG_NAME);
		assert.ok(existsSync(log));
		assert.equal(JSON.parse(readFileSync(log, "utf8", "r")).command, "git log --oneline");
	} finally {
		delete process.env.TORUS_STATE_DIR;
	}
});

test("appendAuditRow: an unwritable target is swallowed without throwing", () => {
	const blocker = path.join(home, "blocker");
	writeFileSync(blocker, "i am a file");
	assert.doesNotThrow(() => appendAuditRow(sampleRow(), path.join(blocker, "audit.log")));
	assert.equal(existsSync(path.join(blocker, "audit.log")), false);
});

test('rulesPath/auditPath: derived from fsutil torusHome(), including the TORUS_HOME="" case', () => {
	delete process.env.TORUS_STATE_DIR;
	assert.equal(rulesPath(), path.join(torusHome(), RULES_FILE_NAME));
	assert.equal(rulesPath(), path.join(home, RULES_FILE_NAME));
	assert.equal(auditPath(), path.join(torusHome(), AUDIT_LOG_NAME));
	const previous = process.env.TORUS_HOME;
	try {
		process.env.TORUS_HOME = "";
		assert.equal(rulesPath(), path.join(torusHome(), RULES_FILE_NAME), 'under TORUS_HOME=""');
		assert.equal(rulesPath(), RULES_FILE_NAME, "empty home collapses to the bare file name");
		process.env.TORUS_HOME = "/elsewhere";
		assert.equal(rulesPath(), path.join("/elsewhere", RULES_FILE_NAME));
		assert.equal(auditPath(), path.join("/elsewhere", AUDIT_LOG_NAME));
		process.env.TORUS_STATE_DIR = "/state/dir";
		try {
			assert.equal(auditPath(), path.join("/state/dir", AUDIT_LOG_NAME));
		} finally {
			delete process.env.TORUS_STATE_DIR;
		}
	} finally {
		process.env.TORUS_HOME = previous;
	}
	assert.equal(rulesPath(), path.join(home, RULES_FILE_NAME));
});

test("loadRules: v2 keys — environment and hardDeny prose arrays, classifyAllShell boolean", () => {
	const file = rulesFile(
		"v2.json",
		JSON.stringify({
			environment: ["Source control: github.example.com/acme", 42],
			hardDeny: ["never send repo contents to third parties"],
			classifyAllShell: true,
		}),
	);
	const { rules, warnings } = loadRules(file);
	assert.deepEqual(rules.environment, ["Source control: github.example.com/acme"]);
	assert.deepEqual(rules.hardDeny, ["never send repo contents to third parties"]);
	assert.equal(rules.classifyAllShell, true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /non-string/);
});

test("loadRules: non-boolean classifyAllShell is ignored with a warning", () => {
	const file = rulesFile("v2-bad-flag.json", JSON.stringify({ classifyAllShell: "yes" }));
	const { rules, warnings } = loadRules(file);
	assert.equal(rules.classifyAllShell, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /classifyAllShell.*boolean/);
});

test("loadRules: v1 files load unchanged (no v2 keys)", () => {
	const file = rulesFile("v1.json", JSON.stringify({ allow: ["ls *"] }));
	const { rules, warnings } = loadRules(file);
	assert.deepEqual(rules, { allow: ["ls *"] });
	assert.deepEqual(warnings, []);
});

test("loadAutomodeRules: the config.json automode section governs, validated like the file (v2 keys)", () => {
	clearConfig();
	clearLegacyRules();
	setConfig({
		automode: {
			allow: ["cargo *"],
			deny: ["sudo *"],
			environment: ["Source control: github.example.com/acme"],
			hardDeny: ["no secrets leave the machine"],
			classifyAllShell: true,
		},
	});
	try {
		const got = loadAutomodeRules();
		assert.deepEqual(got, {
			rules: {
				allow: ["cargo *"],
				deny: ["sudo *"],
				environment: ["Source control: github.example.com/acme"],
				hardDeny: ["no secrets leave the machine"],
				classifyAllShell: true,
			},
			warnings: [],
			source: "config.json",
		});
	} finally {
		clearConfig();
	}
});

test("loadAutomodeRules: legacy fallback is byte-identical to loadRules", () => {
	clearConfig();
	setLegacyRules({ allow: ["bash *", 7], bogus: true });
	try {
		const got = loadAutomodeRules();
		const fromFile = loadRules(legacyRulesPath);
		assert.equal(got.source, "automode.json");
		assert.deepEqual(got.rules, fromFile.rules);
		assert.deepEqual(got.warnings, fromFile.warnings);
	} finally {
		clearLegacyRules();
	}
});

test("loadAutomodeRules: an existing empty automode.json is legacy, not default", () => {
	clearConfig();
	setLegacyRules({});
	try {
		assert.deepEqual(loadAutomodeRules(), {
			rules: {},
			warnings: [],
			source: "automode.json",
		});
	} finally {
		clearLegacyRules();
	}
});

test("loadAutomodeRules: overlap yields config rules plus exactly one shadow warning", () => {
	setLegacyRules({ deny: ["rm *"] });
	setConfig({ automode: { deny: ["sudo *"] } });
	try {
		const got = loadAutomodeRules();
		assert.equal(got.source, "config.json");
		assert.deepEqual(got.rules, { deny: ["sudo *"] });
		assert.equal(got.warnings.length, 1, "exactly one warning");
		assert.ok(got.warnings[0].includes("torus config migrate"), got.warnings[0]);
	} finally {
		clearConfig();
		clearLegacyRules();
	}
});

test("loadAutomodeRules: malformed config.json falls back to the legacy file with a warning", () => {
	writeFileSync(configPath, "{not json");
	setLegacyRules({ deny: ["sudo *"] });
	try {
		const got = loadAutomodeRules();
		assert.equal(got.source, "automode.json");
		assert.deepEqual(got.rules, { deny: ["sudo *"] });
		assert.ok(
			got.warnings.some((w) => w.includes("not valid JSON") && w.includes(configPath)),
			got.warnings.join(" | "),
		);
	} finally {
		clearConfig();
		clearLegacyRules();
	}
});

test("loadAutomodeRules: validation warnings from config carry the config.json prefix", () => {
	clearLegacyRules();
	setConfig({ automode: { allow: "*", classifyAllShell: "yes", timeoutMs: 5 } });
	try {
		const got = loadAutomodeRules();
		assert.equal(got.source, "config.json");
		assert.deepEqual(got.rules, {});
		assert.equal(got.warnings.length, 3, got.warnings.join(" | "));
		for (const warning of got.warnings) {
			assert.ok(warning.startsWith("config.json: "), warning);
		}
		assert.ok(got.warnings.some((w) => w.includes('"allow" must be an array')));
		assert.ok(got.warnings.some((w) => w.includes("classifyAllShell")));
		assert.ok(got.warnings.some((w) => w.includes("timeoutMs")));
	} finally {
		clearConfig();
	}
});

test("loadAutomodeRules: nothing configured means default source with no rules or warnings", () => {
	clearConfig();
	clearLegacyRules();
	assert.deepEqual(loadAutomodeRules(), { rules: {}, warnings: [], source: "default" });
});
