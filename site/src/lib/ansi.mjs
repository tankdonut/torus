/**
 * ANSI screen parser for tmux `capture-pane -e` output.
 *
 * The site renders real TUI captures (see scripts/capture-tui.mjs) instead of
 * hand-drawn terminal mockups: this module turns captured SGR escape sequences
 * into styled runs that TuiCapture.astro maps to HTML at build time. Only the
 * subset the engine's TUI emits is supported (truecolor/256/palette fg+bg,
 * bold, italic, underline, dim, inverse, reset); every other CSI/OSC sequence
 * is stripped so the parser stays total over real captures.
 */

/** xterm 16-color palette, indexes 0-15 (SGR 30-37/90-97 and 40-47/100-107). */
const PALETTE_16 = [
	"#000000",
	"#800000",
	"#008000",
	"#808000",
	"#000080",
	"#800080",
	"#008080",
	"#c0c0c0",
	"#808080",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#0000ff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

/** xterm 256-color cube/grey ramp for indexes 16-255. */
function palette256(index) {
	if (index < 16) return PALETTE_16[index];
	if (index < 232) {
		const stepped = (i) => [0, 95, 135, 175, 215, 255][i] ?? 0;
		const n = index - 16;
		return `rgb(${stepped(Math.floor(n / 36))},${stepped(Math.floor(n / 6) % 6)},${stepped(n % 6)})`;
	}
	const grey = 8 + (index - 232) * 10;
	return `rgb(${grey},${grey},${grey})`;
}

/**
 * A run of text sharing one style. Colors are CSS color strings; absent
 * properties fall back to the terminal defaults the renderer applies.
 *
 * @typedef {object} Run
 * @property {string} text
 * @property {string} [fg]
 * @property {string} [bg]
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [underline]
 * @property {boolean} [dim]
 * @property {boolean} [inverse]
 */

const emptyStyle = () => ({});

/** Apply one SGR parameter list to a style state object (mutates it). */
function applySgr(style, params) {
	const codes = params === "" ? ["0"] : params.split(";");
	for (let i = 0; i < codes.length; i++) {
		const code = Number.parseInt(codes[i] ?? "", 10);
		if (Number.isNaN(code)) continue;
		if (code === 0) {
			for (const key of Object.keys(style)) delete style[key];
		} else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 7) style.inverse = true;
		else if (code === 22) {
			delete style.bold;
			delete style.dim;
		} else if (code === 23) delete style.italic;
		else if (code === 24) delete style.underline;
		else if (code === 27) delete style.inverse;
		else if (code >= 30 && code <= 37) style.fg = PALETTE_16[code - 30];
		else if (code === 39) delete style.fg;
		else if (code >= 40 && code <= 47) style.bg = PALETTE_16[code - 40];
		else if (code === 49) delete style.bg;
		else if (code >= 90 && code <= 97) style.fg = PALETTE_16[code - 90 + 8];
		else if (code >= 100 && code <= 107) style.bg = PALETTE_16[code - 100 + 8];
		else if (code === 38 || code === 48) {
			const key = code === 38 ? "fg" : "bg";
			const mode = Number.parseInt(codes[i + 1] ?? "", 10);
			if (mode === 2) {
				const r = Number.parseInt(codes[i + 2] ?? "", 10);
				const g = Number.parseInt(codes[i + 3] ?? "", 10);
				const b = Number.parseInt(codes[i + 4] ?? "", 10);
				if ([r, g, b].every((v) => v >= 0 && v <= 255)) style[key] = `rgb(${r},${g},${b})`;
				i += 4;
			} else if (mode === 5) {
				const n = Number.parseInt(codes[i + 2] ?? "", 10);
				if (n >= 0 && n <= 255) style[key] = palette256(n);
				i += 2;
			}
		}
	}
}

/** True when two style objects render identically. */
function sameStyle(a, b) {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (Boolean(a[key]) !== Boolean(b[key]) && key !== "fg" && key !== "bg") return false;
		if (key === "fg" && a.fg !== b.fg) return false;
		if (key === "bg" && a.bg !== b.bg) return false;
	}
	return true;
}

const CSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Parse a captured screen into styled lines. Style state carries across lines
 * the way a terminal carries it; trailing whitespace is kept only when styled
 * (unstyled trailing blanks would collapse anyway).
 *
 * @param {string} raw capture-pane -e output
 * @returns {Run[][]}
 */
export function parseAnsiScreen(raw) {
	const clean = raw.replace(OSC_RE, "").replace(/\r/g, "");
	const lines = [];
	let line = [];
	const style = emptyStyle();
	let current = null;

	const pushText = (text) => {
		if (text === "") return;
		if (current && sameStyle(current.style, style)) {
			current.run.text += text;
		} else {
			current = { run: { text, ...style }, style: { ...style } };
			line.push(current.run);
		}
	};

	let index = 0;
	while (index < clean.length) {
		const char = clean[index];
		if (char === "\x1b") {
			const rest = clean.slice(index);
			const match = rest.match(/^\x1b\[([0-9;?]*)([A-Za-z])/);
			if (match) {
				if (match[2] === "m") applySgr(style, match[1].replace(/\?/g, ""));
				index += match[0].length;
				continue;
			}
			const osc = rest.match(OSC_RE);
			if (osc) {
				index += osc[0].length;
				continue;
			}
			// Unknown escape: drop the introducer and continue with the next char.
			index += 1;
			continue;
		}
		if (char === "\n") {
			lines.push(line);
			line = [];
			current = null;
			index += 1;
			continue;
		}
		pushText(char);
		index += 1;
	}
	lines.push(line);
	return lines;
}

/**
 * Crop parsed lines: drop leading/trailing all-blank lines, then keep the
 * requested window. `keepLast` keeps the bottom n lines (fleet sheets render
 * at the bottom of the pane); `from`/`to` are 0-based indexes into the
 * blank-trimmed lines, negative counts from the end.
 *
 * @param {Run[][]} lines
 * @param {{keepLast?: number, from?: number, to?: number}} range
 * @returns {Run[][]}
 */
export function cropLines(lines, range = {}) {
	const blank = (l) => l.every((run) => run.text.trim() === "");
	let start = 0;
	let end = lines.length;
	while (start < end && blank(lines[start])) start += 1;
	while (end > start && blank(lines[end - 1])) end -= 1;
	const trimmed = lines.slice(start, end);
	if (typeof range.keepLast === "number") return trimmed.slice(-range.keepLast);
	let from = range.from ?? 0;
	let to = range.to ?? trimmed.length;
	if (from < 0) from = Math.max(0, trimmed.length + from);
	if (to < 0) to = trimmed.length + to;
	return trimmed.slice(Math.max(0, from), Math.min(trimmed.length, to));
}
