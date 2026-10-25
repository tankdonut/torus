/**
 * torus automode — engine wiring: LLM-classified bash auto-approval.
 *
 * Opt-in via TORUS_PERMISSION_MODE: in default mode the extension is inert —
 * no model calls, no audit rows, no prompts. In bypass mode (startup-only:
 * TORUS_PERMISSION_MODE=bypass, set by the --permission-mode bypass launcher
 * flag and refused from config.json) the whole permission layer is off —
 * this extension never classifies, the context guards, cc-safety-net,
 * sandbox, and approval extensions never register, and the mode cannot be
 * changed mid-session. In auto mode every bash tool
 * call runs one fixed pipeline: deny rules, the critical ask floor (which no
 * allow rule can bypass), ask rules, allow rules, the circuit breaker, the
 * read-only fast path, the session decision cache, and finally the decision
 * model. Each concluding step appends one row to the audit log; a decision
 * model that cannot be reached fails open with an annotation on the tool
 * result. Blocks returned here compose with first-block-wins engine
 * semantics: another extension's block always stays in effect.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { loadConfigFile, loadProjectConfig, writeSection } from "../config/loader.js";
import { PROJECT_AUTOMODE_KEYS } from "../config/sections.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { refreshToruStatus, setStatusPermission } from "../ui/index.js";
import { DecisionCache, decide, pickChatModel, pickModel } from "./classify.js";
import {
	type AuditRow,
	type AutomodeRulesFile,
	type AutomodeRulesSource,
	appendAuditRow,
	auditPath,
	CIRCUIT_BREAKER_DENIES,
	type LoadedAutomodeRules,
	loadAutomodeRules,
	type PermissionMode,
	type PermissionModeSource,
	parseModelPin,
	resolveModeSource,
	rulesPath,
} from "./config.js";
import {
	criticalAskFloor,
	type Decision,
	findBroadAllowEntries,
	isReadOnlyFastPath,
	matchRules,
} from "./policy.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

/** Where to edit the rules behind a deny, keyed by the effective rules source. */
const RULES_HINTS: Record<AutomodeRulesSource, string> = {
	"config.json": "edit the automode section of ~/.torus/config.json to change",
	"automode.json": "edit ~/.torus/automode.json to change",
	default: "edit ~/.torus/automode.json to change",
};

/** Suffix for a rules line, naming where the effective rules came from. */
function rulesSourceSuffix(source: AutomodeRulesSource): string {
	if (source === "config.json") return " (from config.json)";
	if (source === "automode.json") return " (from automode.json)";
	return " (none — defaults)";
}

/** Most intent lines buffered for the softDeny judge tier; oldest drop beyond it. */
const INTENT_BUFFER_MAX_LINES = 20;

function unjudgedMarker(reason: string): string {
	return `\n[automode] ran unjudged (decision model unavailable: ${reason}) — treat with care`;
}

function noUiReason(reason: string): string {
	return `automode: ${reason} — no UI for approval; rerun with TORUS_PERMISSION_MODE=default or approve interactively`;
}

/** Deny rows the setup wizard scans for repeated command prefixes. */
const SETUP_DENIAL_SCAN = 100;

/** The /automode setup draft: suggested entries plus the summary shown for review. */
export type SetupDraft = {
	/** Trusted-infrastructure lines suggested for the `environment` array. */
	environment?: string[];
	/** Prefix patterns suggested for the `ask` array. */
	ask?: string[];
	/** One line per suggestion plus the kept entries, for the review prompt. */
	summary: string[];
};

/** Parse the audit log's deny rows, newest last, capped at `limit`; a missing or unreadable log contributes nothing. */
function recentDenialRows(limit: number): AuditRow[] {
	let text: string;
	try {
		text = readFileSync(auditPath(), "utf8");
	} catch {
		return [];
	}
	const denials = text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			try {
				return JSON.parse(line) as AuditRow;
			} catch {
				return undefined;
			}
		})
		.filter((row): row is AuditRow => row !== undefined && row.verdict === "deny");
	return denials.slice(-limit);
}

function stripConfigQuotes(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1);
	}
	return value;
}

/** First non-empty path segment with a trailing ".git" dropped, or nothing. */
function firstPathSegment(rest: string): string | undefined {
	const segment = rest.split("/").find((part) => part !== "");
	if (segment === undefined || segment === "") return undefined;
	return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

/**
 * Reduce one remote URL to `Source control: <host>/<org-or-first-path-segment>`.
 * Two shapes parse: scheme URLs (`https://github.com/org/repo`, any
 * `scheme://[user@]host[:port]/...` — the port never reaches the line) and
 * scp-like git URLs (`git@github.com:org/repo.git`). Windows drive-letter
 * lookalikes (`C:\repo`) and anything else — relative paths, bare hosts —
 * parse to nothing and are skipped.
 */
function sourceControlLine(url: string): string | undefined {
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) {
		try {
			const parsed = new URL(url);
			const segment = firstPathSegment(parsed.pathname);
			if (parsed.hostname !== "" && segment !== undefined) {
				return `Source control: ${parsed.hostname}/${segment}`;
			}
		} catch {
			// A URL-shaped string the parser rejects is unparseable.
		}
		return undefined;
	}
	if (/^[A-Za-z]:[\\/]/.test(url)) return undefined;
	const scp = url.match(/^(?:[^@\s/]+@)?([^:@\s/]+):(.+)$/);
	const [, host, rest] = scp ?? [];
	if (host === undefined || rest === undefined) return undefined;
	const segment = firstPathSegment(rest);
	if (segment === undefined) return undefined;
	return `Source control: ${host}/${segment}`;
}

/**
 * `Source control: host/org` lines from a git config's remote URLs, deduped,
 * in file order. The file is read as text directly — never through a shell —
 * so a hostile repo's config is just data. A missing file means no lines.
 */
function remoteSourceLines(gitConfig: string): string[] {
	let text: string;
	try {
		text = readFileSync(gitConfig, "utf8");
	} catch {
		return [];
	}
	const lines = new Set<string>();
	let inRemote = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[")) {
			inRemote = /^\[\s*remote\s+"/.test(line);
			continue;
		}
		if (!inRemote) continue;
		const match = line.match(/^url\s*=\s*(.*?)\s*$/);
		const value = match?.[1];
		if (value === undefined) continue;
		const derived = sourceControlLine(stripConfigQuotes(value));
		if (derived !== undefined) lines.add(derived);
	}
	return [...lines];
}

/**
 * Ask-rule suggestions from deny rows. Heuristic: when commands sharing the
 * same first two tokens were denied at least twice, the user keeps reaching
 * for that command family and answering no — draft `"<tok0> <tok1> *"` so
 * future calls open the approval dialog instead of silently burning a model
 * call. The bar is deliberately conservative: a single deny, however
 * repeated the identical command within it, is noise, not a pattern, and an
 * entry already present in the effective ask list is never re-suggested.
 */
function askSuggestions(denials: readonly AuditRow[], rules: AutomodeRulesFile): string[] {
	const counts = new Map<string, number>();
	for (const row of denials) {
		const tokens = row.command
			.trim()
			.split(/\s+/)
			.filter((token) => token !== "");
		const [first, second] = tokens;
		if (first === undefined || second === undefined) continue;
		const prefix = `${first} ${second}`;
		counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
	}
	const present = new Set(rules.ask ?? []);
	const suggestions: string[] = [];
	for (const [prefix, count] of counts) {
		if (count < 2) continue;
		const entry = `${prefix} *`;
		if (present.has(entry) || suggestions.includes(entry)) continue;
		suggestions.push(entry);
	}
	return suggestions;
}

/** The draft's writable payload: only arrays with entries appear. */
function draftPayload(draft: SetupDraft): Record<string, string[]> {
	const payload: Record<string, string[]> = {};
	if (draft.environment !== undefined && draft.environment.length > 0) {
		payload.environment = draft.environment;
	}
	if (draft.ask !== undefined && draft.ask.length > 0) payload.ask = draft.ask;
	return payload;
}

/**
 * Union the draft's arrays into an existing automode section: existing
 * entries keep their order, draft entries append, exact-duplicate strings
 * drop, and every key the draft does not touch survives verbatim.
 */
function mergeDraftIntoSection(
	existing: Record<string, unknown>,
	draft: SetupDraft,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...existing };
	for (const key of DRAFT_KEYS) {
		const additions = draft[key];
		if (additions === undefined || additions.length === 0) continue;
		const entries = Array.isArray(existing[key]) ? [...(existing[key] as unknown[])] : [];
		for (const entry of additions) {
			if (!entries.includes(entry)) entries.push(entry);
		}
		merged[key] = entries;
	}
	return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The only keys a setup draft may carry: trust prose and ask patterns, never widening keys. */
const DRAFT_KEYS = ["environment", "ask"] as const;

/** Parse outcome for a draft file: a ready SetupDraft or a refusal naming the file. */
export type ParsedDraft = { ok: true; draft: SetupDraft } | { ok: false; error: string };

/**
 * Parse a draft file for /automode setup apply. The file is agent-writable
 * input to a permission surface, so it is read strictly: a JSON object whose
 * keys are limited to environment and ask, each an array of non-empty
 * strings, with at least one of the two present. Anything else — widening
 * keys such as allow or hardDeny, junk entries, a missing file — is a named
 * refusal and nothing is applied.
 */
export function parseDraftFile(filePath: string): ParsedDraft {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "read error";
		return { ok: false, error: `${filePath}: unreadable (${code})` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, error: `${filePath}: not valid JSON` };
	}
	if (!isPlainRecord(parsed)) {
		return { ok: false, error: `${filePath}: root is not a JSON object` };
	}
	const refused = Object.keys(parsed).filter(
		(key) => !(DRAFT_KEYS as readonly string[]).includes(key),
	);
	if (refused.length > 0) {
		return {
			ok: false,
			error: `${filePath}: refused key(s) ${refused.join(", ")} — drafts carry environment and ask only`,
		};
	}
	const draft: SetupDraft = { summary: [] };
	for (const key of DRAFT_KEYS) {
		const value = parsed[key];
		if (value === undefined) continue;
		if (
			!Array.isArray(value) ||
			value.some((entry) => typeof entry !== "string" || entry.trim() === "")
		) {
			return { ok: false, error: `${filePath}: "${key}" must be an array of non-empty strings` };
		}
		draft[key] = value as string[];
	}
	if (draft.environment === undefined && draft.ask === undefined) {
		return { ok: false, error: `${filePath}: no environment or ask entries to apply` };
	}
	for (const line of draft.environment ?? []) draft.summary.push(`add environment: ${line}`);
	for (const entry of draft.ask ?? []) draft.summary.push(`add ask: ${entry}`);
	return { ok: true, draft };
}

/**
 * Compose the /automode setup draft from three inputs: the repo's git
 * remotes (environment lines), recent audit denials (ask suggestions), and
 * the currently effective rules (listed as kept in the summary, never
 * re-suggested). Pure apart from reading `<cwd>/.git/config` as text.
 */
export function buildSetupDraft(
	cwd: string,
	denials: readonly AuditRow[],
	current: { rules: AutomodeRulesFile; source: AutomodeRulesSource },
): SetupDraft {
	const environment = remoteSourceLines(path.join(cwd, ".git", "config"));
	const ask = askSuggestions(denials, current.rules);
	const summary: string[] = [];
	for (const line of environment) summary.push(`add environment: ${line}`);
	for (const entry of ask) summary.push(`add ask: ${entry}`);
	const kept = Object.entries(current.rules)
		.filter(([, value]) => Array.isArray(value) && value.length > 0)
		.map(([key, value]) => `${key}: ${(value as string[]).join(", ")}`);
	if (kept.length > 0) summary.push(`keep (from ${current.source}): ${kept.join("; ")}`);
	if (summary.length === 0) summary.push("nothing to add — no remotes or repeated denies found");
	const draft: SetupDraft = { summary };
	if (environment.length > 0) draft.environment = environment;
	if (ask.length > 0) draft.ask = ask;
	return draft;
}

export function registerAutomode(pi: ExtensionAPI): void {
	let startupMode: PermissionMode = "default";
	let startupSource: PermissionModeSource = "default";
	let startupWarning: string | undefined;
	let modeOverride: PermissionMode | undefined;
	let rules: AutomodeRulesFile = {};
	let rulesSource: AutomodeRulesSource = "automode.json";
	let projectExtras: { deny: number; ask: number } | undefined;
	let pin: { provider: string; modelId: string } | undefined;
	const cache = new DecisionCache();
	let consecutiveDenies = 0;
	let askEverything = false;
	const failopenReasons = new Map<string, string>();
	let startup: Promise<void> | undefined;
	// The user's own message lines since the last approval dialog or deny — the
	// clearing window the softDeny judge tier reads. softDeny is prose for the
	// judge only; nothing here maps it to a deterministic rule.
	const intentLines: string[] = [];

	const mode = (): PermissionMode => modeOverride ?? startupMode;

	/** Keep the statusline permission chip in sync with the live session mode. */
	function paintPermission(ctx: ExtensionContext): void {
		setStatusPermission(mode(), askEverything);
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

	/** Apply a rules load, remembering its source; returns the warnings to surface. */
	function applyRules(loaded: LoadedAutomodeRules): string[] {
		rules = loaded.rules;
		rulesSource = loaded.source;
		return loaded.warnings;
	}

	/**
	 * Load the rules (the automode section of config.json first, the legacy
	 * automode.json second) and the model pin, surfacing every warning once.
	 * Startup passes warnings it already holds: rules load before the "on"
	 * notice so the notice can name their source, but their warnings still
	 * follow it.
	 */
	function loadAutoConfig(ctx: ExtensionContext, preloadedWarnings?: string[]): void {
		const warnings = preloadedWarnings ?? applyRules(loadAutomodeRules());
		for (const warning of warnings) {
			ctx.ui.notify(`automode: ${warning}`, "info");
		}
		applyProjectRules(ctx);
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

	/**
	 * Union the project file's tightening-only automode keys into the
	 * effective rules. A project may add deny and ask entries on top of the
	 * user's rules — never widen: its allow, environment, hardDeny, softDeny,
	 * softDenyExceptions, and classifyAllShell keys are refused with one
	 * notice, as are any non-automode sections (chains, serve, keywords,
	 * permissionMode) by the loader's allowlist.
	 */
	function applyProjectRules(ctx: ExtensionContext): void {
		projectExtras = undefined;
		const project = loadProjectConfig(ctx.cwd);
		if (project.warning !== undefined) {
			ctx.ui.notify(`automode: ${project.warning}`, "warning");
		}
		const rawSection = project.config["automode"];
		if (typeof rawSection !== "object" || rawSection === null || Array.isArray(rawSection)) {
			return;
		}
		const section = rawSection as Record<string, unknown>;
		const ignoredKeys = Object.keys(section).filter((key) => !PROJECT_AUTOMODE_KEYS.includes(key));
		if (ignoredKeys.length > 0) {
			ctx.ui.notify(
				`automode: project .torus/config.json may only tighten; ignoring its automode keys: ${ignoredKeys.join(", ")}`,
				"warning",
			);
		}
		let denyAdded = 0;
		let askAdded = 0;
		for (const key of ["deny", "ask"] as const) {
			const entries = section[key];
			if (!Array.isArray(entries)) continue;
			const merged = rules[key] ?? [];
			for (const entry of entries) {
				if (typeof entry === "string" && !merged.includes(entry)) {
					merged.push(entry);
					if (key === "deny") denyAdded += 1;
					else askAdded += 1;
				}
			}
			rules[key] = merged;
		}
		if (denyAdded > 0 || askAdded > 0) {
			projectExtras = { deny: denyAdded, ask: askAdded };
		}
	}

	/**
	 * Display name of the model that will judge commands — the one resolver
	 * for both the on-notice and the /automode status panel, so the two
	 * surfaces cannot drift apart.
	 */
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
			: "none — will fail open";
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
		// permissionMode is user-level only by construction: config.json lives under
		// the torus home (TORUS_HOME||~/.torus), so a repo checkout can never set it.
		const configMode = loadConfigFile().config["permissionMode"];
		const resolved = resolveModeSource(process.env, configMode);
		startupMode = resolved.mode;
		startupSource = resolved.source;
		startupWarning = resolved.warning;
		paintPermission(ctx);
		if (startupWarning !== undefined) {
			ctx.ui.notify(`automode: ${startupWarning}`, "warning");
		}
		if (startupMode === "bypass") {
			ctx.ui.notify(
				"automode: bypass — every permission guard (context guards, cc-safety-net, sandbox, approval, and this classifier) is off for this session; bypass is startup-only, restart without it to re-enable",
				"warning",
			);
			return;
		}
		if (startupMode !== "auto") return;
		const rulesWarnings = applyRules(loadAutomodeRules());
		const origin = startupSource === "config" ? " (from config)" : "";
		ctx.ui.notify(
			`automode: on${origin} — bash calls auto-approved by ${await decisionModelLabel(ctx)}; rules: ${rulesPath()}${rulesSourceSuffix(rulesSource)}`,
			"info",
		);
		loadAutoConfig(ctx, rulesWarnings);
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
		// Every dialog invocation resets the intent window: the user just spoke
		// for themselves, so older intent no longer speaks for them.
		intentLines.length = 0;
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

	// Buffer the user's own message text (never assistant or tool text) as the
	// softDeny tier's clearing window, bounded to the newest lines.
	pi.on("message_start", (event) => {
		const message = event.message;
		if (message.role !== "user") return;
		const parts = typeof message.content === "string" ? [message.content] : message.content;
		for (const part of parts) {
			const text = typeof part === "string" ? part : part.type === "text" ? part.text : "";
			const line = text.trim();
			if (line === "") continue;
			intentLines.push(line);
			if (intentLines.length > INTENT_BUFFER_MAX_LINES) intentLines.shift();
		}
	});

	pi.on("session_start", (_event, ctx) => ensureStartup(ctx));

	pi.on("tool_call", async (event, ctx) => {
		await ensureStartup(ctx);
		if (mode() !== "auto") return undefined;
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;
		if (command.trim() === "") return undefined;

		// (a) deny rules block outright; ask rules prompt; allow rules pass —
		// unless classifyAllShell suspends them, in which case an allow match
		// falls through to the decision model (the floor, fast path, and cache
		// still apply; only rule-based allows are suspended).
		const ruleMatch = matchRules(command, rules);
		if (ruleMatch?.verdict === "deny") {
			intentLines.length = 0;
			audit(command, "rule", "deny", `denied by rule "${ruleMatch.rule}"`);
			return {
				block: true,
				reason: `automode: denied by rule "${ruleMatch.rule}" — ${RULES_HINTS[rulesSource]}`,
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
		if (ruleMatch?.verdict === "allow" && rules.classifyAllShell !== true) {
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
				intentLines.length = 0;
				return { block: true, reason: `automode: denied this session — ${cached.reason}` };
			}
			return askUser(ctx, command, cached.reason);
		}

		// (g) decision model, with timing and fail-open handling. The model
		// verdict itself never clears the intent window — an allow keeps the
		// intent for the next command; only dialogs and denies clear it.
		const startedAt = Date.now();
		const decision = await decide(
			ctx.modelRegistry,
			ctx.model,
			pin,
			command,
			ctx.cwd,
			ctx.signal,
			undefined,
			{
				environment: rules.environment,
				softDeny: rules.softDeny,
				softDenyExceptions: rules.softDenyExceptions,
				hardDeny: rules.hardDeny,
				intent: [...intentLines],
			},
		);
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
				intentLines.length = 0;
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
		const lines = [`mode: ${mode()} (from ${startupSource})`];
		if (modeOverride !== undefined) {
			lines.push(`session override of startup mode ${startupMode}`);
		}
		if (startupWarning !== undefined) {
			lines.push(`warning: ${startupWarning}`);
		}
		try {
			const picked = await pickModel(ctx.modelRegistry, pin);
			if (picked.model !== undefined) {
				lines.push(`decision model: ${picked.model.provider}/${picked.model.id}`);
			} else {
				lines.push(`decision model: ${await decisionModelLabel(ctx)}`);
			}
			if (picked.warning !== undefined) {
				lines.push(`warning: ${picked.warning}`);
			}
		} catch {
			lines.push(`decision model: ${await decisionModelLabel(ctx)}`);
		}
		const path = rulesPath();
		if (mode() === "auto") {
			lines.push(`rules: ${path}${rulesSourceSuffix(rulesSource)}`);
			const list = (label: string, entries: string[] | undefined) => {
				lines.push(
					entries !== undefined && entries.length > 0
						? `  ${label}: ${entries.join("; ")}`
						: `  ${label}: none`,
				);
			};
			list("allow", rules.allow);
			list("ask", rules.ask);
			list("deny", rules.deny);
			list("environment", rules.environment);
			list("hardDeny", rules.hardDeny);
			lines.push(
				`  classifyAllShell: ${rules.classifyAllShell === true ? "on (allow rules suspended)" : "off"}`,
			);
			if (projectExtras !== undefined) {
				lines.push(
					`  project .torus/config.json: +deny ${projectExtras.deny}, +ask ${projectExtras.ask}`,
				);
			}
		} else {
			lines.push(`rules: ${path} (not loaded; ${mode()} mode)`);
		}
		lines.push(`cache: ${cache.size} ${cache.size === 1 ? "entry" : "entries"}`);
		lines.push(
			`circuit breaker: ${askEverything ? "tripped (asking for everything)" : `off (${consecutiveDenies}/${CIRCUIT_BREAKER_DENIES} consecutive denies)`}`,
		);
		return `automode status:\n${lines.join("\n")}`;
	}

	/** Last audit-log denials, newest last, capped at ten; the log is advisory so read errors degrade to "none". */
	function recentDenials(): string {
		if (!existsSync(auditPath())) {
			return "automode: no audit log yet — nothing has been denied";
		}
		const denials = recentDenialRows(Number.POSITIVE_INFINITY);
		if (denials.length === 0) {
			return "automode: no denials recorded";
		}
		const shown = denials.slice(-10);
		const rows = shown.map(
			(row) => `[${new Date(row.ts).toISOString()}] ${row.source}: ${row.command} — ${row.reason}`,
		);
		return `automode recent denials (last ${shown.length} of ${denials.length}):\n${rows.join("\n")}`;
	}

	/**
	 * Land a draft through the validated path: resolve the merge base from
	 * config.json exactly as it sits on disk, union the draft's arrays in,
	 * write atomically, then reload the session's rules. Returns false when
	 * the write is refused.
	 */
	function writeDraft(
		ctx: ExtensionContext,
		draft: SetupDraft,
		current: { rules: AutomodeRulesFile; source: AutomodeRulesSource },
	): boolean {
		// The merge base is the automode section exactly as config.json holds
		// it now — never the legacy file. With no section on disk, the base is
		// the effective rules only when config.json supplied them, else empty.
		const loaded = loadConfigFile();
		const existing = isPlainRecord(loaded.config["automode"])
			? loaded.config["automode"]
			: current.source === "config.json"
				? (current.rules as Record<string, unknown>)
				: {};
		const written = writeSection("automode", mergeDraftIntoSection(existing, draft));
		if (!written.ok) {
			ctx.ui.notify(`automode: ${written.error}`, "warning");
			return false;
		}
		ctx.ui.notify(
			`automode: wrote ${written.path} (reloads at next /automode toggle or session start)`,
			"info",
		);
		loadAutoConfig(ctx);
		return true;
	}

	/**
	 * /automode setup: draft environment and ask entries from the repo's git
	/**
	 * /automode setup: draft environment and ask entries from the repo's git
	 * remotes and the audit log's repeated denies, then — interactively —
	 * write them into config.json's automode section and reload the session's
	 * rules. Headless sessions only see the draft; the legacy automode.json
	 * is never written.
	 */
	async function runSetup(ctx: ExtensionContext): Promise<void> {
		const current = loadAutomodeRules();
		for (const warning of current.warnings) {
			ctx.ui.notify(`automode: ${warning}`, "warning");
		}
		const draft = buildSetupDraft(ctx.cwd, recentDenialRows(SETUP_DENIAL_SCAN), {
			rules: current.rules,
			source: current.source,
		});
		const payload = JSON.stringify(draftPayload(draft), null, 2);
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`automode setup draft:\n${payload}\nrerun in an interactive session to write`,
				"info",
			);
			return;
		}
		for (;;) {
			const choice = await ctx.ui.select(`automode setup draft:\n${draft.summary.join("\n")}`, [
				"Write",
				"Show full draft",
				"Discard",
			]);
			if (choice === "Show full draft") {
				ctx.ui.notify(`automode setup draft (full):\n${payload}`, "info");
				continue;
			}
			if (choice !== "Write") {
				ctx.ui.notify("automode: setup draft discarded; nothing written", "info");
				return;
			}
			writeDraft(ctx, draft, current);
			return;
		}
	}

	/**
	 * /automode setup apply <file>: land an already-reviewed draft file
	 * through the same validated merge the wizard uses. parseDraftFile refuses
	 * everything but environment and ask arrays, so trust prose and ask
	 * patterns are the only things a draft file can add. Interactive sessions
	 * confirm once more before the write; headless ones see the draft and a
	 * rerun hint, never a write.
	 */
	async function runSetupApply(ctx: ExtensionContext, file: string): Promise<void> {
		const target = path.resolve(ctx.cwd, file);
		const parsed = parseDraftFile(target);
		if (!parsed.ok) {
			ctx.ui.notify(`automode: ${parsed.error}`, "warning");
			return;
		}
		const current = loadAutomodeRules();
		for (const warning of current.warnings) {
			ctx.ui.notify(`automode: ${warning}`, "warning");
		}
		const payload = JSON.stringify(draftPayload(parsed.draft), null, 2);
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`automode setup draft (${target}):\n${payload}\nrerun in an interactive session to write`,
				"info",
			);
			return;
		}
		for (;;) {
			const choice = await ctx.ui.select(
				`automode setup draft (${target}):\n${parsed.draft.summary.join("\n")}`,
				["Write", "Show full draft", "Discard"],
			);
			if (choice === "Show full draft") {
				ctx.ui.notify(`automode setup draft (full):\n${payload}`, "info");
				continue;
			}
			if (choice !== "Write") {
				ctx.ui.notify("automode: setup draft discarded; nothing written", "info");
				return;
			}
			writeDraft(ctx, parsed.draft, { rules: current.rules, source: current.source });
			return;
		}
	}

	pi.registerCommand("automode", {
		description:
			"Show the automode permission status; /automode auto|default switches the session mode; /automode denied lists recent denials; /automode setup drafts config entries from git remotes and the audit log; /automode setup apply <file> lands a reviewed draft file (environment and ask only) through the same merge",
		handler: async (args: string, ctx: ExtensionContext) => {
			await ensureStartup(ctx);
			const raw = args.trim();
			const arg = raw.toLowerCase();
			if (arg === "") {
				ctx.ui.notify(await statusText(ctx), "info");
				return;
			}
			if (arg === "denied") {
				ctx.ui.notify(recentDenials(), "info");
				return;
			}
			if (arg === "setup") {
				await runSetup(ctx);
				return;
			}
			if (arg.startsWith("setup apply")) {
				const file = raw.slice("setup apply".length).trim();
				if (file === "") {
					ctx.ui.notify("automode: usage: /automode setup apply <draft.json>", "warning");
					return;
				}
				await runSetupApply(ctx, file);
				return;
			}
			if (arg !== "auto" && arg !== "default") {
				ctx.ui.notify(
					`automode: unknown mode "${args.trim()}" — usage: /automode [auto|default]`,
					"warning",
				);
				return;
			}
			if (startupMode === "bypass") {
				ctx.ui.notify(
					"automode: this session started in bypass mode, which is startup-only — restart with torus --permission-mode auto (or default) to change the permission posture",
					"warning",
				);
				return;
			}
			modeOverride = arg;
			cache.clear();
			consecutiveDenies = 0;
			askEverything = false;
			failopenReasons.clear();
			intentLines.length = 0;
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
