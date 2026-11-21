import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// Contract tests for skills/torus-plan/bin/plan-lint.mjs. The linter runs
// as a child process against fixtures derived from one canonical plan:
// each corrupt case mutates exactly one part of the grammar and asserts
// the output names that rule. Violations cascade (removing a wave heading
// also breaks the final-wave rule), so assertions match substrings of the
// output, never the whole output. The two regression fixtures are real
// approved plans, read as content and copied into the tmp dir; when the
// state dir is unavailable (CI) the suite falls back to an embedded
// representative plan with the same shape.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const linter = path.join(root, "skills", "torus-plan", "bin", "plan-lint.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "plan-lint-"));

after(() => {
	rmSync(dir, { recursive: true, force: true });
});

const runLint = (args) => spawnSync(process.execPath, [linter, ...args], { encoding: "utf8" });

const PLAN = `# Plan — canonical fixture

## Destination
The plan grammar is machine-checkable.

## Constraints
No new extension registration.

## Stopping condition
The suite exits 0 on the real plans.

### Wave 1 — lint the plan grammar

- [ ] 1. Add the lint core
  Files: extensions/plangrammar.ts
  Acceptance: the suite exits 0
  Executor: builder

### Wave 2 — ship the CLI

- [ ] 2. Add the CLI wrapper
  Files: skills/torus-plan/bin/plan-lint.mjs
  Acceptance: the CLI exits 0 on a clean plan
  Executor: builder

### Final verification wave

- [ ] F1. Plan-compliance review
  Delegated to the reviewer.

## Decisions
None.
`;

// Fallback when the real plans are unavailable: same shape, one task per
// rule, enough to prove the linter accepts a representative plan.
const FALLBACK_PLAN = PLAN;

const REAL_PLANS = ["2026-11-12-ci-trust-profile.md", "2026-11-20-untrusted-fencing.md"];

function realPlanContent(name) {
	const stateDir = process.env["TORUS_STATE_DIR"];
	if (stateDir) {
		try {
			return readFileSync(path.join(stateDir, "plans", name), "utf8");
		} catch {
			// Fall through to the embedded fixture.
		}
	}
	return FALLBACK_PLAN;
}

// Writes a variant of the canonical plan into the tmp dir (each [from, to]
// pair applied in order; every anchor must be present so a stale template
// fails loudly instead of silently testing the unmutated plan) and asserts
// the linter exits 1 naming every expected message.
function expectViolation(name, replacements, expected) {
	let content = PLAN;
	for (const [from, to] of replacements) {
		assert.ok(
			content.includes(from),
			`${name}: corrupt anchor "${from}" is missing from the canonical plan template`,
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

test("canonical plan passes: exit 0 with an ok line", () => {
	const file = path.join(dir, "canonical.md");
	writeFileSync(file, PLAN, "utf8");
	const run = runLint([file]);
	assert.equal(run.status, 0, `expected exit 0, got ${run.status}\nstdout:\n${run.stdout}`);
	assert.equal(run.stdout.trim(), `ok ${file}`, "a clean file must print exactly one ok line");
});

test("real approved plans pass: exit 0", () => {
	assert.ok(REAL_PLANS.length >= 2, "the two regression fixtures must be listed");
	for (const name of REAL_PLANS) {
		const content = realPlanContent(name);
		const file = path.join(dir, name);
		writeFileSync(file, content, "utf8");
		const run = runLint([file]);
		assert.equal(
			run.status,
			0,
			`real plan ${name} must lint clean, got ${run.status}\nstdout:\n${run.stdout}`,
		);
	}
});

test("task without an Acceptance: detail line: exit 1 naming the task's line", () => {
	const taskLine = PLAN.split("\n").indexOf("- [ ] 2. Add the CLI wrapper") + 1;
	expectViolation(
		"no-acceptance",
		[
			[
				"  Acceptance: the CLI exits 0 on a clean plan",
				"  Checks: the CLI exits 0 on a clean plan",
			],
		],
		[`${taskLine}: task row has no Acceptance: detail line`],
	);
});

test("no wave headings: exit 1", () => {
	expectViolation(
		"no-waves",
		[
			["### Wave 1 — lint the plan grammar", "### Wave 1: lint the plan grammar"],
			["### Wave 2 — ship the CLI", "### Wave 2: ship the CLI"],
			["### Final verification wave", "### Wrap-up"],
		],
		["no wave heading"],
	);
});

test("no final verification wave: exit 1", () => {
	expectViolation(
		"no-final-wave",
		[["### Final verification wave", "### Wrap-up"]],
		["no final verification wave section"],
	);
});

test("no Stopping condition section: exit 1", () => {
	expectViolation(
		"no-stopping",
		[["## Stopping condition", "## Done when"]],
		["no Stopping condition section"],
	);
});

test("missing file: exit 1", () => {
	const run = runLint([path.join(dir, "absent.md")]);
	assert.equal(run.status, 1, `expected exit 1, got ${run.status}\nstdout:\n${run.stdout}`);
	assert.ok(
		run.stdout.includes("file not found"),
		`expected a "file not found" violation, got:\n${run.stdout}`,
	);
});

test("no arguments: exit 2 with usage", () => {
	const run = runLint([]);
	assert.equal(run.status, 2, `expected exit 2, got ${run.status}\nstderr:\n${run.stderr}`);
	assert.ok(run.stderr.includes("usage:"), `expected usage on stderr, got:\n${run.stderr}`);
});
