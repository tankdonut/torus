import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Contract tests for skills/torus-roadmap/bin/roadmap-lint.mjs. The linter runs
// as a child process against fixtures derived from one canonical roadmap: each
// corrupt case mutates exactly one part of the grammar and asserts the output
// names that rule. Some violations cascade on purpose (a malformed item row is
// flagged and never registered, so references to it report "unknown item"), so
// assertions match substrings of the output, never the whole output.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const linter = path.join(root, "skills", "torus-roadmap", "bin", "roadmap-lint.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "roadmap-lint-"));

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

const runLint = (args) => spawnSync(process.execPath, [linter, ...args], { encoding: "utf8" });

// Exercises all five item statuses, all five detail keys, a Depends chain
// (R1 → R2 → R3), two decision-log rows, and lanes that place every
// planned/in-flight item exactly once.
const ITEMS = `
- R1. Adopt the roadmap grammar — planned
  Note: blocked on the grammar linter landing
  Depends: R2

- R2. Ship the grammar linter — in-flight
  Plan: port the checker and cover it with contract tests
  Depends: R3
  Decision: D1

- R3. Draft the roadmap grammar — done
  Evidence: skills/torus-roadmap/SKILL.md merged

- R4. Diagram every extension — deferred
  Note: needs the archify skill first

- R5. Rewrite the docs site from scratch — dropped
  Decision: D2
`;

const ROADMAP = `# Roadmap — canonical fixture
Created: 2026-10-30
Status: active

## Items
${ITEMS}
## Now / Next / Later

- Now: R2
- Next: R1
- Later: none

## Decision log

- D1 (2026-10-30): the roadmap grammar is normative, the linter enforces it
- D2 (2026-10-27): keep the Astro site, drop the from-scratch rewrite
`;

// Writes a variant of the canonical roadmap into the tmp dir (each [from, to]
// pair applied in order; every anchor must be present so a stale template
// fails loudly instead of silently testing the unmutated roadmap) and asserts
// the linter exits 1 naming every expected message.
function expectViolation(name, replacements, expected) {
	let content = ROADMAP;
	for (const [from, to] of replacements) {
		assert.ok(
			content.includes(from),
			`${name}: corrupt anchor "${from}" is missing from the canonical roadmap template`,
		);
		content = content.replace(from, to);
	}
	const file = path.join(dir, `${name}.md`);
	writeFileSync(file, content, "utf8");
	const run = runLint([file]);
	assert.equal(
		run.status,
		1,
		`${name}: linter must exit 1, got ${run.status}\nstdout:\n${run.stdout}`,
	);
	for (const message of expected) {
		assert.ok(
			run.stdout.includes(message),
			`${name}: expected a violation naming "${message}", got:\n${run.stdout}`,
		);
	}
}

test("canonical roadmap passes: exit 0 with an ok line", () => {
	const file = path.join(dir, "canonical.md");
	writeFileSync(file, ROADMAP, "utf8");
	const run = runLint([file]);
	assert.equal(run.status, 0, `expected exit 0, got ${run.status}\nstdout:\n${run.stdout}`);
	assert.equal(run.stdout.trim(), `ok ${file}`, "a clean file must print exactly one ok line");
});

test("the shipped example roadmap lints clean", () => {
	const file = path.join(root, "skills", "torus-roadmap", "assets", "ROADMAP.example.md");
	const run = runLint([file]);
	assert.equal(
		run.status,
		0,
		`expected exit 0 for the shipped example (${file}), got ${run.status}\nstdout:\n${run.stdout}`,
	);
	assert.equal(
		run.stdout.trim(),
		`ok ${file}`,
		"the shipped example roadmap must print exactly one ok line naming it",
	);
});

test("item row with a status outside the grammar is rejected", () => {
	// R2 never registers, so its Depends referrer and its Now entry also report
	// "unknown item" — the cascade is intended, the assertion targets the root.
	expectViolation(
		"invalid-status",
		[["— in-flight", "— wip"]],
		['item R2 has invalid status "wip" (expected planned|in-flight|done|deferred|dropped)'],
	);
});

test("duplicate item id is rejected", () => {
	expectViolation(
		"duplicate-item-id",
		[["- R4. Diagram every extension", "- R1. Diagram every extension"]],
		["duplicate item id R1"],
	);
});

test("in-flight item without a Plan detail is rejected", () => {
	expectViolation(
		"inflight-missing-plan",
		[["  Plan: port the checker and cover it with contract tests\n", ""]],
		["in-flight item R2 missing Plan detail"],
	);
});

test("done item without an Evidence detail is rejected", () => {
	expectViolation(
		"done-missing-evidence",
		[["  Evidence: skills/torus-roadmap/SKILL.md merged\n", ""]],
		["done item R3 missing Evidence detail"],
	);
});

test("deferred item without a Note detail is rejected", () => {
	expectViolation(
		"deferred-missing-note",
		[["  Note: needs the archify skill first\n", ""]],
		["deferred item R4 missing Note detail"],
	);
});

test("dropped item without a Decision detail is rejected", () => {
	expectViolation(
		"dropped-missing-decision",
		[["  Decision: D2\n", ""]],
		["dropped item R5 missing Decision detail"],
	);
});

test("Depends reference to a missing item is rejected", () => {
	expectViolation(
		"dangling-depends-ref",
		[["  Depends: R2\n", "  Depends: R99\n"]],
		["Depends references unknown item R99"],
	);
});

test("Decision reference to a missing log row is rejected", () => {
	expectViolation(
		"dangling-decision-ref",
		[["  Decision: D1\n", "  Decision: D9\n"]],
		["Decision references unknown decision D9"],
	);
});

test("Now list holding a done item is rejected", () => {
	expectViolation(
		"lane-holds-done-item",
		[["- Now: R2", "- Now: R3"]],
		["Now list references done item R3"],
	);
});

test("planned item absent from all three lanes is rejected", () => {
	expectViolation(
		"item-absent-from-lanes",
		[["- Next: R1", "- Next: none"]],
		["item R1 planned but absent from Now/Next/Later"],
	);
});

test("item listed in two lanes is rejected", () => {
	expectViolation(
		"item-in-two-lanes",
		[["- Later: none", "- Later: R1"]],
		["item R1 is already listed under Next; listed again under Later"],
	);
});

test("header without a Created line is rejected", () => {
	expectViolation(
		"missing-created",
		[["Created: 2026-10-30\n", ""]],
		['header block must contain a "Created: <yyyy-mm-dd>" line'],
	);
});

test("Items section present but with zero item rows is rejected", () => {
	expectViolation(
		"items-section-empty",
		[[ITEMS, ""]],
		["Items section must contain at least one item row"],
	);
});

test("missing Decision log section is rejected", () => {
	expectViolation(
		"missing-decision-log",
		[["## Decision log\n", ""]],
		['missing "## Decision log" section'],
	);
});

test("no arguments: exit 2 with usage on stderr", () => {
	const run = runLint([]);
	assert.equal(run.status, 2, `expected exit 2, got ${run.status}`);
	assert.equal(
		run.stderr.trim(),
		"usage: node roadmap-lint.mjs <file>...",
		"a missing argv must print the usage line on stderr",
	);
	assert.equal(run.stdout, "", "nothing is reported on stdout when usage fails");
});

test("nonexistent file: exit 1 with file not found at line 0", () => {
	const missing = path.join(dir, "does-not-exist.md");
	const run = runLint([missing]);
	assert.equal(run.status, 1, `expected exit 1, got ${run.status}\nstdout:\n${run.stdout}`);
	assert.ok(
		run.stdout.includes(`${missing}:0: file not found`),
		`expected "<path>:0: file not found", got:\n${run.stdout}`,
	);
});
