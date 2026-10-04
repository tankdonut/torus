---
name: torus-execute
description: "Execute a saved torus-plan work plan: delegation-first for splittable waves, per-task worktrees, two-context verification of every done claim, an evidence ledger, and a final verification wave. Use when the user names a plan file (from ~/.torus/plans/) or says 'execute the plan'. Requires an existing plan; create one with torus-plan."
---

# torus-execute

You are the wave owner. The plan is the contract: you route its waves, delegate what splits, verify every done claim with real evidence in a second context, land it, and answer for the result. Delegation never substitutes for ownership: builders implement; you verify, land, and report.

## Setup

1. Read the plan file (`~/.torus/plans/<file>.md`). No plan file named → stop and say so; do not improvise one.
2. Check `torus_recall` for memories tagged to this project that bear on the plan; note conflicts with its constraints.
3. Register the whole plan up front: `work_start` with the plan file (binds plan↔session, reports progress and the next task, and injects an active-work block into every turn — the compaction-proof resume pointer), the objective as this session's goal, and every wave and task as todos via `torus_todowrite` — one todo per task, updated the instant status changes, never batch-completed.
4. Journal evidence with `work_note` — typed rows land in `~/.torus/work/<slug>.ledger.jsonl`: `task-done` (verification + evidence), `verified` (verifiedBy: lead|reviewer), `blocked` (the blocker), `wave-gate` (command + exit code).

The plan file (checkboxes) + work ledger are the durable state. After any restart or compaction, the injected work block points back at them; a new session resumes via `work_start` — never from memory.

## Per wave

1. **Drift check** — re-read the wave's file list and confirm the files still match reality (delegate a quick `explorer` pass if the plan may be stale — surface drift, do not silently adapt).
2. **Route by the plan's executor annotations** — delegation is the default for splittable work:
   - `lead` — implement it yourself: the smallest change satisfying the task, matching local conventions, no opportunistic refactors, no files outside the task's list.
   - `builder` / `fanout:<N>` — one `worktree_create` per task (branch `<type>/<plan-slug>-<wave>-<task>`; skip worktrees for docs-only or single-file waves), then `torus_fanout` with one `builder` per task, `cwd` = the task's worktree. Children never call the worktree tools (parent-only registration); they commit inside their worktree.
3. **Task text contract** — every dispatch is self-contained (the builder sees nothing of this session): goal and exact files in scope; the tests already covering the touched behavior, read as the behavior of record before any edit; the task's constraints and the wave's Must-NOT list; the acceptance command(s); the QA scenarios with evidence paths; and the work slug with the instruction to append its own gotchas and decisions via `work_note` (`event: note`, with the slug) before finishing. The ledger is the plan's shared notepad: builders write to it, its tail is injected back to you every turn, and inherited wisdom travels into the next dispatch text.
4. **Watch external conditions, not clocks** — when a task's completion lives outside the builder's final message (CI turning green, an artifact appearing, a log line), arm `torus_monitor` on that condition at dispatch time; tear it down the moment it fires; never poll or sleep. Watcher silence is never a pass.
5. **Verify every done claim in a second context.** A builder reporting done is a claim, not evidence:
   - LIGHT task (narrow change inside existing layers): you verify — run the acceptance command in the task's worktree, read the full diff, confirm the QA evidence exists on disk.
   - HEAVY task (new module or abstraction; auth/security; external integration; schema or migration; concurrency; cross-domain refactor): delegate verification to `reviewer` with the diff, the acceptance criteria, and the QA evidence. `confirmed` is the only pass verdict; anything else loops back to the builder with the exact finding. When unsure, treat the task as HEAVY.
   On pass: tick the task's checkbox in the plan file (`- [ ]` → `- [x]`) and record `work_note` (`task-done`). A task is done only when its checkbox is ticked AND its verification is in the ledger.
6. **Land at the wave boundary, sequentially** — `worktree_merge` per verified task (tree-identity proof gates the merge); never merge while siblings still run. A merge conflict means the plan's file-exclusivity rule was violated — surface it to the user; do not hand-resolve silently.
7. **Gate the wave once** — after all tasks land, run the wave's verification command on main; record command + exit code + behavioral evidence with `work_note` (`wave-gate`). Commit per repo discipline (atomic commits referencing the wave/task, matching `git log --oneline -20` subject shape, staging only the wave's files).
8. **On failure** — escalation ladder, never mark done with an unverified fix: (1) same builder, exact error output; (2) fresh builder, failed attempts passed as context so it takes a different angle; (3) journal the blocker with `work_note` (`blocked`), move to the next independent wave, surface it in the report.
9. **Cleanup** — `worktree_remove` after landing, or on abandonment (failed task: branch kept). No worktree outlives its wave; every armed monitor is stopped.

## Final verification wave

Run the plan's F1–F3; all must pass before completion:

1. **F1 review** — delegate to `reviewer`: the plan path plus landed commits; ask for plan-compliance and code-quality verdicts against the plan's constraints and Must-NOT list.
2. **F2 stopping condition** — exercise it yourself on the real surface; capture the artifact the plan names.
3. **F3 ideal-state fidelity** — walk every IS row against its recorded evidence; a shortfall becomes a new task appended to the plan (never silently noted) and runs through the same loop.

Tick each F-row in the plan as it passes — `work_complete` gates on them like any other task.

## Completion

Done means every wave is done or has an explicit, journaled blocker:

1. Final ledger pass: every task's checkbox ticked or explicitly blocked with evidence; every verified verdict carries its verifiedBy (lead or reviewer).
2. Call `work_complete` with the summary — it refuses while any checkbox is unticked (the machine gate); fix or journal what it names, then complete.
3. Report: waves shipped (commit hashes), verification summary, residual risks and blockers.
4. One `torus_remember` for the durable lesson from this execution; mark the session goal complete.
