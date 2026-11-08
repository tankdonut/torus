/**
 * torus — interactive_bash.
 *
 * Runs a command under a real PTY via `script -qec <cmd> /dev/null` (zero
 * pty deps: the child gets a TTY, torus holds the pipes). Child output is
 * interpreted by a headless xterm emulator (@xterm/headless): cursor-motion
 * redraws — apt-style carriage-return progress, erase-line prompt repaints,
 * spinner multi-line rewrites — collapse to their final text instead of
 * piling up, and escape sequences split across chunk boundaries parse
 * correctly because the emulator is stateful. In the TUI the output streams
 * into a bottom dialog that replaces the chat editor — raw keystrokes are
 * forwarded to the child (user takeover); ctrl-] detaches; child exit holds
 * the final frame briefly (any key closes it early), then returns the
 * captured tail. Bracketed-paste markers are
 * unwrapped before forwarding, the PTY always gets a winsize (script leaves
 * it 0x0 when its own stdin is a pipe), and children run with NO_COLOR=1
 * and TERM=xterm-256color so programs see a known terminal. Query responses
 * the emulator generates (DSR cursor reports, DA1) are written back to the
 * child, so flows that block on the answer — `gh auth login --web` over an
 * ssh hop — do not stall. Headless contexts
 * run the same command to completion via spawnSync and read the same
 * emulator. Line-oriented programs (REPLs, prompts, pagers, progress bars)
 * render correctly; full-screen apps (vim, htop) still garble — the
 * emulator is a scrollback model, not a viewport; use tmux for those.
 * TORUS_INTERACTIVE=0 disables. Parent sessions only.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ITerminalInitOnlyOptions, ITerminalOptions, Terminal } from "@xterm/headless";
import * as xtermHeadless from "@xterm/headless";
import { knobBoolean, parseZeroDisables } from "../config/knobs.js";
import { gateExtension, type PlatformSupport } from "../platform.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux"],
	deps: [{ name: "script", required: true, note: "util-linux only" }],
	note: "wraps commands with stty for PTY winsize",
};

export const DETACH_KEY = "\x1d";
const SCROLLBACK_LINES = 1_000;
const RENDER_TAIL_CHARS = 4_000;
const TERM_SETTLE_MS = 10;
const EXIT_DWELL_MS = 1_500;
const RENDER_TAIL_LINES = 16;
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3_600;

const liveChildren = new Set<ChildProcess>();

const DEBUG_PATH = process.env["TORUS_INTERACTIVE_DEBUG"];

/** Best-effort diagnostic sink for TORUS_INTERACTIVE_DEBUG; failures are ignored by design. */
function debugAppend(kind: string, text: string): void {
	if (DEBUG_PATH === undefined) return;
	try {
		appendFileSync(DEBUG_PATH, `${kind} ${JSON.stringify(text)}\n`);
	} catch {
		// A diagnostic sink must never break the interactive run it observes.
	}
}

/** Bracketed-paste markers: pi-tui re-wraps pastes for editor components. */
const PASTE_MARKER = /\x1b\[20[01]~/g;
/** Kitty keyboard protocol encoding of ctrl-] (press and repeat events). */
const KITTY_DETACH = /^\x1b\[29;5(:\d)?u$/;
/**
 * The CJS build exposes Terminal only on `default` under Node ESM (no
 * exports map, no lexer-detectable named exports); bundlers and a future
 * exports map see it as a named export. Accept both shapes.
 */
const TerminalCtor: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => Terminal =
	(
		xtermHeadless as unknown as {
			default?: {
				Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => Terminal;
			};
		}
	).default?.Terminal ?? xtermHeadless.Terminal;

/** Headless xterm sized to the PTY it mirrors; allowProposedApi unlocks buffer access. */
export function createTerm(rows: number, cols: number): Terminal {
	return new TerminalCtor({
		allowProposedApi: true,
		scrollback: SCROLLBACK_LINES,
		rows: Math.max(1, rows),
		cols: Math.max(1, cols),
	});
}

/** The emulator flushes queued writes on a timer; wait one settle tick before reading. */
export function settleTerm(_term: Terminal, ms = TERM_SETTLE_MS): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The last `count` written rows as plain text, right-trimmed; rows below the cursor count when painted. */
function tailLines(term: Terminal, count: number): string[] {
	const buffer = term.buffer.active;
	const cursorAbs = buffer.baseY + buffer.cursorY;
	let end = cursorAbs + 1;
	for (let i = buffer.length - 1; i > cursorAbs; i--) {
		if ((buffer.getLine(i)?.translateToString(true) ?? "") !== "") {
			end = i + 1;
			break;
		}
	}
	const first = Math.max(0, end - Math.max(1, count));
	const lines: string[] = [];
	for (let i = first; i < end; i++) {
		lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
	}
	return lines;
}

/** Buffer tail as joined text: at most `chars` characters, outer blank rows trimmed. */
export function termTail(term: Terminal, chars = RENDER_TAIL_CHARS): string {
	const all = tailLines(term, term.buffer.active.length);
	const picked: string[] = [];
	let budget = chars;
	for (let i = all.length - 1; i >= 0; i--) {
		const line = all[i] ?? "";
		const cost = line.length + 1;
		if (cost > budget && picked.length > 0) break;
		picked.unshift(line);
		budget -= cost;
		if (budget <= 0) break;
	}
	while (picked.length > 0 && picked[0] === "") picked.shift();
	while (picked.length > 0 && picked[picked.length - 1] === "") picked.pop();
	return picked.join("\n");
}

/** Unwrap bracketed-paste markers before forwarding input to the child. */
export function unwrapPaste(data: string): string {
	return data.replace(PASTE_MARKER, "");
}

/** ctrl-] in both legacy (\x1d) and kitty keyboard protocol encodings. */
export function isDetachKey(data: string): boolean {
	return data === DETACH_KEY || KITTY_DETACH.test(data);
}

/**
 * Child env: NO_COLOR keeps prompt frameworks from probing the terminal,
 * and TERM states the emulator's actual identity (what the headless xterm speaks).
 */
export function childEnv(): NodeJS.ProcessEnv {
	return { ...process.env, NO_COLOR: "1", TERM: "xterm-256color" };
}

/**
 * Always stty a winsize onto the PTY: script leaves it 0x0 when its own
 * stdin is a pipe, and a 0-row terminal breaks bottom-of-screen redraws outright.
 */
export function buildPtyCommand(command: string, rows: number | null, cols: number | null): string {
	return `stty rows ${rows ?? 24} cols ${cols ?? 80} 2>/dev/null; ${command}`;
}

export class PtyOverlay implements Component {
	private tui: TUI;
	private theme: ExtensionContext["ui"]["theme"];
	private done: (result: string) => void;
	private child: ChildProcess;
	private command: string;
	private term: Terminal;
	private finished = false;
	private reported = false;
	private closed = false;
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	private dwellTimer: ReturnType<typeof setTimeout> | null = null;
	private onData: (chunk: Buffer) => void;
	private onExit: (code: number | null) => void;

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		done: (result: string) => void,
		child: ChildProcess,
		command: string,
		timeoutMs: number,
		rows: number,
		cols: number,
		exitDwellMs: number = EXIT_DWELL_MS,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.child = child;
		this.command = command;
		this.term = createTerm(rows, cols);
		debugAppend("start", this.command);
		// Emulator-origin only: user input goes straight to the child in
		// handleInput, never through the emulator, so nothing written here can
		// loop back through onData — no echo path exists by construction.
		this.term.onData((response) => {
			debugAppend("resp", response);
			if (this.child.stdin?.writable) this.child.stdin.write(response);
		});
		this.onData = (chunk) => {
			const text = chunk.toString("utf8");
			debugAppend("stdout", text);
			this.term.write(text);
			this.tui.requestRender();
		};
		this.onExit = (code) => {
			this.finished = true;
			debugAppend("exit", String(code));
			this.term.write(`\r\n[torus] child exited (${code})\r\n`);
			this.tui.requestRender();
			// Hold the final frame so the user can read it; any keypress closes early.
			this.dwellTimer = setTimeout(() => this.complete(), exitDwellMs);
		};
		this.killTimer = setTimeout(() => {
			this.term.write(`\r\n[torus] timed out after ${Math.round(timeoutMs / 1000)}s\r\n`);
			this.tui.requestRender();
			if (!this.child.killed) this.child.kill("SIGTERM");
		}, timeoutMs);
		child.stdout?.on("data", this.onData);
		child.on("exit", this.onExit);
	}

	invalidate(): void {}

	dispose(): void {
		this.teardown();
	}

	private teardown(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.killTimer) clearTimeout(this.killTimer);
		if (this.dwellTimer) clearTimeout(this.dwellTimer);
		this.child.stdout?.off("data", this.onData);
		this.child.off("exit", this.onExit);
	}

	private complete(): void {
		if (this.closed) return;
		this.teardown();
		// Reads wait one settle tick so the final output and exit note flush in.
		setTimeout(() => {
			if (this.reported) return;
			this.reported = true;
			this.done(termTail(this.term));
		}, TERM_SETTLE_MS);
	}

	handleInput(data: string): void {
		if (isDetachKey(data)) {
			this.complete();
			return;
		}
		if (this.finished) {
			this.complete();
			return;
		}
		const unwrapped = unwrapPaste(data);
		if (unwrapped.length > 0 && this.child.stdin?.writable) {
			this.child.stdin.write(unwrapped);
		}
	}

	render(width: number): string[] {
		const rule = this.theme.fg("dim", "─".repeat(Math.max(0, width)));
		const preview = this.command.length > 48 ? `${this.command.slice(0, 45)}...` : this.command;
		const state = this.finished
			? this.theme.fg("success", "exited")
			: this.theme.fg("warning", "live");
		const hint = this.finished ? "any key closes" : "type to interact";
		const header = `${this.theme.fg("toolTitle", "tty")} ${this.theme.fg("accent", preview)} ${state} ${this.theme.fg("dim", `· ${hint} · ctrl-] detach`)}`;
		const tail = tailLines(this.term, RENDER_TAIL_LINES).map((line) =>
			truncateToWidth(line, Math.max(1, width - 2)),
		);
		return [rule, truncateToWidth(header, Math.max(1, width)), rule, ...tail, rule, ""];
	}
}

export async function headlessRun(
	command: string,
	timeoutMs: number,
): Promise<{ ok: boolean; text: string; timedOut: boolean }> {
	const result = spawnSync("script", ["-qec", buildPtyCommand(command, 24, 80), "/dev/null"], {
		timeout: timeoutMs,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		env: childEnv(),
	});
	const timedOut = result.error?.name === "TimeoutError";
	const term = createTerm(24, 80);
	term.write(`${result.stdout ?? ""}${result.stderr ?? ""}`);
	await settleTerm(term);
	const output = termTail(term).trim();
	return {
		ok: !timedOut && result.status === 0,
		text: output || (timedOut ? "(timed out)" : `(no output; exit ${result.status ?? "?"})`),
		timedOut,
	};
}

const interactiveBashTool = defineTool({
	name: "interactive_bash",
	label: "Interactive Bash",
	description:
		"Run a command that needs INTERACTIVE input (password prompts, REPLs, package-manager confirmations) under a real PTY. Output is interpreted by a headless terminal emulator, so progress-bar redraws and prompt repaints collapse to their final text. In the TUI the user types directly into the program; ctrl-] detaches and returns the captured output. Line-oriented programs render correctly; full-screen apps (vim/htop) do not — use bash for those. Non-interactive commands should use plain bash.",
	parameters: Type.Object({
		command: Type.String({ description: "Shell command to run interactively" }),
		timeout: Type.Optional(
			Type.Number({ description: "Seconds before the child is killed (default 600, max 3600)" }),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const timeoutS = Math.min(Math.max(params.timeout ?? DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
		const timeoutMs = timeoutS * 1000;

		if (!ctx.hasUI) {
			const run = await headlessRun(params.command, timeoutMs);
			return {
				content: [{ type: "text", text: run.text }],
				details: { interactive: false, ok: run.ok, timedOut: run.timedOut },
				isError: !run.ok,
			};
		}

		const stdout = process.stdout as { rows?: number; columns?: number };
		const rows = typeof stdout.rows === "number" ? stdout.rows : null;
		const cols = typeof stdout.columns === "number" ? stdout.columns : null;
		const child = spawn(
			"script",
			["-qec", buildPtyCommand(params.command, rows, cols), "/dev/null"],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: childEnv(),
			},
		);
		liveChildren.add(child);

		try {
			const tail = await ctx.ui.custom<string>(
				(tui, theme, _keybindings, done) =>
					new PtyOverlay(
						tui,
						theme,
						done,
						child,
						params.command,
						timeoutMs,
						rows ?? 24,
						cols ?? 80,
					),
			);
			return {
				content: [{ type: "text", text: tail.trim() || "(no output)" }],
				details: { interactive: true, ok: true },
			};
		} finally {
			if (!child.killed) child.kill("SIGTERM");
			liveChildren.delete(child);
		}
	},
});

export function registerInteractive(pi: ExtensionAPI): void {
	if (!knobBoolean("TORUS_INTERACTIVE", "interactive", "enabled", true, parseZeroDisables)) return;
	pi.registerTool(interactiveBashTool);
	pi.on("session_shutdown", () => {
		for (const child of liveChildren) {
			if (!child.killed) child.kill("SIGTERM");
		}
		liveChildren.clear();
	});
}

export default function interactiveExtension(pi: ExtensionAPI): void {
	if (!gateExtension("interactive", PLATFORM_SUPPORT)) return;
	registerInteractive(pi);
}
