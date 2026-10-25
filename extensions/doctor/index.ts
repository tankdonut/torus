/**
 * torus — /doctor.
 *
 * One command answering "is anything broken?": torus version, engine pin drift,
 * provider auth, MCP wiring, LSP binary, tmux, git identity, and torus
 * state-dir writability, each with a concrete ok/warn/fail line.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { torusHome } from "../fsutil.js";
import { gateExtension, type PlatformSupport, platformDecisions } from "../platform.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin", "win32"],
	deps: [
		{ name: "git", required: false, note: "identity check" },
		{ name: "tmux", required: false, note: "pane check" },
	],
};

export interface CheckResult {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

export function formatDoctorReport(checks: CheckResult[]): string {
	const icon = (status: CheckResult["status"]): string =>
		status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
	const lines = checks.map((check) => `${icon(check.status)} ${check.name}: ${check.detail}`);
	const fails = checks.filter((check) => check.status === "fail").length;
	const warns = checks.filter((check) => check.status === "warn").length;
	return [`torus doctor — ${checks.length} checks: ${fails} fail, ${warns} warn`, ...lines].join(
		"\n",
	);
}

const whichCache = new Map<string, boolean>();

/** Look up a binary on PATH once per process; negatives are cached too. */
function which(bin: string): boolean {
	const cached = whichCache.get(bin);
	if (cached !== undefined) return cached;
	const found = spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
	whichCache.set(bin, found);
	return found;
}

const SANDBOX_SLOT = Symbol.for("torus.sandbox.v1");

type SandboxShared = { state: { mode: "off" | "full"; active: boolean } };

export function sandboxCheck(): CheckResult {
	const slot = (globalThis as Record<symbol, SandboxShared | undefined>)[SANDBOX_SLOT];
	if (!slot) {
		return { name: "sandbox", status: "warn", detail: "extension not loaded" };
	}
	const { mode, active } = slot.state;
	if (mode === "off") {
		return { name: "sandbox", status: "ok", detail: "off (opt-in: TORUS_SANDBOX=full)" };
	}
	if (active) {
		return {
			name: "sandbox",
			status: "ok",
			detail: "full — writes confined, curated network allowlist",
		};
	}
	const deps =
		which("bwrap") && which("socat") ? "bwrap/socat present — init failed" : "bwrap/socat missing";
	return {
		name: "sandbox",
		status: "warn",
		detail: `requested full but running unsandboxed (${deps})`,
	};
}

/**
 * Report on the recorded platform gate decisions: how many extensions loaded,
 * which skipped on this platform, and whether any loaded extension is missing
 * a required dep binary. Read-only; never throws — a doctor crash is worse
 * than a missing check.
 */
export function platformCheck(): CheckResult {
	try {
		const decisions = platformDecisions();
		if (decisions.length === 0) {
			return { name: "platform", status: "ok", detail: "no gate decisions recorded" };
		}
		const skipped = decisions.filter((decision) => decision.loaded === false);
		const loaded = decisions.length - skipped.length;
		const platform = decisions[0]?.platform ?? "unknown";
		const missing: string[] = [];
		for (const decision of decisions) {
			if (!decision.loaded) continue;
			for (const dep of decision.support?.deps ?? []) {
				if (dep?.required !== true || typeof dep.name !== "string") continue;
				if (!which(dep.name)) missing.push(`${dep.name} (${decision.name})`);
			}
		}
		let detail = `${loaded} loaded`;
		if (skipped.length > 0) {
			const names = skipped.map((decision) => decision.name).join(", ");
			detail += `, ${skipped.length} skipped on ${platform}: ${names}`;
		} else if (missing.length === 0) {
			detail += `, 0 skipped (${platform})`;
		}
		if (missing.length > 0) {
			const noun = missing.length === 1 ? "dep" : "deps";
			detail += `; ${missing.length} required ${noun} missing: ${missing.join(", ")}`;
		}
		const status: CheckResult["status"] = skipped.length > 0 || missing.length > 0 ? "warn" : "ok";
		return { name: "platform", status, detail };
	} catch (err) {
		return { name: "platform", status: "warn", detail: `scan failed: ${String(err)}` };
	}
}

export function torusVersionCheck(pinnedVersion: string): CheckResult {
	const root = process.env["TORUS_ROOT"];
	try {
		if (!root) {
			throw new Error("TORUS_ROOT unset");
		}
		const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
			version?: string;
		};
		if (!pkg.version) {
			throw new Error("package.json has no version");
		}
		return { name: "torus", status: "ok", detail: `torus ${pkg.version} (pi@${pinnedVersion})` };
	} catch {
		return {
			name: "torus",
			status: "ok",
			detail: "torus version unknown (no TORUS_ROOT package.json)",
		};
	}
}

interface ProbeResult {
	status: number | null;
	stdout: string;
}

/**
 * Promisified probe spawn: resolves on close with the exit status and captured
 * stdout, mirroring spawnSync's `status: null` on error or kill. An optional
 * timeout kills the child (SIGTERM, then SIGKILL two seconds later).
 */
function runProbe(cmd: string, args: string[], timeoutMs?: number): Promise<ProbeResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve({ status: child.exitCode, stdout });
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			stdout += d;
		});
		child.on("error", () => finish());
		child.on("close", () => finish());
		if (timeoutMs !== undefined) {
			setTimeout(() => {
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
			}, timeoutMs).unref();
		}
	});
}

async function engineCheck(engineBin: string, pinnedVersion: string): Promise<CheckResult> {
	const version = await runProbe(engineBin, ["--version"], 15_000);
	const actual = version.stdout.trim();
	if (version.status !== 0 || actual.length === 0) {
		return { name: "engine", status: "fail", detail: `could not run ${engineBin} --version` };
	}
	if (pinnedVersion && !actual.includes(pinnedVersion)) {
		return {
			name: "engine",
			status: "warn",
			detail: `running ${actual}, package.json pins ${pinnedVersion}`,
		};
	}
	return { name: "engine", status: "ok", detail: actual };
}

function providerAuthCheck(agentDir: string): CheckResult {
	const present = existsSync(path.join(agentDir, "auth.json"));
	return {
		name: "provider auth",
		status: present ? "ok" : "fail",
		detail: present ? "auth.json present" : "auth.json missing — run /login zai",
	};
}

function defaultProviderCheck(agentDir: string): CheckResult {
	try {
		const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")) as {
			defaultProvider?: string;
		};
		return {
			name: "default provider",
			status: settings.defaultProvider ? "ok" : "warn",
			detail: settings.defaultProvider ?? "not set (model picker every session)",
		};
	} catch {
		return { name: "default provider", status: "warn", detail: "settings.json unreadable" };
	}
}

function mcpCheck(repoRoot: string): CheckResult {
	const present = existsSync(path.join(repoRoot, "extensions", "mcp", "index.ts"));
	return {
		name: "mcp servers",
		status: present ? "ok" : "fail",
		detail: present ? "context7 + grep_app registered in-session" : "extensions/mcp missing",
	};
}

function lspCheck(): CheckResult {
	const present = which("typescript-language-server");
	return {
		name: "lsp",
		status: present ? "ok" : "warn",
		detail: present
			? "typescript-language-server on PATH"
			: "typescript-language-server absent — LSP tools will not start for TS",
	};
}

function astGrepCheck(): CheckResult {
	const present = which("sg");
	return {
		name: "ast-grep",
		status: present ? "ok" : "warn",
		detail: present ? "sg on PATH" : "sg absent — torus_astgrep disabled",
	};
}

function tmuxCheck(): CheckResult {
	const present = which("tmux");
	const inSession = Boolean(process.env["TMUX"]);
	return {
		name: "tmux",
		status: present ? (inSession ? "ok" : "warn") : "warn",
		detail: present
			? inSession
				? "running inside tmux (panes active)"
				: "installed but not in a tmux session (no live panes)"
			: "not installed (no delegation panes)",
	};
}

async function gitIdentityCheck(repoRoot: string): Promise<CheckResult> {
	const email = await runProbe("git", ["-C", repoRoot, "config", "user.email"]);
	const value = email.stdout.trim();
	return {
		name: "git identity",
		status: value.length > 0 ? "ok" : "warn",
		detail: value || "no user.email in this repo",
	};
}

function torusStateCheck(): CheckResult {
	const probe = path.join(torusHome(), ".doctor-probe");
	try {
		appendFileSync(probe, "x\n");
		rmSync(probe);
		return { name: "torus state", status: "ok", detail: `${torusHome()} writable` };
	} catch (err) {
		return {
			name: "torus state",
			status: "fail",
			detail: `${torusHome()} not writable: ${String(err)}`,
		};
	}
}

/**
 * Run every health check. The computations are independent, so they run
 * concurrently (the two child spawns overlap via runProbe); results are
 * assembled in the same order the synchronous version produced them, keeping
 * the report byte-identical.
 */
export async function runDoctorChecks(
	repoRoot: string,
	engineBin: string,
	pinnedVersion: string,
): Promise<CheckResult[]> {
	const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(homedir(), ".pi", "agent");
	const checks = await Promise.all([
		torusVersionCheck(pinnedVersion),
		engineCheck(engineBin, pinnedVersion),
		providerAuthCheck(agentDir),
		defaultProviderCheck(agentDir),
		mcpCheck(repoRoot),
		lspCheck(),
		astGrepCheck(),
		tmuxCheck(),
		gitIdentityCheck(repoRoot),
		torusStateCheck(),
		sandboxCheck(),
		platformCheck(),
	]);
	return checks;
}

export function registerDoctor(pi: ExtensionAPI): void {
	pi.registerCommand("doctor", {
		description: "Health-check torus: engine pin, auth, MCP, LSP, ast-grep, tmux, git, state dirs",
		handler: async (_args, ctx) => {
			const { resolveEngineBin } = await import("../engine-child.js");
			const { repoRoot } = await import("../registry.js");
			const pkg = JSON.parse(readFileSync(path.join(repoRoot(), "package.json"), "utf8")) as {
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			const pinned =
				pkg.dependencies?.["@earendil-works/pi-coding-agent"] ??
				pkg.devDependencies?.["@earendil-works/pi-coding-agent"] ??
				"";
			const report = formatDoctorReport(
				await runDoctorChecks(repoRoot(), resolveEngineBin(), pinned),
			);
			ctx.ui.notify(report, "info");
		},
	});
}

export default function doctorExtension(pi: ExtensionAPI): void {
	if (!gateExtension("doctor", PLATFORM_SUPPORT)) return;
	registerDoctor(pi);
}
