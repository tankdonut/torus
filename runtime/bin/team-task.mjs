#!/usr/bin/env node
/**
 * team-task — member-facing CLI over a torus team's shared tasklist.
 *
 * Team members load no team tools (childExtensionArgs carries none), so a
 * CLI invoked through their bash is their only structured path to tasks.json.
 * Every write goes through extensions/team-runtime.ts's updateTasksFile —
 * the same directory-lock + mtime-CAS read-modify-write the lead's
 * team_task_* tools use — so this CLI is just another writer family over the
 * same file, never a raw write. Claim conditions are re-checked inside the
 * lock, never check-then-write outside it.
 *
 * Subcommands (JSON-line output on stdout; exit 0 success, 1 refusal):
 *   list     <teamId>
 *   claim    <teamId> --as <memberName>
 *   complete <teamId> <taskId> --as <memberName> [--force]
 *   release  <teamId> <taskId> --as <memberName>
 *
 * Tested invocation, from the torus checkout root under plain node
 * (no npm scripts, no flags):
 *   node runtime/bin/team-task.mjs claim <teamId> --as <memberName>
 *
 * The runtime module is TypeScript with .js import specifiers, so this
 * launcher registers a .js→.ts resolve hook (same mapping as
 * tests/resolve-ts-hook.mjs) and needs type stripping: Node with default
 * stripping (>=23.6, 22.18+) runs it as-is; an older Node is re-exec'd once
 * with --experimental-strip-types --no-warnings.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pre-strip-types Node cannot load the .ts runtime module; re-exec this
// script with the flag once (the env marker prevents any loop on nodes that
// lack the flag entirely — they exit with a bad-option error instead).
if (!process.features.typescript && !process.env["TORUS_TEAM_TASK_BOOTSTRAPPED"]) {
	const reexec = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", process.argv[1], ...process.argv.slice(2)],
		{ stdio: "inherit", env: { ...process.env, TORUS_TEAM_TASK_BOOTSTRAPPED: "1" } },
	);
	process.exit(reexec.status ?? 1);
}

const { registerHooks } = await import("node:module");
// Extensions import each other with .js specifiers over .ts sources; remap
// before the runtime module's graph loads (registered hooks only apply to
// imports that happen after this call, hence the dynamic import below).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js") && !specifier.includes("node_modules") && context.parentURL) {
			try {
				const tsPath = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, ".ts");
				if (existsSync(tsPath)) {
					return nextResolve(pathToFileURL(tsPath).href, context);
				}
			} catch {
				// fall through to default resolution
			}
		}
		return nextResolve(specifier, context);
	},
});

const runtime = await import(new URL("../../extensions/team-runtime.ts", import.meta.url).href);
const { blockedTasks, readTasksFile, updateTasksFile } = runtime;

const argv = process.argv.slice(2);
const [subcommand, teamId, taskId] = argv;

function option(name) {
	const index = argv.indexOf(name);
	return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function emit(line) {
	process.stdout.write(`${JSON.stringify(line)}\n`);
}

function refuse(message) {
	emit({ ok: false, error: message });
	process.exit(1);
}

function idOrder(a, b) {
	const na = /^t(\d+)$/.exec(a.id);
	const nb = /^t(\d+)$/.exec(b.id);
	if (na && nb) return Number(na[1]) - Number(nb[1]);
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function run() {
	if (!subcommand || !teamId) {
		refuse(
			"usage: team-task.mjs <list|claim|complete|release> <teamId> [--as <memberName>] [<taskId>] [--force]",
		);
	}
	switch (subcommand) {
		case "list":
			return list(teamId);
		case "claim":
			return claim(teamId);
		case "complete":
			return complete(teamId, taskId);
		case "release":
			return release(teamId, taskId);
		default:
			refuse(`unknown subcommand "${subcommand}" — expected list, claim, complete, or release`);
	}
}

function list(teamId0) {
	const tasks = readTasksFile(teamId0).tasks;
	const blocked = blockedTasks(tasks);
	for (const task of tasks) {
		emit({
			id: task.id,
			subject: task.subject,
			status: task.status,
			assignee: task.assignee,
			blocked: blocked.get(task.id) ?? [],
		});
	}
}

function claim(teamId0) {
	const member = option("--as");
	if (!member) refuse("claim requires --as <memberName>");
	// Conditions are re-derived from the freshest read inside every mutator
	// run (CAS retries re-run it), so a task taken or gated mid-CAS is
	// skipped or refused — never claimed on stale state.
	let refusal = null;
	let claimedId = null;
	const result = updateTasksFile(teamId0, (file) => {
		refusal = null;
		claimedId = null;
		const blocked = blockedTasks(file.tasks);
		const claimable = [...file.tasks]
			.sort(idOrder)
			.find((t) => t.status === "pending" && t.assignee === null && !blocked.has(t.id));
		if (!claimable) {
			refusal = "no claimable task — only pending, unassigned, unblocked tasks can be claimed";
			return;
		}
		claimable.assignee = member;
		claimable.status = "in_progress";
		claimable.updatedAt = new Date().toISOString();
		claimedId = claimable.id;
	});
	if (refusal !== null) refuse(refusal);
	const task = result.tasks.find((t) => t.id === claimedId);
	emit({ ok: true, action: "claim", task });
}

function complete(teamId0, taskId0) {
	const member = option("--as");
	if (!taskId0) refuse("complete requires <taskId>");
	if (!member) refuse("complete requires --as <memberName>");
	const force = argv.includes("--force");
	let refusal = null;
	const result = updateTasksFile(teamId0, (file) => {
		refusal = null;
		const task = file.tasks.find((t) => t.id === taskId0);
		if (!task) {
			refusal = `no task ${taskId0}`;
			return;
		}
		if (task.assignee !== member && !force) {
			refusal = `task ${taskId0} is assigned to ${task.assignee ?? "(nobody)"}, not ${member} — pass --force to override`;
			return;
		}
		task.status = "completed";
		task.updatedAt = new Date().toISOString();
	});
	if (refusal !== null) refuse(refusal);
	const task = result.tasks.find((t) => t.id === taskId0);
	emit({ ok: true, action: "complete", task });
}

function release(teamId0, taskId0) {
	const member = option("--as");
	if (!taskId0) refuse("release requires <taskId>");
	if (!member) refuse("release requires --as <memberName>");
	let refusal = null;
	const result = updateTasksFile(teamId0, (file) => {
		refusal = null;
		const task = file.tasks.find((t) => t.id === taskId0);
		if (!task) {
			refusal = `no task ${taskId0}`;
			return;
		}
		if (task.assignee !== member) {
			refusal = `task ${taskId0} is assigned to ${task.assignee ?? "(nobody)"}, not ${member} — only the assignee can release`;
			return;
		}
		task.status = "pending";
		task.assignee = null;
		task.updatedAt = new Date().toISOString();
	});
	if (refusal !== null) refuse(refusal);
	const task = result.tasks.find((t) => t.id === taskId0);
	emit({ ok: true, action: "release", task });
}

run();
