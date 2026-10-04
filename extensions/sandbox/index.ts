/**
 * torus — sandbox extension.
 *
 * Opt-in (TORUS_SANDBOX=full) per-command isolation for agent bash calls, built on
 * @anthropic-ai/sandbox-runtime (srt): writes confined to the workspace
 * (+ tmp + extras + git/worktree plumbing), network restricted to a
 * curated allowlist plus user additions. Degrades to unsandboxed — with a one-time notice —
 * when dependencies are missing or init fails; bash is never bricked.
 *
 * srt 0.0.77 couples filesystem and network restriction (network is
 * schema-required and any defined allowlist activates isolation), so
 * `fs`-only mode is not expressible: TORUS_SANDBOX accepts `off` | `full`.
 *
 * Worktrees: delegated children run with cwd = their worktree and confine
 * to it; the git common dir (linked worktrees share refs/objects with the
 * main repo, so commits would otherwise be denied) and the torus worktrees
 * root (parent-side verification of delegated work) are added to allowWrite.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	SandboxManager,
	type SandboxRuntimeConfig,
	type WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";
import {
	type BashToolCallEvent,
	type ExtensionAPI,
	type ExtensionContext,
	isBashToolResult,
	type ToolCallEvent,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { torusHome } from "../fsutil.js";

export type SandboxMode = "off" | "full";

export interface SandboxEnv {
	mode: SandboxMode;
	/** Raw TORUS_SANDBOX value (lowercased), kept so unsupported requests can be surfaced. */
	requested: string;
	writableExtras: string[];
	netOnly: boolean;
	netAdd: string[];
	netDropped: string[];
}

const OFF_VALUES = new Set(["0", "off"]);
const FULL_VALUES = new Set(["1", "on", "full"]);

/** Exact-host entries (srt matching is exact-host; *.x covers strict subdomains only). */
export const CURATED_NET_ALLOWLIST: readonly string[] = [
	// package registries + artifact hosts
	"registry.npmjs.org",
	"pypi.org",
	"files.pythonhosted.org",
	"crates.io",
	"static.crates.io",
	"index.crates.io",
	"proxy.golang.org",
	"sum.golang.org",
	"rubygems.org",
	"repo.maven.apache.org",
	"services.gradle.org",
	"plugins.gradle.org",
	"api.nuget.org",
	"repo.packagist.org",
	"hex.pm",
	"repo.hex.pm",
	"hackage.haskell.org",
	"cran.r-project.org",
	// VCS / code hosting (github release assets live on release-assets…)
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"raw.githubusercontent.com",
	// core toolchain downloads
	"static.rust-lang.org",
	"nodejs.org",
	"dl.google.com",
	"deb.debian.org",
	"archive.ubuntu.com",
	"security.ubuntu.com",
];

const BROAD_NET_PATTERN = /^(?:\*|\*\.[^.]+)$/;

export function parseNetEntries(raw: string): {
	entries: string[];
	dropped: string[];
} {
	const entries: string[] = [];
	const dropped: string[] = [];
	for (const part of raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0)) {
		if (BROAD_NET_PATTERN.test(part)) dropped.push(part);
		else entries.push(part);
	}
	return { entries, dropped };
}

export function parseSandboxEnv(env: NodeJS.ProcessEnv): SandboxEnv {
	const requested = (env["TORUS_SANDBOX"] ?? "").trim().toLowerCase();
	const mode: SandboxMode = FULL_VALUES.has(requested) ? "full" : "off";
	const writableExtras = (env["TORUS_SANDBOX_WRITABLE"] ?? "")
		.split(":")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const netAdd = parseNetEntries(env["TORUS_SANDBOX_NET_ADD"] ?? "");
	const onlyRaw = (env["TORUS_SANDBOX_NET_ONLY"] ?? "").trim();
	const netOnly = onlyRaw.length > 0 && onlyRaw.toLowerCase() !== "0";
	if (netOnly) {
		const only = parseNetEntries(onlyRaw);
		netAdd.entries.push(...only.entries);
		netAdd.dropped.push(...only.dropped);
	}
	return {
		mode,
		requested,
		writableExtras,
		netOnly,
		netAdd: netAdd.entries,
		netDropped: netAdd.dropped,
	};
}

function gitCommonDir(cwd: string): string | null {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
		encoding: "utf8",
	});
	if (result.status !== 0 || !result.stdout.trim()) return null;
	const dir = result.stdout.trim();
	const resolved = path.isAbsolute(dir) ? dir : path.resolve(cwd, dir);
	return existsSync(resolved) ? resolved : null;
}

function worktreesRoot(): string | null {
	const root = process.env["TORUS_WORKTREES_ROOT"] ?? path.join(torusHome(), "worktrees");
	return existsSync(root) ? root : null;
}

/** Extra writable roots required for git/worktree plumbing (see header). */
export function resolveAdditionalWritableRoots(cwd: string): string[] {
	const roots = [gitCommonDir(cwd), worktreesRoot()];
	return [...new Set(roots.filter((root): root is string => root !== null))];
}

export function buildSandboxConfig(
	cwd: string,
	sandboxEnv: SandboxEnv,
	additionalRoots: string[] = [],
): SandboxRuntimeConfig {
	return {
		filesystem: {
			denyRead: [],
			allowWrite: [cwd, tmpdir(), ...sandboxEnv.writableExtras, ...additionalRoots],
			denyWrite: [],
		},
		network: {
			allowedDomains: [
				...new Set(
					sandboxEnv.netOnly
						? (sandboxEnv.netAdd ?? [])
						: [...CURATED_NET_ALLOWLIST, ...(sandboxEnv.netAdd ?? [])],
				),
			],
			deniedDomains: [],
		},
	};
}

export type SandboxAskFn = (params: { host: string; port: number | undefined }) => Promise<boolean>;

/** Manager surface torus uses (subset of srt's ISandboxManager singleton). */
export interface SandboxManagerLike {
	initialize(config: SandboxRuntimeConfig, ask?: SandboxAskFn): Promise<void>;
	updateConfig(config: SandboxRuntimeConfig): void;
	wrapWithSandbox(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
		options?: WrapWithSandboxOptions,
	): Promise<string>;
	annotateStderrWithSandboxFailures(command: string, stderr: string): string;
	cleanupAfterCommand(): void;
	reset(): Promise<void>;
}

export interface SandboxDeps {
	manager: SandboxManagerLike;
	probe(): Promise<{ errors: string[] }>;
}

export interface SandboxState {
	mode: SandboxMode;
	active: boolean;
}

export async function activateSandbox(
	sandboxEnv: SandboxEnv,
	deps: SandboxDeps,
	sink: (message: string) => void = (message) => {
		process.stderr.write(`${message}\n`);
	},
	additionalWritableRoots: string[] = [],
	ask: SandboxAskFn | undefined = undefined,
): Promise<SandboxState> {
	const unrecognized =
		sandboxEnv.requested !== "" &&
		!FULL_VALUES.has(sandboxEnv.requested) &&
		!OFF_VALUES.has(sandboxEnv.requested);
	if (unrecognized) {
		sink(
			`[torus: sandbox] TORUS_SANDBOX=${sandboxEnv.requested} is not a recognized mode (off | full) — defaulting to off`,
		);
	}
	if (sandboxEnv.mode === "off") {
		return { mode: "off", active: false };
	}
	const probe = await deps.probe();
	if ((sandboxEnv.netDropped ?? []).length > 0) {
		sink(
			`[torus: sandbox] dropped over-broad network entries (srt rejects them): ${sandboxEnv.netDropped.join(", ")}`,
		);
	}
	if (probe.errors.length > 0) {
		sink(
			`[torus: sandbox] unavailable: ${probe.errors.join(", ")} — running unsandboxed (TORUS_SANDBOX=off silences this)`,
		);
		return { mode: "full", active: false };
	}
	try {
		await deps.manager.initialize(
			buildSandboxConfig(process.cwd(), sandboxEnv, additionalWritableRoots),
			ask,
		);
	} catch (error) {
		sink(
			`[torus: sandbox] init failed: ${error instanceof Error ? error.message : String(error)} — running unsandboxed`,
		);
		return { mode: "full", active: false };
	}
	return { mode: "full", active: true };
}

const SANDBOX_SLOT = Symbol.for("torus.sandbox.v1");

/** Shared via globalThis: pi gives each extension entry its own module root, so plain module state is invisible to /doctor. */
function sharedSandboxState(): { state: SandboxState } {
	const store = globalThis as Record<symbol, { state: SandboxState } | undefined>;
	const existing = store[SANDBOX_SLOT];
	if (existing) return existing;
	const created: { state: SandboxState } = { state: { mode: "off", active: false } };
	store[SANDBOX_SLOT] = created;
	return created;
}
const shared = sharedSandboxState();
let activationPromise: Promise<SandboxState> | null = null;
let activeManager: SandboxManagerLike | null = null;
/** toolCallId → original command, for violation annotation on the result. */
const activeCommands = new Map<string, string>();

export function getSandboxState(): SandboxState {
	return shared.state;
}

const STATUS_KEY = "torus:sandbox";
let lastCtx: ExtensionContext | null = null;

function chipText(state: SandboxState): string {
	if (state.mode === "off") return "sbx:off";
	return state.active ? "sbx:on" : "sbx:down";
}

function setSandboxStatus(ctx: ExtensionContext, text: string | undefined): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// Session replacement (resume/fork/switch/reload) invalidates a captured ctx;
		// accessing ctx.ui on it throws. The chip is cosmetic — the next session_start
		// re-renders it with the fresh ctx, so drop the stale reference and move on.
		lastCtx = null;
	}
}

function subscribeChip(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		setSandboxStatus(ctx, chipText(shared.state));
		return undefined;
	});
}

function subscribeSandboxHandlers(pi: ExtensionAPI): void {
	subscribeChip(pi);
	pi.on("tool_call", async (event: ToolCallEvent) => {
		if (event.type !== "tool_call") return undefined;
		if (activationPromise !== null) await activationPromise;
		const manager = activeManager;
		if (!manager || (event as BashToolCallEvent).toolName !== "bash") {
			return undefined;
		}
		const input = event.input as { command?: unknown };
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;
		try {
			const wrapped = await manager.wrapWithSandbox(command, undefined, undefined, undefined, {
				commandId: event.toolCallId,
			});
			input.command = wrapped;
			activeCommands.set(event.toolCallId, command);
			return undefined;
		} catch (error) {
			return {
				block: true,
				reason: `[torus:sandbox] wrap failed: ${error instanceof Error ? error.message : String(error)} (TORUS_SANDBOX=off disables sandboxing)`,
			};
		}
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		if (event.type !== "tool_result") return undefined;
		const manager = activeManager;
		if (!manager || !isBashToolResult(event)) return undefined;
		const command = activeCommands.get(event.toolCallId);
		if (command === undefined) return undefined;
		activeCommands.delete(event.toolCallId);
		let changed = false;
		const content = event.content.map((block) => {
			if (block.type !== "text") return block;
			const annotated = manager.annotateStderrWithSandboxFailures(command, block.text);
			if (annotated === block.text) return block;
			changed = true;
			return { ...block, text: annotated };
		});
		manager.cleanupAfterCommand();
		return changed ? { content } : undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		setSandboxStatus(ctx, undefined);
		const manager = activeManager;
		if (!manager) return undefined;
		activeManager = null;
		activationPromise = null;
		activeCommands.clear();
		void manager.reset();
		return undefined;
	});
}

const defaultDeps: SandboxDeps = {
	manager: SandboxManager,
	probe: () => SandboxManager.checkDependenciesAsync(),
};

let lastConfig: SandboxRuntimeConfig | null = null;

type ApprovalDecision =
	| { kind: "allow" }
	| { kind: "always" }
	| { kind: "deny" }
	| { kind: "custom"; text: string; host: string | null };

function buildAskCallback(manager: SandboxManagerLike): SandboxAskFn {
	return async ({ host, port }) => {
		// Lazy slot resolution: approval loads after sandbox in pi.extensions.
		const store = globalThis as Record<
			symbol,
			| { askNetworkTrust(host: string, port: number | undefined): Promise<ApprovalDecision> }
			| undefined
		>;
		const slot = store[Symbol.for("torus.approval.v1")];
		if (!slot) return false;
		try {
			const decision = await slot.askNetworkTrust(host, port);
			const grantedHost =
				decision.kind === "always"
					? host
					: decision.kind === "custom" && decision.host
						? decision.host
						: null;
			if (lastConfig && grantedHost !== null) {
				lastConfig = {
					...lastConfig,
					network: {
						...lastConfig.network,
						allowedDomains: [...new Set([...lastConfig.network.allowedDomains, grantedHost])],
					},
				};
				manager.updateConfig(lastConfig);
			}
			return grantedHost !== null || decision.kind === "allow";
		} catch {
			return false;
		}
	};
}

export async function registerSandbox(
	_pi: ExtensionAPI,
	deps: SandboxDeps = defaultDeps,
): Promise<void> {
	const sandboxEnv = parseSandboxEnv(process.env);
	if (sandboxEnv.mode === "off") {
		shared.state = { mode: "off", active: false };
		subscribeChip(_pi);
		return;
	}
	subscribeSandboxHandlers(_pi);
	const additionalRoots = resolveAdditionalWritableRoots(process.cwd());
	lastConfig = buildSandboxConfig(process.cwd(), sandboxEnv, additionalRoots);
	activationPromise = activateSandbox(
		sandboxEnv,
		deps,
		undefined,
		additionalRoots,
		buildAskCallback(deps.manager),
	);
	shared.state = await activationPromise;
	if (lastCtx) setSandboxStatus(lastCtx, chipText(shared.state));
	if (shared.state.active) activeManager = deps.manager;
}

export default function sandboxExtension(pi: ExtensionAPI): void {
	void registerSandbox(pi);
}
