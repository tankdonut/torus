/**
 * torus — sandbox extension.
 *
 * Opt-in (TORUS_SANDBOX=full; TORUS_SANDBOX_DEFAULT=full trials a default-on
 * environment without changing the shipped default) per-command isolation for agent bash calls, built on
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
 *
 * Activation pre-creates non-existent writable roots (srt silently drops them
 * from allowWrite otherwise) and claims a fresh private scratch dir via
 * CLAUDE_CODE_TMPDIR: srt injects it as TMPDIR at wrap time but never creates
 * the dir, and its default (/tmp/claude) is shared by every sandbox of the
 * user.
 *
 * Wrap-time shaping (see subscribeSandboxHandlers): policy-exempt command
 * prefixes skip the sandbox outright; every other wrapped command carries an
 * unguessable per-command network id (allow-once ask grants widen only the
 * command that asked), telemetry opt-out and policy env vars as a leading
 * `env` prefix, and install-shaped package-manager commands get the manager's
 * cache roots added to allowWrite via srt's whole-section customConfig.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import { readPersistedHosts } from "../approval/index.js";
import { torusHome } from "../fsutil.js";
import {
	loadSandboxPolicy,
	type ResolvedSandboxPolicy,
	type SandboxWritableRoot,
} from "./policy.js";
import { type SignRelay, type SignRelayOptions, startSignRelay } from "./sign-relay.js";

export type SandboxMode = "off" | "full";

export interface SandboxEnv {
	mode: SandboxMode;
	/** Raw TORUS_SANDBOX value (lowercased), kept so unsupported requests can be surfaced. */
	requested: string;
	writableExtras: string[];
	netOnly: boolean;
	netAdd: string[];
	netDropped: string[];
	/** Policy-provided literal writable roots (user layer first, then trusted project). */
	policyWritable: SandboxWritableRoot[];
	/** Policy host additions layered onto the curated allowlist. */
	policyHostsAdd: string[];
	/** User-layer replacement allowlist from the policy (empty = keep curated). */
	policyHostsOnly: string[];
	/** Policy-denied hosts. */
	policyHostsDeny: string[];
	/** Credential files to deny inside the sandbox (user layer only). */
	credentialsFiles: string[];
	/** Credential env vars to deny inside the sandbox (user layer only). */
	credentialsEnvVars: string[];
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
	// cloud APIs — strict subdomains only (srt rejects bare *.tld patterns)
	"*.amazonaws.com",
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

export function parseSandboxEnv(
	env: NodeJS.ProcessEnv,
	policy?: ResolvedSandboxPolicy,
): SandboxEnv {
	const requested = (env["TORUS_SANDBOX"] ?? "").trim().toLowerCase();
	// Precedence: explicit TORUS_SANDBOX > TORUS_SANDBOX_DEFAULT (trial knob:
	// run an environment default-on ahead of the shipped default flipping) >
	// user-layer policy mode > off. The policy's mode comes from the user
	// layer only (projects cannot set it); a non-on knob value is inert.
	const defaultKnob = (env["TORUS_SANDBOX_DEFAULT"] ?? "").trim().toLowerCase();
	const trialDefault = FULL_VALUES.has(defaultKnob);
	const explicitFull = FULL_VALUES.has(requested);
	const explicitOff = OFF_VALUES.has(requested);
	const mode: SandboxMode = explicitFull
		? "full"
		: explicitOff
			? "off"
			: trialDefault
				? "full"
				: (policy?.mode ?? "off");
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
		policyWritable: policy?.writable ?? [],
		policyHostsAdd: policy?.hostsAdd ?? [],
		policyHostsOnly: policy?.hostsOnly ?? [],
		policyHostsDeny: policy?.hostsDeny ?? [],
		credentialsFiles: policy?.credentialsFiles ?? [],
		credentialsEnvVars: policy?.credentialsEnvVars ?? [],
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

function ensureWritableRoots(roots: string[], sink: (message: string) => void): void {
	for (const root of new Set(roots)) {
		if (existsSync(root)) continue;
		try {
			mkdirSync(root, { recursive: true, mode: 0o700 });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			sink(
				`[torus: sandbox] could not create writable root ${root}: ${reason} — writes there will be denied by the sandbox`,
			);
		}
	}
}

function ensurePrivateScratchDir(sink: (message: string) => void): void {
	const scratch = path.join(tmpdir(), `torus-sbx-${randomUUID()}`);
	try {
		mkdirSync(scratch, { recursive: true, mode: 0o700 });
		process.env["CLAUDE_CODE_TMPDIR"] = scratch;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		sink(
			`[torus: sandbox] could not create private scratch dir ${scratch}: ${reason} — falling back to the shared tmpdir`,
		);
	}
}

export function buildSandboxConfig(
	cwd: string,
	sandboxEnv: SandboxEnv,
	additionalRoots: string[] = [],
	seededHosts: string[] = [],
): SandboxRuntimeConfig {
	// Env-only replacement (TORUS_SANDBOX_NET_ONLY) wins outright; otherwise a
	// user-layer policy replacement (hosts.only) applies on top of env additions,
	// else the curated allowlist plus env/policy additions and persisted trust.
	const allowed = sandboxEnv.netOnly
		? (sandboxEnv.netAdd ?? [])
		: (sandboxEnv.policyHostsOnly ?? []).length > 0
			? [
					...(sandboxEnv.policyHostsOnly ?? []),
					...(sandboxEnv.netAdd ?? []),
					...(sandboxEnv.policyHostsAdd ?? []),
					...seededHosts,
				]
			: [
					...CURATED_NET_ALLOWLIST,
					...(sandboxEnv.netAdd ?? []),
					...(sandboxEnv.policyHostsAdd ?? []),
					...seededHosts,
				];
	const credentials = buildCredentialsConfig(sandboxEnv);
	return {
		filesystem: {
			denyRead: [],
			allowWrite: [
				cwd,
				tmpdir(),
				...sandboxEnv.writableExtras,
				...additionalRoots,
				...(sandboxEnv.policyWritable ?? []),
			],
			denyWrite: [],
		},
		network: {
			allowedDomains: [...new Set(allowed)],
			deniedDomains: sandboxEnv.policyHostsDeny ?? [],
		},
		...(credentials ? { credentials } : {}),
	};
}

/** srt credentials config from the policy's user-layer lists (deny mode). */
function buildCredentialsConfig(
	sandboxEnv: SandboxEnv,
):
	| { files: Array<{ path: string; mode: "deny" }>; envVars: Array<{ name: string; mode: "deny" }> }
	| undefined {
	const files = sandboxEnv.credentialsFiles ?? [];
	const envVars = sandboxEnv.credentialsEnvVars ?? [];
	if (files.length === 0 && envVars.length === 0) return undefined;
	return {
		files: files.map((filePath) => ({ path: filePath, mode: "deny" })),
		envVars: envVars.map((name) => ({ name, mode: "deny" })),
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
	/** Per-command network allowlist keyed by an unguessable wrap commandId. */
	registerCommandNetworkLists(commandId: string, lists: { allowedDomains?: string[] }): void;
	unregisterCommandNetworkLists(commandId: string): void;
	reset(): Promise<void>;
}

export interface SandboxDeps {
	manager: SandboxManagerLike;
	probe(): Promise<{ errors: string[] }>;
	/** Hosts the user already trusted for this project (persisted approval). */
	seededHosts?(): string[];
	/** Sign-relay factory (tests inject a fake). */
	startSignRelay?(options: SignRelayOptions): Promise<SignRelay>;
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
	seededHosts: string[] = [],
): Promise<SandboxState> {
	const unrecognized =
		sandboxEnv.requested !== "" &&
		!FULL_VALUES.has(sandboxEnv.requested) &&
		!OFF_VALUES.has(sandboxEnv.requested);
	if (unrecognized) {
		sink(
			`[torus: sandbox] TORUS_SANDBOX=${sandboxEnv.requested} is not a recognized mode (off | full) — defaulting to ${sandboxEnv.mode}`,
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
	// srt silently drops allowWrite paths that don't exist at init time, so
	// every root must be on disk before initialize; a root that can't be
	// created costs only that root (notice above, activation continues).
	ensureWritableRoots([...sandboxEnv.writableExtras, ...additionalWritableRoots, tmpdir()], sink);
	ensurePrivateScratchDir(sink);
	try {
		await deps.manager.initialize(
			buildSandboxConfig(process.cwd(), sandboxEnv, additionalWritableRoots, seededHosts),
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
/** toolCallId → original command + wrap commandId, for annotation and cleanup. */
const activeCommands = new Map<string, { command: string; commandId: string }>();
/**
 * commandId of the most recently wrapped in-flight command. Ask callbacks
 * fire while the wrapped child runs (after tool_call returns), so the id is
 * held from wrap success until the matching tool_result; with concurrent
 * commands the latest wrap wins, matching srt's attribution limit.
 */
let currentCommandId: string | null = null;

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
		maybeReloadTrustedPolicy();
		return undefined;
	});
}

/**
 * Project trust is only knowable from a session context (the trust event is
 * a consent prompt, not a notification). On the first session start under
 * trust, fold the project policy layer in and live-update the manager.
 */
function maybeReloadTrustedPolicy(): void {
	if (policyLoadedTrusted || activePolicy === null || activeManager === null) return;
	let trusted = false;
	try {
		trusted = lastCtx?.isProjectTrusted() ?? false;
	} catch {
		trusted = false;
	}
	if (!trusted) return;
	policyLoadedTrusted = true;
	const reloaded = loadSandboxPolicy(process.cwd(), { isProjectTrusted: () => true });
	for (const notice of reloaded.notices) {
		process.stderr.write(`${notice}\n`);
	}
	activePolicy = reloaded.policy;
	const reloadedEnv = parseSandboxEnv(process.env, activePolicy);
	if (reloadedEnv.mode !== "full") return;
	lastConfig = buildSandboxConfig(
		process.cwd(),
		reloadedEnv,
		resolveAdditionalWritableRoots(process.cwd()),
		activeSeededHosts?.() ?? [],
	);
	activeManager.updateConfig(lastConfig);
}

/** TORUS_SANDBOX_SIGN beats the policy knob so operators can force either way. */
function signRelayEnabled(): boolean {
	const knob = (process.env["TORUS_SANDBOX_SIGN"] ?? "").trim().toLowerCase();
	if (knob === "relay") return true;
	if (knob === "0" || knob === "off") return false;
	return activePolicy?.signRelay ?? false;
}

async function maybeStartSignRelay(deps: SandboxDeps): Promise<void> {
	if (activeSignRelay !== null) return;
	if (!signRelayEnabled()) return;
	const scratch = process.env["CLAUDE_CODE_TMPDIR"];
	if (!scratch) return;
	if (!process.env["SSH_AUTH_SOCK"]) {
		process.stderr.write(
			"[torus: sandbox] sign relay disabled (no ssh-agent on the host) — TORUS_SANDBOX_SIGN=off silences this\n",
		);
		return;
	}
	try {
		const relay = await (deps.startSignRelay ?? startSignRelay)({ scratchDir: scratch });
		await relay.start();
		activeSignRelay = relay;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[torus: sandbox] sign relay failed to start: ${reason}\n`);
	}
}

function firstMeaningfulToken(command: string): string {
	for (const token of command.trim().split(/\s+/)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return token;
	}
	return "";
}

function wrapEnvExtras(command: string): Record<string, string> {
	const extra = { ...(activePolicy?.env ?? {}) };
	if (activeSignRelay && firstMeaningfulToken(command) === "git") {
		// Env-carried git config overrides repo/user config without touching
		// files; it names the signing program and format only — signing itself
		// stays governed by the user's own commit.gpgsign setting.
		extra["GIT_CONFIG_COUNT"] = "2";
		extra["GIT_CONFIG_KEY_0"] = "gpg.ssh.program";
		extra["GIT_CONFIG_VALUE_0"] = activeSignRelay.wrapperScriptPath;
		extra["GIT_CONFIG_KEY_1"] = "gpg.format";
		extra["GIT_CONFIG_VALUE_1"] = "ssh";
	}
	return extra;
}

/** Policy exemptions (user layer): raw command prefixes that skip the sandbox. */
function isExemptCommand(command: string, exempt: readonly string[]): boolean {
	const trimmed = command.trimStart();
	return exempt.some((prefix) => prefix.length > 0 && trimmed.startsWith(prefix));
}

/** Telemetry opt-outs prepended to every sandboxed command (see prefixEnvVars). */
const BUILTIN_ENV_PREFIXES: ReadonlyArray<readonly [string, string]> = [
	["CHECKPOINT_DISABLE", "1"],
	["GH_NO_UPDATE_NOTIFIER", "1"],
	["DO_NOT_TRACK", "1"],
];

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function shellQuoteValue(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prepends `env K=V ...` to the command: the built-in telemetry opt-outs plus
 * policy env entries (policy wins on a name clash). A var the command already
 * sets — via leading `VAR=...` assignments or an `env(1)` prefix — keeps the
 * command's value; only the rest are prepended, so the rewrite is idempotent
 * and never changes the command's own semantics: the original text survives
 * verbatim after the prefix. WrapWithSandboxOptions has no env channel, so
 * command text is the only way in.
 */
function prefixEnvVars(command: string, extra: Record<string, string> = {}): string {
	const wanted = new Map<string, string>(BUILTIN_ENV_PREFIXES);
	for (const [name, value] of Object.entries(extra)) wanted.set(name, value);
	const tokens = command.trimStart().split(/\s+/);
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === undefined || !ENV_ASSIGNMENT.test(token)) break;
		wanted.delete(token.slice(0, token.indexOf("=")));
		index += 1;
	}
	if (tokens[index] === "env") {
		index += 1;
		while (index < tokens.length) {
			const token = tokens[index];
			if (token === undefined || !ENV_ASSIGNMENT.test(token)) break;
			wanted.delete(token.slice(0, token.indexOf("=")));
			index += 1;
		}
	}
	if (wanted.size === 0) return command;
	const assignments = [...wanted.entries()].map(
		([name, value]) => `${name}=${shellQuoteValue(value)}`,
	);
	return `env ${assignments.join(" ")} ${command}`;
}

/** Package managers whose install verbs write to well-known cache roots. */
const INSTALL_MANAGERS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"pip",
	"pip3",
	"uv",
	"cargo",
	"go",
	"gradle",
	"mvn",
]);
const INSTALL_VERBS = new Set(["install", "update", "add", "upgrade", "ci", "build"]);

/**
 * $HOME-relative cache roots each package manager writes to during installs;
 * "go" instead resolves its module cache at lookup time ($GOPATH/pkg/mod,
 * default ~/go/pkg/mod). Exported for tests.
 */
export const INSTALL_CACHE_ROOTS: Readonly<Record<string, readonly string[]>> = {
	npm: [".npm", ".cache/pnpm", ".cache/yarn"],
	pnpm: [".npm", ".cache/pnpm", ".cache/yarn"],
	yarn: [".npm", ".cache/pnpm", ".cache/yarn"],
	pip: [".cache/pip", ".cache/uv"],
	pip3: [".cache/pip", ".cache/uv"],
	uv: [".cache/pip", ".cache/uv"],
	cargo: [".cargo/registry", ".cargo/git"],
	go: [],
	gradle: [".gradle/caches"],
	mvn: [".m2/repository"],
};

/** The install-shaped manager of this command, or null for anything else. */
function installManager(command: string): string | null {
	const [manager = "", verb = ""] = command.trim().split(/\s+/);
	if (!INSTALL_MANAGERS.has(manager) || !INSTALL_VERBS.has(verb)) return null;
	return manager;
}

function installCacheRoots(tool: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const roots = (INSTALL_CACHE_ROOTS[tool] ?? []).map((relative) =>
		path.resolve(homedir(), relative),
	);
	if (tool === "go") {
		const gopath = (env["GOPATH"] ?? "")
			.split(path.delimiter)
			.map((part) => part.trim())
			.find((part) => part.length > 0);
		roots.push(path.resolve(gopath ?? path.join(homedir(), "go"), "pkg", "mod"));
	}
	return roots;
}

/**
 * customConfig for install-shaped commands: the session allowWrite plus the
 * manager's cache roots as literal entries. srt's customConfig replaces
 * whole sections (filesystem.allowWrite is not merged), so the FULL merged
 * list is passed. Every other command gets undefined — widening a plain
 * command would defeat the workspace confinement.
 */
function installWriteWidening(command: string): Partial<SandboxRuntimeConfig> | undefined {
	const tool = installManager(command);
	if (tool === null || lastConfig === null) return undefined;
	const roots = installCacheRoots(tool);
	ensureWritableRoots(roots, (message) => process.stderr.write(`${message}\n`));
	const session = lastConfig.filesystem.allowWrite;
	const present = new Set(session.map((entry) => (typeof entry === "string" ? entry : entry.path)));
	const additions = roots
		.filter((root) => !present.has(root))
		.map((root): SandboxWritableRoot => ({ path: root, literal: true }));
	if (additions.length === 0) return undefined;
	return { filesystem: { ...lastConfig.filesystem, allowWrite: [...session, ...additions] } };
}

/** srt requires per-command network ids to be unguessable: ≥22 base64url chars. */
function randomCommandId(): string {
	return randomBytes(16).toString("base64url");
}

interface DenialClass {
	matches: (line: string) => boolean;
	notice: string;
}

/**
 * srt's default scratch when no CLAUDE_CODE_TMPDIR was claimed for the session.
 */
const SCRATCH_FALLBACK = "/tmp/claude";

function scratchRoot(): string {
	return (process.env["CLAUDE_CODE_TMPDIR"] ?? SCRATCH_FALLBACK).replace(/\/+$/, "");
}

/**
 * Denial classes for sandbox-failure stderr: srt annotates violations but the
 * errno text itself stays opaque, so the model cannot tell a fixable
 * confinement (widen a root, pre-create a directory, use an exempt path,
 * answer a trust dialog) from a genuine failure. Every rule demands
 * sandbox-shaped context before firing — a false class misleads harder than
 * none: ENOENT classifies only under the session scratch (the namespace hides
 * the parent host-side; an ordinary missing file is not a denial), and EPERM
 * only with socket context (srt blocks AF_UNIX wholesale, tracked upstream as
 * srt #510; chmod-style EPERM is ordinary).
 */
const DENIAL_CLASSES: readonly DenialClass[] = [
	{
		matches: (line) => line.includes("read-only file system"),
		notice:
			"[torus: sandbox] write denied outside allowed roots — add the path's parent to TORUS_SANDBOX_WRITABLE or the sandbox policy's writable list",
	},
	{
		matches: (line) =>
			line.includes("no such file or directory") &&
			(line.includes("mktemp: failed to create file via template") ||
				line.includes(`${scratchRoot().toLowerCase()}/`)),
		notice:
			"[torus: sandbox] path hidden from the sandbox namespace (missing parent) — create the directory host-side or add it to the writable roots",
	},
	{
		matches: (line) =>
			line.includes("operation not permitted") &&
			(line.includes("error connecting to agent") ||
				line.includes("/var/run/docker.sock") ||
				line.includes("unix socket") ||
				(line.includes("connect to") && line.includes("socket"))),
		notice:
			"[torus: sandbox] unix sockets are blocked in the sandbox — run the command via interactive_bash (never wrapped) or an exempt prefix from the user policy; path-scoped sockets are tracked upstream (srt #510)",
	},
	{
		matches: (line) =>
			line.startsWith("deny network-outbound ") || (line.includes("403") && line.includes("://")),
		notice:
			"[torus: sandbox] host not allowed — answer the trust dialog, or add the host via TORUS_SANDBOX_NET_ADD / the sandbox policy's hosts list",
	},
];

/**
 * Classifies sandbox-failure stderr into a single ready-to-append
 * `[torus: sandbox] <class> — <remedy>` line, or null when the text carries no
 * recognizable sandbox denial. First matching class wins (table order), one
 * line per result even when several signatures are present.
 */
export function classifyDenial(text: string): string | null {
	if (text.length === 0) return null;
	const lines = text.toLowerCase().split("\n");
	for (const denial of DENIAL_CLASSES) {
		if (lines.some(denial.matches)) return denial.notice;
	}
	return null;
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
		if (isExemptCommand(command, activePolicy?.exempt ?? [])) return undefined;
		const commandId = randomCommandId();
		try {
			const wrapped = await manager.wrapWithSandbox(
				prefixEnvVars(command, wrapEnvExtras(command)),
				undefined,
				installWriteWidening(command),
				undefined,
				// commandText keeps violations attributed to the raw command even
				// though the wrapped text carries the env prefix.
				{ commandId, commandText: command },
			);
			input.command = wrapped;
			activeCommands.set(event.toolCallId, { command, commandId });
			currentCommandId = commandId;
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
		const tracked = activeCommands.get(event.toolCallId);
		if (tracked === undefined) return undefined;
		activeCommands.delete(event.toolCallId);
		manager.unregisterCommandNetworkLists(tracked.commandId);
		if (currentCommandId === tracked.commandId) currentCommandId = null;
		let changed = false;
		const content = event.content.map((block) => {
			if (block.type !== "text") return block;
			const annotated = manager.annotateStderrWithSandboxFailures(tracked.command, block.text);
			const denial = classifyDenial(annotated);
			if (denial === null) {
				if (annotated === block.text) return block;
				changed = true;
				return { ...block, text: annotated };
			}
			changed = true;
			return { ...block, text: annotated.length > 0 ? `${annotated}\n${denial}` : denial };
		});
		manager.cleanupAfterCommand();
		return changed ? { content } : undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		setSandboxStatus(ctx, undefined);
		const relay = activeSignRelay;
		activeSignRelay = null;
		if (relay) void relay.stop();
		const manager = activeManager;
		if (!manager) return undefined;
		activeManager = null;
		activationPromise = null;
		activeCommands.clear();
		currentCommandId = null;
		void manager.reset();
		return undefined;
	});
}

const defaultDeps: SandboxDeps = {
	manager: SandboxManager,
	probe: () => SandboxManager.checkDependenciesAsync(),
	seededHosts: () => readPersistedHosts(process.cwd()),
	startSignRelay: (options) => startSignRelay(options),
};

let lastConfig: SandboxRuntimeConfig | null = null;

/** Policy resolved at registration; re-read once project trust is active. */
let activePolicy: ResolvedSandboxPolicy | null = null;
let policyLoadedTrusted = false;
let activeSeededHosts: (() => string[]) | undefined;
let activeSignRelay: SignRelay | null = null;

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
			// Allow-once (and custom) grants also land on the in-flight command's
			// network list, so later connections of the same command skip re-asking.
			const perCommandHost =
				decision.kind === "allow" ? host : decision.kind === "custom" ? grantedHost : null;
			if (perCommandHost !== null && currentCommandId !== null) {
				try {
					manager.registerCommandNetworkLists(currentCommandId, {
						allowedDomains: [perCommandHost],
					});
				} catch {
					// Best-effort widening; the decision itself still stands.
				}
			}
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
	// Extension load runs before any session context exists, so the project
	// layer is read as untrusted; the first trusted session_start re-reads it.
	const policyResult = loadSandboxPolicy(process.cwd(), {
		isProjectTrusted: () => policyLoadedTrusted,
	});
	for (const notice of policyResult.notices) {
		process.stderr.write(`${notice}\n`);
	}
	activePolicy = policyResult.policy;
	activeSeededHosts = deps.seededHosts;
	const sandboxEnv = parseSandboxEnv(process.env, activePolicy);
	if (sandboxEnv.mode === "off") {
		shared.state = { mode: "off", active: false };
		subscribeChip(_pi);
		return;
	}
	subscribeSandboxHandlers(_pi);
	const additionalRoots = resolveAdditionalWritableRoots(process.cwd());
	lastConfig = buildSandboxConfig(
		process.cwd(),
		sandboxEnv,
		additionalRoots,
		deps.seededHosts?.() ?? [],
	);
	activationPromise = activateSandbox(
		sandboxEnv,
		deps,
		undefined,
		additionalRoots,
		buildAskCallback(deps.manager),
		deps.seededHosts?.() ?? [],
	);
	shared.state = await activationPromise;
	if (lastCtx) setSandboxStatus(lastCtx, chipText(shared.state));
	if (shared.state.active) activeManager = deps.manager;
	await maybeStartSignRelay(deps);
}

export default function sandboxExtension(pi: ExtensionAPI): void {
	void registerSandbox(pi);
}
