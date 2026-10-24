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
import { DecisionCache, decide, pickModel } from "./classify.js";
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
const UNJUDGED_MARKER = "\n[automode] ran unjudged (decision model unavailable) — treat with care";

function noUiReason(reason: string): string {
	return `automode: ${reason} — no UI for approval; rerun with TORUS_PERMISSION_MODE=default or approve interactively`;
}

export function registerAutomode(pi: ExtensionAPI): void {
	let started = false;
	let startupMode: PermissionMode = "default";
	let startupWarning: string | undefined;
	let modeOverride: PermissionMode | undefined;
	let rules: AutomodeRules = {};
	let pin: { provider: string; modelId: string } | undefined;
	const cache = new DecisionCache();
	let consecutiveDenies = 0;
	let askEverything = false;
	const failopenCallIds = new Set<string>();

	const mode = (): PermissionMode => modeOverride ?? startupMode;

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

	function ensureStartup(ctx: ExtensionContext): void {
		if (started) return;
		started = true;
		const resolved = resolveMode(process.env);
		startupMode = resolved.mode;
		startupWarning = resolved.warning;
		if (startupMode === "auto") {
			loadAutoConfig(ctx);
		}
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

	pi.on("tool_call", async (event, ctx) => {
		ensureStartup(ctx);
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
				}
				return { block: true, reason: `automode: decision model denied — ${decision.reason}` };
			}
			default: {
				consecutiveDenies = 0;
				failopenCallIds.add(event.toolCallId);
				ctx.ui.notify(`automode: ran unjudged (${decision.reason})`, "warning");
				return undefined;
			}
		}
	});

	pi.on("tool_result", (event) => {
		if (!failopenCallIds.delete(event.toolCallId)) return undefined;
		const content = [...event.content];
		const last = content[content.length - 1];
		if (last !== undefined && last.type === "text") {
			content[content.length - 1] = { ...last, text: last.text + UNJUDGED_MARKER };
		} else {
			content.push({ type: "text" as const, text: UNJUDGED_MARKER.trim() });
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
			ensureStartup(ctx);
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
			failopenCallIds.clear();
			if (arg === "auto") {
				loadAutoConfig(ctx);
			}
			ctx.ui.notify(`automode: session mode set to ${arg}`, "info");
		},
	});
}

export default function automodeExtension(pi: ExtensionAPI): void {
	if (!gateExtension("automode", PLATFORM_SUPPORT)) return;
	registerAutomode(pi);
}
