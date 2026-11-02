#!/usr/bin/env node
/**
 * Relocate delegated engine children's session transcripts out of pi's
 * default session dir into $TORUS_STATE_DIR/child-sessions, matching where
 * new children write under TORUS_CHILD_SESSIONS=separate (the default), so
 * pi's /resume lists only interactive sessions.
 *
 * Child sessions are identified two ways, never by content guessing: from
 * torus's own delegation and team logs (every recorded run stamps its engine
 * session id as session="<uuid>"; all state roots under TORUS_HOME are
 * harvested, so worktree-dispatched runs are found), and optionally, with
 * --unnamed, by session name: torus auto-names interactive sessions, children
 * never receive a name, so an unnamed transcript is a child. Safety rails: a
 * session whose header carries a parentSession link (a user fork) is never
 * moved, and neither is anything modified in the last hour (live sessions).
 * Dry-run by default; pass --apply to move.
 *
 * Usage: node scripts/migrate-child-sessions.mjs [--apply] [--unnamed]
 *          [--project <dir>] [--state <dir>]
 *   --project   working dir whose state root holds the logs (default: cwd)
 *   --state     explicit state root (default: $TORUS_STATE_DIR, else derived
 *               from --project); its basename names the pi session dir scanned
 *   --apply     perform the moves; without it, only print what would move
 *   --unnamed   also move sessions torus never named (children carry no name);
 *               named sessions are interactive and always stay
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SESSION_ID_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const SESSION_ATTR_RE = /session="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;

function fail(message) {
	console.error(`migrate-child-sessions: ${message}`);
	process.exit(1);
}

const args = process.argv.slice(2);
let apply = false;
let includeUnnamed = false;
let projectDir = process.cwd();
let stateDirArg;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--apply") apply = true;
	else if (arg === "--unnamed") includeUnnamed = true;
	else if (arg === "--help" || arg === "-h") {
		console.log(
			"node scripts/migrate-child-sessions.mjs [--apply] [--unnamed] [--project <dir>] [--state <dir>]",
		);
		process.exit(0);
	} else if (arg === "--project") projectDir = args[++i] ?? fail("--project requires a value");
	else if (arg === "--state") stateDirArg = args[++i] ?? fail("--state requires a value");
	else fail(`unknown argument: ${arg}`);
}

const torusHome = process.env.TORUS_HOME ?? path.join(homedir(), ".torus");
const projectKey = `--${projectDir.replace(/^\/+/, "").replaceAll("/", "-")}--`;
const stateDir =
	stateDirArg ??
	(process.env.TORUS_STATE_DIR &&
	path.resolve(process.env.TORUS_STATE_DIR).startsWith(path.resolve(torusHome))
		? process.env.TORUS_STATE_DIR
		: path.join(torusHome, "state", projectKey));

if (!existsSync(stateDir)) fail(`state dir not found: ${stateDir} (pass --state or --project)`);

function logFiles(dir) {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
			.map((entry) => path.join(dir, entry.name));
	} catch {
		return [];
	}
}

let logCount = 0;
const childIds = new Set();
const harvest = (file) => {
	logCount++;
	const raw = readFileSync(file, "utf8");
	for (const match of raw.matchAll(SESSION_ATTR_RE)) childIds.add(match[1]);
};
// Harvest every state root under TORUS_HOME, not just this project's: a
// delegation dispatched from a worktree session logs under the worktree's
// state root while its engine child's transcript lands in the main checkout's
// pi session dir.
const harvestRoot = (root) => {
	for (const file of logFiles(path.join(root, "logs"))) harvest(file);
	const teams = path.join(root, "teams");
	if (!existsSync(teams)) return;
	for (const team of readdirSync(teams, { withFileTypes: true })) {
		if (!team.isDirectory()) continue;
		for (const file of logFiles(path.join(teams, team.name))) harvest(file);
	}
};
const stateRoots = path.join(torusHome, "state");
if (existsSync(stateRoots)) {
	for (const entry of readdirSync(stateRoots, { withFileTypes: true })) {
		if (entry.isDirectory()) harvestRoot(path.join(stateRoots, entry.name));
	}
} else {
	harvestRoot(stateDir);
}

const sessionsRoot = process.env.PI_CODING_AGENT_DIR
	? path.join(process.env.PI_CODING_AGENT_DIR, "sessions")
	: path.join(homedir(), ".pi", "agent", "sessions");

// Only this project's pi session dir is scanned: that is the dir /resume
// lists, and a state root's basename is the same key pi encodes cwd into.
const sourceDir = path.join(sessionsRoot, path.basename(stateDir));

// Torus auto-names interactive sessions; children never receive a name, so
// "no session_info name" is the child marker for the --unnamed pass.
function isNamed(raw) {
	let name;
	for (const line of raw.split("\n")) {
		if (!line.includes('"session_info"')) continue;
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "session_info" && typeof entry.name === "string") {
				name = entry.name.trim() || undefined;
			}
		} catch {}
	}
	return name !== undefined;
}

const RECENT_MS = 60 * 60 * 1000;
const candidates = [];
if (existsSync(sourceDir)) {
	for (const file of readdirSync(sourceDir)) {
		const id = SESSION_ID_RE.exec(file)?.[1];
		if (id !== undefined && childIds.has(id)) {
			candidates.push({ file: path.join(sourceDir, file), reason: "logged" });
			continue;
		}
		if (!includeUnnamed || id === undefined) continue;
		let raw;
		try {
			raw = readFileSync(path.join(sourceDir, file), "utf8");
		} catch {
			continue;
		}
		if (!isNamed(raw)) candidates.push({ file: path.join(sourceDir, file), reason: "unnamed" });
	}
}

const destDir = path.join(stateDir, "child-sessions");
let moved = 0;
let skippedFork = 0;
let skippedExisting = 0;
let skippedRecent = 0;
for (const { file, reason } of candidates) {
	const dest = path.join(destDir, path.basename(file));
	if (existsSync(dest)) {
		skippedExisting++;
		console.log(`skip (exists at dest): ${path.basename(file)}`);
		continue;
	}
	try {
		if (statSync(file).mtimeMs > Date.now() - RECENT_MS) {
			skippedRecent++;
			console.log(`skip (modified within the hour): ${path.basename(file)}`);
			continue;
		}
	} catch {
		continue;
	}
	let header;
	try {
		header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]);
	} catch {
		console.warn(`warn (unreadable header, skipping): ${file}`);
		continue;
	}
	if (typeof header.parentSession === "string" && header.parentSession.length > 0) {
		skippedFork++;
		console.log(`skip (fork with parentSession): ${path.basename(file)}`);
		continue;
	}
	console.log(`${apply ? "move" : "would move"} (${reason}): ${file} -> ${dest}`);
	if (apply) {
		mkdirSync(destDir, { recursive: true });
		try {
			chmodSync(destDir, 0o700);
		} catch {}
		renameSync(file, dest);
		moved++;
	}
}

const verb = apply ? "moved" : "would move";
const planned = candidates.length - skippedFork - skippedExisting - skippedRecent;
console.log(
	`\n${logCount} log(s) scanned, ${childIds.size} child session id(s), ${candidates.length} transcript(s) matched, ${verb} ${apply ? moved : planned}, skipped ${skippedFork} fork(s), ${skippedRecent} recent, ${skippedExisting} existing`,
);
if (!apply && candidates.length > 0) console.log("dry run — pass --apply to move");
