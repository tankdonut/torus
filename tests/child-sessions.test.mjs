import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Child-session transcript lookup across roots: delegated engine children
// write transcripts under <state>/child-sessions (flat, directly at the root),
// interactive sessions stay in pi's default per-cwd tree. Both lookup paths —
// fleet transcripts (transcript.ts) and session search (sessions/) — must find
// files in either place without an explicit root. TORUS_HOME and
// PI_CODING_AGENT_DIR are redirected before import because transcript.ts
// resolves its roots at module load and nothing may touch real state or the
// real ~/.pi tree.
const HOME = mkdtempSync(path.join(tmpdir(), "torus-child-sessions-home-"));
const AGENT_DIR = mkdtempSync(path.join(tmpdir(), "torus-child-sessions-agent-"));
process.env.TORUS_HOME = HOME;
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

const fsutil = await import("../extensions/fsutil.ts");
const transcript = await import("../extensions/transcript.ts");
const sessions = await import("../extensions/sessions/index.ts");

const CHILD_ID = "aaaaaaa1-0000-4000-8000-000000000001";
const PARENT_ID = "aaaaaaa2-0000-4000-8000-000000000002";
const UNKNOWN_ID = "aaaaaaa3-0000-4000-8000-000000000003";

const childRoot = path.join(fsutil.projectStateDir(), "child-sessions");
const defaultProject = path.join(AGENT_DIR, "sessions", "--some-project--");
mkdirSync(childRoot, { recursive: true });
mkdirSync(defaultProject, { recursive: true });

const childFile = path.join(childRoot, `2026-11-02T00-00-00-000Z_${CHILD_ID}.jsonl`);
writeFileSync(
	childFile,
	[
		JSON.stringify({
			type: "session",
			id: CHILD_ID,
			timestamp: "2026-11-02T00:00:00.000Z",
			cwd: "/tmp",
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			message: {
				role: "user",
				content: [{ type: "text", text: "the delegated builder fixed the mailbox cursors" }],
			},
		}),
	].join("\n") + "\n",
	"utf8",
);

const parentFile = path.join(defaultProject, `2026-11-02T01-00-00-000Z_${PARENT_ID}.jsonl`);
writeFileSync(
	parentFile,
	[
		JSON.stringify({
			type: "session",
			id: PARENT_ID,
			timestamp: "2026-11-02T01:00:00.000Z",
			cwd: "/tmp",
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			message: {
				role: "user",
				content: [{ type: "text", text: "the interactive lens review session" }],
			},
		}),
	].join("\n") + "\n",
	"utf8",
);

after(() => {
	rmSync(HOME, { recursive: true, force: true });
	rmSync(AGENT_DIR, { recursive: true, force: true });
});

test("findSessionFile without an explicit root resolves child and default roots", () => {
	assert.equal(sessions.findSessionFile(CHILD_ID), childFile);
	assert.equal(sessions.findSessionFile(PARENT_ID), parentFile);
	assert.equal(sessions.findSessionFile(UNKNOWN_ID), null);
});

test("sessionFileExists without an explicit root sees the child root", () => {
	assert.equal(sessions.sessionFileExists(CHILD_ID), true);
	assert.equal(sessions.sessionFileExists(PARENT_ID), true);
	assert.equal(sessions.sessionFileExists(UNKNOWN_ID), false);
});

test("searchSessions scans flat root-level transcripts when asked", () => {
	const stats = { skippedOversized: 0 };
	const hits = sessions.searchSessions("mailbox cursors", childRoot, 8, stats, { rootFiles: true });
	assert.equal(hits.length, 1);
	assert.equal(hits[0].file, childFile);
	assert.equal(hits[0].sessionId, CHILD_ID);
	assert.equal(hits[0].project, "child-sessions");
	// Without the flag the flat file stays invisible — pi's default layout has
	// no root-level transcripts.
	assert.equal(sessions.searchSessions("mailbox cursors", childRoot, 8).length, 0);
});

test("sessionSearchRoots maps each scope to its roots in scan order", () => {
	const piRoot = path.join(AGENT_DIR, "sessions");
	assert.deepEqual(sessions.sessionSearchRoots("all"), [
		{ root: piRoot, rootFiles: false },
		{ root: childRoot, rootFiles: true },
	]);
	assert.deepEqual(sessions.sessionSearchRoots("torus"), [{ root: childRoot, rootFiles: true }]);
	assert.deepEqual(sessions.sessionSearchRoots("interactive"), [
		{ root: piRoot, rootFiles: false },
	]);
});

test("torus_sessions scope steers which roots a search covers", async () => {
	// torus: the child transcript hits, the interactive one stays invisible.
	const scoped = await sessions.sessionsTool.execute("t-scope-1", {
		query: "mailbox cursors",
		scope: "torus",
		limit: 8,
	});
	assert.match(scoped.content[0].text, new RegExp(CHILD_ID));
	assert.doesNotMatch(scoped.content[0].text, /no sessions match/);

	const scopedMiss = await sessions.sessionsTool.execute("t-scope-2", {
		query: "interactive lens review",
		scope: "torus",
		limit: 8,
	});
	assert.match(scopedMiss.content[0].text, /no sessions match/);

	const interactive = await sessions.sessionsTool.execute("t-scope-3", {
		query: "interactive lens review",
		scope: "interactive",
		limit: 8,
	});
	assert.match(interactive.content[0].text, new RegExp(PARENT_ID));

	// default (no scope): default root first, falling through to the child root.
	const byDefault = await sessions.sessionsTool.execute("t-scope-4", {
		query: "mailbox cursors",
		limit: 8,
	});
	assert.match(byDefault.content[0].text, new RegExp(CHILD_ID));
});

test("fleet transcript lookup resolves child sessions through the child root", () => {
	const items = transcript.transcriptItems(CHILD_ID, 10);
	assert.equal(items.length, 1);
	assert.equal(items[0].kind, "user");
	const text = transcript.transcriptItems(PARENT_ID, 10);
	assert.ok(text.length >= 1, "default-root session still resolves");
});
