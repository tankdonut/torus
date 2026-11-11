import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The repo's two review surfaces encode their protocols as load-bearing
// sentences: the protocol IS the prose. torus-plan-review (the plan gate,
// adapted from google/elephant-goldfish-model) and lens-review (the landed
// change-set review loop) both depend on their exact wording.
// tests/skills-spec.test.mjs pins the structural contract of every skill;
// this test pins the sentences both review surfaces' behavior depends on, so
// an edit that rewords a rule fails loudly instead of silently changing the
// gate or the review loop. Each pinned substring is copied from the live
// file, which is the authority; if a phrase legitimately changes, update the
// pin in the same commit and say why in the diff.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(path.join(root, "skills", "torus-plan-review", "SKILL.md"), "utf8");
const planSkill = readFileSync(path.join(root, "skills", "torus-plan", "SKILL.md"), "utf8");
const lensSkill = readFileSync(path.join(root, "skills", "lens-review", "SKILL.md"), "utf8");

test("lens protocol sentences cannot drift", () => {
	assert.ok(
		skill.includes("the context vacuum is the test, the plan must stand alone"),
		"torus-plan-review lost the context-vacuum instruction",
	);
	assert.ok(
		skill.includes("A task whose builder must first make a design choice cannot start"),
		"torus-plan-review lost the zero-decision rule",
	);
	assert.ok(
		skill.includes("proposed files are not findings"),
		"torus-plan-review lost the anchor-check exemption for proposed files",
	);
});

test("triage contest rule cannot drift", () => {
	assert.ok(
		skill.includes('"this was intentional" is not evidence'),
		"torus-plan-review lost the contest evidence standard",
	);
});

test("convergence rules cannot drift", () => {
	assert.ok(
		skill.includes("TWO consecutive clean rounds; one clean round is not enough"),
		"torus-plan-review lost the two-clean-rounds convergence bar",
	);
	assert.ok(
		skill.includes("An applied fix does not settle a finding"),
		"torus-plan-review lost the re-open rule for failed fixes",
	);
	assert.ok(skill.includes("Hard cap: 3 rounds"), "torus-plan-review lost the round cap");
});

test("report grammar and verdict vocabulary cannot drift", () => {
	assert.ok(
		skill.includes("Never write column-zero checkbox rows or lines starting with"),
		"torus-plan-review lost the report grammar guard (checkbox rows and Approval: lines)",
	);
	assert.ok(skill.includes("GATE PASS"), "torus-plan-review lost the GATE PASS verdict");
	assert.ok(skill.includes("GATE BLOCKED"), "torus-plan-review lost the GATE BLOCKED verdict");
});

test("torus-plan wiring reference cannot drift", () => {
	assert.ok(
		planSkill.includes("run `torus-plan-review` on the saved plan"),
		"torus-plan lost the review-gate wiring invocation",
	);
});

test("lens-review verdict contract cannot drift", () => {
	assert.ok(
		lensSkill.includes(
			"each finding carrying severity (`Blocker`, `Major`, or `Nit`), `file:line`, what would fix it, and a stable ID `<lens>-<round>-<n>`",
		),
		"lens-review lost the severity/ID verdict contract",
	);
	assert.ok(
		lensSkill.includes("A lens REJECTs on any Blocker or Major; Nits never block."),
		"lens-review lost the REJECT-on-Blocker-or-Major rule",
	);
});

test("lens-review triage dispositions cannot drift", () => {
	assert.ok(
		lensSkill.includes("Triage belongs to the author session, never to a lens"),
		"lens-review lost the triage-ownership rule",
	);
	for (const disposition of ["FIX", "CONTEST", "ESCALATE", "DECLINE"]) {
		assert.ok(
			lensSkill.includes(`**${disposition}**:`),
			`lens-review lost the ${disposition} disposition`,
		);
	}
	assert.ok(
		lensSkill.includes('"this was intentional" is not evidence'),
		"lens-review lost the contest evidence standard",
	);
	assert.ok(
		lensSkill.includes("Never edit a lens's severity; contest the finding instead."),
		"lens-review lost the severity-immutability rule",
	);
});

test("lens-review convergence rules cannot drift", () => {
	assert.ok(
		lensSkill.includes(
			"A round is clean when no unsettled Blocker or Major comes back and every lens ran.",
		),
		"lens-review lost the clean-round definition",
	);
	assert.ok(
		lensSkill.includes(
			"A clean round converges when no fix has changed the diff since that round reviewed it",
		),
		"lens-review lost the diff-scoped convergence bar",
	);
	assert.ok(
		lensSkill.includes("when fixes land between rounds, two consecutive clean rounds are required"),
		"lens-review lost the two-clean-rounds bar after fixes",
	);
	assert.ok(lensSkill.includes("Hard cap: 3 rounds"), "lens-review lost the round cap");
	assert.ok(
		lensSkill.includes("Residue after the cap closes as named accepted trade-offs"),
		"lens-review lost the residue rule",
	);
});
