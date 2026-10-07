# Security policy

torus is a coding-agent harness: it runs a language model with tool access — files, shell, network — on your machine. This page states what torus defends against, what it does not, and how to report problems. The full tool, command, and environment-variable catalog is [docs/extensions.md](docs/extensions.md).

## Threat model

- **Untrusted repository content.** Everything an agent reads — source, docs, test fixtures, issue text pasted into a prompt — is untrusted input. The standing risk is prompt injection: content crafted to steer the agent into exfiltrating data, mutating files outside the task's scope, or talking its way past its guards. torus assumes any readable file may be the attacker's channel.
- **Delegated subagent output.** Children (`/explorer`, `torus_fanout` / `torus_chain` steps, team members) run in their own sessions; their reports land in the parent conversation as follow-up messages. A child that read injected content can relay it. Parent sessions frame delegation results as data, but nothing authenticates a report's origin.
- **Agent-writable config consumed by trusted processes.** Several files under `~/.torus/` and `~/.pi/` are writable by the agent's bash/write tools and are later read by torus or the engine as configuration or instructions — see [Trust handoffs](#trust-handoffs). Anything the agent can write, an injected instruction can eventually write.
- **Prompt injection between team members.** Team members write reports to mailbox files (`~/.torus/teams/<id>/mailboxes/`); the lead reads outbox content verbatim into its own context. One agent's output is the next agent's untrusted input.

## Guard inventory

- **Context guards** — [extensions/guards/index.ts](extensions/guards/index.ts). Always-on (`TORUS_GUARDS=0` disables): bare `cat` / `head` / `tail` file dumps in bash are blocked with a pointer to the read tool; bash mutations of the memory store (`~/.torus/memory` — mutating git verbs, `--no-verify`, redirects, file mutations) are blocked so memory writes go through `torus_remember` / `torus_forget`; write-tool full rewrites near-identical to disk content (≥ 0.7 line overlap on files ≥ 5 lines) are blocked in favor of targeted edits; oversized tool output is truncated. These are context-integrity guards, not a security boundary.
- **Sandbox** — [extensions/sandbox/index.ts](extensions/sandbox/index.ts). Opt-in (`TORUS_SANDBOX=full`), off by default. Per-command isolation of agent bash calls built on `@anthropic-ai/sandbox-runtime`: writes confined to the workspace (plus tmp and worktree/git plumbing), network restricted to a curated exact-host allowlist plus user additions. Degrades to unsandboxed — with a one-time notice — when the runtime is missing or init fails; bash is never bricked.
- **Approval** — [extensions/approval/index.ts](extensions/approval/index.ts). Trust-on-denial dialogs for the sandbox network allowlist: when sandboxed bash hits a non-allowlisted host, the user chooses Allow once / Always allow (this project) / Deny / Custom host. "Always" decisions persist under `~/.torus/sandbox/<slug>-hosts.json` — outside the sandbox's writable roots, so an agent cannot self-escalate by editing them. Headless sessions auto-deny.

## Trust handoffs

Agent-writable files that trusted processes consume:

| File | Consumed by | Mitigation |
| ---- | ----------- | ---------- |
| `~/.torus/keywords.json` | `extensions/prompts/index.ts` — keyword values are matched against user messages and appended verbatim to the next turn's system prompt | **Partial.** Write-tool paths are matched through the engine's own path resolution (`@`-prefix, `~`, `file://` spellings — canary-tested); it stays user-owned. Bash-side writes (redirects, `rm`, `sed -i`) are not covered. |
| `~/.torus/teams/<id>/team.json` + `tasks.json` | Team tools — `team_status`, `team_task_*`, and `team_respawn`, which revives members from the persisted spec | Partial. Agent and member names are gated to `^[a-z0-9-]+$` before reaching shell command lines or tmux format strings; tasklist updates take a lock and re-read on mtime change. Spec and task text are otherwise consumed as-is. |
| Monitor commands (`monitor_start`) | `extensions/monitor/index.ts` re-executes the stored command string via `bash -c` on an interval for the session's lifetime | **Unmitigated.** Bounded to 5 monitors, ≥ 5 s interval, 30 s per run — but the command executes with the session user's privileges on every tick. |
| `~/.pi/mcp.json` | The pi engine reads MCP server configs; `command` / `args` entries spawn local processes at session start | **Unmitigated by torus.** Engine-owned user config. torus's own registrations (`context7`, `grep_app`) are remote URLs registered in-session — no local spawn. |

## Serve (headless listener)

`torus serve` exposes delegations over HTTP ([docs/serve.md](docs/serve.md)). Threats specific to the listener:

- **Unauthenticated access to `/run`.** Anyone reaching the port can spend the account's models. Mitigation: a bearer token (32 random bytes, 0600 file, constant-time compare) guards every route except `GET /health`, and the default bind is loopback — reaching the port at all requires local access. `TORUS_SERVE=0` is a kill switch.
- **Webhook secret leak = arbitrary task fires.** Each webhook's `X-Torus-Secret` is that endpoint's entire trust boundary: holding it lets a caller fire the trigger's task on demand, and the templated task is still acted on by an agent with the process's credentials. Payload fields render JSON-stringified into the task (`{{payload.x}}`), so bodies stay data rather than free-form task text — but that limits the blast radius, it does not eliminate it.
- **Payload → prompt injection (residual).** Webhook bodies are untrusted input that lands inside agent prompts; stringification preserves type but does not neutralize instructions hiding in string values. Delegated agents carry their standing untrusted-input clauses, and a task like "act on {{payload.body}}" still hands attacker-chosen text to a model with tool access. Prefer payloads that carry identifiers, not prose.
- **Bind exposure.** Loopback by default; a `0.0.0.0` bind puts both the bearer surface and every webhook path on the network with no TLS. That is an explicit opt-in — treat the tokens/secrets as network credentials in that posture and front the listener with a TLS-terminating proxy.

## Engine and OS boundary

torus does **not** provide:

- **OS-level sandboxing or containment.** The opt-in sandbox confines agent *bash* calls only, and only when `TORUS_SANDBOX=full`. Read, write, edit, and the engine's own filesystem access run unsandboxed; with the sandbox off (the default), bash does too.
- **Secret storage.** API keys live in environment variables and engine config files readable by any process the agent spawns. Nothing vaults or redacts them at rest.
- **Network egress control beyond the opt-in sandbox.** Provider traffic, engine fetches, and MCP connections are not filtered by torus; the allowlist applies to sandboxed bash commands only.

Process isolation, credential protection, and filesystem permissions belong to the host OS; which tools exist and how the model reaches its provider belong to the pinned pi engine (pin in `package.json`, drift-checked at spawn by `runtime/bin/torus.mjs`). For genuinely hostile input, run torus inside a VM or a container you control — the shipped image runs non-root with a self-contained payload ([docs/container.md](docs/container.md)).

## Disclosure

Report vulnerabilities privately via [GitHub security advisories](https://github.com/tankdonut/torus/security/advisories) on this repository ("Report a vulnerability"). torus is a solo-maintained personal project: there is no fixed SLA and no bounty program — reports are triaged and answered as capacity allows, and fixes ship through the normal release flow. Please do not open public issues for suspected vulnerabilities.
