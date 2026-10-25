import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Knob resolution reads the live TORUS_HOME via fsutil, so sandbox it before
// importing anything that resolves the config path. The osnotify integration
// also redirects HOME so the desktop-entry write and the fake notify-send
// shim on PATH both land in tmp.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-knobs-test-"));
process.env.HOME = HOME;
process.env.TORUS_HOME = HOME;

const BIN = path.join(HOME, "bin");
const CALLS = path.join(HOME, "calls");
mkdirSync(BIN, { recursive: true });
writeFileSync(
	path.join(BIN, "notify-send"),
	[
		"#!/bin/sh",
		'if [ "$1" = "--help" ]; then echo "  -p, --print-id"; exit 0; fi',
		`printf '%s\\n' "$*" >> '${CALLS}'`,
		"echo 7",
	].join("\n"),
	{ mode: 0o755 },
);
process.env.PATH = `${BIN}:${process.env.PATH}`;

const { CONFIG_FILE_NAME } = await import("../extensions/config/loader.ts");
const { knobBoolean, knobNumber, knobString, parseZeroDisables } = await import(
	"../extensions/config/knobs.ts"
);
const ui = await import("../extensions/ui/index.ts");
const guards = await import("../extensions/guards/index.ts");
const osnotify = await import("../extensions/osnotify.ts");

const configPath = path.join(HOME, CONFIG_FILE_NAME);

const setConfig = (data) => writeFileSync(configPath, JSON.stringify(data));
const clearConfig = () => {
	try {
		rmSync(configPath);
	} catch {}
};

/** Run body with one env var set, restoring (or keeping it unset) afterwards. */
function withEnv(name, value, body) {
	const saved = Object.hasOwn(process.env, name) ? process.env[name] : undefined;
	process.env[name] = value;
	try {
		return body();
	} finally {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
}

// The TS import hook defaults TORUS_NOTIFY=0 for every suite, so "no env"
// scenarios for the notify knob must delete it explicitly.
function withoutEnv(name, body) {
	const saved = Object.hasOwn(process.env, name) ? process.env[name] : undefined;
	delete process.env[name];
	try {
		return body();
	} finally {
		if (saved !== undefined) process.env[name] = saved;
	}
}

after(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("parseZeroDisables: only exactly '0' disables; every other defined value enables", () => {
	assert.equal(parseZeroDisables("0"), false);
	for (const raw of ["1", "true", "false", "", "garbage"]) {
		assert.equal(parseZeroDisables(raw), true, `raw ${JSON.stringify(raw)}`);
	}
});

test("knobBoolean: env beats config beats default; wrong-typed config ignored", () => {
	clearConfig();
	assert.equal(knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true), true);

	setConfig({ ui: { banner: false } });
	assert.equal(knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true), false);

	withEnv("TORUS_KNOB_PROBE", "1", () => {
		assert.equal(knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true), true);
		assert.equal(
			knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true, parseZeroDisables),
			true,
			"zero-disables parse keeps any non-'0' value on",
		);
	});
	withEnv("TORUS_KNOB_PROBE", "0", () => {
		assert.equal(knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true), false);
		assert.equal(knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true, parseZeroDisables), false);
	});

	for (const wrong of ["false", 1, null, ["no"]]) {
		setConfig({ ui: { banner: wrong } });
		assert.equal(
			knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true),
			true,
			`non-boolean config ${JSON.stringify(wrong)} must fall to default`,
		);
	}

	setConfig({ ui: { banner: false } });
	assert.equal(
		knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true, undefined, { ui: { banner: false } }),
		false,
		"preloaded parsed config is honored without a file read",
	);
	clearConfig();
	assert.equal(
		knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true, undefined, { ui: { banner: false } }),
		false,
		"preloaded parsed wins even when no config file exists",
	);
});

test("knobString: env beats config beats default; non-string config ignored", () => {
	clearConfig();
	assert.equal(knobString("TORUS_KNOB_PROBE", "hashline", "fmtCmd", ""), "");

	setConfig({ hashline: { fmtCmd: "/usr/bin/uncrustify" } });
	assert.equal(knobString("TORUS_KNOB_PROBE", "hashline", "fmtCmd", ""), "/usr/bin/uncrustify");

	withEnv("TORUS_KNOB_PROBE", "clang-format", () => {
		assert.equal(knobString("TORUS_KNOB_PROBE", "hashline", "fmtCmd", ""), "clang-format");
	});
	withEnv("TORUS_KNOB_PROBE", "", () => {
		assert.equal(knobString("TORUS_KNOB_PROBE", "hashline", "fmtCmd", ""), "");
	});

	for (const wrong of [7, true, null]) {
		setConfig({ hashline: { fmtCmd: wrong } });
		assert.equal(
			knobString("TORUS_KNOB_PROBE", "hashline", "fmtCmd", "fallback"),
			"fallback",
			`non-string config ${JSON.stringify(wrong)} must fall to default`,
		);
	}

	assert.equal(
		knobString("TORUS_KNOB_PROBE", "hashline", "fmtCmd", "", { hashline: { fmtCmd: "preloaded" } }),
		"preloaded",
	);
	clearConfig();
});

test("knobNumber: env beats config beats default; non-finite and non-number config ignored", () => {
	clearConfig();
	assert.equal(knobNumber("TORUS_KNOB_PROBE", "guards", "maxToolOutput", 16000), 16000);

	setConfig({ guards: { maxToolOutput: 250 } });
	assert.equal(knobNumber("TORUS_KNOB_PROBE", "guards", "maxToolOutput", 16000), 250);

	withEnv("TORUS_KNOB_PROBE", "120", () => {
		assert.equal(knobNumber("TORUS_KNOB_PROBE", "guards", "maxToolOutput", 16000), 120);
	});
	withEnv("TORUS_KNOB_PROBE", "abc", () => {
		assert.ok(
			Number.isNaN(knobNumber("TORUS_KNOB_PROBE", "guards", "maxToolOutput", 16000)),
			"unparseable env wins as NaN like the legacy Number(env) read",
		);
	});

	for (const wrong of ["250", true, null]) {
		setConfig({ guards: { maxToolOutput: wrong } });
		assert.equal(
			knobNumber("TORUS_KNOB_PROBE", "guards", "maxToolOutput", 16000),
			16000,
			`non-number config ${JSON.stringify(wrong)} must fall to default`,
		);
	}

	assert.equal(
		knobNumber("TORUS_KNOB_PROBE", "guards", "maxToolOutput", 16000, undefined, {
			guards: { maxToolOutput: 99 },
		}),
		99,
	);
	clearConfig();
});

test("knobs: a malformed config.json degrades to defaults without throwing", () => {
	writeFileSync(configPath, "{not json");
	assert.equal(knobBoolean("TORUS_KNOB_PROBE", "ui", "banner", true), true);
	assert.equal(knobString("TORUS_KNOB_PROBE", "hashline", "fmtCmd", "d"), "d");
	assert.equal(knobNumber("TORUS_KNOB_PROBE", "guards", "maxToolOutput", 5), 5);
	clearConfig();
});

function registeredUiEvents() {
	const handlers = new Map();
	const calls = { setHeader: 0 };
	const pi = {
		on: (name, fn) => handlers.set(name, fn),
		getMcpServers: () => [],
		getActiveTools: () => [],
		getSettings: () => ({}),
	};
	ui.registerUi(pi);
	const ctx = {
		mode: "tui",
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: undefined,
		ui: {
			setHeader: () => {
				calls.setHeader += 1;
			},
			setStatus: () => {},
		},
	};
	const startSession = () => handlers.get("session_start")({}, ctx);
	return { calls, startSession };
}

test("ui banner: config ui.banner=false suppresses the startup header with no env", () => {
	clearConfig();
	const { calls, startSession } = registeredUiEvents();
	startSession();
	assert.equal(calls.setHeader, 1, "baseline: banner replaces pi's header");

	setConfig({ ui: { banner: false } });
	calls.setHeader = 0;
	startSession();
	assert.equal(calls.setHeader, 0, "config banner:false must keep pi's built-in header");

	setConfig({ ui: { banner: "false" } });
	calls.setHeader = 0;
	startSession();
	assert.equal(calls.setHeader, 1, "non-boolean config banner is ignored");
	clearConfig();
});

test("ui banner: TORUS_BANNER=0 beats config ui.banner=true (env wins)", () => {
	setConfig({ ui: { banner: true } });
	const { calls, startSession } = registeredUiEvents();
	withEnv("TORUS_BANNER", "0", () => {
		startSession();
		assert.equal(calls.setHeader, 0, "env '0' must suppress even with config banner:true");
	});
	startSession();
	assert.equal(calls.setHeader, 1, "without the env var the config banner:true keeps the banner");
	clearConfig();
});

function guardToolResultHandlers() {
	const handlers = new Map();
	guards.registerGuards({
		on: (name, fn) => handlers.set(name, fn),
	});
	return handlers;
}

const BIG_TEXT = `${"H".repeat(4000)}MIDDLE${"T".repeat(4000)}`;

function guardTruncation(handlers) {
	return handlers.get("tool_result")({
		isError: false,
		content: [{ type: "text", text: BIG_TEXT }],
	});
}

test("guards: config guards.maxToolOutput caps tool results with no env", () => {
	clearConfig();
	let handlers = guardToolResultHandlers();
	assert.equal(handlers.size > 0, true, "baseline: guards register their handlers");
	assert.equal(
		guardTruncation(handlers),
		undefined,
		"baseline: 8k result under the 16000 default cap passes through untouched",
	);

	setConfig({ guards: { maxToolOutput: 1000 } });
	handlers = guardToolResultHandlers();
	const capped = guardTruncation(handlers);
	assert.ok(Array.isArray(capped?.content), "config cap must truncate the oversized result");
	assert.match(capped.content[0].text, /truncated \d+ bytes/);
	assert.ok(capped.content[0].text.length < BIG_TEXT.length);

	setConfig({ guards: { maxToolOutput: "1000" } });
	handlers = guardToolResultHandlers();
	assert.equal(
		guardTruncation(handlers),
		undefined,
		"non-number config cap is ignored, default cap applies",
	);
	clearConfig();
});

test("guards: TORUS_GUARDS=0 and TORUS_MAX_TOOL_OUTPUT both beat config (env wins)", () => {
	setConfig({ guards: { enabled: true, maxToolOutput: 40000 } });
	// both knobs are read at registration time, so register under the env
	const disabled = withEnv("TORUS_GUARDS", "0", () => guardToolResultHandlers());
	assert.equal(disabled.size, 0, "env GUARDS=0 must skip registration despite config enabled:true");

	const envCapped = withEnv("TORUS_MAX_TOOL_OUTPUT", "1000", () => guardToolResultHandlers());
	assert.match(
		guardTruncation(envCapped)?.content?.[0]?.text ?? "",
		/truncated \d+ bytes/,
		"env cap must beat the 40000 config cap",
	);

	const configCapped = guardToolResultHandlers();
	assert.equal(
		guardTruncation(configCapped),
		undefined,
		"registration without env honors the 40000 config cap instead",
	);
	clearConfig();
});

test("guards: config guards.enabled=false skips registration with no env", () => {
	setConfig({ guards: { enabled: false } });
	const handlers = guardToolResultHandlers();
	assert.equal(handlers.size, 0, "config enabled:false must disable the whole extension");
	clearConfig();
});

const TOAST = {
	summary: "torus knobs probe",
	body: "b",
	urgency: "low",
	expireMs: 6000,
	transient: true,
};

test("osnotify: config notify.enabled=false skips the spawn; env TORUS_NOTIFY=0 beats enabled:true", async () => {
	clearConfig();
	// osNotify reads the knob before its first await, so capturing the
	// promise inside the env scope tests exactly that env state.
	let pending = withoutEnv("TORUS_NOTIFY", () => osnotify.osNotify(TOAST));
	assert.equal(await pending, 7, "baseline: shim answers with a chain id");
	assert.equal(existsSync(CALLS), true, "baseline: the spawn reached the shim");

	const callsBefore = withoutEnv("TORUS_NOTIFY", () => readFileSync(CALLS, "utf8")).split(
		"\n",
	).length;
	setConfig({ notify: { enabled: false } });
	pending = withoutEnv("TORUS_NOTIFY", () => osnotify.osNotify(TOAST));
	assert.equal(await pending, null, "config enabled:false must return null");
	assert.equal(
		readFileSync(CALLS, "utf8").split("\n").length,
		callsBefore,
		"disabled knob must not spawn notify-send",
	);

	setConfig({ notify: { enabled: true } });
	pending = withEnv("TORUS_NOTIFY", "0", () => osnotify.osNotify(TOAST));
	assert.equal(await pending, null, "env 0 must beat config enabled:true");
	pending = withoutEnv("TORUS_NOTIFY", () => osnotify.osNotify(TOAST));
	assert.equal(await pending, 7, "config enabled:true toasts again once env clears");
	clearConfig();
});

test("knobs: user config beats project; project fills when user lacks the key; env beats both", () => {
	const user = { ui: { banner: true } };
	const project = { ui: { banner: false } };
	assert.equal(
		knobBoolean("TORUS_KNOB_PROJ_TEST", "ui", "banner", true, undefined, user, project),
		true,
		"user wins over project",
	);
	assert.equal(
		knobBoolean("TORUS_KNOB_PROJ_TEST", "ui", "banner", true, undefined, {}, project),
		false,
		"project fills when user lacks the key",
	);
	assert.equal(
		knobBoolean("TORUS_KNOB_PROJ_TEST", "ui", "banner", true, undefined, {}, {}),
		true,
		"default when neither sets it",
	);
	try {
		process.env.TORUS_KNOB_PROJ_TEST = "false";
		assert.equal(
			knobBoolean("TORUS_KNOB_PROJ_TEST", "ui", "banner", true, undefined, user, project),
			false,
			"env beats both tiers",
		);
	} finally {
		delete process.env.TORUS_KNOB_PROJ_TEST;
	}
	assert.equal(
		knobBoolean(
			"TORUS_KNOB_PROJ_TEST",
			"ui",
			"banner",
			true,
			undefined,
			{},
			{ ui: { banner: "nope" } },
		),
		true,
		"wrong-typed project value ignored",
	);
});

test("knobs: the project tier reads <cwd>/.torus/config.json live", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-knobs-proj-"));
	const prev = process.cwd();
	try {
		mkdirSync(path.join(dir, ".torus"), { recursive: true });
		writeFileSync(
			path.join(dir, ".torus", "config.json"),
			JSON.stringify({ guards: { maxToolOutput: 4321 } }),
		);
		process.chdir(dir);
		assert.equal(knobNumber("TORUS_KNOB_PROJ_TEST_N", "guards", "maxToolOutput", 16000), 4321);
	} finally {
		process.chdir(prev);
		rmSync(dir, { recursive: true, force: true });
	}
});
