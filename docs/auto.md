# torus auto

`torus auto` drives the whole planning loop unattended: one invocation chains plan → gate → execute → lens, every stage gates on a machine signal from [docs/machine-contracts.md](machine-contracts.md), and the process exits with a structured report. The launcher intercepts `auto` before the engine passthrough (the same rule as `torus serve`): the process is the surface, so the chain runs to completion without a session attached. The source lives in `extensions/auto/index.ts`.

## Setup

Run it from a shell:

```sh
torus auto "Add a --dry-run flag to the import script" --cwd ../repo-worktree
```

Every positional word joins into the objective; everything else is a flag (the full list is under [Flags and timeouts](#flags-and-timeouts)).

`--cwd` is required: the driver refuses to start without it. Pass a worktree or scratch copy of the repository you drive, not your live checkout: unattended execution writes plans, work state, and scratch files, and a failed stage can leave artifacts behind. A linked git worktree keys on the main checkout's state root, the same as every other torus surface.

Refusals exit 2 with the usage text: missing `--cwd`, an objective and `--plan` both absent, an unknown flag, or a non-positive `--stage-timeout-ms`.

## Stage loop

The chain is sequential and stops at the first failing stage. Four stages, each with one machine signal:

1. **Plan**: a `builder` delegation runs `/skill:torus-plan <objective>` (stamped for the roadmap when `--roadmap` is set). The signal is a new `$TORUS_STATE_DIR/plans/<yyyy-mm-dd>-*.md` file created after the stage started; the plan path is the stage's output.
2. **Gate**: the driver reads `$TORUS_STATE_DIR/plans/gates/<stem>.gate.md`. `GATE BLOCKED` (checked first) fails the stage named `gate-blocked`; `GATE PASS` passes.
3. **Execute**: a `builder` delegation binds the plan with `work_start(<planPath>, assumeApproved: true)`, then works it to completion. The signal is `$TORUS_STATE_DIR/work/<slug>.json` flipping to `"status": "complete"`.
4. **Lens**: the driver accepts only typed `verified` rows appended to `$TORUS_STATE_DIR/work/<slug>.ledger.jsonl` after the stage started. Three or more rows with `"verdict": "OKAY"` and zero with `"verdict": "REJECT"` pass; any REJECT fails the stage named `lens-reject`.

Each stage races its per-stage timeout; on timeout the stage fails named `stage-timeout` and its work stops. If the lens one-shot exits with no ledger rows (an unbound session lands verdicts in the final answer instead), the last `VERDICT: OKAY|REJECT` line in its captured stdout decides; with neither signal the stage fails named `lens-verdict-missing`. A gate child that exits with no report at all fails named `gate-report-missing`.

Two stage kinds run under the hood:

- **Delegation stages** (plan, execute): `runDelegation` children that carry the work tools. The plan child is pinned to the torus-plan skill; the execute child is pinned to the bind-and-complete instruction.
- **Root one-shots** (gate, lens): the driver spawns `node runtime/bin/torus.mjs -a --mode json -p <prompt>` itself. The gate's four-lens fanout and the lens protocol need `torus_delegate`, which delegation children lack, so these stages run in a full root session instead.

The approver seat: execute binds with `assumeApproved: true`, so the unattended driver is the approving authority and the work ledger journals `approval: "assumed"`. Run `torus auto` only where you accept that contract: every plan that passes the gate executes without a human approval.

## Flags and timeouts

| Flag | Behavior |
| --- | --- |
| `<objective>` | positional; words joined into one task. Required unless `--plan` is set |
| `--cwd <dir>` | required; the driven checkout (a worktree or scratch copy) |
| `--roadmap <path>` | stamps the plan against this roadmap's items |
| `--plan <path>` | starts from an existing plan and skips the plan stage; the chain becomes gate → execute → lens |
| `--stage-timeout-ms <n>` | per-stage timeout in milliseconds; default 600000 (10 minutes) |
| `--skills <a,b>` | comma-separated skill names or paths, passed to every stage |

Every stage races `--stage-timeout-ms` from its own start. On timeout the stage fails named and the chain stops: delegation stages are stopped through the delegation registry, one-shot children get `SIGTERM` and then `SIGKILL`. The report and exit code follow the failure.

## Outcomes

The report prints one `stage <name>: ok|FAILED (error) verdict=… artifact=… durationMs=…` line per stage, then a `JSON:` line carrying the whole report. Each stage entry in the JSON has these fields:

| Field | Meaning |
| --- | --- |
| `stage` | `plan`, `gate`, `execute`, or `lens` |
| `ok` | whether the stage's machine signal arrived in time |
| `artifact` | the stage's output where one exists (the plan path) |
| `verdict` | the machine verdict where one exists (gate `PASS`, lens `OKAY`) |
| `error` | the named failure reason on a failed stage |
| `durationMs` | wall time for the stage |

Exit codes: `0` when every attempted stage passed, `1` on the first named stage failure, `2` on a refusal before the chain starts.

For the raw signals behind each stage, the signal inventory in [docs/machine-contracts.md](machine-contracts.md) is the reference this page summarizes.
