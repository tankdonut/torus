/**
 * torus — shared text sanitizers and one-line previews.
 *
 * A leaf module: it imports nothing from extensions/, so any module can pull
 * these formatters without closing an import cycle. The TUI, toasts, wake
 * markers, and logs all funnel untrusted model/tool text through
 * sanitizeRender before it reaches a renderer.
 */

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
