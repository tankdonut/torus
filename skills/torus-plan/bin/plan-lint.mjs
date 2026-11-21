#!/usr/bin/env node

// plan-lint — the CLI for extensions/plangrammar.ts: lint a plan file
// against the plan grammar. A valid plan looks like this:
//
//   # Plan — <title>
//
//   ## Stopping condition
//   ...
//
//   ### Wave 1 — <outcome>
//
//   - [ ] 1. <title>
//     Files: <paths>
//     Acceptance: <exact command or assertion>
//     ...
//
//   ### Final verification wave
//
//   - [ ] F1. <title>
//
// Waves are `### Wave N — <outcome>` headings (the em dash is grammar).
// Tasks are column-zero checkbox rows (`- [ ]`/`- [x]`/`- [X]`/`- [~]`,
// never indented) whose detail block — the indented lines up to the next
// task row or wave heading — carries an `Acceptance:` line. F-tasks are
// exempt: the grammar gives them their own detail lines (review
// delegation, QA capture, ideal-state fidelity). The final verification
// wave must contain at least one F-task row, and a `## Stopping
// condition` section must exist.
//
// Invocation, from the torus checkout root under plain node (no npm
// scripts, no flags):
//   node skills/torus-plan/bin/plan-lint.mjs <file>...
//
// Exit 0 prints one `ok <path>` per clean file; exit 1 prints
// `<path>:<line>: <message>` per violation; exit 2 is a usage error.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The lint module is TypeScript; Node with default stripping (>=23.6,
// 22.18+) runs it as-is and older Node is re-exec'd once with
// --experimental-strip-types (the env marker prevents any loop on nodes
// that lack the flag entirely — they exit with a bad-option error).
if (!process.features.typescript && !process.env["TORUS_PLAN_LINT_BOOTSTRAPPED"]) {
	const reexec = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", process.argv[1], ...process.argv.slice(2)],
		{ stdio: "inherit", env: { ...process.env, TORUS_PLAN_LINT_BOOTSTRAPPED: "1" } },
	);
	process.exit(reexec.status ?? 1);
}

const { lintPlan } = await import(
	new URL("../../../extensions/plangrammar.ts", import.meta.url).href
);

const USAGE = "usage: node plan-lint.mjs <file>...";

function lintPlanFile(path) {
	let source;
	try {
		source = readFileSync(path, "utf8");
	} catch {
		return [{ line: 0, message: "file not found" }];
	}
	return lintPlan(source);
}

function cli(argv) {
	if (argv.length === 0) {
		console.error(USAGE);
		return 2;
	}
	let failed = false;
	for (const path of argv) {
		const violations = lintPlanFile(path);
		if (violations.length === 0) {
			console.log(`ok ${path}`);
			continue;
		}
		failed = true;
		for (const { line, message } of violations) {
			console.log(`${path}:${line}: ${message}`);
		}
	}
	return failed ? 1 : 0;
}

const invokedAsMain =
	Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
	process.exitCode = cli(process.argv.slice(2));
}
