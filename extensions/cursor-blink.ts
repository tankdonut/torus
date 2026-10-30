/**
 * torus — blinking input cursors.
 *
 * Pi draws input cursors as fake-cursor blocks (reverse-video cells) resolved
 * by the TUI; a focused input prefixes its cursor with CURSOR_MARKER so the
 * terminal can also position the hardware cursor there. That marker is the
 * "this input is active" signal: installCursorBlink patches the TUI's cursor
 * resolver so marked cursors blink in lockstep while an active input is on
 * screen, and unmarked ones (an unfocused editor, for instance) stay steady.
 * flickers.
 *
 * Terminal-window focus gates the blink (DECSET 1004 focus reporting:
 * blurred window — steady cursor, focused window — blinking). Terminals
 * without focus reporting never send the events, so the default stays
 * blinking.
 */
import { CURSOR_MARKER, renderFakeCursor, type TUI } from "@earendil-works/pi-tui";

/** Classic terminal cursor blink period. */
export const BLINK_INTERVAL_MS = 530;

// Fake-cursor markers are not exported; derive them from the public wrapper.
// If the wrapper ever changes shape these become bogus strings that simply
// never occur in rendered lines, so the blink stays off instead of breaking.
const [CURSOR_START, CURSOR_END] = renderFakeCursor("\u0000").split("\u0000") as [string, string];

/** A focused input's cursor: the hardware-position marker glued to its block. */
const ACTIVE_CURSOR = `${CURSOR_MARKER}${CURSOR_START}`;

/** DECSET 1004 focus events: the terminal window gained / lost focus. */
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

let windowFocused = true;
let activeTui: TUI | null = null;

/** True where a line carries a cursor of an input that currently has focus. */
function hasActiveCursor(line: string): boolean {
	return line.includes(ACTIVE_CURSOR);
}

/**
 * Strip DECSET 1004 focus sequences from a raw input chunk and report the
 * focus state it carries (undefined when it carries none). Remaining keys in
 * the chunk are returned for pass-through, so focus events riding along with
 * real input never swallow keystrokes.
 */
export function consumeFocusEvents(data: string): { focused: boolean | undefined; data: string } {
	let focused: boolean | undefined;
	let rest = data;
	for (;;) {
		const at = [FOCUS_IN, FOCUS_OUT]
			.map((seq) => rest.indexOf(seq))
			.reduce((a, b) => (a === -1 ? b : b === -1 ? a : Math.min(a, b)));

		if (at === -1) break;

		focused = rest.startsWith(FOCUS_IN, at);

		rest = rest.slice(0, at) + rest.slice(at + FOCUS_IN.length);
	}

	return { focused, data: rest };
}

/**
 * Window focus gate: a blurred terminal shows a steady cursor, a focused one
 * blinks. Restores the cursor block immediately when the window blurs mid-
 * dark-phase so it never lingers hidden.
 */
export function setWindowFocused(focused: boolean): void {
	if (windowFocused === focused) return;
	windowFocused = focused;
	if (!focused && current?.reveal()) activeTui?.requestRender();
}

/** Window focus state as set by focus events; blurred terminals hold a steady cursor. */
export function isWindowFocused(): boolean {
	return windowFocused;
}

/**
 * onTerminalInput listener: gates the blink on DECSET 1004 focus events and
 * strips them from the input stream; every other chunk passes through as-is.
 */
export function focusEventListener(data: string): { consume?: boolean; data?: string } | undefined {
	if (!data.includes(FOCUS_IN) && !data.includes(FOCUS_OUT)) return undefined;
	const { focused, data: rest } = consumeFocusEvents(data);
	if (focused !== undefined) setWindowFocused(focused);
	return rest.length === 0 ? { consume: true } : { data: rest };
}

/**
 * Un-style one line's focused-cursor blocks, keeping the marker (hardware
 * cursor positioning still works) and the cell's text; unfocused blocks are
 * left untouched.
 */
export function stripActiveCursorLine(line: string): string {
	let out = line;
	let at = out.indexOf(ACTIVE_CURSOR);
	while (at !== -1) {
		const rest = out.slice(at + ACTIVE_CURSOR.length);
		const end = rest.indexOf(CURSOR_END);
		if (end === -1) break; // malformed; leave the rest of the line alone
		out =
			out.slice(0, at) + CURSOR_MARKER + rest.slice(0, end) + rest.slice(end + CURSOR_END.length);
		at = out.indexOf(ACTIVE_CURSOR, at + CURSOR_MARKER.length);
	}
	return out;
}

/** Blink state machine, separated from the timer so tests can drive it directly. */
export class CursorBlink {
	private visible = true;
	private seenActive = false;
	private readonly isFocused: () => boolean;

	constructor(isFocused: () => boolean = () => windowFocused) {
		this.isFocused = isFocused;
	}

	/** Resolver hook: record active cursors, hide their blocks on the dark phase. */
	resolve(lines: string[]): string[] {
		if (lines.some(hasActiveCursor)) this.seenActive = true;
		return this.visible ? lines : lines.map(stripActiveCursorLine);
	}

	/** Timer hook: returns true when the phase flipped and a re-render is due. */
	tick(): boolean {
		if (!this.isFocused()) {
			// blurred: hold the cursor solid; keep seenActive so refocus resumes
			if (!this.visible) {
				this.visible = true;
				return true;
			}
			return false;
		}
		if (!this.seenActive) {
			this.visible = true;
			return false;
		}
		this.seenActive = false;
		this.visible = !this.visible;
		return true;
	}

	/** Force the cursor block visible; true when this changed the phase. */
	reveal(): boolean {
		if (this.visible) return false;
		this.visible = true;
		return true;
	}

	get cursorVisible(): boolean {
		return this.visible;
	}
}

const installed = new WeakSet<object>();
let timer: ReturnType<typeof setInterval> | null = null;
let current: CursorBlink | null = null;

/**
 * Patch a TUI so its focused-input cursors blink. Idempotent per TUI; a later
 * install (a mode switch hands extensions a fresh TUI) takes over the single
 * tick timer. Fails safe: if the engine ever moves resolveFakeCursors, the
 * cursor just stays steady.
 */
export function installCursorBlink(tui: TUI, intervalMs: number = BLINK_INTERVAL_MS): void {
	// resolveFakeCursors is protected on the TUI type but an ordinary method at
	// runtime; the pinned engine keeps that surface stable.
	const target = tui as unknown as { resolveFakeCursors?: (lines: string[]) => string[] };
	const original = target.resolveFakeCursors?.bind(tui);
	if (!original || installed.has(tui)) return;
	installed.add(tui);

	const blink = new CursorBlink();
	target.resolveFakeCursors = (lines: string[]) => original(blink.resolve(lines));

	// Ask the terminal for focus events (the same direct private-mode write the
	// TUI itself uses); restored on stop so exit never leaves reporting on.
	const write = tui.terminal?.write?.bind(tui.terminal);
	if (write) {
		write("\x1b[?1004h");
		const stop = tui.stop?.bind(tui);
		if (stop) {
			tui.stop = (options) => {
				write("\x1b[?1004l");
				return stop(options);
			};
		}
	}

	if (timer) clearInterval(timer);
	current = blink;
	activeTui = tui;
	timer = setInterval(() => {
		if (current?.tick()) tui.requestRender();
	}, intervalMs);
	// never hold the process (or a test run) open just for the blink
	timer.unref?.();
}
