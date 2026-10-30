#!/usr/bin/env node
/**
 * team-mail — member-facing CLI over a torus team's member mailboxes.
 *
 * Team members load no team tools (childExtensionArgs carries none), so a
 * CLI invoked through their bash is their only structured path to mail.
 * Every send goes through extensions/team-runtime.ts's deliverMemberMail —
 * which validates sender, recipient, and team membership before delegating
 * to deliverMail — so no raw writes and no forged senders: `lead` and
 * `tasklist` are reserved, and mail must come from a real spec member.
 *
 * Subcommands (JSON-line output on stdout; exit 0 success, 1 refusal):
 *   send    <teamId> --as <name> --to <member> <text...>
 *   members <teamId>
 *
 * Tested invocation, from the torus checkout root under plain node
 * (no npm scripts, no flags):
 *   node runtime/bin/team-mail.mjs send <teamId> --as <name> --to <member> "text"
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
if (!process.features.typescript && !process.env["TORUS_TEAM_MAIL_BOOTSTRAPPED"]) {
	const reexec = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", process.argv[1], ...process.argv.slice(2)],
		{ stdio: "inherit", env: { ...process.env, TORUS_TEAM_MAIL_BOOTSTRAPPED: "1" } },
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
const { deliverMemberMail, readTeamSpec, teamDir } = runtime;

const argv = process.argv.slice(2);
const [subcommand, teamId] = argv;

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

async function run() {
	if (!subcommand || !teamId) {
		refuse("usage: team-mail.mjs <send|members> <teamId> [--as <name>] [--to <member>] [<text...]");
	}
	// send writes: a typo'd team id refuses fast here instead of spinning
	// on mailbox creation against a missing parent. members must be exact
	// about who belongs, so it refuses on any unknown team (exit 1).
	if (!existsSync(teamDir(teamId))) {
		refuse(`team "${teamId}" not found — no team directory at ${teamDir(teamId)}`);
	}
	switch (subcommand) {
		case "send":
			return send(teamId);
		case "members":
			return members(teamId);
		default:
			refuse(`unknown subcommand "${subcommand}" — expected send or members`);
	}
}

function send(teamId0) {
	const from = option("--as");
	const to = option("--to");
	if (!from) refuse("send requires --as <name>");
	if (!to) refuse("send requires --to <member>");
	// Remaining positionals (everything that is not the subcommand, the team
	// id, an option flag, or an option value) join into the mail text.
	const words = [];
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === "--as" || argv[i] === "--to") {
			i++;
			continue;
		}
		words.push(argv[i]);
	}
	if (words.length === 0) refuse("send requires <text>");
	const result = deliverMemberMail(teamId0, from, to, words.join(" "));
	if (!result.ok) refuse(result.reason);
	emit({ ok: true, action: "send", from, to });
}

function members(teamId0) {
	const spec = readTeamSpec(teamId0);
	if (!spec) refuse(`team "${teamId0}" not found`);
	for (const member of spec.members) {
		emit({ name: member.name, agent: member.agent });
	}
}

await run();
