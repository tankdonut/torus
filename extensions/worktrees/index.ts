/**
 * torus — worktree lifecycle tools.
 *
 * Isolated feature workspaces via git worktrees under ONE canonical root
 * outside the repo: ${TORUS_HOME:-~/.torus}/worktrees/<repo>/<branch>
 * (override with TORUS_WORKTREES_ROOT). Living outside the repo means no
 * accidental commits and no gitignore guard; `git worktree list` in the
 * main checkout still enumerates them wherever they live.
 *
 * Safety model ported from the managing-worktrees scripts: merge is
 * rebase → squash (one commit; ff opt-in) → tree-identity proof → only
 * then branch delete. Remove NEVER deletes the branch. Conflicts abort
 * cleanly with a structured error (never a mid-flight rebase) — the
 * branch is always left untouched for a retry.
 *
 * All child processes are spawned ASYNC: the TUI shares this event loop,
 * and a merge drives git rebase/commit (husky gates: typecheck+lint+test)
 * for tens of seconds — blocking spawns froze rendering and input for the
 * whole sequence, reading as a hung TUI. The tool's AbortSignal is
 * threaded through so a stuck git child is cancellable.
 *
 * A "torus:worktree" statusline chip shows the active worktree branch
 * (set by create, cleared when that branch is merged or removed). Pure
 * visibility: pi has no session-wide cwd switch, so the chip carries no
 * enter/exit semantics — work in the worktree via absolute paths or
 * torus_delegate's cwd param.
 *
 * Parent sessions only: registration is skipped when TORUS_ENGINE_CHILD is
 * set (delegation and team-member children spawn with it) — workers execute
 * inside an assigned worktree via cwd; they never drive the lifecycle.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { torusHome } from "../fsutil.js";

const STATUS_KEY = "torus:worktree";
let activeBranch: string | null = null;

function setWorktreeStatus(ctx: ExtensionContext, branch: string | null): void {
	activeBranch = branch;
	ctx.ui.setStatus(STATUS_KEY, branch ? ctx.ui.theme.fg("warning", `wt: ${branch}`) : undefined);
}

/** Branches become filesystem path segments and git arguments — allowlist strictly. */
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBranch(branch: string): string | null {
	if (typeof branch !== "string" || branch.length === 0) return "branch is required";
	if (branch.includes("..")) return "branch must not contain '..'";
	if (!BRANCH_RE.test(branch)) {
		return "branch must match [A-Za-z0-9][A-Za-z0-9._/-]* (alphanumeric first char; no spaces or shell metacharacters)";
	}
	return null;
}

export function worktreeRoot(repoRoot: string): string {
	const base = process.env["TORUS_WORKTREES_ROOT"] ?? path.join(torusHome(), "worktrees");
	return path.join(base, path.basename(repoRoot));
}

export function worktreePath(repoRoot: string, branch: string): string {
	return path.join(worktreeRoot(repoRoot), branch);
}

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/**
 * Async child runner: never blocks the event loop (the TUI renders on it),
 * stdin is closed so a child prompting for input sees EOF instead of
 * hanging forever, and an AbortSignal kills the child (SIGTERM, then
 * SIGKILL after 2s) so users can cancel a stuck git operation.
 */
function runProcess(
	cmd: string,
	args: string[],
	opts: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<GitResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			resolve({ ok, stdout: stdout.trim(), stderr: stderr.trim() });
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			stdout += d;
		});
		child.stderr.on("data", (d: string) => {
			stderr += d;
		});
		child.on("error", (err) => {
			stderr += `${err}`;
			finish(false);
		});
		child.on("close", (code) => finish(code === 0));
		const signal = opts.signal;
		if (signal) {
			const kill = () => {
				child.kill("SIGTERM");
				setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});
}

export function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<GitResult> {
	return runProcess("git", args, { cwd, env: gitEnv(), signal });
}

/** Resolve the MAIN checkout root from any checkout (worktree or main) of the repo. */
export async function mainRoot(from: string): Promise<string | null> {
	const res = await runGit(from, ["rev-parse", "--git-common-dir"]);
	if (!res.ok) return null;
	const commonDir = path.isAbsolute(res.stdout) ? res.stdout : path.resolve(from, res.stdout);
	return realpathSync(path.dirname(commonDir));
}

async function isClean(repoDir: string): Promise<boolean> {
	return (
		(await runGit(repoDir, ["diff", "--quiet", "HEAD"])).ok &&
		(await runGit(repoDir, ["diff", "--cached", "--quiet", "HEAD"])).ok
	);
}

async function currentBranch(repoDir: string): Promise<string> {
	return (await runGit(repoDir, ["branch", "--show-current"])).stdout;
}

/**
 * Spawn env for git: ambient GIT_* variables must not leak into worktree
 * operations — e.g. GIT_INDEX_FILE is set when running under a git hook
 * (husky pre-commit) and would redirect index ops to the parent repo.
 */
export function gitEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return env;
}

async function conflictsIn(repoDir: string): Promise<string[]> {
	return (await runGit(repoDir, ["status", "--porcelain"])).stdout
		.split("\n")
		.filter((line) => line.includes("UU") || line.startsWith("AA") || line.startsWith("DD"))
		.map((line) => line.slice(3).trim())
		.filter((line) => line.length > 0);
}

export type WorktreeResult = { ok: true; message: string } | { ok: false; error: string };

function toolOutput(result: WorktreeResult) {
	return {
		content: [
			{ type: "text" as const, text: result.ok ? result.message : `error: ${result.error}` },
		],
		details: result.ok ? { ok: true } : { ok: false, error: result.error },
	};
}

/** Dependency setup in a freshly created worktree: explicit override wins, else detect. */
async function setupDependencies(
	wtPath: string,
	setupCommand?: string,
	signal?: AbortSignal,
): Promise<string> {
	if (setupCommand !== undefined && setupCommand.length > 0) {
		await runProcess("bash", ["-c", setupCommand], { cwd: wtPath, signal });
		return "ran setup command";
	}
	const exists = (f: string) => existsSync(path.join(wtPath, f));
	if (exists("go.mod")) {
		await runProcess("go", ["mod", "download"], { cwd: wtPath, signal });
		return "go mod download";
	}
	if (exists("package.json")) {
		const args = exists("package-lock.json") ? ["ci"] : ["install"];
		await runProcess("npm", args, { cwd: wtPath, signal });
		return `npm ${args[0]}`;
	}
	if (exists("Cargo.toml")) {
		await runProcess("cargo", ["fetch"], { cwd: wtPath, signal });
		return "cargo fetch";
	}
	if (exists("uv.lock") || exists("pyproject.toml")) {
		await runProcess("uv", ["sync"], { cwd: wtPath, signal });
		return "uv sync";
	}
	if (exists("requirements.txt")) {
		await runProcess("pip", ["install", "-r", "requirements.txt"], { cwd: wtPath, signal });
		return "pip install -r requirements.txt";
	}
	return "no recognized dependency manifest — skipped setup";
}

export async function performCreate(
	repoRoot: string,
	branch: string,
	opts?: { base?: string; setupCommand?: string; signal?: AbortSignal },
): Promise<WorktreeResult> {
	const invalid = validateBranch(branch);
	if (invalid) return { ok: false, error: invalid };
	const wtPath = worktreePath(repoRoot, branch);
	if (existsSync(wtPath)) {
		return { ok: false, error: `worktree already exists: ${wtPath}` };
	}
	const base = opts?.base ?? "HEAD";
	const add = await runGit(repoRoot, ["worktree", "add", wtPath, "-b", branch, base]);
	if (!add.ok) return { ok: false, error: `git worktree add failed: ${add.stderr}` };
	const setup = await setupDependencies(wtPath, opts?.setupCommand, opts?.signal);
	return {
		ok: true,
		message: `worktree ready: ${wtPath} (branch ${branch}, base ${base}; setup: ${setup}). Run the baseline test suite before starting work — a dirty baseline makes every later failure ambiguous.`,
	};
}

export async function performRemove(
	repoRoot: string,
	branch: string,
	opts?: { force?: boolean; teardownCommand?: string; signal?: AbortSignal },
): Promise<WorktreeResult> {
	const invalid = validateBranch(branch);
	if (invalid) return { ok: false, error: invalid };
	const wtPath = worktreePath(repoRoot, branch);
	if (!statSync(wtPath, { throwIfNoEntry: false })?.isDirectory()) {
		return { ok: false, error: `no worktree at ${wtPath}` };
	}
	if (!opts?.force && !(await isClean(wtPath))) {
		return {
			ok: false,
			error:
				"worktree has uncommitted (tracked) changes — commit or stash them, or re-run with force",
		};
	}
	if (opts?.teardownCommand) {
		await runProcess("bash", ["-c", opts.teardownCommand], {
			cwd: wtPath,
			signal: opts.signal,
		}); // best-effort
	}
	const remove = opts?.force
		? await runGit(repoRoot, ["worktree", "remove", "--force", wtPath], opts?.signal)
		: await runGit(repoRoot, ["worktree", "remove", wtPath], opts?.signal);
	if (!remove.ok) {
		return {
			ok: false,
			error: `git worktree remove failed (untracked files?) — re-run with force. Branch '${branch}' is left intact.`,
		};
	}
	return {
		ok: true,
		message: `removed worktree: ${wtPath} (branch '${branch}' left intact — delete it manually only when certain)`,
	};
}

export async function performMerge(
	repoRoot: string,
	branch: string,
	opts?: {
		subject?: string;
		strategy?: "squash" | "ff";
		keep?: boolean;
		mainBranch?: string;
		signal?: AbortSignal;
	},
): Promise<WorktreeResult> {
	const invalid = validateBranch(branch);
	if (invalid) return { ok: false, error: invalid };
	const strategy = opts?.strategy ?? "squash";
	const mainBranch = opts?.mainBranch ?? "main";
	const signal = opts?.signal;
	const wtPath = worktreePath(repoRoot, branch);

	if (!statSync(wtPath, { throwIfNoEntry: false })?.isDirectory()) {
		return { ok: false, error: `no worktree at ${wtPath}` };
	}
	const wtBranch = await currentBranch(wtPath);
	if (wtBranch !== branch) {
		return {
			ok: false,
			error: `worktree at ${wtPath} is on '${wtBranch}', not '${branch}'`,
		};
	}
	if ((await currentBranch(repoRoot)) !== mainBranch) {
		return { ok: false, error: `main checkout is not on branch ${mainBranch}` };
	}
	if (!(await isClean(wtPath)))
		return { ok: false, error: "worktree has uncommitted changes — commit or stash them first" };
	if (!(await isClean(repoRoot))) {
		return {
			ok: false,
			error:
				"main checkout has uncommitted changes — the squash commit would capture unrelated state",
		};
	}
	if (
		(await runGit(repoRoot, ["log", "--oneline", `${mainBranch}..${branch}`])).stdout.length === 0
	) {
		return { ok: false, error: `${branch} has no commits beyond ${mainBranch}` };
	}

	const commitCount = (await runGit(repoRoot, ["rev-list", "--count", `${mainBranch}..${branch}`]))
		.stdout;

	const rebase = await runGit(wtPath, ["rebase", mainBranch], signal);
	if (!rebase.ok) {
		const files = await conflictsIn(wtPath);
		await runGit(wtPath, ["rebase", "--abort"]); // branch untouched; never leave a mid-flight rebase
		return {
			ok: false,
			error: `rebase onto ${mainBranch} hit conflicts (${files.join(", ") || "see git output"}) — aborted cleanly, branch '${branch}' untouched. Resolve the divergence manually in the worktree (git -C ${wtPath} rebase ${mainBranch}), then re-call worktree_merge. Underlying git error: ${rebase.stderr.split("\n").slice(-3).join(" ")}`,
		};
	}

	if (strategy === "ff") {
		const ff = await runGit(repoRoot, ["merge", "--ff-only", branch], signal);
		if (!ff.ok) {
			return {
				ok: false,
				error: `fast-forward refused (${mainBranch} is not an ancestor — it moved during the rebase) — re-call worktree_merge to re-rebase`,
			};
		}
	} else {
		let subject = opts?.subject ?? "";
		if (subject.length === 0) {
			const head = branch.includes("/") ? branch.slice(branch.indexOf("/") + 1) : branch;
			subject = `${branch.includes("/") ? branch.slice(0, branch.indexOf("/")) : "worktree"}: ${head.replaceAll("-", " ")}`;
		}
		const squash = await runGit(repoRoot, ["merge", "--squash", branch], signal);
		if (!squash.ok) {
			await runGit(repoRoot, ["merge", "--abort"]);
			await runGit(repoRoot, ["reset", "--hard", "HEAD"]);
			return {
				ok: false,
				error: `squash merge conflicted (${mainBranch} moved during the rebase) — aborted cleanly, re-call worktree_merge`,
			};
		}
		const series = (await runGit(repoRoot, ["log", "--oneline", `${mainBranch}..${branch}`]))
			.stdout;
		const commit = await runGit(
			repoRoot,
			[
				"commit",
				"-m",
				subject,
				"-m",
				`Squash of ${branch} (${commitCount} commits):\n\n${series
					.split("\n")
					.map((l) => `  ${l}`)
					.join("\n")}`,
			],
			signal,
		);
		if (!commit.ok) return { ok: false, error: `squash commit failed: ${commit.stderr}` };
	}

	// Tree-identity proof: the branch provably exists verbatim on main.
	if ((await runGit(repoRoot, ["diff", mainBranch, branch])).stdout.length > 0) {
		return {
			ok: false,
			error: `tree differs from ${branch} after merge — keeping worktree and branch; inspect: git -C ${repoRoot} diff ${mainBranch} ${branch}`,
		};
	}

	if (opts?.keep) {
		return {
			ok: true,
			message: `merged ${branch} into ${mainBranch} (${strategy}); worktree and branch kept (keep=true)`,
		};
	}

	const remove = await performRemove(repoRoot, branch, { signal });
	if (!remove.ok) {
		return {
			ok: false,
			error: `merge landed on ${mainBranch} and the tree proof passed, but teardown failed: ${remove.error}. Finish with worktree_remove (force) then git branch -D ${branch}`,
		};
	}
	const del = await runGit(repoRoot, ["branch", "-D", branch], signal);
	if (!del.ok)
		return { ok: false, error: `branch delete failed after successful merge: ${del.stderr}` };
	return {
		ok: true,
		message: `merged ${branch} into ${mainBranch} (${strategy}); worktree and branch removed`,
	};
}

export default function worktreesExtension(pi: ExtensionAPI): void {
	if (process.env["TORUS_ENGINE_CHILD"] === "1") return;

	pi.registerTool(
		defineTool({
			name: "worktree_create",
			label: "Worktree Create",
			description:
				"Create an isolated git worktree for multi-step feature work (2+ commits, new files, refactors) at ~/.torus/worktrees/<repo>/<branch> — outside the repo, so no pollution and no gitignore changes. Run the baseline test suite in the new worktree before starting. Skip for single-file fixes. Branch naming: <type>/<short-description>.",
			parameters: Type.Object({
				branch: Type.String({ description: "New branch name, e.g. feat/streaming-import" }),
				base: Type.Optional(
					Type.String({ description: "Start point (default: HEAD of the main checkout)" }),
				),
				setupCommand: Type.Optional(
					Type.String({
						description:
							"Shell snippet run inside the new worktree instead of the auto-detected dependency setup (detected: go mod download / npm ci|install / cargo fetch / uv sync / pip install)",
					}),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const root = await mainRoot(ctx.cwd);
				if (!root)
					return toolOutput({ ok: false, error: `${ctx.cwd} is not inside a git work tree` });
				const result = await performCreate(root, params.branch, { ...params, signal });
				if (result.ok) setWorktreeStatus(ctx, params.branch);
				return toolOutput(result);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "worktree_merge",
			label: "Worktree Merge",
			description:
				"Land a worktree branch into local main: rebase onto main, then squash-merge as ONE commit (body lists the squashed series; pass an imperative subject) — or strategy 'ff' to fast-forward and preserve the commit series. Tears down the worktree and deletes the branch ONLY after a tree-identity proof (git diff main <branch> empty). Conflicts abort cleanly with the branch untouched — resolve manually in the worktree, then re-call.",
			parameters: Type.Object({
				branch: Type.String({ description: "Worktree branch to land" }),
				subject: Type.Optional(
					Type.String({
						description:
							"Squash commit subject (imperative); derived from the branch name when omitted. Ignored for ff.",
					}),
				),
				strategy: Type.Optional(
					Type.Union([Type.Literal("squash"), Type.Literal("ff")], {
						description: "Default: squash",
					}),
				),
				keep: Type.Optional(
					Type.Boolean({ description: "Keep worktree and branch after merging (default: false)" }),
				),
				mainBranch: Type.Optional(
					Type.String({ description: "Integration branch (default: main)" }),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const root = await mainRoot(ctx.cwd);
				if (!root)
					return toolOutput({ ok: false, error: `${ctx.cwd} is not inside a git work tree` });
				const result = await performMerge(root, params.branch, { ...params, signal });
				if (result.ok && activeBranch === params.branch && !params.keep) {
					setWorktreeStatus(ctx, null);
				}
				return toolOutput(result);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "worktree_remove",
			label: "Worktree Remove",
			description:
				"Tear down a worktree WITHOUT deleting its branch (a removed worktree's branch may hold unmerged work — branch deletion is worktree_merge's job, post-proof). Refuses on uncommitted tracked changes unless force. Use teardownCommand for state the worktree owns (compose stacks, volumes) — best-effort, never blocks removal.",
			parameters: Type.Object({
				branch: Type.String({ description: "Worktree branch to remove" }),
				force: Type.Optional(
					Type.Boolean({ description: "Remove despite dirty/untracked state (default: false)" }),
				),
				teardownCommand: Type.Optional(
					Type.String({
						description: "Best-effort shell snippet run inside the worktree before removal",
					}),
				),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const root = await mainRoot(ctx.cwd);
				if (!root)
					return toolOutput({ ok: false, error: `${ctx.cwd} is not inside a git work tree` });
				const result = await performRemove(root, params.branch, { ...params, signal });
				if (result.ok && activeBranch === params.branch) setWorktreeStatus(ctx, null);
				return toolOutput(result);
			},
		}),
	);
}
