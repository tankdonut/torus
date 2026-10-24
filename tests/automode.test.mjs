import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const rulesFilePath = path.join(home, "automode.json");

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

function setRules(rules) {
	if (rules === undefined) rmSync(rulesFilePath, { force: true });
	else writeFileSync(rulesFilePath, JSON.stringify(rules));
}

function setMode(value) {
	if (value === undefined) delete process.env.TORUS_PERMISSION_MODE;
	else process.env.TORUS_PERMISSION_MODE = value;
}

/** Registry stub with no classifier; chat replies drive the decision model. */
function registryStub(replies) {
	const pending = [...replies];
	const calls = { complete: 0, classify: 0 };
	return {
		calls,
		getAvailableOfType: async () => [],
		getModelOfType: () => undefined,
		classify: async () => {
			calls.classify += 1;
			throw new Error("no classifier in stub");
		},
		complete: async () => {
			calls.complete += 1;
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
	setRules(options.rules);
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
		cwd: "/tmp/project",
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
	const { pi, ctx } = setup({ rules: { deny: ["rm *"] } });
	const result = await call(pi, ctx, "rm -rf build");
	assert.deepEqual(result, {
		block: true,
		reason: 'automode: denied by rule "rm *" — edit ~/.torus/automode.json to change',
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
	const { pi, ctx } = setup({ rules: { ask: ["git push *"] }, hasUI: false });
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
	const denied = setup({ rules: { ask: ["git push *"] }, hasUI: true, answer: "Deny" });
	assert.deepEqual(await call(denied.pi, denied.ctx, "git push origin main"), {
		block: true,
		reason: "automode: denied by user",
	});
	assert.equal(denied.dialog.calls.length, 1);
	assert.match(denied.dialog.calls[0].title, /git push origin main/);
	assert.deepEqual(denied.dialog.calls[0].options, ["Allow once", "Always this session", "Deny"]);

	resetAudit();
	const once = setup({ rules: { ask: ["git push *"] }, hasUI: true, answer: "Allow once" });
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

test("ask floor: sudo asks even with a matching allow rule", async () => {
	resetAudit();
	const { pi, ctx } = setup({ rules: { allow: ["sudo *"] }, hasUI: false });
	const result = await call(pi, ctx, "sudo id");
	assert.equal(result.block, true, "allow rule must not bypass the floor");
	assert.match(result.reason, /ask floor/);
	assert.match(result.reason, /sudo/);
	assert.match(result.reason, /no UI for approval/);
	const rows = auditRows();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].source, "dialog");
});

test("fast path: read-only command passes with an audit row and no model call", async () => {
	resetAudit();
	const { pi, ctx, reg } = setup({ rules: undefined });
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
		rules: { allow: ["*"] },
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
	assert.ok(status.includes(rulesFilePath), "status names the rules path");
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
	assert.ok(on[0].message.includes(rulesFilePath), "notice names the rules path");
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
