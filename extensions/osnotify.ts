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

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { knobBoolean, parseZeroDisables } from "./config/knobs.js";
import { formatDuration, formatTokens, shortModel, statusGlyphText } from "./fleet/theme-kit.js";
import { previewLine } from "./text.js";

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

export interface BgToastInfo {
	name: string;
	exit: number | null;
	output: string;
	durationMs: number;
	stopped?: boolean;
	timedOut?: boolean;
}

export type BgToastKind = "done" | "failed";

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

function statsLine(info: DelegationToastInfo): string {
	const tokens = formatTokens(info.tokensIn + info.tokensOut);
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
			summary: `torus ${statusGlyphText("started")} ${who} still running`,
			body: [`${elapsed} in · ${stats}`, preview].filter(Boolean).join("\n"),
			urgency: "low",
			expireMs: 5000,
			transient: true,
		};
	}
	if (kind === "failed") {
		return {
			summary: `torus ${statusGlyphText("failed")} ${who} failed · ${elapsed}`,
			body: [preview || "(no output)", stats].join("\n"),
			urgency: "critical",
			expireMs: 0,
			transient: false,
		};
	}
	return {
		summary: `torus ${statusGlyphText("done")} ${who} finished · ${elapsed}`,
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
			summary: `torus monitor ${statusGlyphText("failed")} ${info.name} failed (${exit})`,
			body: tail,
			urgency: "critical",
			expireMs: 0,
			transient: false,
		};
	}
	return {
		summary: `torus monitor ${statusGlyphText("changed")} ${info.name} output changed`,
		body: tail || "(empty output)",
		urgency: "normal",
		expireMs: 8000,
		transient: false,
	};
}

export interface ShutdownToastInfo {
	name: string;
	members: number;
	dir: string;
}

export function shutdownToast(info: ShutdownToastInfo): Toast {
	return {
		summary: `torus team ${info.name} shut down`,
		body: `${info.members} member(s) stopped · logs kept at ${info.dir}`,
		urgency: "normal",
		expireMs: 6000,
		transient: true,
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
 * Fire a toast without blocking the event loop; resolves to the server
 * notification id when chaining is supported, so a later toast can replace
 * this one in place. replaceId may be the promise from an earlier call —
 * thenable ids are awaited before the argv is built, so a stored result can
 * be passed straight through. A failed spawn or a 3s timeout resolves null.
 */
export async function osNotify(
	toast: Toast,
	replaceId?: number | PromiseLike<number | null>,
): Promise<number | null> {
	if (!knobBoolean("TORUS_NOTIFY", "notify", "enabled", true, parseZeroDisables)) return null;
	ensureDesktopEntry();
	const canChain = canChainIds();
	// callers store an earlier toast's result and pass it back here unchanged;
	// a thenable id is awaited (null resolves to no replacement) before the argv
	// is built, so -r chaining keeps working across the async boundary.
	let chainId: number | undefined;
	if (typeof replaceId === "number") {
		chainId = replaceId;
	} else if (replaceId !== undefined) {
		chainId = (await replaceId) ?? undefined;
	}
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn("notify-send", toastArgs(toast, chainId, canChain), {
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			// absent binary or desktop bus — notifications are best-effort
			resolve(null);
			return;
		}
		let stdout = "";
		let settled = false;
		let termTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const settle = (id: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(termTimer);
			clearTimeout(killTimer);
			resolve(id);
		};
		termTimer = setTimeout(() => {
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
		}, 3000);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => settle(null));
		child.on("close", (code) => {
			if (!canChain || code !== 0) {
				settle(null);
				return;
			}
			const id = Number.parseInt(stdout.trim(), 10);
			settle(Number.isInteger(id) && id > 0 ? id : null);
		});
	});
}

export async function notifyDelegation(
	kind: DelegationToastKind,
	info: DelegationToastInfo,
	now = Date.now(),
	replaceId?: number | PromiseLike<number | null>,
): Promise<number | null> {
	return osNotify(delegationToast(kind, info, now), replaceId);
}

export function notifyMonitor(kind: MonitorToastKind, info: MonitorToastInfo): void {
	osNotify(monitorToast(kind, info)).catch(() => {});
}

export function bgToast(kind: BgToastKind, info: BgToastInfo): Toast {
	const tail = previewLine(info.output, 120);
	if (kind === "done") {
		return {
			summary: `torus bg ${statusGlyphText("done")} ${info.name} exited 0 in ${formatDuration(info.durationMs)}`,
			body: tail || "(no output)",
			urgency: "normal",
			expireMs: 8000,
			transient: false,
		};
	}
	const exit = info.exit === null ? "signal" : `exit ${info.exit}`;
	const why = info.timedOut
		? `timed out (${exit})`
		: info.stopped
			? `stopped (${exit})`
			: `failed (${exit})`;
	return {
		summary: `torus bg ${statusGlyphText(info.stopped === true ? "stopped" : "failed")} ${info.name} ${why}`,
		body: tail || "(no output)",
		urgency: "critical",
		expireMs: 0,
		transient: false,
	};
}

export function notifyBg(kind: BgToastKind, info: BgToastInfo): void {
	osNotify(bgToast(kind, info)).catch(() => {});
}
