/**
 * torus — shared text sanitizers and one-line previews.
 *
 * A leaf module: it imports nothing from extensions/, so any module can pull
 * these formatters without closing an import cycle. The TUI, toasts, wake
 * markers, and logs all funnel untrusted model/tool text through
 * sanitizeRender before it reaches a renderer.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

/** Strip ANSI escape sequences and C1 control chars before text reaches the TUI. */
export function sanitizeRender(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b/g, "")
		.replace(/[\u0080-\u009F]/g, "");
}

/** Escape a literal string for interpolation into a RegExp source. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First meaningful line of a result, flattened and trimmed for the toast body. */
export function previewLine(text: string, max = 140): string {
	for (const raw of sanitizeRender(text).split("\n")) {
		const line = raw.trim().replace(/\s+/g, " ");
		if (line.length === 0) continue;
		return line.length > max ? `${line.slice(0, max - 1)}…` : line;
	}
	return "";
}

/**
 * The status band's head column: every banded row (the torus chip row, the
 * fleet strip, the goal banner) opens with a glyph plus a word, and heads
 * are padded to this many columns so the dim " · " separators stack into one
 * vertical line. Sized for "◆ fleet NN"; a wider head (a three-digit fleet
 * count) shifts only its own dot, never the other rows'.
 */
export const STATUS_HEAD_WIDTH = 10;

/**
 * Pad a status band row head to the head column: the width keys off the
 * plain head (a styled one cannot be measured; test painters wrap literal
 * tags no width helper strips), the style hook paints it, and plain spaces
 * fill the remainder so every row's separator lands in the same column.
 */
export function padStatusHead(
	head: string,
	style: (head: string) => string = (text) => text,
	width: number = STATUS_HEAD_WIDTH,
): string {
	const pad = width - visibleWidth(head);
	return style(head) + (pad > 0 ? " ".repeat(pad) : "");
}
