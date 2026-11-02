#!/usr/bin/env node
/**
 * Relocate delegated engine children's session transcripts out of pi's
 * default session dir into $TORUS_STATE_DIR/child-sessions, matching where
 * new children write under TORUS_CHILD_SESSIONS=separate (the default), so
 * pi's /resume lists only interactive sessions.
 *
 * Child sessions are identified from torus's own delegation and team logs —
 * every recorded run stamps its engine session id as session="<uuid>" — never
 * by content guessing. A session whose header carries a parentSession link (a
 * user fork) is never moved. Dry-run by default; pass --apply to move.
 *
 * Usage: node scripts/migrate-child-sessions.mjs [--apply] [--project <dir>]
 *          [--state <dir>]
 *   --project   working dir whose state root holds the logs (default: cwd)
 *   --state     explicit state root (default: $TORUS_STATE_DIR, else derived
 *               from --project)
 *   --apply     perform the moves; without it, only print what would move
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
let projectDir = process.cwd();
let stateDirArg;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--apply") apply = true;
	else if (arg === "--help" || arg === "-h") {
		console.log(
			"node scripts/migrate-child-sessions.mjs [--apply] [--project <dir>] [--state <dir>]",
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
for (const file of logFiles(path.join(stateDir, "logs"))) harvest(file);
const teamsRoot = path.join(stateDir, "teams");
if (existsSync(teamsRoot)) {
	for (const team of readdirSync(teamsRoot, { withFileTypes: true })) {
		if (!team.isDirectory()) continue;
		for (const file of logFiles(path.join(teamsRoot, team.name))) harvest(file);
	}
}

const sessionsRoot = process.env.PI_CODING_AGENT_DIR
	? path.join(process.env.PI_CODING_AGENT_DIR, "sessions")
	: path.join(homedir(), ".pi", "agent", "sessions");

const candidates = [];
if (existsSync(sessionsRoot)) {
	for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(sessionsRoot, entry.name);
		let files;
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			const id = SESSION_ID_RE.exec(file)?.[1];
			if (id !== undefined && childIds.has(id)) candidates.push(path.join(dir, file));
		}
	}
}

const destDir = path.join(stateDir, "child-sessions");
let moved = 0;
let skippedFork = 0;
let skippedExisting = 0;
for (const file of candidates) {
	const dest = path.join(destDir, path.basename(file));
	if (existsSync(dest)) {
		skippedExisting++;
		console.log(`skip (exists at dest): ${path.basename(file)}`);
		continue;
	}
	let header;
	try {
		const firstLine = readFileSync(file, "utf8").split("\n", 1)[0];
		header = JSON.parse(firstLine);
	} catch {
		console.warn(`warn (unreadable header, skipping): ${file}`);
		continue;
	}
	if (typeof header.parentSession === "string" && header.parentSession.length > 0) {
		skippedFork++;
		console.log(`skip (fork with parentSession): ${path.basename(file)}`);
		continue;
	}
	console.log(`${apply ? "move" : "would move"}: ${file} -> ${dest}`);
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
console.log(
	`\n${logCount} log(s) scanned, ${childIds.size} child session id(s), ${candidates.length} transcript(s) found, ${verb} ${apply ? moved : candidates.length - skippedFork - skippedExisting}, skipped ${skippedFork} fork(s), ${skippedExisting} existing`,
);
if (!apply && candidates.length > 0) console.log("dry run — pass --apply to move");
