# Efficiency — torus vs stock pi overhead

torus layers a harness (child extension set, tool registrations, system-prompt
additions) on top of the stock pi engine. This page documents how that
harness-layer context overhead is measured. The comparison the bench makes:
**stock pi** (bare engine, no extensions) vs **torus** (engine + the same
child-extension set delegations get), on identical prompts — the delta is
torus's overhead.

## Method

- **Task set.** Three fixed, read-only, repo-local prompts are embedded in
  `scripts/bench-overhead.mjs` (state the project name from `README.md`; count
  `registerTool` occurrences under `extensions/`; list the section headings of
  `docs/agents.md`). Deterministic inputs, no file writes, no network beyond
  the model API — so any token delta comes from the harness layer, not the
  task.
- **Configs.** Per task, the pinned engine binary (`resolveEngineBin`) is
  spawned twice with `--mode json`: **stock** gets
  `["--mode", "json", "--model", <model>, "-p", <task>]` and nothing else;
  **torus** gets the same argv plus the canonical `childExtensionArgs` list and
  `TORUS_ENGINE_CHILD=1` — byte-for-byte the spawn a delegation receives.
- **Model axis.** `--model <id>` sets the model for both configs (default
  `zai/glm-5.3-flash`); comparisons are only meaningful within one model.
- **Aggregation.** Each run's JSONL event stream is folded by the shared
  `reduceEngineEvent` pipeline (the same reducer roster/team/fleet consume):
  turns, tokens in/out, `cacheRead`/`cacheWrite`, and the engine-computed
  dollar cost come from `message_end` usage. Malformed event lines are skipped
  and counted, never fatal. With `--runs N` the table reports per-run means.
- **Cache-state caveat.** Every spawn is a fresh session, but provider-side
  prompt caches can survive between runs of the same prompt (and between the
  stock and torus configs), so `cacheRead`/`cacheWrite` deltas are indicative
  rather than exact — a torus run may read cache that a stock run just wrote,
  and vice versa. Fresh-cache `cacheWrite` also embeds torus's larger
  tool/system context by construction. **tokens-in and cost deltas are the
  stable signals**; treat cache columns as context.

## Running it

The bench spawns the real engine and calls the model API — run it with valid
credentials, from the repo root:

```sh
npm run bench:overhead -- --model zai/glm-5.3-flash
```

| Option | Meaning |
| ------ | ------- |
| `--model <id>` | model id for both configs (default `zai/glm-5.3-flash`) |
| `--runs N` | runs per task per config; table shows per-run means (default 1) |
| `--stock-only` / `--torus-only` | quick single-config diffs (no delta rows) |
| `--timeout <sec>` | per-run wall-clock cap (default 600) |
| `--help` | usage |

Exit status is 0 when every run completed, 1 when any run failed; failures and
skipped malformed lines are reported and the bench keeps going.

## Numbers

Pending — to be filled in by a benchmark run.
