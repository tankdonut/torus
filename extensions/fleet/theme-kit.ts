/**
 * torus — shared fleet rendering kit.
 *
 * The browser overlay, the fleet statusline strip, and the notify renderers
 * all draw the same agent rows (colors, spinners, token stats, previews);
 * these helpers are the single source of that presentation logic.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatCost } from "../fsutil.js";
import type { ExternalRun } from "../registry.js";

export type Theme = ExtensionContext["ui"]["theme"];
export type ThemeColor = Parameters<Theme["fg"]>[0];

export const AGENT_COLORS: ThemeColor[] = [
	"mdLink",
	"syntaxFunction",
	"mdHeading",
	"syntaxKeyword",
	"syntaxNumber",
	"syntaxType",
];

export const SPINNER: string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Stable per-entity hash bucket (same name → same bucket across processes). */
export function stableColorIndex(name: string, buckets: number): number {
	let hash = 7;
	for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + (name.codePointAt(i) ?? 0)) | 0;
	return Math.abs(hash) % Math.max(1, buckets);
}

/** Stable per-entity color (same name → same color across all fleet views). */
export function entityColor(name: string): ThemeColor {
	return AGENT_COLORS[stableColorIndex(name, AGENT_COLORS.length)] ?? "mdLink";
}

/** 1.2M / 3.4k / 12 — compact token counts. */
export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/** "zai/glm-5.3-flash" → "glm-5.3-flash"; unslugged names pass through. */
export function shortModel(model: string): string {
	return model.split("/")[1] ?? model;
}

/** 42000 → "42s", 62000 → "1m 02s", 3700000 → "1h 01m" — run durations. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/** Every run/wake status the fleet, doctor, and notification surfaces draw. */
export type StatusState =
	| "running"
	| "started"
	| "done"
	| "failed"
	| "stopped"
	| "changed"
	| "idle"
	| "wake"
	| "warn"
	| "memory"
	| "paused";

/**
 * The one status→glyph/color table behind every run, wake, and doctor marker.
 * `running` is the only animated state: it renders the SPINNER frame at `tick`.
 */
const STATUS_GLYPHS: Record<StatusState, { glyph: (tick: number) => string; color: ThemeColor }> = {
	running: { glyph: (tick) => SPINNER[tick % SPINNER.length] ?? "•", color: "warning" },
	started: { glyph: () => "▶", color: "warning" },
	done: { glyph: () => "✓", color: "success" },
	failed: { glyph: () => "✗", color: "error" },
	stopped: { glyph: () => "■", color: "warning" },
	changed: { glyph: () => "≈", color: "warning" },
	idle: { glyph: () => "·", color: "dim" },
	wake: { glyph: () => "☾", color: "warning" },
	warn: { glyph: () => "⚠", color: "warning" },
	memory: { glyph: () => "✿", color: "success" },
	paused: { glyph: () => "⏸", color: "dim" },
};

/** The table's glyph, theme-colored — the single renderer for run statuses. */
export function statusGlyph(theme: Theme, state: StatusState, tick = 0): string {
	const entry = STATUS_GLYPHS[state];
	return theme.fg(entry.color, entry.glyph(tick));
}

/** The table's bare glyph for themeless surfaces (doctor lines, toast summaries). */
export function statusGlyphText(state: StatusState, tick = 0): string {
	return STATUS_GLYPHS[state].glyph(tick);
}

/** Spinner/check/cross icon colored by status (the run-status slice of the table). */
export function statusIcon(
	theme: Theme,
	status: "running" | "done" | "failed",
	tick: number,
): string {
	return statusGlyph(theme, status, tick);
}

/** "torus-team:build-a1b2c3" → "build" (id suffix stripped); "" for other or missing sources. */
export function teamName(source: string | undefined): string {
	if (source === undefined || !source.startsWith("torus-team:")) return "";
	return source.slice("torus-team:".length).replace(/-[a-z0-9]+$/, "");
}

/** Badge text for an external-run source: "⧉build" for team members, "" otherwise. */
export function teamBadgeText(source: string | undefined): string {
	const name = teamName(source);
	return name === "" ? "" : `⧉${name}`;
}

/** External-run icon: idle members rest on the dim dot, everything else spins. */
export function externalRunIcon(theme: Theme, run: ExternalRun, tick: number): string {
	return run.memberStatus === "idle"
		? statusGlyph(theme, "idle")
		: statusGlyph(theme, "running", tick);
}

/** Delegation icon: a running delegation that is an idle team member rests
 * on the dim dot; every other status keeps its spinner/check/cross. */
export function delegationIcon(
	theme: Theme,
	status: "running" | "done" | "failed",
	run: ExternalRun | undefined,
	tick: number,
): string {
	return statusGlyph(
		theme,
		status === "running" && run?.memberStatus === "idle" ? "idle" : status,
		tick,
	);
}

/** The fleet stat grammar shared by the strip and the fleet browser:
 * "t3 · 1.2k→4.5k · $0.01 · 1m 02s". Idle runs stop at "t3 · idle"; finished
 * runs swap the turn prefix for a suffix ("3t"); `durationMs` omitted drops
 * the trailing duration segment. */
export function fleetStats(stats: {
	turns: number;
	tokensIn: number;
	tokensOut: number;
	cost?: number;
	durationMs?: number;
	idle?: boolean;
	finished?: boolean;
}): string {
	if (stats.idle === true) return `t${stats.turns} · idle`;
	const turns = stats.finished === true ? `${stats.turns}t` : `t${stats.turns}`;
	const cost = formatCost(stats.cost, stats.tokensIn + stats.tokensOut > 0);
	const head = `${turns} · ${formatTokens(stats.tokensIn)}→${formatTokens(stats.tokensOut)}${cost === "" ? "" : ` · ${cost}`}`;
	return stats.durationMs === undefined ? head : `${head} · ${formatDuration(stats.durationMs)}`;
}

/** Full-width dim horizontal rule. */
export function rule(theme: Theme, width: number, color: ThemeColor = "dim"): string {
	return theme.fg(color, "─".repeat(width));
}

/** Flatten unknown text to one line, trimmed and cut to `limit` chars. */
export function flattenPreview(text: unknown, limit: number, ellipsis = "…"): string {
	const flat = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
	return flat.length > limit ? `${flat.slice(0, limit - 1)}${ellipsis}` : flat;
}
