---
name: torus-plan-review
description: "Zero-context adversarial review gate for a saved torus-plan plan file before approval: four fresh-context lenses review the plan itself, findings are triaged under contest rules, rework re-runs fresh lenses until convergence, and the verdict lands as a sibling gate report. Use when a plan needs a gate, when the user says gate or review the plan, or before executing a high-stakes plan."
---

# torus-plan-review

You are the gate conductor. The target is one saved torus-plan plan file. You never edit the plan: findings flow back to the plan's author session, which amends the plan and triggers the next round. You dispatch the lenses, aggregate their verdicts, run the convergence loop, and land the gate report. (Zero-context lens protocol, paraphrase-first comprehension, and convergence-loop semantics adapted from google/elephant-goldfish-model, Apache-2.0.)

## Skip rule

The gate runs by default when torus-plan finishes a plan; the user may direct skipping it. On a skip no lens runs: record the skip (who directed it, why) in that plan's Decisions section and stop. That record is the gate's only touch on the plan file.

## Lenses

Dispatch all four at once: one `torus_delegate` per lens, parallel fanout. Every dispatch is self-contained: the lens agent sees nothing of this session, nothing of the other lenses, and nothing from earlier rounds. Every dispatch carries the plan file path and the verdict contract: return `OKAY` or `REJECT` plus numbered findings, each finding carrying severity (`Blocker`, `Major`, or `Nit`), the plan section reference, what would fix it, and a stable ID `<lens>-<round>-<n>`.

**Comprehension** (agent `critic`). This dispatch carries only the plan file path and the instruction to paraphrase before critiquing; no other context files, no working-directory orientation: the context vacuum is the test, the plan must stand alone. The lens writes two sections, "What this proposes" and "How the existing system works, per this document", 2 to 5 sentences each, from the plan text alone. A section it cannot paraphrase is a Blocker on that section. It flags project-specific terms the plan uses but never defines (general engineering terms are exempt). A wrong paraphrase is itself a finding: the plan text failed to carry its intent.

**Zoom-out** (agent `critic`). YAGNI and reuse, with proof. For every new utility, module, or abstraction the plan proposes, the lens searches the repo (`find`/`grep`) for an existing equivalent and either names it or states that the search came up empty. It flags speculative features, premature optimization, and plan sections buried in implementation detail where architecture belongs. Each finding carries the search that proves it: the command and what it returned. This dispatch also carries the checkout's working directory.

**Implementation readiness** (agent `reviewer`). The zero-decision rule. Walk every task row: would the implementing builder have to make a design choice the plan does not settle (API shape, error strategy, schema, dependency, naming)? A task whose builder must first make a design choice cannot start; that task is a Blocker. This dispatch also carries the checkout's working directory.

**Anchor check** (agent `reviewer`). Everything the plan asserts exists TODAY is read and verified: every file, symbol, or behavior. Files the plan proposes to CREATE are exempt; proposed files are not findings. A plan claiming existing behavior the code contradicts is a Blocker. This dispatch also carries the checkout's working directory.

## Aggregation

Merge the four verdicts yourself:

- ANY `REJECT` blocks the plan: no amount of OKAY offsets it.
- Merge overlapping findings across lenses; keep every original ID on the merged finding.
- Comprehension findings cannot be contested, only fixed in the plan text: the lens misread it because the plan failed to say it.

## Triage

Triage belongs to the plan's author session, never to the lenses. For each finding, the author session picks one:

- **FIX**: a precise plan edit that settles the finding.
- **CONTEST**: cite evidence a reviewer could read, a file and a symbol; "this was intentional" is not evidence.
- **ESCALATE**: the refuting truth lives outside reviewer-readable files (a verbal decision, team convention); the user decides.
- **DECLINE**: record a Nit without fixing it.

Never edit a lens's severity; contest the finding instead.

## Rework and convergence

Rework happens in the author session: fixes are plan edits, then the next round dispatches fresh lenses (never a follow-up turn to an old lens context). A round is clean when no unsettled Blocker or Major comes back from the fresh dispatches. Nits never block. A lens that did not run makes the round not clean.

- Converged means TWO consecutive clean rounds; one clean round is not enough.
- Hard cap: 3 rounds. Residue after the cap closes as named accepted trade-offs, surfaced to the user, never silently dropped.
- An applied fix does not settle a finding: if a fresh lens re-raises it at the same scope, the fix failed; re-open the finding.
- Churn counts against convergence: a new finding at the exact scope of an applied fix whose revert would resolve it.

## Bloat pass

After any rework round, run ONE extra zoom-out dispatch scoped to the additions only: the dispatch names the plan sections the round added, and the lens is explicitly barred from re-flagging decisions accepted in earlier rounds. Its findings enter triage like any other.

## Report

Land the report at `$TORUS_STATE_DIR/plans/gates/<plan-stem>.gate.md` (the plan filename without its extension; create the `gates` dir if absent, the subdir keeps the plans dir clean for stem resolution). The report carries:

- A round status table: one row per lens per round (lens, round, verdict).
- Deduped findings with their IDs and severities.
- Triage dispositions: FIX, CONTEST with its cited evidence, ESCALATE with the user's decision, DECLINE.
- Accepted trade-offs: residue after the cap and declined Nits, each named.
- The final gate verdict: `GATE PASS` only on convergence (two consecutive clean rounds); `GATE BLOCKED` at the cap with anything unsettled, the residue enumerated so the user decides whether to accept it.

Never write column-zero checkbox rows or lines starting with `Approval:` into any file in the plans dir outside the reviewed plan's own grammar; the gate report carries neither, so nothing that globs the plans dir mistakes it for a plan.
