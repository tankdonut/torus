import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-todo-state-"));
process.env["TORUS_HOME"] = home;

const todo = await import("../extensions/todo/index.ts");
const { sessionFileExists } = await import("../extensions/sessions/index.ts");

function todoDir() {
	const dashed = process.cwd().replace(/^\/+/, "").replaceAll("/", "-");
	return path.join(home, "state", `--${dashed}--`, "todo");
}

function newFile(sessionId) {
	return path.join(todoDir(), `${sessionId}.json`);
}

function legacyFile(sessionId) {
	return path.join(home, "todo", `${sessionId}.json`);
}

function plantLegacy(sessionId) {
	mkdirSync(path.join(home, "todo"), { recursive: true });
	writeFileSync(
		legacyFile(sessionId),
		JSON.stringify({ todos: [{ content: "legacy item", status: "pending" }] }, null, 2),
		"utf8",
	);
}

function age(file) {
	const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
	utimesSync(file, old, old);
}

/** Sessions root with a live transcript for `sessionId` (omit id for an empty root). */
function plantedSessionsRoot(sessionId) {
	const root = mkdtempSync(path.join(tmpdir(), "torus-todo-sessions-"));
	const proj = path.join(root, "--proj--");
	mkdirSync(proj);
	if (sessionId) {
		writeFileSync(path.join(proj, `2026-10-09T00-00-00-000Z_${sessionId}.jsonl`), "{}", "utf8");
	}
	return root;
}

test("writeTodos lands under <TORUS_HOME>/state/--<cwd>--/todo", () => {
	try {
		todo.writeTodos("sess-write", [{ content: "alpha", status: "pending", priority: "high" }]);
		assert.equal(existsSync(newFile("sess-write")), true);
		assert.equal(existsSync(legacyFile("sess-write")), false);
		assert.deepEqual(todo.readTodos("sess-write"), [
			{ content: "alpha", status: "pending", priority: "high" },
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("legacy file still reads when the project file is absent", () => {
	try {
		plantLegacy("sess-legacy");
		assert.deepEqual(todo.readTodos("sess-legacy"), [
			{ content: "legacy item", status: "pending" },
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("write migrates: new file appears, legacy twin is unlinked", () => {
	try {
		plantLegacy("sess-migrate");
		todo.writeTodos("sess-migrate", [{ content: "migrated", status: "in_progress" }]);
		assert.equal(existsSync(newFile("sess-migrate")), true);
		assert.equal(existsSync(legacyFile("sess-migrate")), false);
		assert.deepEqual(todo.readTodos("sess-migrate"), [
			{ content: "migrated", status: "in_progress" },
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("fresh todo file is kept even when orphaned", () => {
	try {
		todo.writeTodos("sess-fresh", [{ content: "fresh", status: "pending" }]);
		const root = plantedSessionsRoot();
		const removed = todo.pruneTodoOrphans((id) => sessionFileExists(id, root));
		assert.equal(removed, 0);
		assert.equal(existsSync(newFile("sess-fresh")), true);
		rmSync(root, { recursive: true, force: true });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("aged orphan (session gone) is pruned", () => {
	try {
		todo.writeTodos("sess-orphan", [{ content: "orphan", status: "pending" }]);
		age(newFile("sess-orphan"));
		const root = plantedSessionsRoot();
		const removed = todo.pruneTodoOrphans((id) => sessionFileExists(id, root));
		assert.equal(removed, 1);
		assert.equal(existsSync(newFile("sess-orphan")), false);
		rmSync(root, { recursive: true, force: true });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("aged live session's todo file is kept", () => {
	try {
		todo.writeTodos("sess-live", [{ content: "live", status: "pending" }]);
		age(newFile("sess-live"));
		const root = plantedSessionsRoot("sess-live");
		const removed = todo.pruneTodoOrphans((id) => sessionFileExists(id, root));
		assert.equal(removed, 0);
		assert.equal(existsSync(newFile("sess-live")), true);
		rmSync(root, { recursive: true, force: true });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("unreadable sessions root keeps everything", () => {
	try {
		todo.writeTodos("sess-null", [{ content: "null-guard", status: "pending" }]);
		age(newFile("sess-null"));
		const root = plantedSessionsRoot();
		const missingRoot = path.join(root, "no-such-root");
		const removed = todo.pruneTodoOrphans((id) => sessionFileExists(id, missingRoot));
		assert.equal(removed, 0);
		assert.equal(existsSync(newFile("sess-null")), true);
		rmSync(root, { recursive: true, force: true });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("GC never deletes a legacy-dir file", () => {
	try {
		plantLegacy("sess-legacy-gc");
		age(legacyFile("sess-legacy-gc"));
		const removed = todo.pruneTodoOrphans(() => false);
		assert.equal(removed, 0);
		assert.equal(existsSync(legacyFile("sess-legacy-gc")), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
