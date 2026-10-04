---
name: torus-execute
description: "Execute a saved torus-plan work plan with wave-by-wave verification and an evidence ledger. Use when the user names a plan file (from ~/.torus/plans/) or says 'execute the plan'. Requires an existing plan; create one with torus-plan."
---

# torus-execute

You are the plan executor. The plan is the contract: implement its waves in order, verify each increment with real evidence, and record that evidence back into the plan.

## Setup

1. Read the plan file (`~/.torus/plans/<file>.md`). No plan file named → stop and say so; do not improvise one.
2. Check `torus_recall` for memories tagged to this project that bear on the plan; note conflicts with the plan's constraints.
3. Append an **Execution ledger** section to the plan: one row per wave — `| wave | status | verification | evidence |`.

## Per wave

1. Re-read the wave's file list and change description. Confirm the files still match reality (delegate a quick `explorer` pass if the plan is stale — surface drift, do not silently adapt).
2. **Todo discipline** — one atomic todo per wave action; exactly one in progress; updated the instant status changes.
3. Implement the smallest change satisfying the wave. Match local conventions; no opportunistic refactors; no files outside the wave's list.
4. **Verify** — run the wave's named verification command (typecheck/build/test from the plan). Evidence or it did not happen:
   - command + exit code recorded in the ledger;
   - behavioral changes exercised on the real surface (run the command / endpoint / TUI path).
5. **Commit** — one atomic commit per verified wave, following `/skill:git-ops` discipline (read `git log --oneline -20` first; match its subject shape; stage only the wave's files). Commit message references the wave.
6. On failure: read the error, fix the root cause, re-verify. Two failed fix attempts on the same wave → stop, journal the blocker, move to the next independent wave, and surface the blocker in your report.

## Parallel waves

Parallel builders sharing one checkout race on the git index and HEAD —
that flow is forbidden. Every parallel wave runs each task in its own
worktree; the orchestrator owns the whole lifecycle.

1. **Spin up** — one `worktree_create` per task (branch naming
   `<type>/<plan-slug>-<wave>-<task>`). Skip worktrees for single-task or
   docs-only waves: per-worktree dependency setup (`npm ci` and friends) is
   real cost.
2. **Dispatch** — `torus_fanout` one `builder` per task with
   `cwd: <worktree path>`. Children never call the worktree tools
   (registration is parent-only); they commit inside their worktree.
3. **Verify per task, in its worktree** — baseline suite first, then the
   wave's verification command; evidence into the ledger per task.
4. **Land at the wave boundary, sequentially** — `worktree_merge` per task
   with a `/skill:git-ops`-discipline subject. Never merge a task while
   siblings still run. A merge conflict means the plan's file-exclusivity
   rule was violated — surface it to the user; do not hand-resolve silently.
5. **Gate the wave once** — after all tasks land, run the wave's
   verification command on main; record it in the ledger.
6. **Cleanup is a ledger row** — failed or abandoned task:
   `worktree_remove` (branch kept). No worktree outlives its wave.

Delegation never substitutes for ownership: builders implement, but you
verify, land, and answer for every wave.

## Completion

Done means every wave is `done` or has an explicit, journaled blocker:

1. Re-run the plan's stopping-condition check; capture the artifact that proves it.
2. Final ledger pass: every row green or explicitly blocked with evidence.
3. Report: waves shipped (commit hashes), verification summary, residual risks.
4. Offer one `torus_remember` for the durable lesson from this execution.
