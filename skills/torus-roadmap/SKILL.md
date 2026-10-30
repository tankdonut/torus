---
name: torus-roadmap
description: "Own long-horizon initiative state across many plan and execute runs: one ROADMAP.md per initiative holding plan-slice items, Now/Next/Later lanes, and an append-only decision log. Use when the user says 'roadmap', starts a long-horizon initiative that needs multi-wave tracking, asks to 'sync the roadmap' after a roadmap-stamped plan completes, or wants the next item shaped into a brief for feeding waves to torus-plan."
---

# torus-roadmap

You own long-horizon initiative state. One initiative outlives many torus-plan and torus-execute sessions; the roadmap is what survives them: which plan-slices exist, where each stands, what was decided and why. You do not implement (torus-execute's job) and you do not plan slices (torus-plan's job); you sequence them and hold their memory.

## Location

`$TORUS_STATE_DIR/roadmaps/<slug>/ROADMAP.md` (every torus session exports this env var). Roadmaps live in torus state, never inside a repo: they are planning metadata, not project artifacts.

The `<slug>` is the initiative name, stable for the roadmap's life; the plans you feed carry its absolute path back as their stamp.

## Format

One file per initiative, machine-checked. `assets/ROADMAP.example.md` in this skill is the canonical illustration; the grammar:

- H1 `# Roadmap — <title>`, then `Created: <yyyy-mm-dd>` and `Status: active|completed|parked` header lines.
- `## Items`: one row per item, `- R<n>. <title> — <status>`; status is planned, in-flight, done, deferred, or dropped; ids are unique.
  Detail lines sit under their item, indented exactly two spaces, keyed `Plan:`, `Evidence:`, `Depends:`, `Note:`, or `Decision:`; any other indented line is free prose.
- Status-dependent payloads: in-flight carries `Plan:`, done carries `Evidence:`, deferred carries `Note:`, dropped carries `Decision:`.
- Detail semantics: `Plan:` sketches the run, `Evidence:` cites the proof of completion, `Note:` carries context and lessons, `Depends:` and `Decision:` are reference keys.
- Item titles state outcomes, not chores; the status suffix carries the state.
- The em dash and the two-space indent are grammar, not style; the linter rejects lookalikes.
- `Depends:` lists item references that must resolve within the same file; `Decision:` lists decision-log references; both separate refs by comma or space.
- `## Now / Next / Later`: exactly one row per lane (`- Now: R1, R2`, `- Next: R3`, `- Later: none`); a row is the bare word `none` or a comma-separated item list;
  the three lanes together list every planned or in-flight item exactly once, and no item of any other status.
- `## Decision log`: rows `- D<n> (<yyyy-mm-dd>): <text>`; append-only.

## Verbs

1. **create**: input is a research report, a roadmap draft, or user intent. Write the destination plus scope and non-goals first, before any item.
   Size items as plan-slices (one item ≈ one torus-plan run), never tasks. Seed every item `planned`, seed Now/Next/Later from dependency order, record adoption as D1, lint before finishing.
   Scope and non-goals are load-bearing: later deferral and drop proposals are held against them.
2. **sync**: runs after `work_complete` of a roadmap-stamped plan, or on request. Read the plan's `Roadmap:` stamp line and its work ledger; set item statuses with evidence refs.
   Scan ledger notes and review findings for falsified assumptions that affect OTHER items: each becomes a `Note:` on the affected item plus a decision-log entry.
   Re-derive Now/Next/Later, lint, and report surfaced drift to the user.
3. **next**: pick from Now, then Next, respecting `Depends:`. Compose the brief in-chat: the item IDs, the outcome wanted, constraints, and lessons distilled from prior ledgers.
   Hand it to torus-plan as the user request, and instruct that the plan's Destination carries a `Roadmap: <absolute path> (items R…)` line; that stamp is what sync reads.
   When Now and Next are both empty, say so instead of improvising an item: the initiative is done or parked, which is a Status change plus a decision.
4. **review**: periodic drift check. Delegate to the `reviewer` agent with the roadmap path and the recent ledgers.
   Findings become decision-log entries, new items, or deferrals; never silent reordering.
   Run it every few synced plans, or whenever the user asks whether the roadmap still holds.

## Rules

- Thinness: statuses, sequencing, and decisions only. The moment an item carries acceptance criteria, it belongs in a plan.
- Mutation discipline: statuses and lanes mutate freely; destination or scope changes require a decision-log entry; items are never deleted, they are `dropped` with a `Decision:` ref.
- The decision log is append-only: a superseded decision gets a new row, never an edit.
- `Status:` is initiative-level: active while items remain open, completed when the destination holds, parked while nothing can run.
- Lanes and statuses must agree; hand-edited lanes that contradict item statuses are lint failures, not opinions.
- Artifact containment: roadmap paths and item IDs never appear in commits, code comments, or branch names.
- Memory split: initiative decisions go to the decision log; cross-project lessons go to `torus_remember`.
- Always lint after edits: `node skills/torus-roadmap/bin/roadmap-lint.mjs <file>`.
