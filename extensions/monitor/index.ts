/**
 * torus — monitor.
 *
 * Watch a command's output on an interval; notify + log when it changes or
 * fails (torus_monitor). Run a command once in the background and wake the
 * session when it exits (torus_bg). Both live on globalThis (one map per
 * process) and are cleaned up on session shutdown. TORUS_MONITOR=0 disables
 * monitors, TORUS_BG=0 background tasks.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runChild } from "../child-run.js";
import { knobBoolean, parseZeroDisables } from "../config/knobs.js";
import { flattenPreview } from "../fleet/theme-kit.js";
import { projectStateDir } from "../fsutil.js";
import { MARKER } from "../markers.js";
import { gateExtension, type PlatformSupport } from "../platform.js";
import { BG_KEY, MONITORS_KEY } from "../shared-state.js";
import { deliverWake, torusWake } from "../wake-gate.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin"],
	deps: [{ name: "bash", required: true }],
};

function toolDetails(d: Record<string, unknown>): Record<string, unknown> {
	return d;
}

const MIN_INTERVAL_SEC = 5;
const MAX_MONITORS = 5;
const CHECK_TIMEOUT_SEC = 30;
const MAX_BG_TASKS = 5;
const BG_KILL_GRACE_MS = 2_000;
const BG_TAIL_CHARS = 4096;

/** Per-project monitor log dir, resolved per check — a session can cd after load. */
function monitorLogDir(): string {
	return path.join(projectStateDir(), "monitors");
}

interface MonitorEntry {
	name: string;
	command: string;
	intervalSec: number;
	stopOn: "change" | "fail";
	lastHash: string | null;
	checks: number;
	timer: ReturnType<typeof setInterval>;
	/** In-flight check promise: guards against overlapping ticks, and awaitable by tests. */
	checkPromise: Promise<void> | null;
}

function monitors(): Map<string, MonitorEntry> {
	const existing = (globalThis as Record<symbol, unknown>)[MONITORS_KEY] as
		| Map<string, MonitorEntry>
		| undefined;
	if (existing) return existing;
	const created = new Map<string, MonitorEntry>();
	(globalThis as Record<symbol, unknown>)[MONITORS_KEY] = created;
	return created;
}

export function validateMonitorSpec(name: string, intervalSec: number): string | null {
	if (!/^[a-z0-9-]{1,24}$/.test(name)) return "name must be 1-24 chars of [a-z0-9-]";
	if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL_SEC) {
		return `intervalSec must be >= ${MIN_INTERVAL_SEC}`;
	}
	return null;
}

function hashOutput(output: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < output.length; i += 1) {
		h ^= output.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${h.toString(16)}:${output.length}`;
}

/** Fire path shared by both stopOn outcomes: transcript marker naming the monitor, its reason, exit, and an output tail. */
function emitMonitorFired(
	entry: MonitorEntry,
	reason: "change" | "fail",
	exit: number | null,
	output: string,
): void {
	const tail = flattenPreview(output, 200);
	const what = reason === "fail" ? "failed" : "output changed";
	// Delivery goes through the wake gate: held while the agent runs so the
	// fire joins the next settle flush instead of trickling out of pi's
	// one-at-a-time follow-up queue turns later. deliverWake also fires the
	// toast (fail → error, change → warning) — no standalone toast call here.
	deliverWake({
		customType: MARKER.monitorFired,
		origin: { label: entry.name },
		severity: reason === "fail" ? "error" : "warning",
		summary: torusWake("monitor", entry.name, what, {
			code: exit,
			...(tail.length > 0 ? { tail } : {}),
			hint: "monitor stopped itself, no torus_monitor_stop needed",
		}),
		detail: { name: entry.name, reason, exit, tail, output },
	});
}

/**
 * Async check runner: a monitor command must never block the engine's event
 * loop (the TUI, streaming, and delegations all run on it), so each check
 * spawns a detached child and resolves on close. A 30s ceiling SIGTERMs and
 * then SIGKILLs a stuck command; a kill resolves with status null, matching
 * spawnSync's timeout semantics.
 */
function runCommand(
	command: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return runChild("bash", ["-c", command], {
		timeoutMs: CHECK_TIMEOUT_SEC * 1000,
		resolveOnTimeout: true,
	});
}

/** Run one check cycle: log every result, fire (toast + transcript + stop) on the stopOn outcome. */
export async function runMonitorCheck(entry: MonitorEntry): Promise<void> {
	const run = await runCommand(entry.command);
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const digest = hashOutput(output);
	entry.checks += 1;
	const failed = run.status !== null && run.status !== 0;

	const logDir = monitorLogDir();
	mkdirSync(logDir, { recursive: true });
	const logFile = path.join(logDir, `${entry.name}.log`);
	appendFileSync(
		logFile,
		`[${new Date().toISOString()}] check ${entry.checks} exit=${run.status} hash=${digest}\n${output.slice(0, 2000)}\n`,
	);

	if (failed && entry.stopOn === "fail") {
		emitMonitorFired(entry, "fail", run.status, output);
		stopMonitor(entry.name);
		return;
	}
	if (entry.lastHash !== null && digest !== entry.lastHash && entry.stopOn === "change") {
		emitMonitorFired(entry, "change", run.status, output);
		appendFileSync(logFile, `[${new Date().toISOString()}] change detected — monitor stopped\n`);
		stopMonitor(entry.name);
		return;
	}
	entry.lastHash = digest;
}

/** Serialize checks per monitor: a tick is skipped while a check is in flight. */
function scheduleCheck(entry: MonitorEntry): void {
	if (entry.checkPromise !== null) return;
	entry.checkPromise = runMonitorCheck(entry).finally(() => {
		entry.checkPromise = null;
	});
}

/** Resolve once every scheduled check has settled; test hook. */
export async function pendingChecks(): Promise<void> {
	const pending = [...monitors().values()].map((entry) => entry.checkPromise ?? Promise.resolve());
	await Promise.all(pending);
}

export function stopMonitor(name: string): boolean {
	const entry = monitors().get(name);
	if (!entry) return false;
	clearInterval(entry.timer);
	monitors().delete(name);
	return true;
}

/** Per-project bg log dir, resolved at spawn time — a session can cd after load. */
function bgLogDir(): string {
	return path.join(projectStateDir(), "bg");
}

export interface BgStart {
	name: string;
	command: string;
	cwd?: string;
	timeoutSec?: number;
}

interface BgEntry {
	name: string;
	command: string;
	child: ChildProcess;
	startedAt: number;
	logFile: string;
	/** Rolling in-memory tail; the log file keeps everything. */
	tail: string;
	stopped: boolean;
	timedOut: boolean;
	timeoutTimer: ReturnType<typeof setTimeout> | null;
	killTimer: ReturnType<typeof setTimeout> | null;
	closePromise: Promise<void>;
}

function bgTasks(): Map<string, BgEntry> {
	const existing = (globalThis as Record<symbol, unknown>)[BG_KEY] as
		| Map<string, BgEntry>
		| undefined;
	if (existing) return existing;
	const created = new Map<string, BgEntry>();
	(globalThis as Record<symbol, unknown>)[BG_KEY] = created;
	return created;
}

export function validateBgName(name: string): string | null {
	if (!/^[a-z0-9-]{1,24}$/.test(name)) return "name must be 1-24 chars of [a-z0-9-]";
	return null;
}

/** Exit path shared by every outcome (exit, stop, timeout): log line, wake marker, toast. */
function emitBgExit(entry: BgEntry, code: number | null, signal: string | null): void {
	const durationMs = Date.now() - entry.startedAt;
	const reason = entry.timedOut ? "timed out" : entry.stopped ? "stopped" : "exited";
	// Forward truncation like every other wake (monitor-fired, delegation
	// summaries): tail-end slices cut mid-word into whatever happened to be last.
	const flat = flattenPreview(entry.tail, 200);
	appendFileSync(
		entry.logFile,
		`[${new Date().toISOString()}] exit code=${code} signal=${signal} ${reason} in ${durationMs}ms\n`,
	);
	// deliverWake fires the toast (done → success, everything else → error).
	deliverWake({
		customType: MARKER.bgExit,
		origin: { label: entry.name },
		severity: code === 0 && !entry.stopped && !entry.timedOut ? "success" : "error",
		summary: torusWake("bg", entry.name, reason, {
			code: code !== null ? code : `signal ${signal ?? "unknown"}`,
			durationMs,
			...(flat.length > 0 ? { tail: flat } : {}),
			hint: `log: ${entry.logFile}`,
		}),
		detail: {
			name: entry.name,
			code,
			signal,
			durationMs,
			reason,
			stopped: entry.stopped,
			timedOut: entry.timedOut,
			tail: flat,
			output: entry.tail,
		},
	});
}

/** SIGTERM now, SIGKILL after the grace window; both timers die with the child. */
function killBg(entry: BgEntry): void {
	entry.stopped = true;
	if (entry.killTimer !== null) return;
	entry.child.kill("SIGTERM");
	entry.killTimer = setTimeout(() => entry.child.kill("SIGKILL"), BG_KILL_GRACE_MS);
	entry.killTimer.unref();
}

/**
 * Spawn one background task: `bash -c command` with stdio appended to the
 * per-project bg log. Resolves when the child is spawned and registered; the
 * exit wake fires asynchronously on close. Tests await pendingBgTasks().
 */
export function startBgTask(
	spec: BgStart,
): { ok: true; pid: number | undefined; logFile: string } | { ok: false; error: string } {
	const invalid = validateBgName(spec.name);
	if (invalid) return { ok: false, error: invalid };
	if (bgTasks().has(spec.name)) {
		return {
			ok: false,
			error: `a bg task named "${spec.name}" is still running — torus_bg_stop it first`,
		};
	}
	if (bgTasks().size >= MAX_BG_TASKS) {
		return {
			ok: false,
			error: `bg task cap reached (${MAX_BG_TASKS}): ${[...bgTasks().keys()].join(", ")} — stop one first`,
		};
	}
	const logDir = bgLogDir();
	mkdirSync(logDir, { recursive: true });
	const logFile = path.join(logDir, `${spec.name}.log`);
	const child = spawn("bash", ["-c", spec.command], {
		cwd: spec.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let resolveClosed: () => void = () => {};
	const closePromise = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});
	const entry: BgEntry = {
		name: spec.name,
		command: spec.command,
		child,
		startedAt: Date.now(),
		logFile,
		tail: "",
		stopped: false,
		timedOut: false,
		timeoutTimer: null,
		killTimer: null,
		closePromise,
	};
	appendFileSync(
		logFile,
		`\n[${new Date().toISOString()}] start pid=${child.pid}: ${spec.command}\n`,
	);
	let settled = false;
	const finish = (code: number | null, signal: string | null) => {
		if (settled) return;
		settled = true;
		if (entry.timeoutTimer !== null) clearTimeout(entry.timeoutTimer);
		if (entry.killTimer !== null) clearTimeout(entry.killTimer);
		// The entry holds its name until close, so a successor cannot exist.
		bgTasks().delete(spec.name);
		emitBgExit(entry, code, signal);
		resolveClosed();
	};
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	const onChunk = (chunk: string) => {
		appendFileSync(logFile, chunk);
		entry.tail = (entry.tail + chunk).slice(-BG_TAIL_CHARS);
	};
	child.stdout?.on("data", onChunk);
	child.stderr?.on("data", onChunk);
	child.on("error", (err: Error) => {
		appendFileSync(logFile, `\n[${new Date().toISOString()}] spawn error: ${err.message}\n`);
		finish(null, null);
	});
	child.on("close", (code, signal) => finish(code, signal));
	if (spec.timeoutSec !== undefined) {
		entry.timeoutTimer = setTimeout(() => {
			entry.timedOut = true;
			killBg(entry);
		}, spec.timeoutSec * 1000);
		entry.timeoutTimer.unref();
	}
	bgTasks().set(spec.name, entry);
	return { ok: true, pid: child.pid, logFile };
}

/** Stop one task by name; the entry lives until close delivers its exit wake. */
export function stopBgTask(name: string): "stopped" | "missing" {
	const entry = bgTasks().get(name);
	if (!entry) return "missing";
	killBg(entry);
	return "stopped";
}

/** Resolve once every running task has closed; test hook. */
export async function pendingBgTasks(): Promise<void> {
	await Promise.all([...bgTasks().values()].map((entry) => entry.closePromise));
}

const monitorTool = defineTool({
	name: "torus_monitor",
	label: "Torus Monitor",
	description:
		"Watch a shell command on an interval; desktop-notifies and stops when its output changes (stopOn: change) or it exits non-zero (stopOn: fail). History lands in $TORUS_STATE_DIR/monitors/<name>.log. Use for CI tails, file watches, long builds. To wait on the outcome, end the turn rather than sleeping or re-polling in-turn: the fire marker wakes the session, and the wake gate holds delivery while a run is active.",
	parameters: Type.Object({
		name: Type.String({ description: "Short monitor name ([a-z0-9-])" }),
		command: Type.String({ description: "Shell command whose output is watched" }),
		intervalSec: Type.Optional(
			Type.Number({ minimum: 5, maximum: 600, description: "Default 30" }),
		),
		stopOn: Type.Optional(
			Type.Union([Type.Literal("change"), Type.Literal("fail")], { description: "Default change" }),
		),
	}),
	async execute(_toolCallId, params) {
		if (!knobBoolean("TORUS_MONITOR", "monitor", "enabled", true, parseZeroDisables)) {
			return {
				content: [{ type: "text", text: "monitors disabled (TORUS_MONITOR=0)" }],
				details: toolDetails({ error: "disabled" }),
				isError: true,
			};
		}
		const intervalSec = params.intervalSec ?? 30;
		const invalid = validateMonitorSpec(params.name, intervalSec);
		if (invalid) {
			return {
				content: [{ type: "text", text: invalid }],
				details: toolDetails({ error: "invalid" }),
				isError: true,
			};
		}
		if (monitors().has(params.name)) {
			stopMonitor(params.name);
		}
		while (monitors().size >= MAX_MONITORS) {
			const oldest = monitors().keys().next().value;
			if (oldest === undefined) break;
			stopMonitor(oldest);
		}

		const entry: MonitorEntry = {
			name: params.name,
			command: params.command,
			intervalSec,
			stopOn: params.stopOn ?? "change",
			lastHash: null,
			checks: 0,
			timer: setInterval(() => scheduleCheck(entry), intervalSec * 1000),
			checkPromise: null,
		};
		monitors().set(params.name, entry);
		// First check runs detached: the tool returns immediately instead of
		// freezing the engine for the command's full runtime.
		scheduleCheck(entry);
		return {
			content: [
				{
					type: "text",
					text: `monitor "${params.name}" running every ${intervalSec}s (${entry.stopOn}) — first check logged; auto-stops itself when it fires; torus_monitor_stop only to cancel before that; to wait on it, end the turn rather than sleeping or re-polling: the fire marker wakes the session, and the wake gate holds delivery while a run is active, so in-turn polling never sees it`,
				},
			],
			details: toolDetails({ name: params.name, intervalSec, active: monitors().size }),
		};
	},
});

const monitorStopTool = defineTool({
	name: "torus_monitor_stop",
	label: "Torus Monitor Stop",
	description: "Stop a running torus monitor by name",
	parameters: Type.Object({ name: Type.String() }),
	async execute(_toolCallId, params) {
		const stopped = stopMonitor(params.name);
		return {
			content: [
				{
					type: "text",
					text: stopped
						? `monitor "${params.name}" stopped`
						: `no monitor named "${params.name}" — monitors stop themselves when they fire, so a fired one is already gone`,
				},
			],
			details: toolDetails({ stopped }),
			isError: !stopped,
		};
	},
});

const bgTool = defineTool({
	name: "torus_bg",
	label: "Torus Background Task",
	description:
		"Run a shell command once in the background and wake the session when it exits: the exit marker carries the exit code, duration, and an output tail, held by the wake gate while a run is active. Output logs to $TORUS_STATE_DIR/bg/<name>.log. Outlives the turn (no nohup needed), dies with the session. Use for long builds, test suites, image bakes — anything the bash timeout would cut; torus_monitor is the sibling for watching a command on an interval. To wait on the outcome, end the turn rather than polling in-turn.",
	parameters: Type.Object({
		name: Type.String({ description: "Short task name ([a-z0-9-])" }),
		command: Type.String({ description: "Shell command to run once, to completion" }),
		cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
		timeoutSec: Type.Optional(
			Type.Number({
				minimum: 1,
				maximum: 86_400,
				description: "Kill past this (SIGTERM, SIGKILL after 2s); the wake reports a timeout",
			}),
		),
	}),
	async execute(_toolCallId, params) {
		if (!knobBoolean("TORUS_BG", "monitor", "bg", true, parseZeroDisables)) {
			return {
				content: [{ type: "text", text: "background tasks disabled (TORUS_BG=0)" }],
				details: toolDetails({ error: "disabled" }),
				isError: true,
			};
		}
		const started = startBgTask(params);
		if (!started.ok) {
			return {
				content: [{ type: "text", text: started.error }],
				details: toolDetails({ error: "invalid" }),
				isError: true,
			};
		}
		return {
			content: [
				{
					type: "text",
					text: `bg "${params.name}" started (pid ${started.pid ?? "?"}) — log: ${started.logFile}; wakes the session when it exits; end the turn rather than polling: the wake gate holds the exit marker while a run is active`,
				},
			],
			details: toolDetails({ name: params.name, pid: started.pid, logFile: started.logFile }),
		};
	},
});

const bgStopTool = defineTool({
	name: "torus_bg_stop",
	label: "Torus Background Task Stop",
	description:
		"Stop a running background task by name (SIGTERM, SIGKILL after 2s); its exit marker reports it as stopped",
	parameters: Type.Object({ name: Type.String() }),
	async execute(_toolCallId, params) {
		const outcome = stopBgTask(params.name);
		return {
			content: [
				{
					type: "text",
					text:
						outcome === "stopped"
							? `bg "${params.name}" stopping (SIGTERM, SIGKILL after 2s) — its exit marker reports it as stopped`
							: `no bg task named "${params.name}" — finished tasks are gone; the log keeps their output`,
				},
			],
			details: toolDetails({ outcome }),
			isError: outcome === "missing",
		};
	},
});

export function registerMonitor(pi: ExtensionAPI): void {
	pi.registerTool(monitorTool);
	pi.registerTool(monitorStopTool);
	pi.registerTool(bgTool);
	pi.registerTool(bgStopTool);
	pi.on("session_shutdown", () => {
		for (const name of [...monitors().keys()]) stopMonitor(name);
		for (const entry of [...bgTasks().values()]) killBg(entry);
	});
}

export default function monitorExtension(pi: ExtensionAPI): void {
	if (!gateExtension("monitor", PLATFORM_SUPPORT)) return;
	registerMonitor(pi);
}
