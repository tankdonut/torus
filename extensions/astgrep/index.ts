/**
 * torus — ast-grep composition (native tool form).
 *
 * Wraps the sg binary for structural search and rewrite — patterns match
 * AST nodes, not text, so renames/transforms survive formatting drift.
 * Requires sg on PATH (/doctor reports it).
 */

import { spawn } from "node:child_process";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runChild } from "../child-run.js";
import { truncateText } from "../guards/index.js";
import { gateExtension, type PlatformSupport } from "../platform.js";

export const PLATFORM_SUPPORT: PlatformSupport = {
	platforms: ["linux", "darwin", "win32"],
	deps: [{ name: "sg", required: false }],
};

function toolDetails(d: Record<string, unknown>): Record<string, unknown> {
	return d;
}

const OUTPUT_CAP = 12_000;
/** Run limits for the sg child: 30s wall clock, 4MB buffered output. */
const SG_TIMEOUT_MS = 30_000;
const SG_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * PATH probe for the sg binary, memoized for the process lifetime (a negative
 * result is cached too, so later calls fail fast without respawning `which`).
 */
let sgAvailable: boolean | null = null;

async function probeSg(): Promise<boolean> {
	if (sgAvailable !== null) return sgAvailable;
	sgAvailable = await new Promise<boolean>((resolve) => {
		const probe = spawn("which", ["sg"], { stdio: "ignore" });
		probe.on("error", () => resolve(false));
		probe.on("close", (code) => resolve(code === 0));
	});
	return sgAvailable;
}

interface SgResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

/**
 * Async sg runner: piped stdio, both streams buffered, resolves on close so
 * the engine event loop (the TUI renders on it) never blocks. A 30s kill
 * timer bounds runaway scans, and output past the 4MB cap is discarded —
 * capped text at close with a null exit status on a kill, never a thrown
 * error.
 */
async function runSg(args: string[]): Promise<SgResult> {
	const run = await runChild("sg", args, { timeoutMs: SG_TIMEOUT_MS, maxBuffer: SG_MAX_BUFFER });
	return { stdout: run.stdout, stderr: run.stderr, status: run.status };
}
export function buildAstgrepArgs(
	pattern: string,
	language?: string,
	paths?: string[],
	rewrite?: string,
): string[] {
	const args = ["run", "-p", pattern];
	if (language) args.push("-l", language);
	if (rewrite) args.push("--rewrite", rewrite);
	for (const p of paths ?? ["."]) args.push(p);
	return args;
}

const astgrepTool = defineTool({
	name: "torus_astgrep",
	label: "Ast-grep",
	description:
		"Structural code search/rewrite via ast-grep. pattern is an sg pattern (code with $VARS as metavariables, e.g. 'import $X from \"$MOD\"'); language like ts/py/go/rust; optional paths (default .); optional rewrite applies a structural rewrite and prints the rewritten files. Prefer this over grep when syntax shape matters more than text.",
	parameters: Type.Object({
		pattern: Type.String({ description: "sg pattern with $META variables" }),
		language: Type.Optional(Type.String({ description: "language id (ts, py, go, rust, ...)" })),
		paths: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })),
		rewrite: Type.Optional(
			Type.String({ description: "replacement pattern — performs the rewrite" }),
		),
	}),
	async execute(_toolCallId, params) {
		if (!(await probeSg())) {
			return {
				content: [
					{
						type: "text",
						text: "sg (ast-grep) is not on PATH — install from ast-grep.github.io, then retry",
					},
				],
				details: toolDetails({ error: "missing-binary" }),
				isError: true,
			};
		}
		const run = await runSg(
			buildAstgrepArgs(params.pattern, params.language, params.paths, params.rewrite),
		);
		const out = `${run.stdout}${run.stderr}`.trim();
		const text = truncateText(out.length > 0 ? out : "(no matches)", OUTPUT_CAP);
		return {
			content: [{ type: "text", text }],
			details: toolDetails({ exitCode: run.status, rewrite: params.rewrite !== undefined }),
			isError: run.status !== null && run.status !== 0 && out.length === 0,
		};
	},
});

export function registerAstgrep(pi: ExtensionAPI): void {
	pi.registerTool(astgrepTool);
}

export default function astgrepExtension(pi: ExtensionAPI): void {
	if (!gateExtension("astgrep", PLATFORM_SUPPORT)) return;
	registerAstgrep(pi);
}
