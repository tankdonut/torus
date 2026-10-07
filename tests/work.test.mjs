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
	approvalBlocker,
	registerWork,
	resolvePlan,
	readWorkState,
	writeWorkState,
	appendLedgerEntry,
	readLedger,
	ledgerAppendError,
	resolveLedgerSlug,
	listWorkStates,
	activeWorkFor,
	workContextBlock,
} = await import("../extensions/work/index.ts");
const { setCurrentSessionId } = await import("../extensions/registry.ts");

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

test("approvalBlocker: null on marker or recorded escape, blocker otherwise; checkbox-shaped fakes never count", () => {
	assert.equal(approvalBlocker("Approval: tankdonut 2026-10-07\n- [ ] 1. A\n"), null);
	assert.equal(approvalBlocker("Approval: skipped (--yes)\n- [ ] 1. A\n"), null);
	assert.equal(
		approvalBlocker("# plan\n\n- [x] 1. A\n- [x] F1. Final\n"),
		'plan lacks an approval marker (add a line "Approval: <user/date>", or "Approval: skipped (--yes)" to bind without review)',
	);
	// a checkbox row is task grammar, never an approval marker — and it still parses as a task
	assert.ok(approvalBlocker("- [ ] Approval: fake\n") !== null);
	assert.equal(parsePlanTasks("- [ ] Approval: fake\n").tasks.length, 1);
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

test("resolveLedgerSlug: paraphrased dispatch slugs resolve; ambiguity and misses name candidates", () => {
	plantState({ slug: "2026-10-04-fix-widget-thing" });
	assert.deepEqual(resolveLedgerSlug("2026-10-04-fix-widget-thing"), {
		slug: "2026-10-04-fix-widget-thing",
	});
	// the churn case: a lead paraphrases the dated stem in a dispatch text
	assert.deepEqual(resolveLedgerSlug("fix-widget-thing"), {
		slug: "2026-10-04-fix-widget-thing",
	});
	assert.deepEqual(resolveLedgerSlug("2026-10-04-fix-widget"), {
		slug: "2026-10-04-fix-widget-thing",
	});

	plantState({ slug: "2026-10-05-fix-widget" });
	const ambiguous = resolveLedgerSlug("fix-widget");
	assert.ok(
		"error" in ambiguous &&
			/ambiguous/.test(ambiguous.error) &&
			/2026-10-04-fix-widget-thing/.test(ambiguous.error) &&
			/2026-10-05-fix-widget/.test(ambiguous.error),
	);

	const miss = resolveLedgerSlug("ghost-xyz");
	assert.ok(
		"error" in miss &&
			/no work state for slug "ghost-xyz"/.test(miss.error) &&
			/known works/.test(miss.error),
	);

	// ledgerAppendError rides the same resolution, so a paraphrased slug journals fine
	assert.equal(ledgerAppendError("fix-widget-thing"), null);
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

function workTools() {
	const tools = [];
	const ambientChild = process.env["TORUS_ENGINE_CHILD"];
	delete process.env["TORUS_ENGINE_CHILD"];
	try {
		registerWork({ registerTool: (t) => tools.push(t), on: () => {} });
	} finally {
		if (ambientChild !== undefined) process.env["TORUS_ENGINE_CHILD"] = ambientChild;
	}
	return Object.fromEntries(tools.map((t) => [t.name, t]));
}

test("work_start refuses unmarked plans: exact REFUSED text, no state file, no start row; checkbox fakes do not count", async () => {
	setCurrentSessionId("ses-gate");
	const { work_start } = workTools();

	plantPlan("gate-unmarked", "# plan\n\n- [ ] 1. A\n- [ ] 2. B\n");
	const refused = await work_start.execute("t", { plan: "gate-unmarked" });
	assert.equal(refused.isError, true);
	assert.equal(
		refused.content[0].text,
		'REFUSED — plan lacks an approval marker (add a line "Approval: <user/date>", or "Approval: skipped (--yes)" to bind without review)',
	);
	assert.equal(readWorkState("gate-unmarked"), null, "no state file on refusal");
	assert.deepEqual(readLedger("gate-unmarked", 5), [], "no start row on refusal");

	// a checkbox-shaped fake is a task row, not approval — the plan has tasks yet still refuses
	plantPlan("gate-fake", "- [ ] Approval: fake\n");
	const fakeRefused = await work_start.execute("t", { plan: "gate-fake" });
	assert.equal(fakeRefused.isError, true);
	assert.match(fakeRefused.content[0].text, /REFUSED — plan lacks an approval marker/);
});

test("work_start binds approved plans: marker text, skipped escape, and assumeApproved recorded in the start row", async () => {
	setCurrentSessionId("ses-gate");
	const { work_start } = workTools();

	plantPlan("gate-marked", "# plan\n\nApproval: tankdonut 2026-10-07\n\n- [ ] 1. A\n");
	const marked = await work_start.execute("t", { plan: "gate-marked" });
	assert.equal(marked.isError, undefined);
	assert.ok(readWorkState("gate-marked"), "state written on bind");
	const markedRows = readLedger("gate-marked", 5);
	assert.equal(markedRows.at(-1)?.event, "start");
	assert.equal(markedRows.at(-1)?.approval, "tankdonut 2026-10-07");

	plantPlan("gate-skipped", "Approval: skipped (--yes)\n- [ ] 1. A\n");
	const skipped = await work_start.execute("t", { plan: "gate-skipped" });
	assert.equal(skipped.isError, undefined);
	assert.equal(readLedger("gate-skipped", 1).at(-1)?.approval, "skipped (--yes)");

	plantPlan("gate-assume", "# plan\n\n- [ ] 1. A\n");
	const assumed = await work_start.execute("t", { plan: "gate-assume", assumeApproved: true });
	assert.equal(assumed.isError, undefined);
	assert.ok(readWorkState("gate-assume"), "escape hatch still binds state");
	assert.equal(readLedger("gate-assume", 1).at(-1)?.approval, "assumed");
});

test("work_note admits converge rows: append via the tool, tail keeps the event intact", async () => {
	plantState({ slug: "open-cv" });
	const { work_note } = workTools();

	const out = await work_note.execute("t", {
		event: "converge",
		text: "waves synthesized: what shipped, what verification proved, residual risks",
		slug: "open-cv",
	});
	assert.equal(out.isError, undefined);
	assert.match(out.content[0].text, /\[converge\] waves synthesized/);

	const rows = readLedger("open-cv", 5);
	assert.equal(rows.at(-1)?.event, "converge");
	assert.equal(
		rows.at(-1)?.text,
		"waves synthesized: what shipped, what verification proved, residual risks",
	);
	assert.deepEqual(
		readLedger("open-cv", 1).map((e) => e.event),
		["converge"],
	);
});
