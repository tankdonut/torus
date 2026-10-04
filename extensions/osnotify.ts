/**
 * torus — OS notifications.
 *
 * Desktop toasts for delegation lifecycle and monitor events, rendered as
 * notify-send summary + body pairs: the summary leads with the run's @handle
 * (agent name as fallback) plus duration; the body carries a one-line result
 * preview and run stats. Every toast carries the `torus` desktop-entry hint
 * so GNOME groups them under a single source; a delegation's finishing toast
 * replaces its RUNNING_LATE_MS "still running" toast in place via
 * replaces-id; low-value toasts are transient (banner only, no tray pile-up)
 * while failures and monitor changes stay resident. Silently no-ops where
 * notify-send is absent; TORUS_NOTIFY=0 opts out entirely.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Runs shorter than this never announce their start; completion always toasts. */
export const RUNNING_LATE_MS = 45_000;

export type ToastUrgency = "low" | "normal" | "critical";

export interface DelegationToastInfo {
	agent: string;
	handle: string | null;
	model: string;
	startedAt: number;
	turns: number;
	tokensIn: number;
	tokensOut: number;
	text: string;
}

export type DelegationToastKind = "running-late" | "done" | "failed";

export interface MonitorToastInfo {
	name: string;
	exit: number | null;
	output: string;
}

export type MonitorToastKind = "failed" | "changed";

export interface Toast {
	summary: string;
	body: string;
	urgency: ToastUrgency;
	/** notify-send -t milliseconds; 0 asks the server to keep it until dismissed. */
	expireMs: number;
	/** Transient toasts banner without piling up in the message tray. */
	transient: boolean;
}

/** Prefer the run's @handle over the generic agent name (fleet/pane convention). */
export function runLabel(agent: string, handle: string | null): string {
	return handle ? `@${handle}` : agent;
}

export function formatDuration(ms: number): string {
	if (ms < 0) ms = 0;
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) {
		const sec = totalSec % 60;
		return sec > 0 ? `${totalMin}m ${String(sec).padStart(2, "0")}s` : `${totalMin}m`;
	}
	const hours = Math.floor(totalMin / 60);
	const min = totalMin % 60;
	return min > 0 ? `${hours}h ${String(min).padStart(2, "0")}m` : `${hours}h`;
}

export function compactTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

function shortModel(model: string): string {
	return model.split("/")[1] ?? model;
}

/**
 * Strip ANSI escape sequences and C1 control chars before text reaches a
 * toast. Local copy of registry's sanitizeRender — kept here to avoid a
 * registry ↔ osnotify import cycle.
 */
function flatten(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b/g, "")
		.replace(/[\u0080-\u009F]/g, "");
}

/** First meaningful line of a result, flattened and trimmed for the toast body. */
export function previewLine(text: string, max = 140): string {
	for (const raw of flatten(text).split("\n")) {
		const line = raw.trim().replace(/\s+/g, " ");
		if (line.length === 0) continue;
		return line.length > max ? `${line.slice(0, max - 1)}…` : line;
	}
	return "";
}

function statsLine(info: DelegationToastInfo): string {
	const tokens = compactTokens(info.tokensIn + info.tokensOut);
	return `${info.turns} turn${info.turns === 1 ? "" : "s"} · ${tokens} tok · ${shortModel(info.model)}`;
}

export function delegationToast(
	kind: DelegationToastKind,
	info: DelegationToastInfo,
	now = Date.now(),
): Toast {
	const who = runLabel(info.agent, info.handle);
	const elapsed = formatDuration(now - info.startedAt);
	const preview = previewLine(info.text);
	const stats = statsLine(info);

	if (kind === "running-late") {
		return {
			summary: `torus ▶ ${who} still running`,
			body: [`${elapsed} in · ${stats}`, preview].filter(Boolean).join("\n"),
			urgency: "low",
			expireMs: 5000,
			transient: true,
		};
	}
	if (kind === "failed") {
		return {
			summary: `torus ✗ ${who} failed · ${elapsed}`,
			body: [preview || "(no output)", stats].join("\n"),
			urgency: "critical",
			expireMs: 0,
			transient: false,
		};
	}
	return {
		summary: `torus ✓ ${who} finished · ${elapsed}`,
		body: [preview || "(no text output)", stats].join("\n"),
		urgency: "low",
		expireMs: 6000,
		transient: true,
	};
}

export function monitorToast(kind: MonitorToastKind, info: MonitorToastInfo): Toast {
	const tail = previewLine(info.output, 120);
	if (kind === "failed") {
		const exit = info.exit === null ? "signal" : `exit ${info.exit}`;
		return {
			summary: `torus monitor ✗ ${info.name} failed (${exit})`,
			body: tail,
			urgency: "critical",
			expireMs: 0,
			transient: false,
		};
	}
	return {
		summary: `torus monitor ≈ ${info.name} output changed`,
		body: tail || "(empty output)",
		urgency: "normal",
		expireMs: 8000,
		transient: false,
	};
}

/** The notification-spec body parser eats raw markup — escape the big three. */
function escapeMarkup(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** notify-send gained --print-id/--replace-id in 0.7.9; only chain when present. */
let chainSupport: boolean | null = null;
function canChainIds(): boolean {
	if (chainSupport === null) {
		try {
			const help = spawnSync("notify-send", ["--help"], { encoding: "utf8", timeout: 3000 });
			chainSupport = /--print-id/.test(help.stdout ?? "");
		} catch {
			chainSupport = false;
		}
	}
	return chainSupport;
}

/** The exact notify-send argv for a toast; pure given the chaining capability. */
export function toastArgs(toast: Toast, replaceId?: number, canChain = true): string[] {
	const args = [
		"-a",
		"torus",
		"-u",
		toast.urgency,
		"-t",
		String(toast.expireMs),
		"-h",
		"STRING:desktop-entry:torus",
	];
	if (toast.transient) args.push("-h", "boolean:transient:true");
	if (canChain) {
		args.push("-p");
		if (replaceId !== undefined) args.push("-r", String(replaceId));
	}
	args.push(escapeMarkup(toast.summary));
	if (toast.body !== "") args.push(escapeMarkup(toast.body));
	return args;
}

/**
 * GNOME groups toasts by desktop-entry identity, so all torus notifications
 * need one installed source entry. NoDisplay keeps it out of app grids while
 * remaining a valid notification source; written once, never overwritten.
 */
const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=torus
Comment=torus fleet delegation and monitor notifications
Exec=torus
Icon=utilities-terminal
NoDisplay=true
`;

let desktopEntryEnsured = false;
function ensureDesktopEntry(): void {
	if (desktopEntryEnsured) return;
	desktopEntryEnsured = true;
	const target = path.join(homedir(), ".local", "share", "applications", "torus.desktop");
	try {
		mkdirSync(path.dirname(target), { recursive: true });
		if (!existsSync(target)) writeFileSync(target, DESKTOP_ENTRY, { mode: 0o644 });
	} catch {
		// unwritable HOME — grouping falls back to the plain app name
	}
}

/**
 * Fire a toast; returns the server notification id when chaining is
 * supported, so a later toast can replace this one in place.
 */
export function osNotify(toast: Toast, replaceId?: number): number | null {
	if (process.env["TORUS_NOTIFY"] === "0") return null;
	ensureDesktopEntry();
	const canChain = canChainIds();
	try {
		const run = spawnSync("notify-send", toastArgs(toast, replaceId, canChain), {
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			timeout: 3000,
		});
		if (!canChain || run.status !== 0) return null;
		const id = Number.parseInt((run.stdout ?? "").trim(), 10);
		return Number.isInteger(id) && id > 0 ? id : null;
	} catch {
		// absent binary or desktop bus — notifications are best-effort
		return null;
	}
}

export function notifyDelegation(
	kind: DelegationToastKind,
	info: DelegationToastInfo,
	now = Date.now(),
	replaceId?: number,
): number | null {
	return osNotify(delegationToast(kind, info, now), replaceId);
}

export function notifyMonitor(kind: MonitorToastKind, info: MonitorToastInfo): void {
	osNotify(monitorToast(kind, info));
}
