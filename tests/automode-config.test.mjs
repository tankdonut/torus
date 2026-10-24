import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-automode-"));
process.env.TORUS_HOME = home;

const {
	resolveMode,
	loadRules,
	parseModelPin,
	appendAuditRow,
	torusHomeDir,
	rulesPath,
	auditPath,
	RULES_FILE_NAME,
	AUDIT_LOG_NAME,
} = await import("../extensions/automode/config.ts");

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

test("appendAuditRow: an unwritable target is swallowed without throwing", () => {
	const blocker = path.join(home, "blocker");
	writeFileSync(blocker, "i am a file");
	assert.doesNotThrow(() => appendAuditRow(sampleRow(), path.join(blocker, "audit.log")));
	assert.equal(existsSync(path.join(blocker, "audit.log")), false);
});

test("torusHomeDir and derived paths: TORUS_HOME > HOME > os.homedir()", () => {
	assert.equal(torusHomeDir({ TORUS_HOME: "/t", HOME: "/h" }), "/t");
	assert.equal(torusHomeDir({ HOME: "/h" }), "/h");
	assert.equal(torusHomeDir({}), homedir());
	assert.equal(torusHomeDir(), home);
	assert.equal(rulesPath({ TORUS_HOME: "/t" }), path.join("/t", RULES_FILE_NAME));
	assert.equal(auditPath({ TORUS_HOME: "/t" }), path.join("/t", AUDIT_LOG_NAME));
	assert.equal(RULES_FILE_NAME, "automode.json");
	assert.equal(AUDIT_LOG_NAME, "automode.log");
});
