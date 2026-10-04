import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// The work module resolves its state dir at import time — sandbox TORUS_HOME first.
process.env["TORUS_HOME"] = mkdtempSync(path.join(tmpdir(), "work-test-"));

const {
	parsePlanTasks,
	completionBlocker,
	resolvePlan,
	readWorkState,
	writeWorkState,
	appendLedgerEntry,
	readLedger,
	ledgerAppendError,
	listWorkStates,
	activeWorkFor,
	workContextBlock,
} = await import("../extensions/work/index.ts");

function plantPlan(name, body) {
	const dir = path.join(process.env["TORUS_HOME"], "plans");
	mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${name}.md`);
	writeFileSync(file, body, "utf-8");
	return file;
}

function plantState(overrides) {
	const state = {
		slug: "s",
		planPath: "/nowhere.md",
		sessionId: "ses-a",
		status: "active",
		createdAt: 1,
		startedAt: 1,
		lastActiveAt: 1,
		completedAt: null,
		...overrides,
	};
	writeWorkState(state);
	return state;
}

test("parsePlanTasks reads column-zero rows only, both check states, skips empty titles", () => {
	const md = [
		"# plan",
		"",
		"- [ ] 1. One",
		"  - [ ] nested detail is not a task",
		"- [x] 2. Two",
		"- [X] 3. Three",
		"- [ ] ",
		"plain text",
	].join("\n");
	const { tasks, done } = parsePlanTasks(md);
	assert.equal(tasks.length, 3);
	assert.equal(done, 2);
	assert.deepEqual(
		tasks.map((t) => [t.line, t.checked, t.title]),
		[
			[3, false, "1. One"],
			[5, true, "2. Two"],
			[6, true, "3. Three"],
		],
	);
});

test("parsePlanTasks on a plan with no rows yields zero tasks", () => {
	assert.deepEqual(parsePlanTasks("# nothing\nbody\n"), { tasks: [], done: 0 });
});

test("completionBlocker: null when all checked, lists remainder otherwise, errors on no tasks", () => {
	assert.equal(completionBlocker("- [x] 1. A\n- [x] F1. Final\n"), null);
	const blocker = completionBlocker("- [x] 1. A\n- [ ] 2. B\n- [ ] 3. C\n");
	assert.match(blocker, /2 unchecked/);
	assert.match(blocker, /2\. B/);
	assert.match(blocker, /3\. C/);
	assert.match(completionBlocker("# empty\n"), /no column-zero checkbox tasks/);
});

test("resolvePlan: exact stem beats prefix, unique prefix resolves, ambiguity errors with candidates", () => {
	plantPlan("alpha", "- [ ] 1. A\n");
	plantPlan("alpha-two", "- [ ] 1. A\n");
	plantPlan("alpha-x", "- [ ] 1. A\n");
	plantPlan("beta", "- [ ] 1. A\n");

	assert.deepEqual(resolvePlan("alpha"), {
		planPath: path.join(process.env["TORUS_HOME"], "plans", "alpha.md"),
		slug: "alpha",
	});
	const prefixed = resolvePlan("alpha-t");
	assert.equal(prefixed.error, undefined);
	if (!("error" in prefixed)) assert.equal(prefixed.slug, "alpha-two");

	const ambiguous = resolvePlan("alpha-");
	assert.ok(
		"error" in ambiguous && /alpha-two/.test(ambiguous.error) && /alpha-x/.test(ambiguous.error),
	);

	const missing = resolvePlan("nope");
	assert.ok("error" in missing && /no plan matches/.test(missing.error));
});

test("resolvePlan: absolute paths resolve when the file exists, error when missing", () => {
	const file = plantPlan("abs", "- [ ] 1. A\n");
	const resolved = resolvePlan(file);
	assert.ok(!("error" in resolved) && resolved.planPath === file);
	const failed = resolvePlan("/definitely/not/here.md");
	assert.ok("error" in failed);
});

test("resolvePlan sanitizes hostile slugs to the filesystem-safe charset", () => {
	const file = plantPlan("2026-10-04 we!rd slug", "- [ ] 1. A\n");
	const resolved = resolvePlan(file);
	if ("error" in resolved) throw new Error(resolved.error);
	assert.match(resolved.slug, /^[a-zA-Z0-9._-]+$/);
});

test("ledger: append then tail newest-last; corrupt lines skipped; missing file is empty", () => {
	appendLedgerEntry("t", { ts: "1", sessionId: "s", event: "note", text: "first" });
	appendLedgerEntry("t", { ts: "2", sessionId: "s", event: "task-done", text: "second" });
	assert.deepEqual(
		readLedger("t", 10).map((e) => e.text),
		["first", "second"],
	);
	appendFileSync(
		path.join(process.env["TORUS_HOME"], "work", "t.ledger.jsonl"),
		"{not json\n",
		"utf-8",
	);
	assert.equal(readLedger("t", 10).length, 2);
	assert.deepEqual(
		readLedger("t", 1).map((e) => e.text),
		["second"],
	);
	assert.deepEqual(readLedger("missing-slug", 5), []);
});

test("activeWorkFor: newest active binding for the session wins; paused/complete/other sessions skipped", () => {
	assert.equal(activeWorkFor(null), null);
	assert.equal(activeWorkFor("ses-none"), null);
	plantState({ slug: "old", sessionId: "ses-a", lastActiveAt: 100 });
	plantState({ slug: "new", sessionId: "ses-a", lastActiveAt: 200 });
	plantState({ slug: "paused", sessionId: "ses-a", status: "paused", lastActiveAt: 300 });
	plantState({ slug: "done", sessionId: "ses-a", status: "complete", lastActiveAt: 400 });
	plantState({ slug: "other", sessionId: "ses-b", lastActiveAt: 500 });
	assert.equal(activeWorkFor("ses-a")?.slug, "new");
	const listed = listWorkStates();
	assert.deepEqual(
		listed.map((s) => s.slug),
		["old", "new", "paused", "done", "other"],
	);
});

test("work state round-trips through disk", () => {
	plantState({ slug: "round", sessionId: "ses-x" });
	const read = readWorkState("round");
	assert.equal(read?.planPath, "/nowhere.md");
	assert.equal(read?.status, "active");
	assert.equal(readWorkState("absent"), null);
});

test("ledgerAppendError: unknown slug errors, closed work refuses, active work allows", () => {
	assert.match(ledgerAppendError("ghost"), /no work state for slug "ghost"/);
	plantState({ slug: "paused-w", status: "paused" });
	assert.match(ledgerAppendError("paused-w"), /paused/);
	plantState({ slug: "done-w", status: "complete" });
	assert.match(ledgerAppendError("done-w"), /its ledger is closed/);
	plantState({ slug: "open-w" });
	assert.equal(ledgerAppendError("open-w"), null);
});

test("workContextBlock: injects plan path, progress, next task; missing plan surfaces; complete is silent", () => {
	const file = plantPlan("ctx", "- [x] 1. A\n- [ ] 2. B\n");
	plantState({ slug: "ctx", planPath: file, sessionId: "ses-a", lastActiveAt: 2000 });
	const block = workContextBlock("ses-a");
	assert.match(block, /torus work/);
	assert.match(block, new RegExp(file.replaceAll("/", "\\/")));
	assert.match(block, /1\/2 tasks checked/);
	assert.match(block, /Next: L2 2\. B/);
	assert.match(block, /work_note/);

	plantState({ slug: "gone", planPath: "/nowhere.md", sessionId: "ses-b", lastActiveAt: 999 });
	assert.match(workContextBlock("ses-b"), /Plan MISSING/);

	plantState({ slug: "ctx", planPath: file, sessionId: "ses-c", status: "complete" });
	assert.equal(workContextBlock("ses-c"), "");
});
