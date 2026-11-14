/**
 * torus — delegation panes.
 *
 * tmux pane lifecycle for delegations: open a pane tailing the delegation log
 * and kill it when the run leaves the registry. Purely a leaf over child-run —
 * the registry owns the records and calls in here.
 */

import { runChild } from "../child-run.js";

/** Single-quote a value for safe interpolation into a shell command string. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Async tmux runner: spawn, pipe stdout, buffer, resolve on close — never
 * blocks the engine event loop. A stuck server is killed after 5s.
 */
export function runTmux(args: string[]): Promise<{ ok: boolean; stdout: string }> {
	return runChild("tmux", args, { timeoutMs: 5000 }).then((run) => ({
		ok: run.status === 0,
		stdout: run.stdout.trim(),
	}));
}

/**
 * Open a tmux pane tailing the delegation log. Any failure (no server, no
 * client, no split) yields a null paneId and the run continues paneless.
 */
export async function tmuxPaneFor(
	logFile: string,
	agent: string,
	handle: string | null,
): Promise<string | null> {
	if (process.env["TORUS_TMUX"] === "0" || !process.env["TMUX"]) return null;
	// No has-session pre-check: a failed split-window already implies no
	// server, and any non-zero exit counts as "no pane".
	const split = await runTmux([
		"split-window",
		"-h",
		"-P",
		"-F",
		"#{pane_id}",
		"-l",
		"35%",
		`tail -n +1 -f ${shellQuote(logFile)}`,
	]);
	if (!split.ok || split.stdout === "") return null;
	const paneId = split.stdout;
	// One invocation for the follow-ups: focus back, border on, title the pane.
	await runTmux([
		"select-pane",
		"-L",
		";",
		"set-option",
		"-p",
		"-t",
		paneId,
		"pane-border-status",
		"top",
		";",
		"select-pane",
		"-t",
		paneId,
		"-T",
		`torus: ${handle ? `@${handle}` : agent}`,
	]);
	return paneId;
}

export async function killPane(paneId: string | null): Promise<void> {
	if (!paneId) return;
	await runTmux(["kill-pane", "-t", paneId]);
}
