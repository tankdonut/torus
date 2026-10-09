/**
 * torus — approval extension.
 *
 * Trust-on-denial UX for the sandbox's network allowlist: when srt's proxy
 * hits a non-allowlisted host, ask the user Allow once / Always allow
 * (this project) / Deny / Custom… (typed host or *.domain ⇒ session
 * allow). "Always" persists under ~/.torus/state/--<project>--/sandbox-hosts.json
 * — outside the sandbox's writable roots, so the agent cannot self-escalate.
 * Approvals from the pre-namespacing ~/.torus/sandbox/<slug>-hosts.json
 * layout are still read (never rewritten) so existing trusts keep working.
 * Headless sessions auto-deny. TORUS_APPROVAL=0 leaves the slot absent
 * (sandbox denies unmatched hosts, as before).
 */
import { unlinkSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { projectStateDir, readJsonFallback, torusHome, writeJson } from "../fsutil.js";

export type TrustDecision =
	| { kind: "allow" }
	| { kind: "always" }
	| { kind: "deny" }
	| { kind: "custom"; text: string; host: string | null };

export interface ApprovalSlot {
	askNetworkTrust(host: string, port: number | undefined): Promise<TrustDecision>;
}

const APPROVAL_SLOT = Symbol.for("torus.approval.v1");
const DIALOG_TIMEOUT_MS = 120_000;
const ALLOW_ONCE = "Allow once";
const ALWAYS_ALLOW = "Always allow (this project)";
const DENY = "Deny";
const CUSTOM = "Custom…";

function hostsFile(cwd: string): string {
	return path.join(projectStateDir(cwd), "sandbox-hosts.json");
}

/** Pre-namespacing slug: strip non-alphanumerics, lowercase, last 48 chars. */
function legacyProjectSlug(cwd: string): string {
	const slug = cwd
		.replace(/[^a-zA-Z0-9-]/g, "")
		.toLowerCase()
		.slice(-48);
	return slug.length > 0 ? slug : "default";
}

/** Old flat layout, kept as a read fallback only — never written. */
function legacyHostsFile(cwd: string): string {
	return path.join(torusHome(), "sandbox", `${legacyProjectSlug(cwd)}-hosts.json`);
}

export function readPersistedHosts(cwd: string): string[] {
	const persisted = readJsonFallback<{ hosts?: unknown }>(hostsFile(cwd), legacyHostsFile(cwd), {
		hosts: [],
	});
	if (!Array.isArray(persisted.hosts)) return [];
	return persisted.hosts.filter((host): host is string => typeof host === "string");
}

export function writePersistedHosts(cwd: string, hosts: string[]): void {
	writeJson(hostsFile(cwd), { hosts: [...new Set(hosts)] });
	try {
		unlinkSync(legacyHostsFile(cwd));
	} catch {}
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const WILDCARD_HOST_RE = /^\*\.[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parseCustomHost(text: string): string | null {
	const value = text.trim().toLowerCase();
	if (HOST_RE.test(value) || WILDCARD_HOST_RE.test(value)) return value;
	return null;
}

function matchesAllowed(host: string, entry: string): boolean {
	if (entry === host) return true;
	if (entry.startsWith("*.")) return host.endsWith(entry.slice(1));
	return false;
}

function anyMatches(host: string, entries: Iterable<string>): boolean {
	for (const entry of entries) {
		if (matchesAllowed(host, entry)) return true;
	}
	return false;
}

export interface DecideOptions {
	persist?: (hosts: string[]) => void;
}

/**
 * Pure-ish decision core (injectable ctx + persistence) so tests never
 * touch real dialogs or the real ~/.torus tree.
 */
export async function decideTrust(
	ctx: ExtensionContext | null,
	host: string,
	port: number | undefined,
	options: DecideOptions = {},
): Promise<TrustDecision> {
	const persist =
		options.persist ?? ((hosts: string[]) => writePersistedHosts(process.cwd(), hosts));
	const cwd = ctx?.cwd ?? process.cwd();
	const persisted = readPersistedHosts(cwd);
	if (anyMatches(host, persisted)) return { kind: "allow" };
	if (!ctx?.hasUI) return { kind: "deny" };
	const where = `${host}${port !== undefined ? `:${port}` : ""}`;
	const chosen = await ctx.ui.select(
		`Sandbox — trust ${where}?`,
		[ALLOW_ONCE, ALWAYS_ALLOW, DENY, CUSTOM],
		{ timeout: DIALOG_TIMEOUT_MS },
	);
	if (chosen === ALLOW_ONCE) return { kind: "allow" };
	if (chosen === ALWAYS_ALLOW) {
		persist([...persisted, host]);
		return { kind: "always" };
	}
	if (chosen === CUSTOM) {
		const typed = (await ctx.ui.input(`${where} — host or *.domain to allow`))?.trim();
		if (typed) return { kind: "custom", text: typed, host: parseCustomHost(typed) };
		return { kind: "deny" };
	}
	return { kind: "deny" };
}

let lastCtx: ExtensionContext | null = null;
const sessionAllowed = new Set<string>();
const sessionDenied = new Set<string>();
const inFlight = new Map<string, Promise<TrustDecision>>();

async function askNetworkTrust(host: string, port: number | undefined): Promise<TrustDecision> {
	if (anyMatches(host, sessionDenied)) return { kind: "deny" };
	if (anyMatches(host, sessionAllowed)) return { kind: "allow" };
	const key = `${host}:${port ?? 443}`;
	const pending = inFlight.get(key);
	if (pending) return pending;
	const decision = decideTrust(lastCtx, host, port).then((result) => {
		if (result.kind === "always") {
			sessionAllowed.add(host);
		} else if (result.kind === "custom" && result.host) {
			sessionAllowed.add(result.host);
		} else if (result.kind === "allow") {
			sessionAllowed.add(host);
		} else {
			sessionDenied.add(host);
		}
		return result;
	});
	inFlight.set(key, decision);
	try {
		return await decision;
	} finally {
		inFlight.delete(key);
	}
}

export function registerApproval(pi: ExtensionAPI): void {
	if (process.env["TORUS_APPROVAL"] === "0") return;
	const store = globalThis as Record<symbol, ApprovalSlot | undefined>;
	if (!store[APPROVAL_SLOT]) {
		store[APPROVAL_SLOT] = { askNetworkTrust };
	}
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		return undefined;
	});
}

export default function approvalExtension(pi: ExtensionAPI): void {
	registerApproval(pi);
}
