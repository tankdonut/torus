import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, renderFakeCursor } from "@earendil-works/pi-tui";

const {
	CursorBlink,
	consumeFocusEvents,
	installCursorBlink,
	isWindowFocused,
	setWindowFocused,
	stripActiveCursorLine,
} = await import("../extensions/cursor-blink.ts");

const START = renderFakeCursor("\u0000").split("\u0000")[0];
const END = renderFakeCursor("\u0000").split("\u0000")[1];
const active = (text) => CURSOR_MARKER + renderFakeCursor(text);
const passive = (text) => renderFakeCursor(text);

test("stripActiveCursorLine: hides only focused-cursor blocks, keeps marker and text", () => {
	const line = `tail ${active("x")} mid ${passive("y")} end`;
	const stripped = stripActiveCursorLine(line);
	assert.equal(stripped, `tail ${CURSOR_MARKER}x mid ${passive("y")} end`);
});

test("stripActiveCursorLine: hides every focused block on the line and leaves clean lines alone", () => {
	const two = `${active("a")}${active("b")}`;
	assert.equal(stripActiveCursorLine(two), `${CURSOR_MARKER}a${CURSOR_MARKER}b`);
	const clean = "plain line";
	assert.equal(stripActiveCursorLine(clean), clean);
	const onlyPassive = passive("z");
	assert.equal(stripActiveCursorLine(onlyPassive), onlyPassive);
});

test("stripActiveCursorLine: malformed block (no end marker) is left untouched", () => {
	const broken = `x ${CURSOR_MARKER}${START}y`;
	assert.equal(stripActiveCursorLine(broken), broken);
});

test("CursorBlink: ticks flip the phase only after an active cursor was resolved", () => {
	const blink = new CursorBlink();
	assert.equal(blink.tick(), false, "nothing active yet");
	assert.equal(blink.cursorVisible, true);

	const lines = [`hello ${active(" ")}`];
	assert.deepEqual(blink.resolve(lines), lines, "visible phase passes lines through");

	assert.equal(blink.tick(), true);
	assert.equal(blink.cursorVisible, false);
	assert.deepEqual(blink.resolve(lines), [stripActiveCursorLine(lines[0])]);

	assert.equal(blink.tick(), true);
	assert.equal(blink.cursorVisible, true);
});

test("CursorBlink: an idle tick restores the visible phase and stops rendering", () => {
	const blink = new CursorBlink();
	blink.resolve([`hi ${active(" ")}`]);
	blink.tick();
	assert.equal(blink.cursorVisible, false);
	// no active cursor resolved since: tick goes quiet and resets to visible
	assert.equal(blink.tick(), false);
	assert.equal(blink.cursorVisible, true);
});

test("CursorBlink: passive cursors never trigger blinking", () => {
	const blink = new CursorBlink();
	blink.resolve([`unfocused ${passive(" ")}`]);
	assert.equal(blink.tick(), false);
	assert.equal(blink.cursorVisible, true);
});

test("installCursorBlink: patches the TUI resolver and is idempotent per TUI", () => {
	let renders = 0;
	const tui = {
		resolveFakeCursors(lines) {
			return lines.map((l) => l.replaceAll(START, "<block>").replaceAll(END, "</block>"));
		},
		requestRender() {
			renders += 1;
		},
	};
	installCursorBlink(tui, 1e9); // never fires; the timer is unref'd anyway
	const patched = tui.resolveFakeCursors;
	installCursorBlink(tui, 1e9);
	assert.equal(tui.resolveFakeCursors, patched, "second install must not re-wrap");

	const out = tui.resolveFakeCursors([`a ${active(" ")} b`]);
	assert.deepEqual(out, [`a ${CURSOR_MARKER}<block> </block> b`]);
	assert.equal(renders, 0, "no tick has fired yet");
});

test("installCursorBlink: TUIs without the resolver are left alone", () => {
	const tui = { requestRender() {} };
	installCursorBlink(tui, 1e9);
	assert.equal("resolveFakeCursors" in tui, false);
});

test("consumeFocusEvents: strips focus in/out and keeps trailing keys", () => {
	assert.deepEqual(consumeFocusEvents("\x1b[I"), { focused: true, data: "" });
	assert.deepEqual(consumeFocusEvents("\x1b[O"), { focused: false, data: "" });
	assert.deepEqual(consumeFocusEvents("hi"), { focused: undefined, data: "hi" });
	// refocus plus a keystroke in one chunk: the key survives
	assert.deepEqual(consumeFocusEvents("\x1b[Ix"), { focused: true, data: "x" });
	assert.deepEqual(consumeFocusEvents("a\x1b[Ob\x1b[Ic"), { focused: true, data: "abc" });
});

test("CursorBlink: a blurred window holds the cursor solid, refocus resumes blinking", () => {
	let focused = true;
	const blink = new CursorBlink(() => focused);
	const lines = [`hi ${active(" ")}`];
	blink.resolve(lines);
	blink.tick();
	assert.equal(blink.cursorVisible, false, "focused: dark phase reached");

	focused = false;
	assert.equal(blink.tick(), true, "blur immediately restores the block");
	assert.equal(blink.cursorVisible, true);
	assert.equal(blink.tick(), false, "blurred ticks stay quiet");
	blink.resolve(lines); // renders continue while blurred
	assert.equal(blink.tick(), false);
	assert.equal(blink.cursorVisible, true, "blurred never hides the cursor");

	focused = true;
	assert.equal(blink.tick(), true, "refocus resumes blinking");
	assert.equal(blink.cursorVisible, false);
});

test("installCursorBlink: focus events are observed in handleTerminalInput and delegated", () => {
	setWindowFocused(true);
	const seen = [];
	const tui = {
		terminal: { write: () => {} },
		resolveFakeCursors: (lines) => lines,
		handleTerminalInput: (data) => {
			seen.push(data);
		},
		requestRender() {},
	};
	installCursorBlink(tui, 1e9);
	tui.handleTerminalInput("x");
	assert.deepEqual(seen, ["x"], "chunks delegate untouched");
	assert.equal(isWindowFocused(), true);
	tui.handleTerminalInput("\x1b[O");
	assert.deepEqual(seen, ["x", "\x1b[O"], "focus chunk still reaches the engine");
	assert.equal(isWindowFocused(), false, "ESC[O blurs");
	tui.handleTerminalInput("\x1b[I");
	assert.equal(isWindowFocused(), true, "ESC[I refocuses");
});

test("installCursorBlink: enables focus reporting and disables it on stop", () => {
	const writes = [];
	let stopped = false;
	const tui = {
		terminal: { write: (d) => writes.push(d) },
		resolveFakeCursors: (lines) => lines,
		requestRender() {},
		stop: () => {
			stopped = true;
		},
	};
	installCursorBlink(tui, 1e9);
	assert.deepEqual(writes, ["\x1b[?1004h"]);
	tui.stop();
	assert.equal(stopped, true);
	assert.deepEqual(writes, ["\x1b[?1004h", "\x1b[?1004l"]);
});
