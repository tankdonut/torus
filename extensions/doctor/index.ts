/**
 * torus — /doctor.
 *
 * One command answering "is anything broken?": engine pin drift, provider
 * auth, MCP wiring, LSP binary, tmux, git identity, and torus state-dir
 * writability, each with a concrete ok/warn/fail line.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

function which(bin: string): boolean {
	return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
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

export function runDoctorChecks(
	repoRoot: string,
	engineBin: string,
	pinnedVersion: string,
): CheckResult[] {
	const checks: CheckResult[] = [];

	const version = spawnSync(engineBin, ["--version"], { encoding: "utf8", timeout: 15000 });
	const actual = (version.stdout ?? "").trim();
	if (version.status !== 0 || actual.length === 0) {
		checks.push({ name: "engine", status: "fail", detail: `could not run ${engineBin} --version` });
	} else if (pinnedVersion && !actual.includes(pinnedVersion)) {
		checks.push({
			name: "engine",
			status: "warn",
			detail: `running ${actual}, package.json pins ${pinnedVersion}`,
		});
	} else {
		checks.push({ name: "engine", status: "ok", detail: actual });
	}

	const agentDir = process.env["PI_CODING_AGENT_DIR"] ?? path.join(homedir(), ".pi", "agent");
	checks.push({
		name: "provider auth",
		status: existsSync(path.join(agentDir, "auth.json")) ? "ok" : "fail",
		detail: existsSync(path.join(agentDir, "auth.json"))
			? "auth.json present"
			: "auth.json missing — run /login zai",
	});
	try {
		const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")) as {
			defaultProvider?: string;
		};
		checks.push({
			name: "default provider",
			status: settings.defaultProvider ? "ok" : "warn",
			detail: settings.defaultProvider ?? "not set (model picker every session)",
		});
	} catch {
		checks.push({ name: "default provider", status: "warn", detail: "settings.json unreadable" });
	}

	checks.push({
		name: "mcp servers",
		status: existsSync(path.join(repoRoot, "extensions", "mcp", "index.ts")) ? "ok" : "fail",
		detail: existsSync(path.join(repoRoot, "extensions", "mcp", "index.ts"))
			? "context7 + grep_app registered in-session"
			: "extensions/mcp missing",
	});

	checks.push({
		name: "lsp",
		status: which("typescript-language-server") ? "ok" : "warn",
		detail: which("typescript-language-server")
			? "typescript-language-server on PATH"
			: "typescript-language-server absent — LSP tools will not start for TS",
	});

	checks.push({
		name: "ast-grep",
		status: which("sg") ? "ok" : "warn",
		detail: which("sg") ? "sg on PATH" : "sg absent — torus_astgrep disabled",
	});

	checks.push({
		name: "tmux",
		status: which("tmux") ? (process.env["TMUX"] ? "ok" : "warn") : "warn",
		detail: which("tmux")
			? process.env["TMUX"]
				? "running inside tmux (panes active)"
				: "installed but not in a tmux session (no live panes)"
			: "not installed (no delegation panes)",
	});

	const email = spawnSync("git", ["-C", repoRoot, "config", "user.email"], { encoding: "utf8" });
	checks.push({
		name: "git identity",
		status: (email.stdout ?? "").trim().length > 0 ? "ok" : "warn",
		detail: (email.stdout ?? "").trim() || "no user.email in this repo",
	});

	const probe = path.join(homedir(), ".torus", ".doctor-probe");
	try {
		appendFileSync(probe, "x\n");
		rmSync(probe);
		checks.push({ name: "torus state", status: "ok", detail: "~/.torus writable" });
	} catch (err) {
		checks.push({
			name: "torus state",
			status: "fail",
			detail: `~/.torus not writable: ${String(err)}`,
		});
	}

	checks.push(sandboxCheck());

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
			const report = formatDoctorReport(runDoctorChecks(repoRoot(), resolveEngineBin(), pinned));
			ctx.ui.notify(report, "info");
		},
	});
}

export default function doctorExtension(pi: ExtensionAPI): void {
	registerDoctor(pi);
}
