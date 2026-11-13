---
name: lens-review
description: "Fan out adversarial multi-lens review (security, correctness, test coverage) over a change-set and land the verdicts as evidence. Use when a diff, plan, or landed work needs independent verification passes before it's trusted, and as torus-execute's final-verification code-quality pass, dispatched by name over the landed commits."
---

# lens-review

You are the review conductor. Three independent lenses (security, correctness, test coverage) each examine the same change-set in a second context and return a verdict. You never take a lens's word for the whole: you aggregate the verdicts and land them as evidence.

## Setup

1. Name the change-set: a commit range (`base..head`), a pasted diff, or an explicit file list. Pin the working directory the review runs in.
2. Collect the acceptance criteria: the plan excerpt, the task's stated claims, or the behavior the change-set says it delivers. No claims to review against → ask for them; review without criteria is opinion.
3. If a work ledger is bound to this session, read its tail first (`tail -n 20` of the active work ledger). Sibling context and prior findings tell each lens what to probe harder.

## Lenses

Dispatch all three at once: one `torus_delegate` per lens, agent `reviewer`, parallel fanout. Each dispatch is self-contained (the reviewer sees nothing of this session) and carries:

- The diff scope (commit range or files) and the working directory.
- The round number and the acceptance criteria, verbatim.
- The lens checklist below.
- The verdict contract: return `OKAY` or `REJECT` plus numbered findings, each finding carrying severity (`Blocker`, `Major`, or `Nit`), `file:line`, what would fix it, and a stable ID `<lens>-<round>-<n>`. Vague findings do not count. A lens REJECTs on any Blocker or Major; Nits never block. The verdict comes back as the lens's final text; never instruct a lens to journal it (the reviewer persona carries no `work_note` tool, and a dispatch that asks for one gets a hand-formatted ledger row instead).

**Security**. Where does this change-set trust what it shouldn't: injection paths (shell, query, path traversal, template interpolation), guard bypasses (auth checks, allowlists, capability gates that new code slips past), trust handoffs (data crossing a process or session boundary unvalidated), unsafe paths (file writes, symlink and absolute-path handling, anything touching credentials or env). Gate every finding on confidence: a finding counts only when the vulnerable pattern AND attacker-controlled input reaching it are both confirmed: trace each input to its source first (operator config, env vars, and constants are server-controlled, not findings) and check for upstream validation or framework/runtime mitigation before flagging. Theoretical hardening and defense-in-depth suggestions never count as findings. Fold the exploit precondition into the finding text: what an attacker must control, reach, or already hold for the issue to bite (direct exploit, exploitable with conditions, specific preconditions). (Confidence-gated methodology adapted from getsentry/skills `security-review`, Apache-2.0.)

**Correctness**. Does the code do what the criteria claim? Read the diff against each claim and hunt the counterexample: the input, ordering, or state where the claim breaks. A claim the diff doesn't implement and an implementation the criteria never asked for are both findings.

**Test coverage**. Do the tests prove the claims? Check each criterion has a test that fails without the implementation; check failure-path coverage (error, empty, corrupt, concurrent, not only the happy path); check fixtures are honest: real shapes from the domain, not echoes of the code's own assumptions.

## Aggregation

Merge the three verdicts yourself:

- ANY `REJECT` blocks the change-set: no amount of OKAY offsets it.
- Merge overlapping findings across lenses; keep every original ID on the merged finding.
- Lenses disagreeing about the same line is not a tie to average: resolve it by reading the code, then record which lens was right and why.
- Findings that survive aggregation become the blocking list; findings that dissolve under a fresh read are recorded as resolved, never silently dropped.

## Triage

Triage belongs to the author session, never to a lens. For each finding, the author session picks one:

- **FIX**: a precise change-set edit that settles the finding.
- **CONTEST**: cite evidence a reviewer could read, a file and a symbol; "this was intentional" is not evidence.
- **ESCALATE**: the refuting truth lives outside reviewer-readable files (a verbal decision, team convention); the user decides.
- **DECLINE**: record a Nit without fixing it.

Never edit a lens's severity; contest the finding instead.

## Rework and convergence

Rework happens in the author session: fixes land on the change-set, then the next round dispatches fresh lenses on the new diff (never a follow-up turn to an old lens context). A round is clean when no unsettled Blocker or Major comes back and every lens ran. Convergence is scoped to the diff the round reviewed:

- A clean round converges when no fix has changed the diff since that round reviewed it; when fixes land between rounds, two consecutive clean rounds are required.
- Hard cap: 3 rounds. Residue after the cap closes as named accepted trade-offs, surfaced to the user, never silently dropped.

## Evidence

Land one `work_note` per lens verdict yourself, from the lens's returned text (event: `verified`, `verifiedBy: reviewer`): the text names the lens, its verdict, the round, and the top blocking finding when there is one (e.g. `security REJECT round 2 — injection at <file>:<line>, user input reaches a shell unquoted`). The conductor writes the row, never the lens. When no work is bound to this session, or `work_note` is not in this session's toolset, the verdicts land in the final chat answer instead. Never invent a slug.

The final answer carries the aggregate: per-lens verdicts by round, the blocking findings with their IDs and `file:line`, and what would clear each one.

## Scope guard

Lenses review; they never edit. A reviewer proposing to "just fix it" is a finding, not a fix: the change-set goes back to its author with the blocking list, and a re-review of a fix starts fresh lenses on the new diff.
