/**
 * torus — interactive_bash.
 *
 * Runs a command under a real PTY via `script -qec <cmd> /dev/null` (zero
 * deps: the child gets a TTY, torus holds the pipes). In the TUI the output
 * streams into a bottom dialog that replaces the chat editor — raw
 * keystrokes are forwarded to the child (user takeover); ctrl-] detaches;
 * child exit auto-completes and returns the captured tail. Terminal control
 * sequences are stripped from the stream, bracketed-paste markers are
 * unwrapped before forwarding, the PTY gets a real winsize, and children run
 * with NO_COLOR=1 so prompt frameworks do not interrogate the terminal
 * (queries like OSC 11 or CSI cursor probes cannot be answered through the
 * pipes and stall flows such as `gh auth login --web`). Headless contexts
 * run the same command to completion via spawnSync. Line-oriented programs
 * (REPLs, prompts, pagers) render correctly; full-screen apps (vim, htop)
 * garble — use tmux for those. TORUS_INTERACTIVE=0 disables. Parent
 * sessions only.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { gateExtension, type PlatformSupport } from "../platform.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux"],
	deps: [{ name: "script", required: true, note: "util-linux only" }],
	note: "wraps commands with stty for PTY winsize",
};

export const DETACH_KEY = "\x1d";
const RING_BYTE_CAP = 64_000;
const RENDER_TAIL_CHARS = 4_000;
const RENDER_TAIL_LINES = 16;
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3_600;

const liveChildren = new Set<ChildProcess>();

/** Bracketed-paste markers: pi-tui re-wraps pastes for editor components. */
const PASTE_MARKER = /\x1b\[20[01]~/g;
/** Kitty keyboard protocol encoding of ctrl-] (press and repeat events). */
const KITTY_DETACH = /^\x1b\[29;5(:\d)?u$/;
const CONTROL_SEQUENCES = [
	/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, // OSC (incl. unterminated tail)
	/\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g, // DCS/SOS/PM/APC
	/\x1b\[[0-9:;<=>?]*[!-/]*[@-~]/g, // CSI
	/\x1b[()*+][0-9A-Za-z]?/g, // charset designators, e.g. ESC(B
	/\x1b[\x30-\x7e]/g, // two-char escapes (ESC7, ESC8, ESC=, ...)
	/[\x00-\x08\x0b-\x1f\x7f]/g, // remaining C0 (keeps \t and \n)
];

/** Strip OSC/DCS/CSI/escape/C0 control sequences from PTY output. */
export function stripTerminalControls(chunk: string): string {
	let out = chunk;
	for (const pattern of CONTROL_SEQUENCES) {
		out = out.replace(pattern, "");
	}
	return out;
}

/** Unwrap bracketed-paste markers before forwarding input to the child. */
export function unwrapPaste(data: string): string {
	return data.replace(PASTE_MARKER, "");
}

/** ctrl-] in both legacy (\x1d) and kitty keyboard protocol encodings. */
export function isDetachKey(data: string): boolean {
	return data === DETACH_KEY || KITTY_DETACH.test(data);
}

/** Give the PTY a real winsize so children skip cursor-probe size detection. */
export function buildPtyCommand(command: string, rows: number | null, cols: number | null): string {
	if (!rows || !cols) return command;
	return `stty rows ${rows} cols ${cols} 2>/dev/null; ${command}`;
}

export function capRing(ring: string, incoming: string): string {
	const next = ring + incoming;
	if (next.length <= RING_BYTE_CAP) return next;
	return next.slice(next.length - RING_BYTE_CAP);
}

export function ringTail(ring: string, chars = RENDER_TAIL_CHARS): string {
	return ring.length <= chars ? ring : ring.slice(ring.length - chars);
}

export class PtyOverlay implements Component {
	private tui: TUI;
	private theme: ExtensionContext["ui"]["theme"];
	private done: (result: string) => void;
	private child: ChildProcess;
	private command: string;
	private ring = "";
	private finished = false;
	private closed = false;
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	private onData: (chunk: Buffer) => void;
	private onExit: (code: number | null) => void;

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		done: (result: string) => void,
		child: ChildProcess,
		command: string,
		timeoutMs: number,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.child = child;
		this.command = command;
		this.onData = (chunk) => {
			this.ring = capRing(this.ring, stripTerminalControls(chunk.toString("utf8")));
			this.tui.requestRender();
		};
		this.onExit = (code) => {
			this.finished = true;
			this.ring = capRing(this.ring, `\n[torus] child exited (${code})\n`);
			this.complete();
			this.tui.requestRender();
		};
		this.killTimer = setTimeout(() => {
			this.ring = capRing(
				this.ring,
				`\n[torus] timed out after ${Math.round(timeoutMs / 1000)}s\n`,
			);
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
		this.child.stdout?.off("data", this.onData);
		this.child.off("exit", this.onExit);
	}

	private complete(): void {
		if (this.closed) return;
		this.teardown();
		this.done(ringTail(this.ring));
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
		const header = `${this.theme.fg("toolTitle", "tty")} ${this.theme.fg("accent", preview)} ${state} ${this.theme.fg("dim", "· type to interact · ctrl-] detach")}`;
		const tail = ringTail(this.ring)
			.split("\n")
			.slice(-RENDER_TAIL_LINES)
			.map((line) => truncateToWidth(line, Math.max(1, width - 2)));
		return [rule, truncateToWidth(header, Math.max(1, width)), rule, ...tail, rule, ""];
	}
}

export function headlessRun(
	command: string,
	timeoutMs: number,
): { ok: boolean; text: string; timedOut: boolean } {
	const result = spawnSync("script", ["-qec", command, "/dev/null"], {
		timeout: timeoutMs,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, NO_COLOR: "1" },
	});
	const timedOut = result.error?.name === "TimeoutError";
	const output = stripTerminalControls(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim();
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
		"Run a command that needs INTERACTIVE input (password prompts, REPLs, package-manager confirmations) under a real PTY. In the TUI the user types directly into the program; ctrl-] detaches and returns the captured output. Line-oriented programs render correctly; full-screen apps (vim/htop) do not — use bash for those. Non-interactive commands should use plain bash.",
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
			const run = headlessRun(params.command, timeoutMs);
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
				env: { ...process.env, NO_COLOR: "1" },
			},
		);
		liveChildren.add(child);

		try {
			const tail = await ctx.ui.custom<string>(
				(tui, theme, _keybindings, done) =>
					new PtyOverlay(tui, theme, done, child, params.command, timeoutMs),
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
	if (process.env["TORUS_INTERACTIVE"] === "0") return;
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
