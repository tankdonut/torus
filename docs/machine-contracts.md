# Machine contracts for the planning loop

External drivers can steer a torus planning loop without reading extension source: every stage emits a signal a script can consume. This page (docs/machine-contracts.md) inventories one signal per stage of the roadmap, plan, gate, and execute loop, plus the two verdict surfaces (lens review and delegation runs). Paths use the spelling the runtime exports: `$TORUS_STATE_DIR` for this project's state root, and `TORUS_HOME` (default `~/.torus`) for user-level state; both are defined in [docs/configuration.md](configuration.md).

## Stage signals

| Stage | Machine signal | How a driver consumes it |
| --- | --- | --- |
| Roadmap | `node skills/torus-roadmap/bin/roadmap-lint.mjs <file>` | Exit 0 clean (`ok <path>`), exit 1 violations (`<path>:<line>: <message>`), exit 2 usage. |
| Plan | `node skills/torus-plan/bin/plan-lint.mjs <file>` | Same exit shape and output lines as roadmap lint. |
| Gate | `$TORUS_STATE_DIR/plans/gates/<stem>.gate.md` | Grep for `GATE PASS` or `GATE BLOCKED`; the file is absent on skipped gates. |
| Execute | `$TORUS_STATE_DIR/work/<slug>.json` and `$TORUS_STATE_DIR/work/<slug>.ledger.jsonl` | Read `status` flipping to `"complete"`, and parse the JSONL ledger rows by their `event` field (`start`, `task-done`, `verified`, `blocked`, `wave-gate`, `note`, `converge`, `complete`). |
| Lens | `verified` ledger rows (bound runs) or the final answer (unbound runs) | Bound runs carry optional `lens` (string), `verdict` (`OKAY` or `REJECT`), and `round` (number) fields; unbound runs end the final answer with a `VERDICT: <OKAY\|REJECT>` line to grep. |
| Delegation | `~/.torus/runs/<id>.json` beacons, serve `POST /run` (`wait: true`), wake-marker details | Beacons carry optional `exitCode`, `error`, and `noProgress` fields; the settled 200 response carries `verdict: {ok, exitCode, turns, stopped, error, noProgress}`; wake details carry the same keys when present. |

The plan stage adds a second signal at bind time: `work_start` refuses to bind a plan that fails the lint, before the approval gate, with `REFUSED — plan lint: …` naming up to 5 violations (`… + N more` past the cap). `assumeApproved` bypasses the approval gate only, so a plan the lint rejects stays unbound under every flag.

This page inventories signals only; how stages compose into a full loop lives in the plan skill ([skills/torus-plan/SKILL.md](../skills/torus-plan/SKILL.md)). The tools behind each signal are documented in [docs/extensions.md](extensions.md).

## Backward compatibility

The new fields are fold-ins, not format changes. Delegation beacons load cleanly with `exitCode`, `error`, or `noProgress` absent, and JSON output drops keys that are unset. Ledger rows written before lens typing, including hand-written rows, read fine without `lens`, `verdict`, or `round`. Plans written before the plan lint existed may fail a re-bind with `REFUSED — plan lint: …`; the loud refusal is intended, because a plan the grammar cannot parse has no reliable machine contract.
