import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	keyHint,
	keyText,
	rawKeyHint,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	foregroundAnsi,
	isAppleTerminalSession,
	rgbColor,
	type TerminalColorMode,
} from "@earendil-works/pi-tui";
import { knobBoolean, parseZeroDisables } from "../config/knobs.js";
import { type EngineTally, reduceEngineEvent } from "../engine-child.js";
import { formatCost } from "../fsutil.js";
import { connectedServerCount, mcpStatusText } from "../mcp/index.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { providerAvailabilities } from "../providers/index.js";
import { sessionPersona } from "../registry.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

export const STATUS_KEY = "torus";

/** Persistent session-cost chip key; `torus:`-prefixed like the delegation markers. */
export const COST_STATUS_KEY = "torus:cost";

type AppTheme = ExtensionContext["ui"]["theme"];
export type StatusPainter = Pick<AppTheme, "fg" | "bold">;

/** Delegation tool executions that count toward the in-flight statusline chip. */
const DELEGATION_TOOLS = new Set([
	"torus_delegate",
	"torus_fanout",
	"torus_chain",
	"torus_results",
]);

/** In-flight delegation tool executions; parallel fanouts must not wipe each other's indicator. */
let delegateInFlight = 0;

/**
 * Session-cost tallies behind the `torus:cost` chip, keyed by session id so a
 * switch back to an earlier in-process session restores its own total. Fed
 * through the shared engine-child reducer — the same math every delegation
 * surface uses — never a second cost parser.
 */
const sessionCostTallies = new Map<string, EngineTally>();

function freshSessionTally(): EngineTally {
	return { turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, cost: 0, text: "" };
}

/** Session id for cost keying; contexts without a session manager share one bucket. */
function sessionCostId(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId() ?? "";
}

/** TORUS_STATUSLINE_COST=0, or ui.statuslineCost=false in config.json, never touches the cost key — no set, no clear. */
function statuslineCostSuppressed(): boolean {
	return !knobBoolean("TORUS_STATUSLINE_COST", "ui", "statuslineCost", true, parseZeroDisables);
}

/**
 * Render the session-cost chip for ctx's session. formatCost yields "" when
 * nothing measurable happened — keep the entry absent rather than blank.
 */
function paintSessionCost(ctx: ExtensionContext): void {
	if (statuslineCostSuppressed()) return;
	const tally = sessionCostTallies.get(sessionCostId(ctx));
	const text = tally ? formatCost(tally.cost, tally.tokensIn + tally.tokensOut > 0) : "";
	ctx.ui.setStatus(COST_STATUS_KEY, text === "" ? undefined : text);
}

/** Current model / thinking effort, seeded from ctx and kept fresh via events. */
let currentModel: string | undefined;
let currentEffort: string | undefined;

/** MCP connected/registered counts; refreshed on session_start + turn_start and by the settle-poll below. */
let mcpCounts = { connected: 0, registered: 0 };

/**
 * Settle-poll timer: MCP connections come up in the background after session_start and pi emits
 * no event when one connects (mcp_servers_change fires only on register/unregister), so without
 * polling the first statusline paint would show MCP 0 until the first prompt's turn_start.
 */
let mcpPollTimer: ReturnType<typeof setInterval> | undefined;

/** Active or paused session goal, pushed by the goal extension; complete/unset drops the segment. */
export interface GoalChip {
	head: string;
	status: "active" | "paused";
}
let goalChip: GoalChip | undefined;

/** Permission-mode chip state pushed by the automode extension; unset in default mode. */
let permissionChip: { kind: "auto" | "bypass"; degraded: boolean } | undefined;

/**
 * Prod hook for the automode extension: auto mode renders a statusline chip
 * (`auto`, or `auto·ask` once the circuit breaker degrades the session to
 * asking); bypass mode renders a red `bypass` chip for the whole session so
 * the missing guards stay visible; default mode drops it.
 */
export function setStatusPermission(mode: "auto" | "default" | "bypass", degraded = false): void {
	permissionChip =
		mode === "default" ? undefined : { kind: mode, degraded: mode === "auto" && degraded };
}

/**
 * Persona colors are raw RGB (truecolor) rather than theme keys: distinct
 * keys can resolve to identical colors in a theme (observed collisions made
 * personas indistinguishable), and raw values keep the editor border and the
 * statusline chip exactly in sync on every surface.
 */
export const PERSONA_COLORS: Record<string, [number, number, number]> = {
	leader: [86, 182, 194],
	builder: [80, 250, 123],
	explorer: [241, 196, 15],
	librarian: [189, 147, 249],
	reviewer: [255, 85, 85],
	dreamer: [255, 121, 198],
	looker: [142, 200, 255],
};

export function personaFg(persona: string, text: string): string {
	const rgb = PERSONA_COLORS[persona];
	if (!rgb) return text;
	const [r, g, b] = rgb;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** Test/interop hook: set the model+effort state the statusline renders. */
export function setStatusModel(model: string | undefined, effort: string | undefined): void {
	currentModel = model;
	currentEffort = effort;
}

/** Test/interop hook: set the MCP counts and goal chip the statusline renders. */
export function setStatusExtras(
	mcp: { connected: number; registered: number } | null,
	goal: GoalChip | null,
): void {
	mcpCounts = mcp ?? { connected: 0, registered: 0 };
	goalChip = goal ?? undefined;
}

/** Prod hook for the goal extension: replace the rendered goal chip. */
export function setStatusGoal(goal: GoalChip | undefined): void {
	goalChip = goal;
}

/** Test/interop hook: whether the post-session_start MCP settle-poll is still running. */
export function mcpSettlePollActive(): boolean {
	return mcpPollTimer !== undefined;
}

function shortModelId(id: string): string {
	const slash = id.indexOf("/");
	return slash === -1 ? id : id.slice(slash + 1);
}

export function buildStatus(theme?: StatusPainter): string {
	const available = providerAvailabilities();
	const engine = process.env["TORUS_ENGINE"] ?? "pi";
	const providers =
		(["zai", "opencode-go"] as const).filter((p) => available[p]).join("|") || "no-keys";
	const persona = sessionPersona();

	const sep = theme ? theme.fg("dim", " · ") : " · ";
	const brand = theme ? theme.fg("accent", theme.bold("torus")) : "torus";

	const segments = [brand];
	// identity block: persona, model, and thinking effort share the persona
	// color so the active configuration reads as one group; model ids are
	// shortened ("zai/glm-4.7" -> "glm-4.7") to keep the line short
	const modelText = currentModel ? shortModelId(currentModel) : undefined;
	if (persona) {
		segments.push(personaFg(persona, persona));
		if (modelText) segments.push(personaFg(persona, modelText));
		if (currentEffort) segments.push(personaFg(persona, currentEffort));
	} else if (modelText) {
		segments.push(theme ? theme.fg("dim", modelText) : modelText);
	}
	segments.push(theme ? theme.fg("dim", providers) : providers);
	// the stock engine is the norm — tag the line only when overridden
	if (engine !== "pi") {
		segments.push(theme ? theme.fg("dim", `[${engine}]`) : `[${engine}]`);
	}
	if (permissionChip) {
		const text =
			permissionChip.kind === "bypass" ? "bypass" : permissionChip.degraded ? "auto·ask" : "auto";
		const color =
			permissionChip.kind === "bypass" ? "error" : permissionChip.degraded ? "warning" : "success";
		segments.push(theme ? theme.fg(color, text) : text);
	}
	const mcpText = mcpStatusText(mcpCounts.connected, mcpCounts.registered);
	if (mcpText) {
		const color = mcpCounts.connected > 0 ? "success" : "warning";
		segments.push(theme ? theme.fg(color, mcpText) : mcpText);
	}
	if (goalChip) {
		const icon = goalChip.status === "active" ? "▶" : "⏸";
		const text = `${icon} ${goalChip.head}`;
		const color = goalChip.status === "active" ? "warning" : "dim";
		segments.push(theme ? theme.fg(color, text) : text);
	}
	if (delegateInFlight > 0) {
		const tag = delegateInFlight > 1 ? `delegate ×${delegateInFlight}` : "delegate";
		segments.push(theme ? theme.fg("warning", tag) : tag);
	}
	return segments.join(sep);
}

/**
 * Single render path for the torus statusline key. Live ctx wins over the
 * cached model/effort: other manifest entries (prompts, goal) repaint through
 * their own module instance of this file, where the event-fed cache never
 * receives model_select — and same-model persona switches emit no event at
 * all — so any stale cache would paint a model the engine already left.
 */
export function refreshToruStatus(ctx: ExtensionContext): void {
	currentModel = ctx.model?.id ?? currentModel;
	currentEffort = ctx.thinkingLevel ?? currentEffort;
	ctx.ui.setStatus(STATUS_KEY, buildStatus(ctx.ui.theme));
}

/** TORUS_BANNER=0, or ui.banner=false in config.json, keeps pi's built-in startup header instead of the torus banner. */
function bannerSuppressed(): boolean {
	return !knobBoolean("TORUS_BANNER", "ui", "banner", true, parseZeroDisables);
}

const RESET = "\x1b[0m";

/** torus brand palette: muted teal ring with a single amber glint, fixed across themes (like pi's coral/blue/yellow). */
const TORUS_TEAL = rgbColor(111, 179, 168);
const TORUS_AMBER = rgbColor(230, 182, 93);

/**
 * The torus mark: a 6x4 pixel ring in brand teal with an amber glint nested
 * in the bottom-right notch. Two text lines of half blocks (each cell is two
 * vertical pixels); the glint cell stacks teal over amber via fg+bg.
 */
export function torusLogoLines(mode: TerminalColorMode): [string, string] {
	const teal = (text: string) => foregroundAnsi(TORUS_TEAL, mode) + text + RESET;
	const top = teal("▄▄▀▀▄▄");
	const bottom =
		teal("▀▀▄▄▀") +
		foregroundAnsi(TORUS_AMBER, mode) +
		backgroundAnsi(TORUS_TEAL, mode) +
		"▀" +
		RESET;
	return [top, bottom];
}

/** Text fallback for the mark: "torus" in the brand teal and amber. */
export function torusWordmark(mode: TerminalColorMode): string {
	return (
		foregroundAnsi(TORUS_TEAL, mode) +
		"to" +
		RESET +
		foregroundAnsi(TORUS_AMBER, mode) +
		"rus" +
		RESET
	);
}

/** Apple Terminal draws gaps between rows and misaligns half blocks; it gets the wordmark instead. */
export function supportsTorusLogo(): boolean {
	return !isAppleTerminalSession();
}

/** torus payload version from the package manifest; engine version is VERSION. */
// The header render closure calls this on every repaint, so the manifest read
// is memoized: resolved once per process, env override honored on that first call.
let cachedVersion: string | null = null;

function torusVersion(): string {
	if (cachedVersion !== null) return cachedVersion;
	const candidates = [
		process.env["TORUS_ROOT"],
		path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
	];
	for (const root of candidates) {
		if (!root) continue;
		try {
			const version: string = JSON.parse(
				readFileSync(path.join(root, "package.json"), "utf8"),
			).version;
			cachedVersion = version;
			return version;
		} catch {
			// manifest missing or unreadable: fall through to the next candidate
		}
	}
	cachedVersion = "unknown";
	return cachedVersion;
}

/** Compact keybinding hint line, mirroring the engine's collapsed header. */
function compactHints(painter: StatusPainter): string {
	return [
		keyHint("app.interrupt", "interrupt"),
		rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawKeyHint("/", "commands"),
		rawKeyHint("!", "bash"),
		keyHint("app.tools.expand", "more"),
	].join(painter.fg("muted", " · "));
}

/** Full keybinding hint rows, mirroring the engine's expanded header. */
function expandedHints(): string[] {
	return [
		keyHint("app.interrupt", "to interrupt"),
		keyHint("app.clear", "to clear"),
		rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
		keyHint("app.exit", "to exit (empty)"),
		keyHint("app.suspend", "to suspend"),
		keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
		keyHint("app.thinking.cycle", "to cycle thinking level"),
		rawKeyHint(
			`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`,
			"to cycle models",
		),
		keyHint("app.model.select", "to select model"),
		keyHint("app.tools.expand", "to expand tools"),
		keyHint("app.thinking.toggle", "to expand thinking"),
		keyHint("app.editor.external", "for external editor"),
		rawKeyHint("/", "for commands"),
		rawKeyHint("!", "to run bash"),
		rawKeyHint("!!", "to run bash (no context)"),
		keyHint("app.message.followUp", "to queue follow-up"),
		keyHint("app.message.dequeue", "to edit all queued messages"),
		keyHint("app.clipboard.pasteImage", "to paste files on macOS, images, or text"),
		rawKeyHint("drop files", "to attach"),
	];
}

/** Torus-native rows for the expanded banner: fleet and launcher surfaces. */
function torusHintRows(painter: StatusPainter): [string, string] {
	const sep = painter.fg("muted", " · ");
	return [
		[
			rawKeyHint("/roster", "list agents"),
			rawKeyHint("/doctor", "health check"),
			rawKeyHint("alt+t", "fleet view"),
		].join(sep),
		[
			rawKeyHint("torus serve", "HTTP server"),
			rawKeyHint("torus acp-agent", "ACP over stdio"),
			rawKeyHint("torus --help", "full CLI help"),
		].join(sep),
	];
}

export interface BannerOptions {
	expanded: boolean;
	version: string;
	engineVersion: string;
	/** Whether the loaded-resources listing is visible (quietStartup "header" hides it). */
	showDetails: boolean;
	/** Render the half-block mark; false forces the text wordmark. Defaults to terminal support. */
	logo?: boolean;
}

/** Painter subset the banner needs: theme colors plus the terminal color mode for brand ANSI. */
export type BannerPainter = StatusPainter & { getColorMode(): TerminalColorMode };

/** Startup banner lines: torus branding and native surfaces, engine hints below. */
export function bannerLines(painter: BannerPainter, options: BannerOptions): string[] {
	const version = `${options.version} ${painter.fg("dim", `(pi@${options.engineVersion})`)}`;
	const onboarding = painter.fg(
		"dim",
		"Ask how to use or extend torus; pi can explain its own features and docs.",
	);
	const logo = options.logo ?? supportsTorusLogo();
	// The mark's first line carries the version, its second line the first hint row, mirroring pi's logo layout.
	const lead = (firstRow: string): string[] => {
		if (!logo) return [`${torusWordmark(painter.getColorMode())} ${version}`, firstRow];
		const [top, bottom] = torusLogoLines(painter.getColorMode());
		return [`${top} ${version}`, `${bottom} ${firstRow}`];
	};
	if (options.expanded) {
		const [fleet, launcher] = torusHintRows(painter);
		return [...lead(fleet), launcher, "", ...expandedHints(), "", onboarding];
	}
	const detailsSuffix = options.showDetails ? " and loaded resources" : "";
	return [
		...lead(compactHints(painter)),
		painter.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} to show full startup help${detailsSuffix}.`,
		),
		"",
		onboarding,
	];
}

/**
 * Replace pi's built-in startup header with the torus banner (interactive
 * only). Respects quietStartup: true silencing and TORUS_BANNER=0; hint rows
 * come from the live keybinding config, and ctrl+o expansion keeps working
 * because the component implements setExpanded.
 */
function installStartupBanner(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	if (pi.getSettings().quietStartup === true) return;
	if (bannerSuppressed()) return;
	const showDetails = pi.getSettings().quietStartup !== "header";
	let expanded = false;
	ctx.ui.setHeader((_tui, theme) => {
		const header = {
			render: (_width: number): string[] =>
				bannerLines(theme, {
					expanded,
					version: torusVersion(),
					engineVersion: VERSION,
					showDetails,
				}),
			invalidate: () => {},
			setExpanded: (value: boolean) => {
				expanded = value;
			},
		};
		return header;
	});
}

export function registerUi(pi: ExtensionAPI): void {
	const refreshMcp = () => {
		const registered = pi.getMcpServers().map((server) => server.name);
		mcpCounts = {
			connected: connectedServerCount(registered, pi.getActiveTools()),
			registered: registered.length,
		};
	};

	const stopMcpPoll = () => {
		if (mcpPollTimer !== undefined) {
			clearInterval(mcpPollTimer);
			mcpPollTimer = undefined;
		}
	};

	/** Poll until every registered server is connected (or the deadline passes), repainting on change. */
	const pollMcpUntilSettled = (ctx: ExtensionContext) => {
		stopMcpPoll();
		const deadline = Date.now() + 30_000;
		const timer = setInterval(() => {
			const before = mcpCounts.connected;
			refreshMcp();
			if (mcpCounts.connected !== before) refreshToruStatus(ctx);
			const settled = mcpCounts.registered === 0 || mcpCounts.connected >= mcpCounts.registered;
			if (settled || Date.now() >= deadline) stopMcpPoll();
		}, 250);
		// never hold the process (or a test run) open just for this poll
		timer.unref?.();
		mcpPollTimer = timer;
	};

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		currentModel = ctx.model?.id;
		currentEffort = ctx.thinkingLevel;
		refreshMcp();
		pollMcpUntilSettled(ctx);
		refreshToruStatus(ctx);
		// a fresh session has spent nothing yet — drop any chip from the prior one
		paintSessionCost(ctx);
		installStartupBanner(pi, ctx);
	});

	pi.on("turn_start", (_event, ctx: ExtensionContext) => {
		refreshMcp();
		refreshToruStatus(ctx);
	});

	pi.on("message_end", (event, ctx: ExtensionContext) => {
		if (statuslineCostSuppressed()) return;
		const id = sessionCostId(ctx);
		const tally = sessionCostTallies.get(id) ?? freshSessionTally();
		reduceEngineEvent(event as unknown as Record<string, unknown>, tally);
		sessionCostTallies.set(id, tally);
		paintSessionCost(ctx);
	});

	pi.on("model_select", (event, ctx: ExtensionContext) => {
		currentModel = event.model.id;
		refreshToruStatus(ctx);
	});

	pi.on("thinking_level_select", (event, ctx: ExtensionContext) => {
		currentEffort = event.level;
		refreshToruStatus(ctx);
	});

	pi.on("tool_execution_start", (event, ctx: ExtensionContext) => {
		if (DELEGATION_TOOLS.has(event.toolName)) {
			delegateInFlight += 1;
			refreshToruStatus(ctx);
		}
	});

	pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
		if (DELEGATION_TOOLS.has(event.toolName)) {
			delegateInFlight = Math.max(0, delegateInFlight - 1);
			if (delegateInFlight === 0) refreshToruStatus(ctx);
		}
	});
}

export default function uiExtension(pi: ExtensionAPI): void {
	if (!gateExtension("ui", PLATFORM_SUPPORT)) return;
	registerUi(pi);
}
