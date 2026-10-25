import assert from "node:assert/strict";
import {
	existsSync,
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

const home = mkdtempSync(path.join(tmpdir(), "torus-automode-wiring-"));
process.env.TORUS_HOME = home;
delete process.env.TORUS_PERMISSION_MODE;
delete process.env.TORUS_PERMISSION_MODEL;

const automode = await import("../extensions/automode/index.ts");

// fsutil (pulled in by the ui import chain) recomputes TORUS_STATE_DIR from
// the cwd on every call and mirrors it into the env — still under the fake
// TORUS_HOME, but the exact dir is only knowable after the import settles, so
// pinning a value up top cannot stick. Audit rows follow the live env value;
// mirror auditPath's resolution instead.
const auditLogPath = process.env.TORUS_STATE_DIR
	? path.join(process.env.TORUS_STATE_DIR, "automode.log")
	: path.join(home, "automode.log");
const configFilePath = path.join(home, "config.json");

function auditRows() {
	if (!existsSync(auditLogPath)) return [];
	return readFileSync(auditLogPath, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

function resetAudit() {
	rmSync(auditLogPath, { force: true });
}

function setConfig(config) {
	if (config === undefined) rmSync(configFilePath, { force: true });
	else writeFileSync(configFilePath, JSON.stringify(config));
}

function setMode(value) {
	if (value === undefined) delete process.env.TORUS_PERMISSION_MODE;
	else process.env.TORUS_PERMISSION_MODE = value;
}

/** Registry stub with no classifier; chat replies drive the decision model. */
function registryStub(replies) {
	const pending = [...replies];
	const calls = { complete: 0, classify: 0 };
	const contexts = [];
	return {
		calls,
		contexts,
		getAvailableOfType: async () => [],
		getModelOfType: () => undefined,
		find: () => undefined,
		hasConfiguredAuth: () => false,
		classify: async () => {
			calls.classify += 1;
			throw new Error("no classifier in stub");
		},
		complete: async (_model, context) => {
			calls.complete += 1;
			contexts.push(context);
			return { stopReason: "stop", content: [{ type: "text", text: pending.shift() ?? "junk" }] };
		},
	};
}

const jsonReply = (verdict, reason = "stub reason") =>
	JSON.stringify({ verdict, confidence: 0.9, reason });

const sessionModel = { provider: "test", id: "chat-1" };

function makePi() {
	const handlers = {};
	const commands = {};
	return {
		handlers,
		commands,
		on: (name, fn) => {
			handlers[name] = fn;
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
	};
}

/**
 * Fresh wired extension instance: per-scenario env, rules file, dialog answer,
 * and chat replies. State lives inside the factory closure, so instances never
 * share rules, cache, or breaker state.
 */
function setup(options = {}) {
	const mode = "mode" in options ? options.mode : "1";
	setMode(mode);
	setConfig(options.config);
	const pi = makePi();
	automode.default(pi);
	const reg = registryStub(options.replies ?? []);
	const notifications = [];
	const dialog = { calls: [] };
	const ctx = {
		hasUI: options.hasUI ?? false,
		ui: {
			notify: (message, type) => {
				notifications.push({ message, type });
			},
			select: async (title, choices) => {
				dialog.calls.push({ title, options: choices });
				return options.answer;
			},
			setStatus: () => {},
		},
		modelRegistry: reg,
		model: sessionModel,
		cwd: options.cwd ?? "/tmp/project",
		signal: undefined,
	};
	return { pi, ctx, notifications, reg, dialog };
}

const bashCall = (command, id = "call-1") => ({
	type: "tool_call",
	toolName: "bash",
	toolCallId: id,
	input: { command, excludeFromContext: false, cwd: "/tmp/project" },
});

const bashResult = (id, text = "done") => ({
	type: "tool_result",
	toolName: "bash",
	toolCallId: id,
	input: { command: "x" },
	content: [{ type: "text", text }],
	isError: false,
});

const call = (pi, ctx, command, id) => pi.handlers.tool_call(bashCall(command, id), ctx);

test("default mode: every command passes with no audit rows and no prompts", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: undefined });
	for (const command of ["rm -rf /", "sudo id", "ls -la", "cargo build"]) {
		assert.equal(await call(pi, ctx, command), undefined, command);
	}
	assert.equal(auditRows().length, 0);
	assert.equal(notifications.length, 0, "default mode prompts nothing");
});

test("auto mode: deny rule blocks with the rule named in the reason and one audit row", async () => {
	resetAudit();
	const { pi, ctx } = setup({ config: { automode: { deny: ["rm *"] } } });
	const result = await call(pi, ctx, "rm -rf build");
	assert.deepEqual(result, {
		block: true,
		reason:
			'automode: denied by rule "rm *" — edit the automode section of ~/.torus/config.json to change',
	});
	const rows = auditRows();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].mode, "auto");
	assert.equal(rows[0].source, "rule");
	assert.equal(rows[0].verdict, "deny");
	assert.equal(rows[0].reason, 'denied by rule "rm *"');
	assert.equal(rows[0].command, "rm -rf build");
	assert.equal(typeof rows[0].ts, "number");
});

test("auto mode: ask rule headless blocks with the no-UI reason", async () => {
	resetAudit();
	const { pi, ctx } = setup({ config: { automode: { ask: ["git push *"] } }, hasUI: false });
	const result = await call(pi, ctx, "git push origin main");
	assert.equal(result.block, true);
	assert.match(result.reason, /ask rule "git push \*"/);
	assert.match(result.reason, /no UI for approval/);
	assert.match(result.reason, /TORUS_PERMISSION_MODE=default/);
	const rows = auditRows();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, "dialog");
	assert.equal(rows[0].verdict, "deny");
});

test("auto mode with UI: dialog deny blocks, allow once passes without caching", async () => {
	resetAudit();
	const denied = setup({
		config: { automode: { ask: ["git push *"] } },
		hasUI: true,
		answer: "Deny",
	});
	assert.deepEqual(await call(denied.pi, denied.ctx, "git push origin main"), {
		block: true,
		reason: "automode: denied by user",
	});
	assert.equal(denied.dialog.calls.length, 1);
	assert.match(denied.dialog.calls[0].title, /git push origin main/);
	assert.deepEqual(denied.dialog.calls[0].options, ["Allow once", "Always this session", "Deny"]);

	resetAudit();
	const once = setup({
		config: { automode: { ask: ["git push *"] } },
		hasUI: true,
		answer: "Allow once",
	});
	assert.equal(await call(once.pi, once.ctx, "git push origin main"), undefined);
	assert.equal(await call(once.pi, once.ctx, "git push origin main"), undefined);
	assert.equal(once.dialog.calls.length, 2, "Allow once does not seed the cache");
	assert.deepEqual(
		auditRows().map((row) => row.source),
		["dialog", "dialog"],
	);
});

test("auto mode with UI: Always this session caches; repeat passes via cache with no dialog", async () => {
	resetAudit();
	const { pi, ctx, dialog } = setup({
		hasUI: true,
		answer: "Always this session",
		replies: [jsonReply("ask")],
	});
	assert.equal(await call(pi, ctx, "cargo build"), undefined);
	ctx.ui.select = async () => {
		throw new Error("cached allow must not re-open a dialog");
	};
	assert.equal(await call(pi, ctx, "cargo build"), undefined);
	assert.equal(dialog.calls.length, 1);
	assert.deepEqual(
		auditRows().map((row) => [row.source, row.verdict]),
		[
			["model", "ask"],
			["dialog", "allow"],
			["cache", "allow"],
		],
	);
});

test("ask floor fail-safe: judge unavailable restores the ask for floored commands", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({ config: { automode: { allow: ["sudo *"] } }, hasUI: false });
	const result = await call(pi, ctx, "sudo id");
	assert.equal(result.block, true, "allow rule must not bypass the floor");
	assert.match(result.reason, /ask floor \(judge unavailable\)/);
	assert.match(result.reason, /sudo\/su/);
	assert.match(result.reason, /no UI for approval/);
	assert.equal(reg.calls.complete, 1, "the judge was tried before falling back to asking");
	assert.deepEqual(
		auditRows().map((row) => row.source),
		["failopen", "dialog"],
		"one row for the failed judgment, one for the ask",
	);
	assert.match(auditRows()[0].reason, /\[floor: privilege escalation via sudo\/su\]/);
});

test("ask floor: the judge decides floored commands; an allow rule never shortcuts them", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({
		config: { automode: { allow: ["sudo *"] } },
		replies: [jsonReply("allow")],
	});
	assert.equal(await call(pi, ctx, "sudo id"), undefined, "judge allow runs the command");
	assert.equal(reg.calls.complete, 1, "the judge was consulted despite the allow rule");
	const prompt = reg.contexts[0]?.systemPrompt ?? "";
	assert.match(prompt, /Critical operation floor/, "the floor class rides into the prompt");
	assert.match(prompt, /privilege escalation via sudo\/su/);
	const rows = auditRows();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, "model");
	assert.match(rows[0].reason, /\[floor: privilege escalation via sudo\/su\]/);
});

test("ask floor: a judge deny blocks the floored command with the class tagged", async () => {
	resetAudit();
	const { pi, ctx } = setup({ replies: [jsonReply("deny")] });
	const result = await call(pi, ctx, "git push --force origin main");
	assert.equal(result.block, true);
	assert.match(result.reason, /decision model denied/);
	assert.match(auditRows()[0].reason, /\[floor: git push --force\]/);
});

test("ask floor: an ask rule outranks the judge for floored commands", async () => {
	resetAudit();
	const { pi, ctx, reg, dialog } = setup({
		config: { automode: { ask: ["sudo *"] } },
		replies: [jsonReply("allow")],
		hasUI: true,
		answer: "Deny",
	});
	const result = await call(pi, ctx, "sudo id");
	assert.equal(result.block, true, "the ask rule dialog decides, not the judge");
	assert.equal(reg.calls.complete, 0, "the judge is never called when an ask rule matches");
	assert.equal(dialog.calls.length, 1);
});

test("sub-shells are judged like any other command, not floored", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({ replies: [jsonReply("deny")] });
	const result = await call(pi, ctx, "echo $(date)");
	assert.equal(result.block, true, "the judge denied it — proving it was judged, not floored");
	assert.equal(reg.calls.complete, 1);
	assert.doesNotMatch(
		reg.contexts[0]?.systemPrompt ?? "",
		/Critical operation floor/,
		"no floor block for a plain substitution",
	);
	assert.doesNotMatch(auditRows()[0].reason, /\[floor:/);
});

test("fast path: read-only command passes with an audit row and no model call", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({});
	assert.equal(await call(pi, ctx, "ls -la"), undefined);
	assert.equal(reg.calls.complete, 0, "no chat call");
	assert.equal(reg.calls.classify, 0, "no classifier call");
	assert.deepEqual(
		auditRows().map((row) => [row.source, row.verdict, row.command]),
		[["fastpath", "allow", "ls -la"]],
	);
});

test("failopen: both model paths fail, command runs with a notify and a result annotation", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ replies: ["junk not json"] });
	assert.equal(await call(pi, ctx, "cargo build", "call-77"), undefined);
	assert.ok(
		notifications.some((n) => n.message.includes("ran unjudged")),
		"failopen notifies",
	);
	const rows = auditRows();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, "failopen");
	assert.equal(rows[0].verdict, "failopen");
	assert.equal(typeof rows[0].ms, "number");

	const annotated = pi.handlers.tool_result(bashResult("call-77", "build ok"), ctx);
	assert.ok(annotated, "result is rewritten");
	assert.match(
		annotated.content[0].text,
		/\[automode\] ran unjudged \(decision model unavailable: .+\) — treat with care/,
	);
	assert.ok(annotated.content[0].text.startsWith("build ok"));
	assert.equal(pi.handlers.tool_result(bashResult("call-other"), ctx), undefined);
});

test("circuit breaker: three consecutive model denies make the fourth command a dialog", async () => {
	resetAudit();
	const { pi, ctx, notifications, reg } = setup({
		replies: [jsonReply("deny"), jsonReply("deny"), jsonReply("deny")],
	});
	const denied = ["cargo build", "make -j4", "npm install left-pad"];
	for (const [index, command] of denied.entries()) {
		const result = await call(pi, ctx, command, `deny-${index}`);
		assert.equal(result.block, true, command);
		assert.match(result.reason, /decision model denied/);
	}
	assert.equal(reg.calls.complete, 3);
	assert.ok(
		notifications.some((n) => n.message.includes("3 consecutive denies")),
		"breaker trip notifies",
	);
	const fourth = await call(pi, ctx, "go test ./...", "deny-3");
	assert.equal(reg.calls.complete, 3, "fourth command never reaches the model");
	assert.equal(fourth.block, true);
	assert.match(fourth.reason, /circuit breaker: repeated denies/);
	assert.match(fourth.reason, /no UI for approval/);
});

test("broad allow entry warns and is ignored: the command still reaches the model", async () => {
	resetAudit();
	const { pi, ctx, notifications, reg } = setup({
		config: { automode: { allow: ["*"] } },
		replies: [jsonReply("deny")],
	});
	const result = await call(pi, ctx, "cargo build");
	assert.equal(result.block, true, "broad entry does not allow-list the command");
	assert.match(result.reason, /decision model denied/);
	assert.equal(reg.calls.complete, 1, "command was judged by the model");
	assert.ok(
		notifications.some((n) => n.message.includes("broad allow") && n.type === "warning"),
		"broad-allow warning surfaces",
	);
});

test("/automode: status shows mode and rules path; toggles clear the cache and reset state", async () => {
	resetAudit();
	const idle = setup({ mode: undefined });
	await idle.pi.commands.automode.handler("", idle.ctx);
	const status = idle.notifications[idle.notifications.length - 1].message;
	assert.match(status, /mode: default/);
	assert.ok(status.includes(configFilePath), "status names the config path");
	assert.match(status, /cache: 0/);

	const active = setup({ hasUI: true, answer: "Always this session", replies: [jsonReply("ask")] });
	await active.pi.commands.automode.handler("", active.ctx);
	assert.equal(await call(active.pi, active.ctx, "cargo build"), undefined);
	await active.pi.commands.automode.handler("", active.ctx);
	const cached = active.notifications[active.notifications.length - 1].message;
	assert.match(cached, /mode: auto/);
	assert.match(cached, /cache: 1/);

	await active.pi.commands.automode.handler("default", active.ctx);
	assert.match(
		active.notifications[active.notifications.length - 1].message,
		/session mode set to default/,
	);
	await active.pi.commands.automode.handler("auto", active.ctx);
	await active.pi.commands.automode.handler("", active.ctx);
	const after = active.notifications[active.notifications.length - 1].message;
	assert.match(after, /mode: auto/);
	assert.match(after, /cache: 0/, "toggling clears the cache");
	assert.match(after, /circuit breaker: off/);

	await active.pi.commands.automode.handler("banana", active.ctx);
	assert.match(active.notifications[active.notifications.length - 1].message, /usage: \/automode/);
});

test("startup notice: auto mode announces on once, naming the session model and rules path", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({});
	await pi.handlers.session_start({ type: "session_start" }, ctx);
	const on = notifications.filter((n) => n.message.startsWith("automode: on"));
	assert.equal(on.length, 1, "notice fires once at startup");
	assert.match(on[0].message, /bash calls auto-approved by session model/);
	assert.ok(on[0].message.includes(configFilePath), "notice names the config path");
	assert.equal(on[0].type, "info");
	await call(pi, ctx, "ls -la");
	assert.equal(
		notifications.filter((n) => n.message.startsWith("automode: on")).length,
		1,
		"not repeated on later calls",
	);
});

test("statusline chip tracks session mode and breaker degradation", async () => {
	const ui = await import("../extensions/ui/index.ts");
	const segment = () => ui.buildStatus().split(" · ");
	resetAudit();
	const { pi, ctx } = setup({
		mode: "1",
		hasUI: true,
		replies: [jsonReply("deny"), jsonReply("deny"), jsonReply("deny")],
	});
	await call(pi, ctx, "ls /tmp", "chip-0");
	assert.ok(segment().includes("auto"), "auto mode paints the chip");
	const denied = ["cargo build", "make -j4", "npm install left-pad"];
	for (const [index, command] of denied.entries()) {
		await call(pi, ctx, command, `chip-deny-${index}`);
	}
	assert.ok(segment().includes("auto·ask"), "breaker degradation repaints the chip");
	await pi.commands.automode.handler("default", ctx);
	assert.ok(!segment().some((s) => s === "auto" || s === "auto·ask"), "default drops the chip");
	await pi.commands.automode.handler("auto", ctx);
	assert.ok(segment().includes("auto"), "auto repaints the chip");
});

test("classifyAllShell: allow rules suspend, the model judges instead", async () => {
	resetAudit();
	const suspended = setup({
		config: { automode: { allow: ["cargo *"], classifyAllShell: true } },
		replies: [jsonReply("ask")],
	});
	const asked = await call(suspended.pi, suspended.ctx, "cargo build", "cas-1");
	assert.equal(suspended.reg.calls.complete, 1, "allow match reaches the model");
	assert.equal(asked.block, true);
	assert.match(asked.reason, /no UI for approval/);

	resetAudit();
	const normal = setup({
		config: { automode: { allow: ["cargo *"] } },
		replies: [jsonReply("ask")],
	});
	const passed = await call(normal.pi, normal.ctx, "cargo build", "cas-2");
	assert.equal(passed, undefined);
	assert.equal(
		normal.reg.calls.complete,
		0,
		"without the flag the allow rule passes with no model call",
	);
});

test("/automode prints the effective config including v2 keys", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({
		config: {
			automode: {
				allow: ["cargo *"],
				environment: ["Source control: github.example.com/acme"],
				hardDeny: ["no secrets leave the machine"],
				classifyAllShell: true,
			},
		},
	});
	await call(pi, ctx, "ls /tmp", "status-1");
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /cargo \*/);
	assert.match(status, /Source control: github\.example\.com\/acme/);
	assert.match(status, /no secrets leave the machine/);
	assert.match(status, /classifyAllShell: on/);
});

test("/automode status names the fast-chain judge, matching the on-notice", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: "1" });
	// No classifier available; the fast chain's first entry resolves with auth,
	// so the chat fallback judges with it before the session model is ever used.
	const flash = { provider: "zai", id: "glm-5.3-flash" };
	ctx.modelRegistry = {
		getAvailableOfType: async () => [],
		getModelOfType: () => undefined,
		find: (provider, id) => (provider === "zai" && id === "glm-5.3-flash" ? flash : undefined),
		hasConfiguredAuth: () => true,
		classify: async () => {
			throw new Error("no classifier in stub");
		},
		complete: async () => ({
			stopReason: "stop",
			content: [{ type: "text", text: jsonReply("allow") }],
		}),
	};
	await call(pi, ctx, "ls /tmp", "status-fast");
	const on = notifications.find((n) => n.message.startsWith("automode: on"));
	assert.ok(on, "on-notice fired");
	assert.ok(on.message.includes("fast chain (zai/glm-5.3-flash)"), on.message);
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /decision model: fast chain \(zai\/glm-5\.3-flash\)/);
});

test("config.json automode section governs: rules load from config, surfaces and hints name it", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ config: { automode: { deny: ["sudo *"] } } });
	const result = await call(pi, ctx, "sudo id");
	assert.equal(result.block, true, "config deny rule blocks sudo");
	assert.equal(
		result.reason,
		'automode: denied by rule "sudo *" — edit the automode section of ~/.torus/config.json to change',
	);
	const on = notifications.filter((n) => n.message.startsWith("automode: on"));
	assert.equal(on.length, 1);
	assert.ok(on[0].message.includes(configFilePath), "notice still names the config path");
	assert.ok(on[0].message.includes("(from config.json)"), "notice names the config source");
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.ok(status.includes(configFilePath), "status still names the config path");
	assert.ok(status.includes("(from config.json)"), "status names the config source");
	assert.match(status, /deny: sudo \*/);
});

test("mode precedence: env auto beats a config default value; status says from env", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: "1", config: { permissionMode: "default" } });
	await call(pi, ctx, "ls -la");
	assert.ok(
		notifications.some((n) => n.message.startsWith("automode: on")),
		"env auto wins the tier",
	);
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: auto \(from env\)/);
});

test("mode precedence: env default beats a config auto value — default mode, no notice", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: "default", config: { permissionMode: "auto" } });
	await call(pi, ctx, "rm -rf /");
	assert.equal(notifications.length, 0, "default mode never announces on");
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: default \(from env\)/);
});

test("mode precedence: config auto with env unset starts auto; status says from config", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: undefined, config: { permissionMode: "auto" } });
	await call(pi, ctx, "ls -la");
	const on = notifications.filter((n) => n.message.startsWith("automode: on"));
	assert.equal(on.length, 1, "config-sourced auto announces on once");
	assert.ok(on[0].message.includes("(from config)"), "notice names the config source");
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: auto \(from config\)/);
});

test("mode precedence: both tiers unset stays default; status says from default", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: undefined, config: undefined });
	await call(pi, ctx, "rm -rf /");
	assert.equal(notifications.length, 0, "default mode notifies nothing");
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: default \(from default\)/);
});

test("mode precedence: env junk beats a config auto value — default mode with the env warning", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: "yolo", config: { permissionMode: "auto" } });
	await call(pi, ctx, "rm -rf /");
	assert.ok(
		!notifications.some((n) => n.message.startsWith("automode: on")),
		"junk env never starts auto, not even via config",
	);
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: default/);
	assert.match(status, /warning: TORUS_PERMISSION_MODE=yolo is not recognized/);
});

test("mode precedence: config junk with env unset is default with a warning naming the value", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({
		mode: undefined,
		config: { permissionMode: "sometimes" },
	});
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: default/);
	assert.match(status, /warning: permissionMode="sometimes" is not recognized/);
	assert.ok(
		!notifications.some((n) => n.message.startsWith("automode: on")),
		"junk config value never starts auto",
	);
});

test("mode precedence: non-string config permissionMode is junk-warned default", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ mode: undefined, config: { permissionMode: 3 } });
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: default/);
	assert.match(status, /warning: permissionMode=3 is not recognized/);
});

test("/automode denied lists recent denials from the audit log", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ config: { automode: { deny: ["make *"] } } });
	await call(pi, ctx, "make -j4", "denied-1");
	await pi.commands.automode.handler("denied", ctx);
	const denied = notifications.map((n) => n.message).find((m) => m.includes("recent denials"));
	assert.ok(denied, "denied notify fired");
	assert.match(denied, /rule/);
	assert.match(denied, /make -j4/);
	assert.match(denied, /denied by rule/);
});

const messageStart = (content) => ({
	type: "message_start",
	message: { role: "user", content, timestamp: 0 },
});
const userSays = (pi, ctx, text) =>
	pi.handlers.message_start(messageStart([{ type: "text", text }]), ctx);

test("intent window: user messages ride the judge guidance; non-user text never lands", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({ replies: [jsonReply("allow")] });
	userSays(pi, ctx, "run the migration with psql directly");
	pi.handlers.message_start(
		{
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "rm -rf everything" }] },
		},
		ctx,
	);
	pi.handlers.message_start(
		{ type: "message_start", message: { role: "user", content: [{ type: "text", text: "   " }] } },
		ctx,
	);
	pi.handlers.message_start(messageStart("plain string content also counts"), ctx);
	assert.equal(await call(pi, ctx, "psql -f migrate.sql", "iw-1"), undefined);
	const prompt = reg.contexts[0].systemPrompt;
	assert.match(prompt, /Recent user intent/);
	assert.match(prompt, /run the migration with psql directly/);
	assert.match(prompt, /plain string content also counts/);
	assert.ok(!prompt.includes("rm -rf everything"), "assistant text never enters the window");
	assert.ok(!prompt.includes("   "), "blank text blocks are skipped");
});

test("intent window: any dialog clears it; the next guidance carries no intent block", async () => {
	resetAudit();
	const { pi, ctx, reg, dialog } = setup({
		hasUI: true,
		answer: "Allow once",
		replies: [jsonReply("ask"), jsonReply("allow")],
	});
	userSays(pi, ctx, "run the migration with psql directly");
	await call(pi, ctx, "psql -f migrate.sql", "dlg-1");
	assert.match(reg.contexts[0].systemPrompt, /run the migration with psql directly/);
	assert.equal(dialog.calls.length, 1, "the model ask opened a dialog");
	await call(pi, ctx, "cargo build", "dlg-2");
	assert.equal(reg.calls.complete, 2);
	assert.ok(
		!reg.contexts[1].systemPrompt.includes("Recent user intent ("),
		"the dialog cleared the window",
	);
});

test("intent window: a model allow keeps the intent for the next command", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({ replies: [jsonReply("allow"), jsonReply("allow")] });
	userSays(pi, ctx, "run the migration with psql directly");
	assert.equal(await call(pi, ctx, "psql -f migrate.sql", "keep-1"), undefined);
	await call(pi, ctx, "cargo build", "keep-2");
	assert.match(reg.contexts[1].systemPrompt, /Recent user intent/);
	assert.match(reg.contexts[1].systemPrompt, /run the migration with psql directly/);
});

test("intent window: a model deny clears it", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({ replies: [jsonReply("deny"), jsonReply("allow")] });
	userSays(pi, ctx, "run the migration with psql directly");
	const denied = await call(pi, ctx, "psql -f migrate.sql", "mdeny-1");
	assert.equal(denied.block, true);
	assert.match(denied.reason, /decision model denied/);
	await call(pi, ctx, "cargo build", "mdeny-2");
	assert.ok(
		!reg.contexts[1].systemPrompt.includes("Recent user intent ("),
		"the model deny cleared the window",
	);
});

test("intent window: a rule deny clears it", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({
		config: { automode: { deny: ["rm *"] } },
		replies: [jsonReply("allow")],
	});
	userSays(pi, ctx, "delete the build directory");
	const denied = await call(pi, ctx, "rm -rf build", "rdeny-1");
	assert.equal(denied.block, true);
	assert.match(denied.reason, /denied by rule/);
	await call(pi, ctx, "cargo build", "rdeny-2");
	assert.ok(
		!reg.contexts[0].systemPrompt.includes("Recent user intent ("),
		"the rule deny cleared the window",
	);
});

test("intent window: the /automode mode toggle clears it", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({ replies: [jsonReply("allow")] });
	userSays(pi, ctx, "run the migration with psql directly");
	await pi.commands.automode.handler("auto", ctx);
	await call(pi, ctx, "cargo build", "tog-1");
	assert.ok(
		!reg.contexts[0].systemPrompt.includes("Recent user intent ("),
		"the toggle cleared the window",
	);
});

test("softDeny tier: psql migrations ride the guidance to the judge; scripted replies prove the judge enforces the tier", async () => {
	resetAudit();
	const denied = setup({
		config: {
			automode: {
				softDeny: ["never run database migrations outside the CLI"],
				softDenyExceptions: ["psql run by the deploy wrapper"],
			},
		},
		replies: [jsonReply("deny", "soft boundary: migration outside the CLI")],
	});
	const blocked = await call(denied.pi, denied.ctx, "psql -f migrate.sql", "sd-1");
	assert.equal(blocked.block, true, "the scripted judge denies the soft boundary");
	assert.match(
		blocked.reason,
		/decision model denied/,
		"the tier is judged by the model, not by rules",
	);
	const deniedPrompt = denied.reg.contexts[0].systemPrompt;
	assert.match(deniedPrompt, /Soft boundaries/);
	assert.match(deniedPrompt, /never run database migrations outside the CLI/);
	assert.match(deniedPrompt, /Soft-boundary exceptions/);
	assert.match(deniedPrompt, /psql run by the deploy wrapper/);
	assert.ok(!deniedPrompt.includes("Recent user intent ("), "no intent buffered yet");

	resetAudit();
	const allowed = setup({
		config: { automode: { softDeny: ["never run database migrations outside the CLI"] } },
		replies: [jsonReply("allow", "the intent names the exact migration command")],
	});
	userSays(allowed.pi, allowed.ctx, "run the migration with psql directly");
	assert.equal(await call(allowed.pi, allowed.ctx, "psql -f migrate.sql", "sd-2"), undefined);
	const allowedPrompt = allowed.reg.contexts[0].systemPrompt;
	assert.match(allowedPrompt, /Soft boundaries/);
	assert.match(allowedPrompt, /Recent user intent/);
	assert.match(allowedPrompt, /run the migration with psql directly/);
});

const projectDir = mkdtempSync(path.join(tmpdir(), "torus-automode-wizard-"));
const gitConfigPath = path.join(projectDir, ".git", "config");
const { appendAuditRow } = await import("../extensions/automode/config.ts");

function seedGitConfig(...urls) {
	mkdirSync(path.dirname(gitConfigPath), { recursive: true });
	const lines = ["[core]", "\tbare = false"];
	for (const [index, url] of urls.entries()) {
		lines.push(`[remote "r${index}"]`, `\turl = ${url}`, "\tfetch = +refs/heads/*:refs/remotes/*");
	}
	writeFileSync(gitConfigPath, `${lines.join("\n")}\n`);
}

function clearGitConfig() {
	rmSync(path.dirname(gitConfigPath), { recursive: true, force: true });
}

const denyRow = (command) => ({
	ts: Date.now(),
	mode: "auto",
	source: "model",
	verdict: "deny",
	reason: "stub deny",
	command,
});

/** Scripted wizard/dialog answers: each ui.select call pops the next one. */
function scriptSelects(dialog, answers) {
	return async (title, choices) => {
		dialog.calls.push({ title, options: choices });
		return answers[dialog.calls.length - 1];
	};
}

test("/automode setup headless: prints the draft and never writes", async () => {
	resetAudit();
	seedGitConfig("git@github.com:tankdonut/torus.git", "https://github.com/tankdonut/torus");
	appendAuditRow(denyRow("git push origin main"));
	appendAuditRow(denyRow("git push --force origin"));
	appendAuditRow(denyRow("cargo build"));
	setConfig(undefined);
	const { pi, ctx, notifications } = setup({ mode: undefined });
	ctx.cwd = projectDir;
	await pi.commands.automode.handler("setup", ctx);
	const draft = notifications
		.map((n) => n.message)
		.find((m) => m.startsWith("automode setup draft:"));
	assert.ok(draft, "draft notify fired");
	assert.ok(draft.includes("Source control: github.com/tankdonut"), "remote line exact");
	assert.equal(
		draft.split("Source control: github.com/tankdonut").length - 1,
		1,
		"both url forms dedupe to one line",
	);
	assert.ok(draft.includes("git push *"), "repeated same-prefix denies suggest an ask entry");
	assert.ok(!draft.includes("cargo *"), "a single deny does not suggest");
	assert.match(draft, /rerun in an interactive session to write/);
	assert.equal(existsSync(configFilePath), false, "headless never writes");
});

test("buildSetupDraft: url forms, unparseable urls, and kept entries", () => {
	seedGitConfig(
		"git@github.com:tankdonut/torus.git",
		"https://github.com/tankdonut/torus",
		"ssh://git@gitlab.example.com:2222/acme/monorepo.git",
		"/srv/local/repo",
		"C:\\repos\\x",
		"https://only-host/",
	);
	const draft = automode.buildSetupDraft(projectDir, [], { rules: {}, source: "default" });
	assert.deepEqual(draft.environment, [
		"Source control: github.com/tankdonut",
		"Source control: gitlab.example.com/acme",
	]);

	const kept = automode.buildSetupDraft(
		projectDir,
		[denyRow("git push a"), denyRow("git push b")],
		{ rules: { deny: ["rm *"], ask: ["git push *"] }, source: "config.json" },
	);
	assert.equal(kept.ask, undefined, "an already-present ask entry is not re-suggested");
	assert.ok(kept.summary.some((line) => line.includes("keep (from config.json)")));
	assert.ok(kept.summary.some((line) => line.includes("deny: rm *")));

	clearGitConfig();
	const noGit = automode.buildSetupDraft(projectDir, [], { rules: {}, source: "default" });
	assert.equal(noGit.environment, undefined, "no .git means no remote lines");
	assert.ok(noGit.summary.some((line) => line.includes("nothing to add")));
});

test("/automode setup Write: unions into config.json, notifies the path, reloads the rules", async () => {
	resetAudit();
	seedGitConfig("https://github.com/tankdonut/torus.git");
	appendAuditRow(denyRow("git push origin main"));
	appendAuditRow(denyRow("git push --force"));
	const seeded = {
		chains: { default: "gpt" },
		automode: { environment: ["Source control: seeded"], deny: ["rm *"] },
	};
	const { pi, ctx, notifications, dialog, reg } = setup({
		mode: "1",
		hasUI: true,
		replies: [],
		config: seeded,
	});
	ctx.cwd = projectDir;
	ctx.ui.select = scriptSelects(dialog, ["Write", "Deny"]);
	// Pre-write the push family reaches the fail-open model path.
	assert.equal(await call(pi, ctx, "git push origin main", "w-pre"), undefined);
	assert.equal(reg.calls.complete, 1);
	await pi.commands.automode.handler("setup", ctx);
	assert.ok(dialog.calls[0].title.startsWith("automode setup draft:\n"));
	assert.ok(dialog.calls[0].title.includes("keep (from config.json)"), "kept entries listed");
	assert.deepEqual(dialog.calls[0].options, ["Write", "Show full draft", "Discard"]);
	const wrote = notifications.map((n) => n.message).find((m) => m.includes("wrote "));
	assert.ok(wrote.includes(configFilePath), "notify names the written path");
	assert.match(wrote, /reloads at next \/automode toggle or session start/);
	const onDisk = JSON.parse(readFileSync(configFilePath, "utf8"));
	assert.deepEqual(onDisk.chains, { default: "gpt" }, "other sections preserved");
	assert.deepEqual(
		onDisk.automode.environment,
		["Source control: seeded", "Source control: github.com/tankdonut"],
		"existing entries kept, draft appended",
	);
	assert.deepEqual(onDisk.automode.ask, ["git push *"]);
	assert.deepEqual(onDisk.automode.deny, ["rm *"], "keys absent from the draft untouched");
	// The reloaded rules apply immediately: the new ask rule dialogues before
	// any model call, and the kept deny still blocks, naming config.json.
	const blocked = await call(pi, ctx, "git push origin main", "w-post");
	assert.equal(reg.calls.complete, 1, "the ask rule fires before the model");
	assert.equal(blocked.block, true);
	assert.equal(blocked.reason, "automode: denied by user");
	assert.match(dialog.calls[1].title, /ask rule "git push \*" matched/);
	assert.ok(dialog.calls[1].title.includes("git push origin main"));
	const denied = await call(pi, ctx, "rm -rf build", "w-deny");
	assert.match(denied.reason, /denied by rule "rm \*"/);
	assert.match(denied.reason, /config\.json/, "the reload sourced rules from config.json");
});

test("/automode setup Discard: nothing written, file untouched", async () => {
	resetAudit();
	seedGitConfig("git@github.com:tankdonut/torus.git");
	appendAuditRow(denyRow("git push origin main"));
	appendAuditRow(denyRow("git push --force"));
	const { pi, ctx, notifications, dialog } = setup({
		mode: undefined,
		hasUI: true,
		answer: "Discard",
		config: { automode: { environment: ["Source control: seeded"] } },
	});
	const before = statSync(configFilePath);
	const beforeBytes = readFileSync(configFilePath, "utf8");
	ctx.cwd = projectDir;
	await pi.commands.automode.handler("setup", ctx);
	assert.equal(dialog.calls.length, 1);
	assert.deepEqual(dialog.calls[0].options, ["Write", "Show full draft", "Discard"]);
	assert.equal(readFileSync(configFilePath, "utf8"), beforeBytes, "content unchanged");
	assert.equal(statSync(configFilePath).mtimeMs, before.mtimeMs, "not even rewritten");
	assert.ok(notifications.some((n) => /discarded/.test(n.message)));
});

test("/automode setup Show full draft: notifies the full JSON and loops back to the select", async () => {
	resetAudit();
	seedGitConfig("git@github.com:tankdonut/torus.git");
	appendAuditRow(denyRow("cargo publish --dry-run"));
	setConfig(undefined);
	const { pi, ctx, notifications, dialog } = setup({ mode: undefined, hasUI: true });
	ctx.cwd = projectDir;
	ctx.ui.select = scriptSelects(dialog, ["Show full draft", "Discard"]);
	await pi.commands.automode.handler("setup", ctx);
	assert.equal(dialog.calls.length, 2, "the select re-opens after showing the draft");
	assert.ok(dialog.calls[1].title.startsWith("automode setup draft:\n"));
	const full = notifications
		.map((n) => n.message)
		.find((m) => m.startsWith("automode setup draft (full):"));
	assert.ok(full, "full-draft notify fired");
	assert.deepEqual(JSON.parse(full.slice("automode setup draft (full):\n".length)), {
		environment: ["Source control: github.com/tankdonut"],
	});
	assert.ok(
		notifications.some((n) => /discarded/.test(n.message)),
		"the loop still ends",
	);
});

test("/automode setup Write on a malformed config.json: error notify, bytes survive, no temp file", async () => {
	resetAudit();
	seedGitConfig("git@github.com:tankdonut/torus.git");
	appendAuditRow(denyRow("git push origin main"));
	appendAuditRow(denyRow("git push --force"));
	const { pi, ctx, notifications } = setup({ mode: undefined, hasUI: true, answer: "Write" });
	const bytes = "{not json";
	writeFileSync(configFilePath, bytes);
	ctx.cwd = projectDir;
	await pi.commands.automode.handler("setup", ctx);
	assert.equal(readFileSync(configFilePath, "utf8"), bytes, "bytes survive the refusal");
	const error = notifications.map((n) => n.message).find((m) => m.includes("not valid JSON"));
	assert.ok(error?.includes(configFilePath), "the error names the path");
	assert.ok(!notifications.some((n) => n.message.includes("wrote ")), "nothing was written");
	assert.deepEqual(
		readdirSync(home).filter((name) => name.endsWith(".tmp")),
		[],
		"no temp file left",
	);
});

test("project config: deny/ask union tightens; allow and other keys are refused", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "torus-proj-rules-"));
	mkdirSync(path.join(cwd, ".torus"), { recursive: true });
	writeFileSync(
		path.join(cwd, ".torus", "config.json"),
		JSON.stringify({ automode: { deny: ["make *"], allow: ["cargo *"], environment: ["x"] } }),
	);
	resetAudit();
	const { pi, ctx, notifications, reg } = setup({ cwd, replies: [jsonReply("ask")] });
	const blocked = await call(pi, ctx, "make -j4", "pr-1");
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /denied by rule "make \*"/);

	const judged = await call(pi, ctx, "cargo build", "pr-2");
	assert.equal(reg.calls.complete, 1, "a project allow entry does not bypass the model");
	assert.match(judged.reason ?? "", /no UI for approval/);

	assert.ok(
		notifications.some(
			(n) =>
				n.message.includes("may only tighten") &&
				n.message.includes("allow") &&
				n.message.includes("environment"),
		),
		"ignored-keys notice fired",
	);
	await pi.commands.automode.handler("", ctx);
	assert.ok(
		notifications.some((n) => n.message.includes("project .torus/config.json: +deny 1")),
		"status shows the project extras line",
	);
	rmSync(cwd, { recursive: true, force: true });
});

test("/automode setup apply: lands a reviewed draft, unions into config.json, reloads rules", async () => {
	resetAudit();
	const { pi, ctx, notifications, dialog } = setup({ mode: "1", hasUI: true, answer: "Write" });
	setConfig({ automode: { ask: ["git push *"] } });
	const drafts = mkdtempSync(path.join(tmpdir(), "torus-drafts-"));
	const file = path.join(drafts, "draft.json");
	writeFileSync(
		file,
		JSON.stringify({
			environment: ["Source control: github.com/acme/widgets"],
			ask: ["cargo publish *"],
		}),
	);
	await pi.commands.automode.handler(`setup apply ${file}`, ctx);
	assert.ok(dialog.calls.length > 0, "a confirm dialog ran");
	assert.match(dialog.calls[0].title, /add environment: Source control/);
	assert.ok(
		notifications.some((n) => n.message.includes("wrote ") && n.message.includes("config.json")),
		"the write is announced",
	);
	const onDisk = JSON.parse(readFileSync(configFilePath, "utf8"));
	assert.deepEqual(
		onDisk.automode.ask,
		["git push *", "cargo publish *"],
		"ask unions, dupes drop",
	);
	assert.deepEqual(onDisk.automode.environment, ["Source control: github.com/acme/widgets"]);

	await pi.commands.automode.handler("", ctx);
	const status = notifications[notifications.length - 1].message;
	assert.match(status, /environment: Source control: github\.com\/acme\/widgets/, "rules reloaded");
	rmSync(drafts, { recursive: true, force: true });
});

test("/automode setup apply: resolves a relative draft path against the session cwd", async () => {
	resetAudit();
	setConfig(undefined);
	const cwd = mkdtempSync(path.join(tmpdir(), "torus-apply-cwd-"));
	writeFileSync(path.join(cwd, "draft.json"), JSON.stringify({ ask: ["git push *"] }));
	const { pi, ctx, notifications } = setup({ cwd, hasUI: true, answer: "Write" });
	await pi.commands.automode.handler("setup apply draft.json", ctx);
	assert.ok(
		notifications.some((n) => n.message.includes("wrote ")),
		"relative path applied",
	);
	const onDisk = JSON.parse(readFileSync(configFilePath, "utf8"));
	assert.deepEqual(onDisk.automode.ask, ["git push *"]);
	rmSync(cwd, { recursive: true, force: true });
});

test("/automode setup apply: widening keys, junk arrays, and empty drafts are refused untouched", async () => {
	resetAudit();
	const { pi, ctx, notifications } = setup({ hasUI: true, answer: "Write" });
	setConfig({ automode: { ask: ["git push *"] } });
	const bytes = readFileSync(configFilePath, "utf8");
	const drafts = mkdtempSync(path.join(tmpdir(), "torus-drafts-"));
	const cases = [
		["widening.json", { allow: ["rm *"] }, /refused key\(s\) allow/],
		["harddeny.json", { hardDeny: ["curl *"] }, /refused key\(s\) hardDeny/],
		["junk.json", { ask: [42] }, /"ask" must be an array of non-empty strings/],
		[
			"empty-strings.json",
			{ environment: [""] },
			/"environment" must be an array of non-empty strings/,
		],
		["empty.json", {}, /no environment or ask entries to apply/],
		["not-json.json", "]{ not json", /not valid JSON/],
	];
	for (const [name, body] of cases) {
		writeFileSync(path.join(drafts, name), JSON.stringify(body));
	}
	writeFileSync(path.join(drafts, "not-json.json"), "]{ not json");
	for (const [name, , pattern] of cases) {
		notifications.length = 0;
		await pi.commands.automode.handler(`setup apply ${path.join(drafts, name)}`, ctx);
		assert.match(
			notifications[notifications.length - 1].message,
			pattern,
			`${name} refuses with the reason`,
		);
	}
	assert.equal(readFileSync(configFilePath, "utf8"), bytes, "config bytes survive every refusal");
	rmSync(drafts, { recursive: true, force: true });
});

test("/automode setup apply: headless prints the draft and writes nothing; missing file and bare usage warn", async () => {
	resetAudit();
	setConfig(undefined);
	const drafts = mkdtempSync(path.join(tmpdir(), "torus-drafts-"));
	const file = path.join(drafts, "draft.json");
	writeFileSync(file, JSON.stringify({ environment: ["Source control: github.com/acme/widgets"] }));

	const headless = setup({ hasUI: false });
	await headless.pi.commands.automode.handler(`setup apply ${file}`, headless.ctx);
	const printed = headless.notifications[headless.notifications.length - 1].message;
	assert.match(printed, /setup draft \(.*draft\.json\)/);
	assert.match(printed, /rerun in an interactive session to write/);
	assert.ok(!existsSync(configFilePath), "headless wrote nothing");

	const missing = setup({});
	await missing.pi.commands.automode.handler(
		`setup apply ${path.join(drafts, "nope.json")}`,
		missing.ctx,
	);
	assert.match(missing.notifications[missing.notifications.length - 1].message, /unreadable/);

	const bare = setup({});
	await bare.pi.commands.automode.handler("setup apply", bare.ctx);
	assert.match(
		bare.notifications[bare.notifications.length - 1].message,
		/usage: \/automode setup apply/,
	);

	const discard = setup({ hasUI: true, answer: "Discard" });
	await discard.pi.commands.automode.handler(`setup apply ${file}`, discard.ctx);
	assert.ok(
		discard.notifications.some((n) => n.message.includes("discarded; nothing written")),
		"discard leaves config untouched",
	);
	assert.ok(!existsSync(configFilePath), "no config after discard");
	rmSync(drafts, { recursive: true, force: true });
});

test("bypass mode: warns once, judges nothing, and cannot be switched mid-session", async () => {
	resetAudit();
	const { pi, ctx, notifications, reg } = setup({ mode: "bypass" });
	const result = await call(pi, ctx, "rm -rf /tmp/whatever");
	assert.equal(result, undefined, "nothing blocks in bypass mode");
	assert.equal(reg.calls.complete, 0, "no model call ever happens");
	assert.equal(reg.calls.classify, 0, "no classifier call ever happens");
	assert.equal(auditRows().length, 0, "no audit rows");
	const bypassNotice = notifications.find((n) => n.message.startsWith("automode: bypass"));
	assert.ok(bypassNotice, "bypass announce fired");
	assert.equal(bypassNotice.type, "warning");
	assert.ok(
		!notifications.some((n) => n.message.startsWith("automode: on")),
		"bypass never announces auto",
	);
	await pi.commands.automode.handler("auto", ctx);
	assert.ok(
		notifications.some((n) => n.message.includes("startup-only")),
		"switching out of bypass is refused as startup-only",
	);
	await pi.commands.automode.handler("", ctx);
	const status = notifications.map((n) => n.message).find((m) => m.includes("automode status"));
	assert.ok(status, "status notify fired");
	assert.match(status, /mode: bypass \(from env\)/);
	assert.match(status, /rules: .+ \(not loaded; bypass mode\)/);
});

test("config bypass is refused: default mode runs, the startup-only warning surfaces once", async () => {
	resetAudit();
	const { pi, ctx, notifications, reg } = setup({
		mode: undefined,
		config: { permissionMode: "bypass" },
	});
	const result = await call(pi, ctx, "rm -rf /tmp/whatever");
	assert.equal(result, undefined, "default mode passes unclassified");
	assert.equal(reg.calls.complete, 0, "no model call");
	assert.ok(
		!notifications.some((n) => n.message.startsWith("automode: on")),
		"refused bypass never starts auto",
	);
	assert.ok(
		!notifications.some((n) => n.message.startsWith("automode: bypass —")),
		"refused bypass never starts bypass either",
	);
	const warned = notifications.filter((n) => n.message.includes("startup-only"));
	assert.equal(warned.length, 1, "the refusal warning surfaces exactly once");
});

function fixtureRow(n, verdict = "allow") {
	return {
		ts: 1700000000000 + n,
		mode: "auto",
		source: `fixture-${n}`,
		verdict,
		reason: `fixture reason ${n} padded so each JSON line runs well past a hundred bytes and a few thousand rows clear the half-megabyte tail cap`,
		command: `echo fixture-row-${n}`,
	};
}

function writeAuditRows(rows) {
	writeFileSync(auditLogPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function fullParseDenials(limit) {
	return auditRows()
		.filter((row) => row.verdict === "deny")
		.slice(-limit);
}

test("recentDenialRows on an oversized log returns the same tail as a full parse", () => {
	resetAudit();
	const rows = [];
	for (let i = 0; i < 5000; i += 1) {
		rows.push(fixtureRow(i, i >= 3500 && i % 200 === 0 ? "deny" : "allow"));
	}
	rows.push(fixtureRow(5000, "deny"), fixtureRow(5001, "deny"), fixtureRow(5002, "deny"));
	writeAuditRows(rows);
	assert.ok(statSync(auditLogPath).size > 512 * 1024, "fixture log exceeds the 512KB tail cap");
	assert.equal(fullParseDenials(10).length, 10, "golden trims: eleven denials total");
	assert.deepEqual(automode.recentDenialRows(10), fullParseDenials(10), "tail read matches golden");
	assert.deepEqual(
		automode
			.recentDenialRows(Number.POSITIVE_INFINITY)
			.slice(-10)
			.map((row) => row.command),
		fullParseDenials(Number.POSITIVE_INFINITY)
			.slice(-10)
			.map((row) => row.command),
		"infinite limit still exposes the same recent tail as the handler's slice",
	);
	resetAudit();
});

test("recentDenialRows on a small log keeps today's full-read behavior", () => {
	resetAudit();
	writeAuditRows([fixtureRow(1, "deny"), fixtureRow(2), fixtureRow(3, "deny")]);
	assert.ok(statSync(auditLogPath).size <= 512 * 1024, "fixture stays under the tail cap");
	assert.deepEqual(automode.recentDenialRows(10), fullParseDenials(10));
	assert.deepEqual(
		automode.recentDenialRows(10).map((row) => row.command),
		["echo fixture-row-1", "echo fixture-row-3"],
		"both denials survive, non-denials never do",
	);
	resetAudit();
});

test("recentDenialRows on an empty or missing log returns nothing", () => {
	resetAudit();
	assert.deepEqual(automode.recentDenialRows(10), [], "missing log");
	writeFileSync(auditLogPath, "");
	assert.deepEqual(automode.recentDenialRows(10), [], "empty log");
	resetAudit();
});
