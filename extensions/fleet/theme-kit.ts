/**
 * torus — shared fleet rendering kit.
 *
 * The browser overlay, the fleet statusline strip, and the notify renderers
 * all draw the same agent rows (colors, spinners, token stats, previews);
 * these helpers are the single source of that presentation logic.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stableColorIndex } from "../registry.js";

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

/** Spinner/check/cross icon colored by status. */
export function statusIcon(
	theme: Theme,
	status: "running" | "done" | "failed",
	tick: number,
): string {
	if (status === "running") return theme.fg("warning", SPINNER[tick % SPINNER.length] ?? "•");
	if (status === "done") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
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
