import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-automode-"));
process.env.TORUS_HOME = home;

const {
	resolveMode,
	validateRulesObject,
	loadAutomodeRules,
	parseModelPin,
	isBypassMode,
	appendAuditRow,
	auditPath,
	AUDIT_LOG_NAME,
} = await import("../extensions/automode/config.ts");
const { torusHome } = await import("../extensions/fsutil.ts");

// Live-env defaults below must resolve against the fake home even when the
// suite itself runs inside a torus session (which exports TORUS_STATE_DIR).
// The config import pulls in fsutil (via the unified loader), whose module
// load re-mirrors TORUS_STATE_DIR — clear it after the imports settle.
delete process.env.TORUS_STATE_DIR;

const configPath = path.join(home, "config.json");

const setConfig = (value) => writeFileSync(configPath, JSON.stringify(value));
const clearConfig = () => rmSync(configPath, { force: true });

const sampleRow = (over = {}) => ({
	ts: 1_761_000_000_000,
	mode: "auto",
	source: "test",
	verdict: "allow",
	reason: "unit test",
	command: "git status",
	...over,
});

const validate = (source, origin = "config.json") => validateRulesObject(source, origin);

const readLines = (file) =>
	readFileSync(file, "utf8")
		.trimEnd()
		.split("\n")
		.filter((line) => line !== "");

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

test("validateRulesObject: unknown top-level keys warn", () => {
	const { rules, warnings } = validate({
		allow: ["bash *"],
		ask: ["git push*"],
		deny: ["rm -rf*"],
		timeoutMs: 15,
	});
	assert.deepEqual(rules, { allow: ["bash *"], ask: ["git push*"], deny: ["rm -rf*"] });
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes("timeoutMs"));
});

test("validateRulesObject: non-array rule fields are ignored with a warning each", () => {
	const { rules, warnings } = validate({ allow: "*", deny: null });
	assert.deepEqual(rules, {});
	assert.equal(warnings.length, 2);
	assert.ok(warnings.some((w) => w.includes('"allow"')));
	assert.ok(warnings.some((w) => w.includes('"deny"')));
});

test("validateRulesObject: non-string entries are dropped with a warning, strings kept", () => {
	const { rules, warnings } = validate({ allow: ["bash *", 42, null, "git *"] });
	assert.deepEqual(rules, { allow: ["bash *", "git *"] });
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].includes("2 non-string entries"));
});

test("validateRulesObject: every warning carries the origin prefix", () => {
	const { warnings } = validate({ allow: "*", bogus: true });
	assert.ok(warnings.length >= 2);
	for (const warning of warnings) {
		assert.ok(warning.startsWith("config.json: "), warning);
	}
});

test("validateRulesObject: v2 keys — environment and hardDeny prose arrays, classifyAllShell boolean", () => {
	const { rules, warnings } = validate({
		environment: ["Source control: github.example.com/acme", 42],
		hardDeny: ["never send repo contents to third parties"],
		classifyAllShell: true,
	});
	assert.deepEqual(rules.environment, ["Source control: github.example.com/acme"]);
	assert.deepEqual(rules.hardDeny, ["never send repo contents to third parties"]);
	assert.equal(rules.classifyAllShell, true);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /non-string/);
});

test("validateRulesObject: non-boolean classifyAllShell is ignored with a warning", () => {
	const { rules, warnings } = validate({ classifyAllShell: "yes" });
	assert.equal(rules.classifyAllShell, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /classifyAllShell.*boolean/);
});

test("validateRulesObject: v1 shapes load unchanged (no v2 keys)", () => {
	const { rules, warnings } = validate({ allow: ["ls *"] });
	assert.deepEqual(rules, { allow: ["ls *"] });
	assert.deepEqual(warnings, []);
});

test("validateRulesObject: softDeny and softDenyExceptions are prose arrays; junk entries drop with origin-prefixed warnings", () => {
	const { rules, warnings } = validate({
		softDeny: ["never run database migrations outside the CLI", 42],
		softDenyExceptions: ["psql run by the deploy wrapper"],
	});
	assert.deepEqual(rules, {
		softDeny: ["never run database migrations outside the CLI"],
		softDenyExceptions: ["psql run by the deploy wrapper"],
	});
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].startsWith("config.json: "), warnings[0]);
	assert.match(warnings[0], /"softDeny" contains 1 non-string entry/);
});

test("validateRulesObject: non-array softDeny is ignored with an origin-prefixed warning", () => {
	const { rules, warnings } = validate({ softDeny: "nope" });
	assert.deepEqual(rules, {});
	assert.equal(warnings.length, 1);
	assert.ok(warnings[0].startsWith("config.json: "));
	assert.match(warnings[0], /"softDeny" must be an array of strings/);
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
	const lines = readLines(log);
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
	assert.equal(JSON.parse(readLines(log)[0]).command, "git status");
});

test("appendAuditRow: default path prefers TORUS_STATE_DIR when set", () => {
	const stateDir = path.join(home, "state");
	process.env.TORUS_STATE_DIR = stateDir;
	try {
		appendAuditRow(sampleRow({ command: "git log --oneline" }));
		const log = path.join(stateDir, AUDIT_LOG_NAME);
		assert.ok(existsSync(log));
		assert.equal(JSON.parse(readLines(log)[0]).command, "git log --oneline");
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

test('auditPath: derived from fsutil torusHome(), including the TORUS_HOME="" case', () => {
	delete process.env.TORUS_STATE_DIR;
	assert.equal(auditPath(), path.join(torusHome(), AUDIT_LOG_NAME));
	assert.equal(auditPath(), path.join(home, AUDIT_LOG_NAME));
	const previous = process.env.TORUS_HOME;
	try {
		process.env.TORUS_HOME = "";
		assert.equal(auditPath(), path.join(torusHome(), AUDIT_LOG_NAME), 'under TORUS_HOME=""');
		assert.equal(auditPath(), AUDIT_LOG_NAME, "empty home collapses to the bare file name");
		process.env.TORUS_HOME = "/elsewhere";
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
	assert.equal(auditPath(), path.join(home, AUDIT_LOG_NAME));
});

test("loadAutomodeRules: the config.json automode section governs, validated (v2 keys)", () => {
	clearConfig();
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

test("loadAutomodeRules: an empty section is the config source, distinct from no section", () => {
	clearConfig();
	setConfig({ automode: {} });
	try {
		assert.deepEqual(loadAutomodeRules(), {
			rules: {},
			warnings: [],
			source: "config.json",
		});
	} finally {
		clearConfig();
	}
});

test("loadAutomodeRules: validation warnings carry the config.json prefix", () => {
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
	assert.deepEqual(loadAutomodeRules(), { rules: {}, warnings: [], source: "default" });
});

test("loadAutomodeRules: malformed config.json means no rules with its own warning", () => {
	writeFileSync(configPath, "{not json");
	try {
		const got = loadAutomodeRules();
		assert.equal(got.source, "default");
		assert.deepEqual(got.rules, {});
		assert.ok(
			got.warnings.some((w) => w.includes("not valid JSON") && w.includes(configPath)),
			got.warnings.join(" | "),
		);
	} finally {
		clearConfig();
	}
});

test("loadAutomodeRules: a pre-unification standalone rules file is not a source", () => {
	clearConfig();
	// The pre-unification rules file is gone as a config source: planted
	// under the torus home, it must not reach the effective rules.
	const preUnified = ["automode", ".json"].join("");
	writeFileSync(path.join(home, preUnified), JSON.stringify({ deny: ["sudo *"] }), "utf8");
	try {
		const got = loadAutomodeRules();
		assert.deepEqual(got.rules, {});
		assert.equal(got.source, "default");
		assert.deepEqual(got.warnings, []);
	} finally {
		rmSync(path.join(home, preUnified), { force: true });
	}
});

test("loadAutomodeRules: valid softDeny and softDenyExceptions pass clean from config.json", () => {
	setConfig({
		automode: {
			softDeny: ["never run database migrations outside the CLI"],
			softDenyExceptions: ["psql run by the deploy wrapper"],
		},
	});
	try {
		assert.deepEqual(loadAutomodeRules(), {
			rules: {
				softDeny: ["never run database migrations outside the CLI"],
				softDenyExceptions: ["psql run by the deploy wrapper"],
			},
			warnings: [],
			source: "config.json",
		});
	} finally {
		clearConfig();
	}
});

test("loadAutomodeRules: softDeny junk from config.json warns with the config.json prefix", () => {
	setConfig({
		automode: { softDeny: "nope", softDenyExceptions: ["psql run by the deploy wrapper", null] },
	});
	try {
		const got = loadAutomodeRules();
		assert.equal(got.source, "config.json");
		assert.deepEqual(got.rules, { softDenyExceptions: ["psql run by the deploy wrapper"] });
		assert.equal(got.warnings.length, 2, got.warnings.join(" | "));
		for (const warning of got.warnings) {
			assert.ok(warning.startsWith("config.json: "), warning);
		}
		assert.ok(got.warnings.some((w) => w.includes('"softDeny" must be an array')));
		assert.ok(
			got.warnings.some((w) => w.includes('"softDenyExceptions" contains 1 non-string entry')),
		);
	} finally {
		clearConfig();
	}
});

test("resolveMode: bypass selects bypass mode from env only, case and whitespace tolerant", () => {
	assert.deepEqual(resolveMode({ TORUS_PERMISSION_MODE: "bypass" }), { mode: "bypass" });
	assert.deepEqual(resolveMode({ TORUS_PERMISSION_MODE: " Bypass " }), { mode: "bypass" });
	assert.equal(resolveMode({ TORUS_PERMISSION_MODE: "bypass" }).mode, "bypass");
});

test("resolveMode: config bypass is refused with the startup-only warning and default mode", () => {
	const resolved = resolveMode({ TORUS_PERMISSION_MODE: undefined }, "bypass");
	assert.equal(resolved.mode, "default");
	assert.match(resolved.warning ?? "", /bypass/);
	assert.match(resolved.warning ?? "", /startup-only/);
});

test("resolveMode: env bypass beats a config auto value — bypass wins its tier", () => {
	assert.deepEqual(resolveMode({ TORUS_PERMISSION_MODE: "bypass" }, "auto"), { mode: "bypass" });
});

test("isBypassMode: true only for the exact bypass spelling", () => {
	assert.equal(isBypassMode({ TORUS_PERMISSION_MODE: "bypass" }), true);
	assert.equal(isBypassMode({ TORUS_PERMISSION_MODE: "BYPASS" }), true);
	assert.equal(isBypassMode({ TORUS_PERMISSION_MODE: "auto" }), false);
	assert.equal(isBypassMode({ TORUS_PERMISSION_MODE: " bypass " }), true);
	assert.equal(isBypassMode({}), false);
});
