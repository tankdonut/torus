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

Measured 2026-10-07, torus 0.3.0 + engine pin 1.0.4, single run per task per config (cold cache), zai credentials. `npm run bench:overhead -- --model <id>`.

**glm-5.3-flash**

| task                |        config | turns | tokens in | tokens out | cache read | cache write |     cost |      ms |
| ------------------- | :------------ | :---- | :-------- | :--------- | :--------- | :---------- | :------- | :------ |
| readme-name         |         stock |     2 |     9,173 |         62 |         64 |           0 |  $0.0014 |   8,029 |
| readme-name         |         torus |     2 |    24,588 |         93 |        832 |           0 |  $0.0038 |  15,495 |
| readme-name         | Δ torus−stock |     0 |   +15,415 |        +31 |       +768 |           0 | +$0.0024 |  +7,466 |
| register-tool-count |         stock |     2 |     3,555 |         94 |      4,864 |           0 |  $0.0007 |  11,204 |
| register-tool-count |         torus |     2 |    11,482 |        105 |     12,800 |           0 |  $0.0022 |  14,461 |
| register-tool-count | Δ torus−stock |     0 |    +7,927 |        +11 |     +7,936 |           0 | +$0.0014 |  +3,257 |
| agents-doc-headings |         stock |     2 |     2,375 |        235 |      8,192 |           0 |  $0.0007 |   8,469 |
| agents-doc-headings |         torus |     2 |     2,898 |        230 |     24,064 |           0 |  $0.0013 |  16,189 |
| agents-doc-headings | Δ torus−stock |     0 |      +523 |         -5 |    +15,872 |           0 | +$0.0006 |  +7,720 |
| totals              |         stock |     6 |    15,103 |        391 |     13,120 |           0 |  $0.0029 |  27,702 |
| totals              |         torus |     6 |    38,968 |        428 |     37,696 |           0 |  $0.0072 |  46,145 |
| totals              | Δ torus−stock |     0 |   +23,865 |        +37 |    +24,576 |           0 | +$0.0043 | +18,443 |


**glm-5.3**

| task                |        config | turns | tokens in | tokens out | cache read | cache write |     cost |     ms |
| ------------------- | :------------ | :---- | :-------- | :--------- | :--------- | :---------- | :------- | :----- |
| readme-name         |         stock |     2 |     4,222 |         51 |      5,248 |           0 |  $0.0075 |  4,415 |
| readme-name         |         torus |     2 |     3,799 |         70 |     21,440 |           0 |  $0.0112 | 11,329 |
| readme-name         | Δ torus−stock |     0 |      -423 |        +19 |    +16,192 |           0 | +$0.0037 | +6,914 |
| register-tool-count |         stock |     2 |       152 |        108 |      8,256 |           0 |  $0.0028 |  9,436 |
| register-tool-count |         torus |     2 |       191 |         89 |     24,064 |           0 |  $0.0069 |  6,842 |
| register-tool-count | Δ torus−stock |     0 |       +39 |        -19 |    +15,808 |           0 | +$0.0041 | -2,594 |
| agents-doc-headings |         stock |     2 |     2,378 |        371 |      8,192 |           0 |  $0.0071 |  8,074 |
| agents-doc-headings |         torus |     2 |     2,893 |        378 |     24,064 |           0 |  $0.0120 | 12,077 |
| agents-doc-headings | Δ torus−stock |     0 |      +515 |         +7 |    +15,872 |           0 | +$0.0049 | +4,003 |
| totals              |         stock |     6 |     6,752 |        530 |     21,696 |           0 |  $0.0174 | 21,925 |
| totals              |         torus |     6 |     6,883 |        537 |     69,568 |           0 |  $0.0301 | 30,248 |
| totals              | Δ torus−stock |     0 |      +131 |         +7 |    +47,872 |           0 | +$0.0127 | +8,323 |


### Reading them

- The torus configuration here is the delegated-child extension set without a per-agent `--tools` whitelist — the ceiling, not the trimmed surface real delegations now use (every child agent ships a complete whitelist that removes tools it never touches, and MCP servers are scoped to researcher agents).
- On glm-5.3 the non-cached input overhead is near zero (+131 tokens across all tasks); the harness layer rides almost entirely in cache-read tokens (declaration surface, cached at a fraction of input price) — +$0.004 per task at 5.3 pricing.
- On glm-5.3-flash the input delta is larger (+8k tokens/task) at flash's cheaper rates — +$0.0014 per task.
- Wall-clock overhead (+2–7 s/run) is extension loading at spawn; amortized in real sessions that run many turns.
- Single-run, cold-cache, self-reported — directional, not benchmark-grade. Re-run with `--runs 3` for tighter numbers.


Pending — to be filled in by a benchmark run.
