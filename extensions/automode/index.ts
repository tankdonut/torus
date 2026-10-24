/**
 * torus automode — engine wiring: LLM-classified bash auto-approval.
 *
 * Opt-in via TORUS_PERMISSION_MODE: in default mode the extension is inert —
 * no model calls, no audit rows, no prompts. In auto mode every bash tool
 * call runs one fixed pipeline: deny rules, the critical ask floor (which no
 * allow rule can bypass), ask rules, allow rules, the circuit breaker, the
 * read-only fast path, the session decision cache, and finally the decision
 * model. Each concluding step appends one row to the audit log; a decision
 * model that cannot be reached fails open with an annotation on the tool
 * result. Blocks returned here compose with first-block-wins engine
 * semantics: another extension's block always stays in effect.
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { refreshToruStatus, setStatusPermission } from "../ui/index.js";
import { DecisionCache, decide, pickChatModel, pickModel } from "./classify.js";
import {
	type AuditRow,
	appendAuditRow,
	CIRCUIT_BREAKER_DENIES,
	loadRules,
	type PermissionMode,
	parseModelPin,
	resolveMode,
	rulesPath,
} from "./config.js";
import {
	type AutomodeRules,
	criticalAskFloor,
	type Decision,
	findBroadAllowEntries,
	isReadOnlyFastPath,
	matchRules,
} from "./policy.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

const RULES_HINT = "edit ~/.torus/automode.json to change";

function unjudgedMarker(reason: string): string {
	return `\n[automode] ran unjudged (decision model unavailable: ${reason}) — treat with care`;
}

function noUiReason(reason: string): string {
	return `automode: ${reason} — no UI for approval; rerun with TORUS_PERMISSION_MODE=default or approve interactively`;
}

export function registerAutomode(pi: ExtensionAPI): void {
	let startupMode: PermissionMode = "default";
	let startupWarning: string | undefined;
	let modeOverride: PermissionMode | undefined;
	let rules: AutomodeRules = {};
	let pin: { provider: string; modelId: string } | undefined;
	const cache = new DecisionCache();
	let consecutiveDenies = 0;
	let askEverything = false;
	const failopenReasons = new Map<string, string>();
	let startup: Promise<void> | undefined;

	const mode = (): PermissionMode => modeOverride ?? startupMode;

	/** Keep the statusline permission chip in sync with the live session mode. */
	function paintPermission(ctx: ExtensionContext): void {
		setStatusPermission(mode() === "auto" ? "auto" : "default", askEverything);
		if (ctx.hasUI) refreshToruStatus(ctx);
	}

	function audit(
		command: string,
		source: AuditRow["source"],
		verdict: AuditRow["verdict"],
		reason: string,
		extra?: Pick<Decision, "model" | "confidence"> & { ms?: number },
	): void {
		const row: AuditRow = { ts: Date.now(), mode: mode(), source, verdict, reason, command };
		if (extra?.model !== undefined) row.model = extra.model;
		if (extra?.confidence !== undefined) row.confidence = extra.confidence;
		if (extra?.ms !== undefined) row.ms = extra.ms;
		appendAuditRow(row);
	}

	/** Load the rules file and model pin, surfacing every warning once. */
	function loadAutoConfig(ctx: ExtensionContext): void {
		const loaded = loadRules(rulesPath(process.env));
		rules = loaded.rules;
		for (const warning of loaded.warnings) {
			ctx.ui.notify(`automode: ${warning}`, "info");
		}
		const pinned = parseModelPin(process.env);
		pin = pinned.pin;
		if (pinned.warning !== undefined) {
			ctx.ui.notify(`automode: ${pinned.warning}`, "warning");
		}
		const broad = findBroadAllowEntries(rules);
		if (broad.length > 0) {
			ctx.ui.notify(
				`automode: broad allow entries match nothing under prefix-pattern rules and are ignored in auto mode: ${broad.join(", ")}`,
				"warning",
			);
		}
	}

	/** Display name of the model that will judge commands, for the on-notice. */
	async function decisionModelLabel(ctx: ExtensionContext): Promise<string> {
		try {
			const picked = await pickModel(ctx.modelRegistry, pin);
			if (picked.model !== undefined) {
				return `${picked.model.provider}/${picked.model.id}`;
			}
			const chat = pickChatModel(ctx.modelRegistry, ctx.model);
			if (chat !== undefined) {
				const isSession =
					ctx.model !== undefined &&
					chat.provider === ctx.model.provider &&
					chat.id === ctx.model.id;
				return isSession
					? `session model (${chat.provider}/${chat.id})`
					: `fast chain (${chat.provider}/${chat.id})`;
			}
		} catch {
			// Per-call decide() does its own lookup and fail-open handling.
		}
		return ctx.model !== undefined
			? `session model (${ctx.model.provider}/${ctx.model.id})`
			: "session model";
	}

	/**
	 * Resolve the permission mode once (memoized, so concurrent first calls
	 * share one init). Auto mode announces itself before any rules warnings:
	 * the first thing the user sees is that bash calls are auto-approved.
	 */
	function ensureStartup(ctx: ExtensionContext): Promise<void> {
		startup ??= startupOnce(ctx);
		return startup;
	}

	async function startupOnce(ctx: ExtensionContext): Promise<void> {
		const resolved = resolveMode(process.env);
		startupMode = resolved.mode;
		startupWarning = resolved.warning;
		paintPermission(ctx);
		if (startupMode !== "auto") return;
		ctx.ui.notify(
			`automode: on — bash calls auto-approved by ${await decisionModelLabel(ctx)}; rules: ${rulesPath(process.env)}`,
			"info",
		);
		loadAutoConfig(ctx);
	}

	/**
	 * Ask the user (step f). Headless sessions block with the reason spelled
	 * out; interactive ones get a three-way dialog whose "Always" answer seeds
	 * the session cache. Dialog allows reset the deny streak, dialog denies
	 * leave it — only the decision model's own denies grow it.
	 */
	async function askUser(
		ctx: ExtensionContext,
		command: string,
		reason: string,
	): Promise<ToolCallEventResult | undefined> {
		if (!ctx.hasUI) {
			audit(command, "dialog", "deny", `no UI to ask: ${reason}`);
			return { block: true, reason: noUiReason(reason) };
		}
		const choice = await ctx.ui.select(`automode: ${reason}\n\n  ${command}\n\nAllow?`, [
			"Allow once",
			"Always this session",
			"Deny",
		]);
		if (choice === "Allow once") {
			consecutiveDenies = 0;
			audit(command, "dialog", "allow", `allowed once by user: ${reason}`);
			return undefined;
		}
		if (choice === "Always this session") {
			consecutiveDenies = 0;
			cache.set(command, {
				verdict: "allow",
				source: "cache",
				reason: `allowed for this session by user: ${reason}`,
			});
			audit(command, "dialog", "allow", `allowed for this session by user: ${reason}`);
			return undefined;
		}
		audit(command, "dialog", "deny", `denied by user: ${reason}`);
		return { block: true, reason: "automode: denied by user" };
	}

	pi.on("session_start", (_event, ctx) => ensureStartup(ctx));

	pi.on("tool_call", async (event, ctx) => {
		await ensureStartup(ctx);
		if (mode() !== "auto") return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;
		if (command.trim() === "") return undefined;

		// (a) deny rules block outright; ask and allow rules wait for the floor.
		const ruleMatch = matchRules(command, rules);
		if (ruleMatch?.verdict === "deny") {
			audit(command, "rule", "deny", `denied by rule "${ruleMatch.rule}"`);
			return {
				block: true,
				reason: `automode: denied by rule "${ruleMatch.rule}" — ${RULES_HINT}`,
			};
		}

		// (b) the critical ask floor outranks every allow shortcut.
		const floor = criticalAskFloor(command);
		if (floor !== undefined) {
			return askUser(ctx, command, `ask floor: ${floor}`);
		}

		if (ruleMatch?.verdict === "ask") {
			return askUser(ctx, command, `ask rule "${ruleMatch.rule}" matched`);
		}
		if (ruleMatch?.verdict === "allow") {
			consecutiveDenies = 0;
			audit(command, "rule", "allow", `allowed by rule "${ruleMatch.rule}"`);
			return undefined;
		}

		// (c) tripped circuit breaker: ask for everything this session.
		if (askEverything) {
			return askUser(ctx, command, "circuit breaker: repeated denies");
		}

		// (d) read-only fast path: no model call.
		if (isReadOnlyFastPath(command)) {
			consecutiveDenies = 0;
			audit(command, "fastpath", "allow", "read-only fast path");
			return undefined;
		}

		// (e) replay a decision approved for this session.
		const cached = cache.get(command);
		if (cached !== undefined) {
			audit(command, "cache", cached.verdict, cached.reason, cached);
			if (cached.verdict === "allow") {
				consecutiveDenies = 0;
				return undefined;
			}
			if (cached.verdict === "deny") {
				return { block: true, reason: `automode: denied this session — ${cached.reason}` };
			}
			return askUser(ctx, command, cached.reason);
		}

		// (g) decision model, with timing and fail-open handling.
		const startedAt = Date.now();
		const decision = await decide(ctx.modelRegistry, ctx.model, pin, command, ctx.cwd, ctx.signal);
		const ms = Date.now() - startedAt;
		audit(command, decision.source, decision.verdict, decision.reason, { ...decision, ms });
		switch (decision.verdict) {
			case "allow": {
				consecutiveDenies = 0;
				return undefined;
			}
			case "ask": {
				return askUser(ctx, command, decision.reason);
			}
			case "deny": {
				consecutiveDenies += 1;
				if (consecutiveDenies >= CIRCUIT_BREAKER_DENIES && !askEverything) {
					askEverything = true;
					ctx.ui.notify(
						`automode: ${CIRCUIT_BREAKER_DENIES} consecutive denies — asking for everything this session`,
						"warning",
					);
					paintPermission(ctx);
				}
				return { block: true, reason: `automode: decision model denied — ${decision.reason}` };
			}
			default: {
				consecutiveDenies = 0;
				failopenReasons.set(event.toolCallId, decision.reason);
				ctx.ui.notify(`automode: ran unjudged (${decision.reason})`, "warning");
				return undefined;
			}
		}
	});

	pi.on("tool_result", (event) => {
		const reason = failopenReasons.get(event.toolCallId);
		if (reason === undefined) return undefined;
		failopenReasons.delete(event.toolCallId);
		const content = [...event.content];
		const last = content[content.length - 1];
		const marker = unjudgedMarker(reason);
		if (last !== undefined && last.type === "text") {
			content[content.length - 1] = { ...last, text: last.text + marker };
		} else {
			content.push({ type: "text" as const, text: marker.trim() });
		}
		return { content };
	});

	async function statusText(ctx: ExtensionContext): Promise<string> {
		const lines = [`mode: ${mode()}`];
		if (modeOverride !== undefined) {
			lines.push(`session override of startup mode ${startupMode}`);
		}
		if (startupWarning !== undefined) {
			lines.push(`warning: ${startupWarning}`);
		}
		const fallback =
			ctx.model !== undefined
				? `session model fallback (${ctx.model.provider}/${ctx.model.id})`
				: "none — will fail open";
		try {
			const picked = await pickModel(ctx.modelRegistry, pin);
			if (picked.model !== undefined) {
				lines.push(`decision model: ${picked.model.provider}/${picked.model.id}`);
			} else {
				lines.push(`decision model: ${fallback}`);
			}
			if (picked.warning !== undefined) {
				lines.push(`warning: ${picked.warning}`);
			}
		} catch {
			lines.push(`decision model: ${fallback}`);
		}
		const path = rulesPath(process.env);
		if (mode() === "auto") {
			lines.push(
				`rules: ${path} (allow ${rules.allow?.length ?? 0}, ask ${rules.ask?.length ?? 0}, deny ${rules.deny?.length ?? 0})`,
			);
		} else {
			lines.push(`rules: ${path} (not loaded; default mode)`);
		}
		lines.push(`cache: ${cache.size} ${cache.size === 1 ? "entry" : "entries"}`);
		lines.push(
			`circuit breaker: ${askEverything ? "tripped (asking for everything)" : `off (${consecutiveDenies}/${CIRCUIT_BREAKER_DENIES} consecutive denies)`}`,
		);
		return `automode status:\n${lines.join("\n")}`;
	}

	pi.registerCommand("automode", {
		description:
			"Show the automode permission status; /automode auto|default switches the session mode",
		handler: async (args: string, ctx: ExtensionContext) => {
			await ensureStartup(ctx);
			const arg = args.trim().toLowerCase();
			if (arg === "") {
				ctx.ui.notify(await statusText(ctx), "info");
				return;
			}
			if (arg !== "auto" && arg !== "default") {
				ctx.ui.notify(
					`automode: unknown mode "${args.trim()}" — usage: /automode [auto|default]`,
					"warning",
				);
				return;
			}
			modeOverride = arg;
			cache.clear();
			consecutiveDenies = 0;
			askEverything = false;
			failopenReasons.clear();
			if (arg === "auto") {
				loadAutoConfig(ctx);
			}
			ctx.ui.notify(`automode: session mode set to ${arg}`, "info");
			paintPermission(ctx);
		},
	});
}

export default function automodeExtension(pi: ExtensionAPI): void {
	if (!gateExtension("automode", PLATFORM_SUPPORT)) return;
	registerAutomode(pi);
}
