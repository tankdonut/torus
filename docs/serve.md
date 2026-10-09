# torus serve

`torus serve` boots an authenticated HTTP server over the delegation core (`extensions/serve/index.ts`): every `POST /run` is a session-free `runDelegation()` call with `parentSession: null` — the same production path memory reflect/dream and team respawn use — so runs land in the shared registry (record + run beacon) and are fleet-visible like any other delegation. Each run carries a unique `srv-` handle for correlation. The server is the process, never a pi manifest extension, and never starts implicitly: only the `torus serve` launcher subcommand calls `startServe()`.

## Setup

Config lives at `~/.torus/serve.json` (read-with-fallback to defaults):

```json
{
	"port": 4747,
	"bind": "127.0.0.1",
	"tokenPath": "optional/explicit/auth.json",
	"triggers": []
}
```

Defaults shown; every field is optional. `EADDRINUSE` fails startup with a clean error naming the port and the serve.json override.

Run it:

```
torus serve
```

Auth is a bearer token in `~/.torus/serve/auth.json` (`{token, createdAt}`, mode 0600). First start mints 32 random bytes (hex) and prints `serve token: <token>` exactly once to stdout; subsequent starts read silently. Every `/run` and `/runs` request requires `Authorization: Bearer <token>`, compared constant-time; anything missing or wrong is 401 JSON. Only `GET /health` is unauthenticated.

Routes:

| Route | Auth | Behavior |
|---|---|---|
| `GET /health` | none | `{ok: true, version}` |
| `POST /run` | bearer | `{agent, task, model?, cwd?, wait?}` — default responds `{delegationId}` immediately; `wait: true` awaits the outcome (10-min cap → 504) |
| `GET /runs` | bearer | delegation list from the shared registry |
| `POST /hook/<slug>` | per-trigger secret (`X-Torus-Secret`) | webhook fire — see [Webhooks](#webhooks) |

Agent/model validation is roster's own pre-flight: an unknown agent or invalid model returns 400 naming the reason and spawns nothing.

Trust boundary: delegations inherit the serve process environment — provider credentials included — so the bearer token is the entire boundary; anyone holding it can spend the account's models. Bind stays loopback by default. `TORUS_SERVE=0` is a kill switch: startup refuses, the launcher exits 1.

## Scheduled triggers

`triggers` in serve.json schedules time-based delegations — no cron syntax, just an interval in minutes:

```json
{
	"triggers": [
		{
			"name": "nightly-status",
			"everyMinutes": 720,
			"agent": "builder",
			"task": "Summarize the fleet's runs from the last 12 hours.",
			"model": "primary"
		}
	]
}
```

Fields: `name` (unique slug — lowercase letters, digits, hyphens), `everyMinutes` (integer ≥ 5), `agent` (must be a delegatable roster agent), `task` (non-empty), `model` (optional; roster chain shorthand or exact model id).

Caps and validation, enforced at startup:

- at most 8 triggers per serve.json;
- an entry that is invalid in any way — bad name, non-integer or too-short interval, unknown agent, empty task, wrong-typed model, duplicate name — refuses startup with an error naming the trigger and the field. Fail loud, fix the file. A missing or empty `triggers` array is fine and schedules nothing.

Behavior:

- each trigger runs one unref'd `setInterval` at its own cadence — no global timer, no catch-up stampede on boot;
- a firing goes through the same path as `POST /run`: roster pre-flight (unknown agent → refused, no spawn), `srv-` handle tagging, registry record, fleet visibility;
- a tick skips while that trigger's previous run is still active — the skip is per-trigger, so a slow `nightly-status` never starves `hourly-build`;
- `lastFired` per trigger persists to `~/.torus/serve/triggers-state.json` (atomic write) after every fire attempt, so restarting the server inside the interval does not re-fire — and a trigger whose persisted timestamp is already past the interval fires on the next tick after restart;
- all intervals clear on server shutdown (SIGINT/SIGTERM); in-flight runs finish on their own.

## Webhooks

Any trigger can also be fired over HTTP: add a `webhook` block and the trigger gains a secret-authenticated `POST` endpoint whose JSON body is rendered into the task.

```json
{
	"triggers": [
		{
			"name": "issue-hook",
			"everyMinutes": 720,
			"agent": "builder",
			"task": "Triage issue {{payload.issue}} titled {{payload.title}}.",
			"webhook": { "path": "/hook/issues" }
		}
	]
}
```

Validation (startup, fail loud like the rest of `triggers`): `webhook.path` must be unique across triggers, must start with `/hook/`, and the remainder must be a slug (lowercase letters, digits, hyphens). The scheduled side is unaffected — a webhook trigger still fires on its `everyMinutes` cadence, and webhook fires do not touch the schedule's `lastFired` bookkeeping: the two paths run independently.

### Secret lifecycle

Each webhook trigger gets its own secret — 32 random bytes (hex), minted at first start, stored in `~/.torus/serve/triggers-state.json` beside the trigger's `lastFired`, and printed exactly once to stdout (same pattern as the bearer token):

```
webhook secret for issue-hook: 3f9a1c…64 hex chars
```

Restarts read the stored secret silently, so the secret (and any integrations using it) survives restarts. To rotate, delete the trigger's entry in triggers-state.json — the next start mints a fresh secret (and the trigger's `lastFired` resets).

### Calling a webhook

Valid:

```console
$ curl -X POST http://127.0.0.1:4747/hook/issues \
    -H "X-Torus-Secret: <secret>" \
    -H "Content-Type: application/json" \
    -d '{"issue": 42, "title": "build fails on arm64"}'
{"delegationId":"0e8d…"}
```

Wrong secret:

```console
$ curl -X POST http://127.0.0.1:4747/hook/issues -H "X-Torus-Secret: nope" -d '{}'
{"ok":false,"error":"unauthorized"}
```

The response is fire-and-ack: `{delegationId}` comes back as soon as the run is registered — there is no wait mode. Everything else maps plainly: wrong/missing secret → 401, unknown path → 404, non-POST → 405, body over 64 KiB → 413, malformed JSON → 400.

### Payload templating

- The task may reference body fields as `{{payload.<field>}}`; dotted paths (`{{payload.user.name}}`) traverse objects.
- Values render **JSON-stringified** — `42`, `"quoted"`, `{"nested":true}`. A payload is data: stringification preserves type and structure and keeps values from being interpreted as anything else.
- Values nested deeper than 8 levels render `"[truncated]"`.
- Missing fields render empty.
- Body cap: 64 KiB (413 beyond).

### Concurrency

Webhooks are explicit events: **every request fires a new delegation**, even if the same trigger's previous run (scheduled or webhook) is still active. The skip-while-active gate exists for timer ticks only — a webhook request is a distinct ask and always lands. Fire rate is therefore your caller's discipline; there is no queueing or dedup.

### Security posture

The per-trigger secret is the trust boundary: anyone holding it can make the trigger's agent run its (payload-templated) task with your models. The payload is rendered as data, but the templated task itself is still acted on — see the serve section of [SECURITY.md](../SECURITY.md) for the full picture (bearer boundary, prompt-injection residual, bind exposure). Bind stays loopback by default; exposing webhooks beyond localhost means putting secrets on a network — prefer a TLS-terminating reverse proxy if you must.

## ACP agent (`torus acp-agent`)

`torus acp-agent` serves torus as an Agent Client Protocol v1 (stable) agent over stdio, so ACP-speaking editors (Zed, JetBrains) can drive it: newline-delimited JSON-RPC in on stdin, out on stdout — stdout is protocol-only, logs go to stderr. Spec pin (same as the consume half in `extensions/acp/index.ts`): github.com/agentclientprotocol/agent-client-protocol, docs/protocol/v1/ (repo formerly zed-industries), accessed 2026-10-09; initialization.mdx blob ea16b093. No `@agentclientprotocol/sdk` — the same node primitives as `extensions/rpc.ts`. The launcher intercepts the subcommand before the pi passthrough (serve pattern): the agent process is the surface, never an extension inside an engine session.

Wire flow: `initialize` → `session/new` → `session/prompt`, plus `session/update` notifications streamed during a prompt.

| Method | Behavior |
|---|---|
| `initialize` | `{protocolVersion: 1, agentCapabilities: {loadSession: false, promptCapabilities: {embeddedContext: false}}, agentInfo: {name: "torus", version: <repo version>, title: "torus"}, authMethods: []}` |
| `session/new` | spawns a **fresh headless engine child** (one per ACP session, `--mode rpc` plus the canonical child extension set — no persona file, no `--model`; the editor drives the default torus engine) → `{sessionId: <opaque id>}`. `cwd` from params (fallback: the agent's cwd); `mcpServers` ignored — torus advertises no `mcpCapabilities` |
| `session/prompt` | text blocks concatenated into one task → the engine child's events stream back as `session/update` (below); when the run settles → `{stopReason: "end_turn"}` |
| `session/cancel` (notification) | kills that session's engine child; the pending prompt (if any) settles `{stopReason: "cancelled"}` |
| `session/load` | JSON-RPC error `-32601` method-not-found — torus children are fresh-per-session; `loadSession: false` at initialize already gates it client-side |
| anything else (`fs/*`, `terminal/*`, …) | JSON-RPC error `-32601` method-not-found — capability-gated off at initialize (clientCapabilities from the editor govern; torus simply does not implement them) |

Any `session/*` request before `initialize` answers `-32002` — the LSP-style ServerNotInitialized code, borrowed by convention (ACP itself does not define one). Engine-child event mapping: assistant `text_delta` → `agent_message_chunk` (one `messageId` per prompt turn); `tool_execution_start` → `tool_call` (`status: "pending"`, `kind: "other"`, title = tool name) followed by `tool_call_update` `in_progress`; `tool_execution_end` → `tool_call_update` `completed` (`failed` on engine error); every other engine event (session, message_start/end, auto-retry, compaction) is omitted — the editor sees the stream, not the transcript. An engine child that dies mid-prompt settles the prompt request with a JSON-RPC error (`-32603`) naming the failure — no hang, and no trailing `agent_message_chunk`: the error is the whole surface for a dead child. A second `session/prompt` while one is in flight for that session answers `-32602`.

Shutdown: EOF on stdin kills every engine child and exits 0 (SIGINT/SIGTERM do the same). Cancellation is kill-shaped on purpose — `session/cancel` SIGTERMs the session's child rather than steering an abort, so a cancelled prompt never leaves work running. Trust boundary: the editor process already controls spawning torus, so ACP adds no auth of its own (`authMethods: []`); the engine children inherit the agent process environment — provider credentials included — exactly like every other torus child.
