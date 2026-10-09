/**
 * torus — monitor.
 *
 * Watch a command's output on an interval; notify + log when it changes or
 * fails. Monitors live on globalThis (one map per process) and are cleaned
 * up on session shutdown. TORUS_MONITOR=0 disables.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { projectStateDir, torusHome } from "../fsutil.js";
import { notifyMonitor } from "../osnotify.js";
import { emitTorusCustom } from "../registry.js";

function toolDetails(d: Record<string, unknown>): Record<string, unknown> {
	return d;
}

const MIN_INTERVAL_SEC = 5;
const MAX_MONITORS = 5;

/** Per-project monitor log dir, resolved per check — a session can cd after load. */
function monitorLogDir(): string {
	return path.join(projectStateDir(), "monitors");
}

/** Pre-namespacing log dir; only ever read for the one-time rename migration. */
function legacyDir(): string {
	return path.join(torusHome(), "monitors");
}

interface MonitorEntry {
	name: string;
	command: string;
	intervalSec: number;
	stopOn: "change" | "fail";
	lastHash: string | null;
	checks: number;
	timer: ReturnType<typeof setInterval>;
}

const MONITORS_KEY = Symbol.for("torus.monitors");

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
	const tail = output.trim().replace(/\s+/g, " ").slice(0, 200);
	const what = reason === "fail" ? "failed" : "output changed";
	emitTorusCustom(
		{
			customType: "torus.monitor-fired",
			content: [
				{
					type: "text",
					text: `monitor "${entry.name}" ${what}${exit !== null ? ` (exit ${exit})` : ""}${tail.length > 0 ? `: ${tail}` : ""}`,
				},
			],
			display: true,
			details: { name: entry.name, reason, exit, tail },
		},
		// Wake the model so it reacts to the fired monitor: an idle session starts
		// a turn; a streaming one gets the marker queued as a follow-up instead of
		// steering mid-generation.
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

/** Run one check cycle: log every result, fire (toast + transcript + stop) on the stopOn outcome. */
export function runMonitorCheck(entry: MonitorEntry): void {
	const run = spawnSync("bash", ["-c", entry.command], { encoding: "utf8", timeout: 30000 });
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const digest = hashOutput(output);
	entry.checks += 1;
	const failed = run.status !== null && run.status !== 0;

	const logDir = monitorLogDir();
	mkdirSync(logDir, { recursive: true });
	const logFile = path.join(logDir, `${entry.name}.log`);
	// One-time migration: a pre-namespacing log is renamed (not copied) into
	// the project dir on first write; history is durable and never pruned.
	const legacyFile = path.join(legacyDir(), `${entry.name}.log`);
	if (existsSync(legacyFile) && !existsSync(logFile)) {
		renameSync(legacyFile, logFile);
	}
	appendFileSync(
		logFile,
		`[${new Date().toISOString()}] check ${entry.checks} exit=${run.status} hash=${digest}\n${output.slice(0, 2000)}\n`,
	);

	if (failed && entry.stopOn === "fail") {
		emitMonitorFired(entry, "fail", run.status, output);
		notifyMonitor("failed", { name: entry.name, exit: run.status, output });
		stopMonitor(entry.name);
		return;
	}
	if (entry.lastHash !== null && digest !== entry.lastHash && entry.stopOn === "change") {
		emitMonitorFired(entry, "change", run.status, output);
		notifyMonitor("changed", { name: entry.name, exit: run.status, output });
		appendFileSync(logFile, `[${new Date().toISOString()}] change detected — monitor stopped\n`);
		stopMonitor(entry.name);
		return;
	}
	entry.lastHash = digest;
}

export function stopMonitor(name: string): boolean {
	const entry = monitors().get(name);
	if (!entry) return false;
	clearInterval(entry.timer);
	monitors().delete(name);
	return true;
}

const monitorTool = defineTool({
	name: "torus_monitor",
	label: "Torus Monitor",
	description:
		"Watch a shell command on an interval; desktop-notifies and stops when its output changes (stopOn: change) or it exits non-zero (stopOn: fail). History lands in $TORUS_STATE_DIR/monitors/<name>.log. Use for CI tails, file watches, long builds.",
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
		if (process.env["TORUS_MONITOR"] === "0") {
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
			timer: setInterval(() => runMonitorCheck(entry), intervalSec * 1000),
		};
		monitors().set(params.name, entry);
		runMonitorCheck(entry);
		return {
			content: [
				{
					type: "text",
					text: `monitor "${params.name}" running every ${intervalSec}s (${entry.stopOn}) — first check logged; torus_monitor_stop to cancel`,
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
					text: stopped ? `monitor "${params.name}" stopped` : `no monitor named "${params.name}"`,
				},
			],
			details: toolDetails({ stopped }),
			isError: !stopped,
		};
	},
});

export function registerMonitor(pi: ExtensionAPI): void {
	pi.registerTool(monitorTool);
	pi.registerTool(monitorStopTool);
	pi.on("session_shutdown", () => {
		for (const name of [...monitors().keys()]) stopMonitor(name);
	});
}

export default function monitorExtension(pi: ExtensionAPI): void {
	registerMonitor(pi);
}
