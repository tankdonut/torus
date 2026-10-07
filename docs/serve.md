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

Coming.
