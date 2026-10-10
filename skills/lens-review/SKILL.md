---
name: lens-review
description: "Fan out adversarial multi-lens review (security, correctness, test coverage) over a change-set and land the verdicts as evidence. Use when a diff, plan, or landed work needs independent verification passes before it's trusted."
---

# lens-review

You are the review conductor. Three independent lenses — security, correctness, test coverage — each examine the same change-set in a second context and return a verdict. You never take a lens's word for the whole: you aggregate the verdicts and land them as evidence.

## Setup

1. Name the change-set: a commit range (`base..head`), a pasted diff, or an explicit file list. Pin the working directory the review runs in.
2. Collect the acceptance criteria — the plan excerpt, the task's stated claims, or the behavior the change-set says it delivers. No claims to review against → ask for them; review without criteria is opinion.
3. If a work ledger is bound to this session, read its tail first (`tail -n 20` of the active work ledger) — sibling context and prior findings tell each lens what to probe harder.

## Lenses

Dispatch all three at once — one `torus_delegate` per lens, agent `reviewer`, parallel fanout. Each dispatch is self-contained (the reviewer sees nothing of this session) and carries:

- The diff scope (commit range or files) and the working directory.
- The acceptance criteria, verbatim.
- The lens checklist below.
- The verdict contract: return `OKAY` or `REJECT` plus numbered findings, each finding carrying `file:line` and what would fix it. Vague findings do not count.

**Security** — where does this change-set trust what it shouldn't: injection paths (shell, query, path traversal, template interpolation), guard bypasses (auth checks, allowlists, capability gates that new code slips past), trust handoffs (data crossing a process or session boundary unvalidated), unsafe paths (file writes, symlink and absolute-path handling, anything touching credentials or env). Gate every finding on confidence: a finding counts only when the vulnerable pattern AND attacker-controlled input reaching it are both confirmed — trace each input to its source first (operator config, env vars, and constants are server-controlled, not findings) and check for upstream validation or framework/runtime mitigation before flagging. Theoretical hardening and defense-in-depth suggestions never count as findings. Tag each finding with severity: Critical (direct exploit — RCE, injection, auth bypass, committed secrets), High (exploitable with conditions — stored XSS, SSRF, IDOR), Medium (specific preconditions — reflected XSS, CSRF, traversal). (Confidence-gated methodology adapted from getsentry/skills `security-review`, Apache-2.0.)

**Correctness** — does the code do what the criteria claim? Read the diff against each claim and hunt the counterexample: the input, ordering, or state where the claim breaks. A claim the diff doesn't implement and an implementation the criteria never asked for are both findings.

**Test coverage** — do the tests prove the claims? Check each criterion has a test that fails without the implementation; check failure-path coverage (error, empty, corrupt, concurrent — not just the happy path); check fixtures are honest — real shapes from the domain, not echoes of the code's own assumptions.

## Aggregation

Merge the three verdicts yourself:

- ANY `REJECT` blocks the change-set — no amount of OKAY offsets it.
- Lenses disagreeing about the same line is not a tie to average: resolve it by reading the code, then record which lens was right and why.
- Findings that survive aggregation become the blocking list; findings that dissolve under a fresh read are recorded as resolved, never silently dropped.

## Evidence

Land one `work_note` per lens verdict (event: `verified`): the text names the lens, its verdict, and the top blocking finding when there is one (e.g. `security REJECT — injection at <file>:<line>, user input reaches a shell unquoted`). When no work is bound to this session, the verdicts land in the final chat answer instead — never invent a slug.

The final answer carries the aggregate: per-lens verdicts, the blocking findings with `file:line`, and what would clear each one.

## Scope guard

Lenses review; they never edit. A reviewer proposing to "just fix it" is a finding, not a fix — the change-set goes back to its author with the blocking list, and a re-review of the fix starts fresh lenses on the new diff.
