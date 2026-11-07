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
	type Component,
	foregroundAnsi,
	isAppleTerminalSession,
	rgbColor,
	type TerminalColorMode,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { knobBoolean, parseZeroDisables } from "../config/knobs.js";
import { installCursorBlink } from "../cursor-blink.js";
import { type EngineTally, reduceEngineEvent } from "../engine-child.js";
import { createFleetStrip, FLEET_WIDGET_KEY } from "../fleet/index.js";
import { formatCost } from "../fsutil.js";
import { connectedServerCount, mcpStatusText } from "../mcp/index.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { providerAvailabilities } from "../providers/index.js";
import {
	type DelegationRecord,
	onDelegationUsageChange,
	sessionPersona,
	sharedState,
} from "../registry.js";

export const PLATFORM_SUPPORT: PlatformSupport = { platforms: ["linux", "darwin", "win32"] };

export const STATUS_KEY = "torus";
const STATUSLINE_WIDGET_KEY = "torus-statusline";
const DOCK_GAP_WIDGET_KEY = "torus-dock-gap";

/** pi-lsp-client's ctx.ui.setStatus key (sha-pinned upstream; a rename degrades to the footer chip). */
const LSP_STATUS_KEY = "pi-lsp";
/** The absorbed lsp display text: on the Symbol.for global, not module state, so every ui module instance renders it. */
const LSP_TEXT_KEY = Symbol.for("torus.statusline.lsp.v1");
const STATUS_WRAP_MARK = Symbol.for("torus.status-absorb.v1");

function lspText(): string | undefined {
	return (globalThis as Record<symbol, unknown>)[LSP_TEXT_KEY] as string | undefined;
}

/** Persistent session-cost chip key; `torus:`-prefixed like the delegation markers. */
export const COST_STATUS_KEY = "torus:cost";

/**
 * The torus statusline chips live on a Symbol.for global, not module state:
 * pi gives each extension file its own module instance of this file, so
 * instance-local chips would vanish or split across instances. Undefined
 * removes a chip; the store re-renders through the widget's repaint hook.
 */
const CHIPS_KEY = Symbol.for("torus.statusline.chips.v1");
const CHIPS_REPAINT_KEY = Symbol.for("torus.statusline.repaint.v1");

function chipsStore(): Map<string, string> {
	const store = globalThis as Record<symbol, unknown>;
	let chips = store[CHIPS_KEY] as Map<string, string> | undefined;
	if (chips === undefined) {
		chips = new Map();
		store[CHIPS_KEY] = chips;
	}
	return chips;
}

/** Test/interop accessor: the live chip map (key → pre-styled text). */
export function torusChips(): Map<string, string> {
	return chipsStore();
}

/** Set or clear one torus statusline chip; repaints the widget when one is mounted. */
export function setTorusChip(key: string, text: string | undefined): void {
	const chips = chipsStore();
	if (text === undefined) chips.delete(key);
	else chips.set(key, text);
	const repaint = (globalThis as Record<symbol, unknown>)[CHIPS_REPAINT_KEY] as
		| (() => void)
		| undefined;
	repaint?.();
}

let ctxForStatusRefresh: ExtensionContext | null = null;

/**
 * Absorb pi-lsp-client's footer status into the main statusline segment. The
 * engine hands every extension in a session one shared ui context, so wrapping
 * its setStatus once per session_start intercepts pi-lsp's calls too: "LSP 2"
 * becomes an lsp:2 segment right after the mcp count (SGR colors arrive baked
 * in and survive verbatim) and the footer slot stays clear. Other keys pass
 * through untouched; a marker keeps re-fired session starts from stacking
 * wrappers on the same object.
 */
function installLspStatusAbsorb(ui: ExtensionContext["ui"]): void {
	const setStatus = ui.setStatus;
	const mark = setStatus as unknown as Record<symbol, boolean>;
	if (typeof setStatus !== "function" || mark[STATUS_WRAP_MARK]) {
		return;
	}
	const forward: (key: string, text: string | undefined) => void = setStatus.bind(ui);
	const wrapped = (key: string, text: string | undefined): void => {
		if (key === LSP_STATUS_KEY) {
			(globalThis as Record<symbol, unknown>)[LSP_TEXT_KEY] =
				text === undefined ? undefined : text.replaceAll("LSP ", "lsp:");
			if (ctxForStatusRefresh) refreshToruStatus(ctxForStatusRefresh);
			forward(key, undefined);
			return;
		}
		forward(key, text);
	};
	(wrapped as unknown as Record<symbol, boolean>)[STATUS_WRAP_MARK] = true;
	ui.setStatus = wrapped;
}

/**
 * The torus statusline: every chip on wrapping rows instead of the engine
 * footer's single truncated line. Chips render sorted by key (the order the
 * engine's footer used), greedily filled at the render width, capped at two
 * rows so a chip flood cannot squeeze the editor. Chip boundaries carry the
 * same dim " · " the composite torus chip joins its segments with, so the
 * whole strip reads as one series instead of dots collapsing into spaces
 * after the composite's last segment.
 */
class TorusStatusline implements Component {
	private readonly sep: string;

	constructor(sep: string) {
		this.sep = sep;
	}

	render(width: number): string[] {
		const chips = [...chipsStore().entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => text);
		if (chips.length === 0) return [];
		const rows: string[] = [];
		let row = "";
		for (const chip of chips) {
			const piece = truncateToWidth(chip, width);
			const candidate = row === "" ? piece : `${row}${this.sep}${piece}`;
			if (row === "" || visibleWidth(candidate) <= width) {
				row = candidate;
			} else {
				rows.push(row);
				row = piece;
				if (rows.length === 2) break;
			}
		}
		if (row !== "" && rows.length < 2) rows.push(row);
		return rows;
	}

	invalidate(): void {}
}

/**
 * The statusline component factory; session_start mounts it with the live
 * theme and tests drive it directly (no painter → plain separator).
 */
export function createTorusStatusline(painter?: StatusPainter): Component {
	return new TorusStatusline(painter ? painter.fg("dim", " · ") : " · ");
}

type AppTheme = ExtensionContext["ui"]["theme"];
export type StatusPainter = Pick<AppTheme, "fg" | "bold">;

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
 * Fleet spend per session: every registry run the session dispatched
 * (delegations, team members), folded per-record as a cost delta because
 * finished records evict from the registry — once a delta is folded the
 * total stands even after the record is gone. Symbol.for shared state for
 * the same reason the chip store is one: every ui module instance must see
 * the same numbers.
 */
const FLEET_SPEND_KEY = Symbol.for("torus.statusline.fleet-spend.v1");
type FleetSpendState = Map<string, { spend: number; seen: Map<string, number> }>;

function fleetSpendStore(): FleetSpendState {
	return sharedState(FLEET_SPEND_KEY, () => new Map());
}

/** Fold one usage-bearing record update into its parent session's fleet total. */
function foldFleetRecord(record: DelegationRecord): void {
	const parent = record.parentSession;
	if (parent === null) return;
	const store = fleetSpendStore();
	const bucket = store.get(parent) ?? { spend: 0, seen: new Map() };
	store.set(parent, bucket);
	bucket.spend += record.cost - (bucket.seen.get(record.id) ?? 0);
	// terminal records keep their seen entry forever: a second notification of
	// the same finish (multiple observers, a re-fired event) then folds zero
	// instead of re-adding the full cost. Entries are one id per finished run,
	// so the map stays trivially small.
	bucket.seen.set(record.id, record.cost);
}

function fleetSpendFor(sessionId: string): number {
	return fleetSpendStore().get(sessionId)?.spend ?? 0;
}

/**
 * Render the session-cost chip for ctx's session. formatCost yields "" when
 * nothing measurable happened — keep the entry absent rather than blank.
 * Registry spend dispatched by this session (delegations, team members)
 * appends as a warning-colored `+$fleet` suffix: `cost:$own+$fleet`, or a
 * bare `cost:+$fleet` when the session itself has spent nothing yet.
 */
function paintSessionCost(ctx: ExtensionContext): void {
	if (statuslineCostSuppressed()) return;
	const id = sessionCostId(ctx);
	const tally = sessionCostTallies.get(id);
	const cost = tally ? formatCost(tally.cost, tally.tokensIn + tally.tokensOut > 0) : "";
	const fleet = fleetSpendFor(id);
	const fleetCost = fleet > 0 ? formatCost(fleet, true) : "";
	if (cost === "" && fleetCost === "") {
		setTorusChip(COST_STATUS_KEY, undefined);
		return;
	}
	const plus = `+${fleetCost}`;
	const suffix = fleetCost === "" ? "" : ctx.ui.theme ? ctx.ui.theme.fg("warning", plus) : plus;
	setTorusChip(COST_STATUS_KEY, `cost:${cost}${suffix}`);
}

/**
 * Seed the session-cost tally from the session's own entries so a resumed
 * session keeps the spend its earlier engine process recorded: the live
 * tally only ever sees message_end events, so without seeding every restart
 * resets the chip to absent until a new turn completes. Runs only when no
 * tally exists yet (an in-process tally is always at least as fresh as the
 * entry list) and folds assistant messages through the same reducer
 * message_end uses, so both halves of a resumed session total identically.
 */
function seedSessionCost(ctx: ExtensionContext): void {
	if (statuslineCostSuppressed()) return;
	const id = sessionCostId(ctx);
	if (id === "" || sessionCostTallies.has(id)) return;
	let entries: ReturnType<NonNullable<ExtensionContext["sessionManager"]>["getEntries"]>;
	try {
		entries = ctx.sessionManager?.getEntries() ?? [];
	} catch {
		// a session manager without getEntries (fakes, partial surfaces) has nothing to seed
		return;
	}
	const tally = freshSessionTally();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		reduceEngineEvent({ type: "message_end", message: entry.message }, tally);
	}
	sessionCostTallies.set(id, tally);
}

/** Current model / thinking effort, seeded from ctx and kept fresh via events. */
let currentModel: string | undefined;
let currentEffort: string | undefined;

/** MCP connected/registered counts; refreshed on session_start + turn_start and by the settle-poll below. */
let mcpCounts = { connected: 0, registered: 0 };

/**
 * Settle-poll timer: MCP connections come up in the background after session_start and pi emits
 * no event when one connects (mcp_servers_change fires only on register/unregister), so without
 * polling the first statusline paint would show mcp:0 until the first prompt's turn_start.
 */
let mcpPollTimer: ReturnType<typeof setInterval> | undefined;

/** Active or paused session goal, pushed by the goal extension; complete/unset drops the segment. */
export interface GoalChip {
	head: string;
	status: "active" | "paused";
}
let goalChip: GoalChip | undefined;

/**
 * Permission-mode chip state pushed by the automode extension. Lives on a
 * Symbol.for global, not module state: pi gives each extension file its own
 * module instance of this file, and an instance-local chip would vanish the
 * next time a different instance repaints the torus segment.
 */
const PERMISSION_KEY = Symbol.for("torus.status.permission.v1");
type PermissionChip = { kind: "default" | "auto" | "bypass"; degraded: boolean };

function permissionChip(): PermissionChip | undefined {
	return (globalThis as Record<symbol, unknown>)[PERMISSION_KEY] as PermissionChip | undefined;
}

/**
 * Prod hook for the automode extension. The chip is always on, in the sbx:
 * style: dim `perm:default`, green `perm:auto` (amber `perm:auto·ask` once the
 * circuit breaker degrades the session to asking), red `perm:bypass` for the
 * whole startup-locked session so the missing guards stay visible. Toggle
 * rides `/automode auto|default`.
 */
export function setStatusPermission(mode: "auto" | "default" | "bypass", degraded = false): void {
	(globalThis as Record<symbol, unknown>)[PERMISSION_KEY] = {
		kind: mode,
		degraded: mode === "auto" && degraded,
	};
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
	critic: [255, 140, 0],
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
	const permission = permissionChip();
	if (permission) {
		const text =
			permission.kind === "bypass"
				? "perm:bypass"
				: permission.kind === "default"
					? "perm:default"
					: permission.degraded
						? "perm:auto·ask"
						: "perm:auto";
		const color =
			permission.kind === "bypass"
				? "error"
				: permission.kind === "default"
					? "dim"
					: permission.degraded
						? "warning"
						: "success";
		segments.push(theme ? theme.fg(color, text) : text);
	}
	const mcpText = mcpStatusText(mcpCounts.connected, mcpCounts.registered);
	if (mcpText) {
		const color = mcpCounts.connected > 0 ? "success" : "warning";
		segments.push(theme ? theme.fg(color, mcpText) : mcpText);
	}
	// the absorbed pi-lsp status: pre-styled (SGR baked in), rendered right after
	// the mcp count so the two health chips read as one group
	const lsp = lspText();
	if (lsp) segments.push(lsp);
	if (goalChip) {
		// state rides the color, not an icon: warning while active, dim while paused
		const color = goalChip.status === "active" ? "warning" : "dim";
		const text = `goal:${goalChip.head}`;
		segments.push(theme ? theme.fg(color, text) : text);
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
	setTorusChip(STATUS_KEY, buildStatus(ctx.ui.theme));
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

const CURSOR_BLINK_WIDGET_KEY = "torus:cursor-blink";

/**
 * Blink active input cursors (editor, dialogs) from a zero-line widget whose
 * factory is the reliable spot to capture the live TUI. Dialog-opening code
 * re-installs on mode switches, which hand extensions a fresh TUI.
 */
function installCursorBlinkWidget(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	ctx.ui.setWidget(CURSOR_BLINK_WIDGET_KEY, (tui) => {
		installCursorBlink(tui);
		return {
			render: (_width: number): string[] => [],
			invalidate: () => {},
		};
	});
}

export function registerUi(pi: ExtensionAPI): void {
	// fleet spend rides delegation record updates: fold each into the
	// session-keyed total and repaint when a live ctx exists (module-level
	// subscribe; the store itself is shared so any instance's fold counts)
	onDelegationUsageChange((record) => {
		foldFleetRecord(record);
		if (ctxForStatusRefresh) paintSessionCost(ctxForStatusRefresh);
	});

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
		// a fresh session has spent nothing yet — drop any chip from the prior one;
		// a resumed one seeds its past spend from the session entries first
		seedSessionCost(ctx);
		paintSessionCost(ctx);
		ctx.ui.setWidget(STATUSLINE_WIDGET_KEY, (tui, theme) => {
			(globalThis as Record<symbol, unknown>)[CHIPS_REPAINT_KEY] = () => tui.requestRender();
			return createTorusStatusline(theme);
		});
		// Re-register the fleet strip after the chip rows: widget insertion
		// order is registration order, and the fleet extension registers
		// before this one — without this the strip would sit above the chips.
		ctx.ui.setWidget(FLEET_WIDGET_KEY, (tui, theme) => createFleetStrip(tui, theme));
		// The engine spaces the chat side of the widget dock with a leading
		// spacer but leaves the editor side flush; one blank row keeps the
		// chips/strip off the editor border (and its embedded working spinner).
		ctx.ui.setWidget(DOCK_GAP_WIDGET_KEY, () => ({
			render: () => [""],
			invalidate: () => {},
		}));
		installStartupBanner(pi, ctx);
		installCursorBlinkWidget(ctx);
		if (ctx.mode === "tui") {
			ctxForStatusRefresh = ctx;
			installLspStatusAbsorb(ctx.ui);
		}
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
}

export default function uiExtension(pi: ExtensionAPI): void {
	if (!gateExtension("ui", PLATFORM_SUPPORT)) return;
	registerUi(pi);
}
