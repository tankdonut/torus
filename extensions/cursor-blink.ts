/**
 * torus — blinking input cursors.
 *
 * Pi draws input cursors as fake-cursor blocks (reverse-video cells) resolved
 * by the TUI; a focused input prefixes its cursor with CURSOR_MARKER so the
 * terminal can also position the hardware cursor there. That marker is the
 * "this input is active" signal: installCursorBlink patches the TUI's cursor
 * resolver so marked cursors blink in lockstep while an active input is on
 * screen, and unmarked ones (an unfocused editor, for instance) stay steady.
 * Toggling happens by re-rendering, so the blink stops on its own the moment
 * no active cursor is rendered — a closed dialog or blurred editor never
 * flickers.
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

/** True where a line carries a cursor of an input that currently has focus. */
function hasActiveCursor(line: string): boolean {
	return line.includes(ACTIVE_CURSOR);
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

	/** Resolver hook: record active cursors, hide their blocks on the dark phase. */
	resolve(lines: string[]): string[] {
		if (lines.some(hasActiveCursor)) this.seenActive = true;
		return this.visible ? lines : lines.map(stripActiveCursorLine);
	}

	/** Timer hook: returns true when the phase flipped and a re-render is due. */
	tick(): boolean {
		if (!this.seenActive) {
			this.visible = true;
			return false;
		}
		this.seenActive = false;
		this.visible = !this.visible;
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

	if (timer) clearInterval(timer);
	current = blink;
	timer = setInterval(() => {
		if (current?.tick()) tui.requestRender();
	}, intervalMs);
	// never hold the process (or a test run) open just for the blink
	timer.unref?.();
}
