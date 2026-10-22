import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "torus-todo-state-"));
process.env["TORUS_HOME"] = home;

const todo = await import("../extensions/todo/index.ts");
const { sessionFileExists } = await import("../extensions/sessions/index.ts");
const { projectKeyFor } = await import("../extensions/fsutil.ts");

function todoDir() {
	return path.join(home, "state", projectKeyFor(process.cwd()), "todo");
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
			{ id: "t1", content: "alpha", status: "pending", priority: "high" },
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
			{ id: "t2", content: "migrated", status: "in_progress" },
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

test("write assigns stable ids and a later write updates by id", () => {
	try {
		todo.writeTodos("sess-ids", [
			{ content: "first", status: "pending" },
			{ content: "second", status: "pending" },
		]);
		todo.writeTodos("sess-ids", [
			{ id: "t1", content: "first", status: "completed" },
			{ id: "t2", content: "second", status: "in_progress" },
		]);
		assert.deepEqual(todo.readTodos("sess-ids"), [
			{ id: "t1", content: "first", status: "completed" },
			{ id: "t2", content: "second", status: "in_progress" },
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("completed items omitted from a write are retained; pending omitted are removed", () => {
	try {
		todo.writeTodos("sess-retain", [
			{ content: "ship it", status: "completed" },
			{ content: "write tests", status: "pending" },
		]);
		const state = todo.writeTodos("sess-retain", [{ content: "ship it", status: "completed" }]);
		assert.deepEqual(state.todos, [{ id: "t1", content: "ship it", status: "completed" }]);
		assert.equal(todo.readTodoState("sess-retain").stats.tracked, 2);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("status dropped removes an item explicitly and the tracked count never shrinks", () => {
	try {
		todo.writeTodos("sess-drop", [
			{ content: "done thing", status: "completed" },
			{ content: "live thing", status: "pending" },
			{ content: "later thing", status: "pending" },
		]);
		const state = todo.writeTodos("sess-drop", [
			{ id: "t1", content: "done thing", status: "dropped" },
			{ id: "t2", content: "live thing", status: "in_progress" },
			{ id: "t3", content: "later thing", status: "pending" },
		]);
		assert.deepEqual(state.todos, [
			{ id: "t2", content: "live thing", status: "in_progress" },
			{ id: "t3", content: "later thing", status: "pending" },
		]);
		const after = todo.readTodoState("sess-drop");
		assert.equal(after.stats.tracked, 3);
		assert.equal(after.stats.donePeak, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a paraphrased rewrite updates the original item instead of duplicating", () => {
	try {
		todo.writeTodos("sess-paraphrase", [{ content: "fix the failing tests", status: "pending" }]);
		const state = todo.writeTodos("sess-paraphrase", [
			{ content: "fix tests", status: "completed" },
		]);
		assert.deepEqual(state.todos, [{ id: "t1", content: "fix tests", status: "completed" }]);
		assert.equal(todo.readTodoState("sess-paraphrase").stats.tracked, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("matched items keep their priority when the rewrite omits it", () => {
	try {
		todo.writeTodos("sess-prio", [{ content: "audit", status: "pending", priority: "high" }]);
		const state = todo.writeTodos("sess-prio", [
			{ id: "t1", content: "audit", status: "in_progress" },
		]);
		assert.deepEqual(state.todos, [
			{ id: "t1", content: "audit", status: "in_progress", priority: "high" },
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("empty write clears the list but keeps the monotone counters", () => {
	try {
		todo.writeTodos("sess-clear", [
			{ content: "a", status: "completed" },
			{ content: "b", status: "completed" },
			{ content: "c", status: "pending" },
		]);
		const state = todo.writeTodos("sess-clear", []);
		assert.deepEqual(state.todos, []);
		const after = todo.readTodoState("sess-clear");
		assert.equal(after.stats.tracked, 3);
		assert.equal(after.stats.donePeak, 2);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("legacy items without ids are adopted on the next write", () => {
	try {
		plantLegacy("sess-adopt");
		const state = todo.writeTodos("sess-adopt", [{ content: "legacy item", status: "completed" }]);
		assert.deepEqual(state.todos, [{ id: "t1", content: "legacy item", status: "completed" }]);
		assert.equal(state.stats.tracked, 1);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a fully-completed list closes: the next write starts a fresh list", () => {
	try {
		todo.writeTodos("sess-close", [
			{ content: "old one", status: "completed" },
			{ content: "old two", status: "completed" },
		]);
		const state = todo.writeTodos("sess-close", [{ content: "new work", status: "in_progress" }]);
		assert.deepEqual(state.todos, [{ id: "t3", content: "new work", status: "in_progress" }]);
		const after = todo.readTodoState("sess-close");
		assert.equal(after.stats.tracked, 3);
		assert.equal(after.stats.donePeak, 2);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("re-including completed items by id carries them across the close boundary", () => {
	try {
		todo.writeTodos("sess-carry", [
			{ content: "kept done", status: "completed" },
			{ content: "dropped done", status: "completed" },
		]);
		const state = todo.writeTodos("sess-carry", [
			{ id: "t1", content: "kept done", status: "completed" },
			{ content: "fresh task", status: "pending" },
		]);
		assert.deepEqual(state.todos, [
			{ id: "t1", content: "kept done", status: "completed" },
			{ id: "t3", content: "fresh task", status: "pending" },
		]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a closed list reopens when a stored item is written back to a live status", () => {
	try {
		todo.writeTodos("sess-reopen", [{ content: "reopen me", status: "completed" }]);
		const state = todo.writeTodos("sess-reopen", [
			{ id: "t1", content: "reopen me", status: "in_progress" },
		]);
		assert.deepEqual(state.todos, [{ id: "t1", content: "reopen me", status: "in_progress" }]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("context block shows completed items with their ids", () => {
	try {
		todo.writeTodos("sess-block", [
			{ content: "shipped feature", status: "completed" },
			{ content: "polish docs", status: "in_progress" },
		]);
		const block = todo.todoContextBlock("sess-block");
		assert.ok(block.includes("◐ t2 (medium) polish docs"));
		assert.ok(block.includes("● t1 (medium) shipped feature"));
		assert.ok(block.includes("completed items omitted from a write are"));
		assert.ok(block.indexOf("polish docs") < block.indexOf("shipped feature"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("context block collapses to one closed line when every item is completed", () => {
	try {
		todo.writeTodos("sess-block-closed", [
			{ content: "first done", status: "completed" },
			{ content: "second done", status: "completed" },
		]);
		const block = todo.todoContextBlock("sess-block-closed");
		assert.ok(block.startsWith("[torus todos"));
		assert.ok(block.includes("●2 of 2 done"));
		assert.ok(block.includes("closed"));
		assert.ok(!block.includes("first done"));
		assert.ok(!block.includes("second done"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
