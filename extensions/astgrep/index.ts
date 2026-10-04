/**
 * torus — ast-grep composition (native tool form).
 *
 * Wraps the sg binary for structural search and rewrite — patterns match
 * AST nodes, not text, so renames/transforms survive formatting drift.
 * Requires sg on PATH (/doctor reports it).
 */

import { spawnSync } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateText } from "../guards/index.js";

function toolDetails(d: Record<string, unknown>): Record<string, unknown> {
	return d;
}

const OUTPUT_CAP = 12_000;

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
		const which = spawnSync("which", ["sg"], { stdio: "ignore" });
		if (which.status !== 0) {
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
		const run = spawnSync(
			"sg",
			buildAstgrepArgs(params.pattern, params.language, params.paths, params.rewrite),
			{
				encoding: "utf8",
				timeout: 30000,
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		const out = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
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
	registerAstgrep(pi);
}
