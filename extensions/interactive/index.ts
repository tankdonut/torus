/**
 * torus — interactive_bash.
 *
 * Runs a command under a real PTY via `script -qec <cmd> /dev/null` (zero
 * deps: the child gets a TTY, torus holds the pipes). In the TUI the output
 * streams into a bordered overlay the user can TYPE INTO — raw keystrokes are
 * forwarded to the child (user takeover); ctrl-] detaches; child exit
 * auto-completes and returns the captured tail. Headless contexts run the
 * same command to completion via spawnSync. Line-oriented programs (REPLs,
 * prompts, pagers) render correctly; full-screen apps (vim, htop) garble —
 * use tmux for those. TORUS_INTERACTIVE=0 disables. Parent sessions only.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";

export const DETACH_KEY = "\x1d";
const RING_BYTE_CAP = 64_000;
const RENDER_TAIL_CHARS = 4_000;
const DEFAULT_TIMEOUT_S = 300;
const MAX_TIMEOUT_S = 3_600;

const liveChildren = new Set<ChildProcess>();

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
	private onData: (chunk: Buffer) => void;
	private onExit: (code: number | null) => void;

	constructor(
		tui: TUI,
		theme: ExtensionContext["ui"]["theme"],
		done: (result: string) => void,
		child: ChildProcess,
		command: string,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.child = child;
		this.command = command;
		this.onData = (chunk) => {
			this.ring = capRing(this.ring, chunk.toString("utf8"));
			this.tui.requestRender();
		};
		this.onExit = (code) => {
			this.finished = true;
			this.ring = capRing(this.ring, `\n[torus] child exited (${code})\n`);
			this.complete();
			this.tui.requestRender();
		};
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
		this.child.stdout?.off("data", this.onData);
		this.child.off("exit", this.onExit);
	}

	private complete(): void {
		if (this.closed) return;
		this.teardown();
		this.done(ringTail(this.ring));
	}

	handleInput(data: string): void {
		if (data === DETACH_KEY) {
			this.complete();
			return;
		}
		if (this.finished) {
			this.complete();
			return;
		}
		if (this.child.stdin?.writable) {
			this.child.stdin.write(data);
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
			.slice(-24)
			.map((line) => truncateToWidth(line.replace(/\r/g, ""), Math.max(1, width - 2)));
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
	});
	const timedOut = result.error?.name === "TimeoutError";
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\r/g, "").trim();
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
		"Run a command that needs INTERACTIVE input (password prompts, REPLs, package-manager confirmations) under a real PTY. In the TUI the user can type directly into the program; ctrl-] detaches and returns the captured output. Line-oriented programs render correctly; full-screen apps (vim/htop) do not — use bash for those. Non-interactive commands should use plain bash.",
	parameters: Type.Object({
		command: Type.String({ description: "Shell command to run interactively" }),
		timeout: Type.Optional(
			Type.Number({ description: "Seconds before the child is killed (default 300, max 3600)" }),
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

		const child = spawn("script", ["-qec", params.command, "/dev/null"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		liveChildren.add(child);
		const killTimer = setTimeout(() => {
			if (!child.killed) child.kill("SIGTERM");
		}, timeoutMs);

		try {
			const tail = await ctx.ui.custom<string>(
				(tui, theme, _keybindings, done) => new PtyOverlay(tui, theme, done, child, params.command),
				{ overlay: true },
			);
			return {
				content: [{ type: "text", text: tail.replace(/\r/g, "").trim() || "(no output)" }],
				details: { interactive: true, ok: true },
			};
		} finally {
			clearTimeout(killTimer);
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
	registerInteractive(pi);
}
