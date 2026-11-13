/**
 * torus — the one child-process runner.
 *
 * Every async spawn site funnels through runChild: stdout/stderr piped and
 * decoded as utf8, resolved on close, and one shared kill ladder — SIGTERM,
 * then SIGKILL after SIGKILL_GRACE_MS — for timeouts and abort signals.
 * Callers trim their own stdout; no capture options beyond maxBuffer.
 */

import { spawn } from "node:child_process";

/** How long a SIGTERMed child has to exit on its own before SIGKILL lands. */
export const SIGKILL_GRACE_MS = 2_000;

export interface RunChildOptions {
	/** Kill ladder starts this long after spawn; omit for no timeout. */
	timeoutMs?: number;
	/** Abort kills the child via the same ladder. */
	signal?: AbortSignal;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Cap stdout and stderr capture at this many characters; overflow is discarded. */
	maxBuffer?: number;
	/** On timeout resolve with status null and the buffers so far instead of waiting for close. */
	resolveOnTimeout?: boolean;
	/** With maxBuffer set, kill the child mid-stream the first time either captured stream reaches the cap. */
	killOnCap?: boolean;
}

export interface RunChildResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: string;
}

/**
 * Spawn a child with piped stdio and resolve on close — never blocks the
 * engine event loop (the TUI renders on it). No timeout: buffers, exit
 * status, done. Timeout or abort: SIGTERM, then SIGKILL after the grace
 * period; a killed child resolves with status null. With resolveOnTimeout
 * the promise resolves at the deadline but the SIGKILL escalation stays
 * armed, so a child that ignores SIGTERM cannot leak. A spawn failure arrives
 * via the async 'error' event and resolves with status null plus the error
 * message, not a rejection. With killOnCap the first captured stream to reach
 * maxBuffer triggers the same ladder mid-stream. All timers are unref'd.
 */
export function runChild(
	cmd: string,
	args: string[],
	opts: RunChildOptions = {},
): Promise<RunChildResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let capKilled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		// keepKillTimer leaves the SIGKILL escalation armed when resolving on
		// timeout: a child that ignores SIGTERM must still be killed after the
		// grace period even though the promise has already resolved.
		const finish = (status: number | null, error?: string, keepKillTimer = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			if (!keepKillTimer) clearTimeout(killTimer);
			resolve({ status, stdout, stderr, ...(error !== undefined ? { error } : {}) });
		};
		const ladder = () => {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS).unref();
		};
		if (opts.timeoutMs !== undefined) {
			timeoutTimer = setTimeout(() => {
				ladder();
				if (opts.resolveOnTimeout) finish(null, undefined, true);
			}, opts.timeoutMs).unref();
		}
		const cap = opts.maxBuffer;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		const capped = (current: string, chunk: string): string => {
			if (cap === undefined) return current + chunk;
			// keep capturing (streaming on) past the cap; overflow is discarded
			const room = cap - current.length;
			if (room <= 0) return current;
			return current + (chunk.length > room ? chunk.slice(0, room) : chunk);
		};
		// killOnCap: the first stream to reach the cap kills the child mid-stream
		// via the shared ladder; close then resolves with status null and the
		// buffers so far, exactly like a timeout kill.
		const capKill = () => {
			if (settled || capKilled) return;
			capKilled = true;
			ladder();
		};
		child.stdout?.on("data", (chunk: string) => {
			stdout = capped(stdout, chunk);
			if (opts.killOnCap && cap !== undefined && stdout.length >= cap) capKill();
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = capped(stderr, chunk);
			if (opts.killOnCap && cap !== undefined && stderr.length >= cap) capKill();
		});
		child.on("error", (err) => {
			finish(null, err.message);
		});
		child.on("close", (code) => {
			finish(code);
		});
		const signal = opts.signal;
		if (signal) {
			if (signal.aborted) ladder();
			else signal.addEventListener("abort", ladder, { once: true });
		}
	});
}
