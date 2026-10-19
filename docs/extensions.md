# Extension reference

torus is composed through the `pi.extensions` manifest in `package.json`. Load order is manifest order, and a new extension loads only after you add it there. Delegated children load a child-safe subset via spawn args (see [Child set](#child-set)), so children cannot recurse delegations.

This page covers every entry's purpose, tools (exact names), slash commands, shortcuts, hooks, and env vars. Sources: the extension sources under `extensions/`. `tests/docs-coverage.test.mjs` keeps this file honest: every manifest entry, registered tool name, and `TORUS_*` env read must appear here.

## Reading this file

Each catalog section follows one shape: a purpose line, a tools table, then labeled lines for commands, shortcuts, hooks, env, and interactions. Two cross-cutting guides live elsewhere: [docs/serve.md](serve.md) for the HTTP server and the ACP agent role, and [Child set](#child-set) for what delegated children load.

The cast, defined once so the catalog stays terse:

- **Delegated child**: an engine process the lead session spawns to run one task on a roster agent. Children load the child-safe extension set and cannot delegate further.
- **Persona**: the agent identity the main session wears. One persona per `agents/*.md` file; `alt+p` cycles them.
- **Roster**: the parsed set of `agents/*.md` definitions. Delegation targets and the persona cycle both draw from it.
- **Team member**: a long-lived engine process inside a persistent team. It communicates through file mailboxes and a shared tasklist, not through the parent transcript.
- **ACP agent**: an external agent speaking the Agent Client Protocol. torus consumes them as delegatable children and serves as one itself (`torus acp-agent`).
- **Codemode**: an engine mode where a sandboxed JavaScript script calls tools and non-LLM models, and only the script's output reaches the model. `exposure: "codemode"` hides a tool behind codemode scripts.
- **Engine pin**: the `@earendil-works/pi-coding-agent` version pinned in `package.json`. Every shipped binary carries it.
- **srt**: `@anthropic-ai/sandbox-runtime`, the sandbox runtime the `sandbox` extension builds on.

## Torus-native extensions

### `mcp`

Registers two remote MCP servers in-session via pi's `registerMcpServer`: **context7** (library docs lookup) and **grep_app** (public GitHub code search).

No tools, commands, or hooks. No filesystem or state.

- **Env:** none
- **Interactions:** `/doctor` probes the wiring; loaded into every delegated child

#### Statusline count

The connected-server count renders in the unified `torus` statusline segment (`MCP 2`, beside pi-lsp-client's `LSP N` chip). A server counts only once its `mcp__<server>__<tool>` entries appear in the active tool set: registered-but-down shows `MCP 0` in warning color, connected shows success.

The `ui` extension polls the count on `session_start` and every `turn_start`, plus a short settle-poll after each `session_start`. pi emits no event when a connection comes up, so the poll repaints the count as background connections settle; without it the statusline would read `MCP 0` until the first prompt.

#### MCP spec status

The pinned engine speaks the MCP **2025-11-25** revision (its own docs cite `modelcontextprotocol.io/specification/2025-11-25`, e.g. the server resources page). The **2026-07-28** GA revision is the ecosystem's direction: protocol sessions, the `initialize` handshake, and stream resumability are gone, making stateless servers the default posture. The TypeScript SDK's v2 line (`@modelcontextprotocol/server` + client) implements it, while v1.x is maintenance-only.

torus holds no SDK dependency of its own. When the engine moves to an SDK line speaking 2026-07-28, torus rides the normal `feat(deps)` engine-pin bump. Until then, prefer MCP servers that work stateless-agnostically (most stdio servers do).

#### Exposure policy

Both servers keep `exposure: "direct"`: the lead session uses context7 and grep_app daily, so their `mcp__<server>__<tool>` tools are declared there like built-ins. Delegated children reach MCP only through their `tools:` whitelist globs. `--tools` replaces the whole selection, so a glob like `mcp__grep_app__*` is what makes a registered server callable in that child:

| Persona | MCP access |
| --- | --- |
| `explorer` | grep_app, via the `mcp__grep_app__*` glob |
| `librarian` | context7 and grep_app |
| `builder`, `dreamer`, `looker`, `reviewer` | none (MCP is a researcher surface, and builder's web tools already cover doc lookup) |

If main-session context cost ever justifies slimming, the documented lever is `exposure: "codemode"` (or per-tool `toolExposure` patterns) on `registerMcpServer`, pushing the servers behind codemode scripts. Recorded here, deliberately not pulled yet.

### `providers`

GLM model routing: the model fallback chains every delegation path walks, plus user-configurable chains and alternate providers via `chains.json`.

No tools, commands, or hooks.

- **Interactions:** roster and team-runtime resolve chains through it; the `ui` statusline shows provider availability

#### Model chains

Registers no providers of its own: both chain providers are built into stock pi, so authenticate via `/login zai` and `/login opencode-go` (the gateway also reads `OPENCODE_API_KEY`). Built-in chains: primary `zai/glm-5.3 → zai/glm-5.3-flash → opencode-go/glm-5.3-flash`, fast `zai/glm-5.3-flash → opencode-go/glm-5.3-flash`.

`chains.json` under `TORUS_HOME` (default `~/.torus`) overrides either built-in chain wholesale. Shape `{"primary": ["provider/model", …], "fast": […]}`, read per call so edits apply without a restart:

| Condition | Result |
| --- | --- |
| A tier is a non-empty array of non-empty model ids | That tier is overridden |
| An absent, empty, or malformed tier | falls back to that tier's built-in chain (mixed validity is fine: a valid `primary` beside a malformed `fast` overrides only `primary`) |
| A file that is not valid JSON | Warns on stderr naming the file; both chains stay at the built-in defaults |
| Unknown tier keys | Ignored |

Overridden entries ride the same provider-availability filter as the defaults: a model whose provider is not credentialed is skipped. Agent frontmatter `model:` pins still win over any chain head.

#### Alternate providers

The same file's `providers` map registers compatible endpoints through the engine's `pi.registerProvider`: one entry per server, models addressable in chains as `<provider-name>/<model-id>`.

| Field | Rule |
| --- | --- |
| `baseUrl` | Non-empty |
| `api` | One of the engine's supported ids: `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`, `mistral-conversations`, `bedrock-converse-stream`, `google-generative-ai`, `google-vertex`, `pi-messages` |
| `models` | Non-empty array; each takes a non-empty `id`, optional `name`, and the knobs the engine already knows (`contextWindow`, `maxTokens`, `reasoning`, `input`), defaulted the way the engine's own bare entries default: text-only, no reasoning, zero cost, 128k context, 16k output. Unknown extra fields ignored |
| `apiKey` | Optional; an env ref the engine expands at request time (e.g. `"$OPENROUTER_API_KEY"`) |

A keyless local endpoint needs none: a dummy key equal to the provider name is supplied, the exact trick the pinned engine's own `docs/models.md` compatible-endpoint example uses for Ollama (`{"providers": {"ollama": {"baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama", "models": [{"id": "qwen2.5-coder:7b"}]}}}`, there via the engine's `models.json`, here via chains.json so torus chains can route to it).

An invalid entry (missing/empty `baseUrl`, unknown `api`, empty `models`, a model without an `id`) warns on stderr naming the provider and is SKIPPED: valid siblings still register and the built-in chains hold. A `providers` value that is not an object is ignored the same way, and an entry the engine itself rejects degrades to the same skip. A declared provider counts as available, so its models pass the roster's availability filter without a torus-side credential gate; auth is the engine's to resolve. pi-ai's `KnownProvider` ids ship no `ollama`/`lmstudio`, so for local servers this compatible-endpoint registration IS the mechanism (the engine's separate llama.cpp router path is untouched).

Recipes:

```json
{"fast": ["ollama/gemma3:12b"], "providers": {"ollama": {"baseUrl": "http://127.0.0.1:11434/v1", "api": "openai-completions", "models": [{"id": "gemma3:12b", "name": "Gemma 3 12B"}]}}}
```

```json
{"fast": ["openrouter/z-ai/glm-4.7"], "providers": {"openrouter": {"baseUrl": "https://openrouter.ai/api/v1", "api": "openai-completions", "apiKey": "$OPENROUTER_API_KEY", "models": [{"id": "z-ai/glm-4.7", "contextWindow": 200000}]}}}
```

openrouter is a `KnownProvider`, but registering it here wires the env-ref key without `/login`. Registration runs wherever this extension loads: the main window resolves chain ids and titles; delegated children spawn with the resolved `--model` id and otherwise rely on engine-built-in providers and the engine's own `~/.pi/agent/models.json` endpoints.

### `roster`

The delegation core: parses `agents/*.md` into the roster and spawns the pinned engine as a child per delegation.

| Tool | Purpose |
| --- | --- |
| `torus_roster` | List agents, chains, credentialed providers |
| `torus_delegate` | Run one self-contained task on a roster agent; accepts `agent`, `task`, `handle`, `skills`, `cwd`, `model`; live `renderCall`/`renderResult` |

- **Commands:** `/roster`; one command per agent file. Session-mode `/leader` toggles the persona. Child agents (`/builder`, `/dreamer`, `/explorer`, `/librarian` + alias `/research`, `/looker`, `/reviewer`) delegate the argument text, wait for that session's running delegations to quiesce (10-min cap), and inject the result as a follow-up user message
- **Hooks:** `session_start`: record session id; rehydrate past delegations from the project state dir's logs, with the legacy flat `~/.torus/logs` as fallback
- **Env:** none directly
- **Interactions:** heavy consumer of the shared registry; memory's dream/reflect and team's fanout/chain call `runDelegation()`; prompts, ui, notify, browser, and fleet all consume its state

#### Delegation mechanics

Frontmatter is the agent definition. Each delegation spawns the pinned engine as a child (RPC mode with JSON-mode fallback), walking the agent's model chain on no-work failures. Emits `torus.delegation-start` / `torus.delegation-result` transcript messages, streams per-turn snapshots into the shared registry, and supports mid-run stop (`x`) and steer (`s`).

Start markers reach the parent model's context (custom messages convert to user messages), so background runs pass neutral `announce` text instead of the task preview: a dreamer-directed task ("You are reflecting…") would read there as an instruction. `torus_delegate` passes `announce: false`: the tool block is that call's transcript surface (live `onUpdate` + statusline chip, and call/result lines are mouse regions opening the fleet), so no deferred start marker lands next to the result at completion. Its result details carry `turns`, `usage`, and `delegationId` for the renderer.

`model` takes `primary`/`fast` (chain shorthands, resolved to the chain's first credentialed candidate) or an exact available id. It is validated pre-flight: invalid values reject naming the valid candidates, with no spawn. The walk falls back down the agent's own chain on no-work failures.

`skills` resolves names and paths against the same set the main window loaded: pi's auto-discovered skills plus the **torus payload package's `pi.skills`** (the `repoRoot()`/`TORUS_ROOT` manifest; the launcher loads it via `--extension <payload-root>`, and delegation children get manifest skills only through this resolver since they spawn with bare extension files). Delegation-cwd manifests are deliberately ignored. Everything under those roots passes path containment; everything else is rejected.

### `acp`

External ACP-speaking agents as delegatable children, and torus itself as an ACP agent for editors.

No tools or commands of its own (the serve half is the launcher subcommand `torus acp-agent`).

- **Env:** none directly (`TORUS_HOME` via the shared `torusHome()`)
- **Interactions:** roster's `runDelegation()` dispatches to the `AcpChild` transport (`extensions/acp/index.ts`) when the name resolves in `acp.json`; registry/fleet views show ACP runs like any other delegation. The serve half consumes `RpcChild` (`rpc.ts`), `resolveEngineBin`/`childExtensionArgs` (`engine-child.ts`), and `repoRoot()` (`registry.ts`). Loaded in the main window only, not part of the child set

#### Consume: external agents as children

`acp.json` under `TORUS_HOME` (default `~/.torus`) declares them. Shape `{"agents": {"<name>": {"command": "…", "args": […], "env": {"KEY": "value"}}}}`; `args` defaults to `[]`, and `env` is merged over the inherited child environment. An absent file means no ACP agents and the engine delegation path is untouched. Malformed JSON, a non-object root, or a bad entry warns on stderr and skips only that entry.

Name resolution: an exact name match in `acp.json` **wins over a roster agent** of the same name. The requested name is looked up there before the roster, and a name resolving nowhere is rejected naming both the roster agents and the configured ACP agent set (`torus_roster` and the roster section of the system prompt list configured ACP agents too).

One delegation spawns a fresh child speaking Agent Client Protocol v1 (stable) over stdio. Spec pin: github.com/agentclientprotocol/agent-client-protocol, docs/protocol/v1/ (repo formerly zed-industries), accessed 2026-10-09; initialization.mdx blob ea16b093. No `@agentclientprotocol/sdk` dependency: node primitives mirroring `rpc.ts`'s line-buffered stdio handling.

| Wire step | Behavior |
| --- | --- |
| `initialize` | Empty `clientCapabilities` (fs/terminal unsupported, so the agent cannot lean on torus-side capabilities); a response protocolVersion other than 1 fails the run naming it |
| `session/new` | `cwd` = delegation cwd, `mcpServers: []` |
| `session/prompt` | Settles the run (below) |

**No session/load**: every delegation starts a cold session; there is no resume. `agent_message_chunk` updates concatenate into the final text. `tool_call`/`tool_call_update` surface as `→`/`←` activity lines (completed/failed statuses only) and counts. `plan`, `available_commands_update`, `user_message_chunk`, `agent_thought_chunk`, and other variants are ignored.

Permissions are **fail-closed**: an inbound `session/request_permission` is answered with the `cancelled` outcome and a visible `! permission request denied` activity line; torus never auto-approves.

Run settlement: `stopReason` `end_turn` → ok; `cancelled`, `refusal`, `max_tokens`, `max_turn_requests` → settled not-ok naming the stopReason. A JSON-RPC error response, child death, or stdin close before the response → not-ok with a transport error naming the agent. The child is killed after settling.

ACP agents skip model chains entirely (they run their own models): usage/cost fields are best-effort zeros and the registry model label is `acp/<name>`. Skills are rejected pre-flight (engine-agent surface). Mid-run stop (`x`) kills the ACP child; steer is a no-op stub.

#### Serve: torus as an ACP agent

`torus acp-agent` answers the same protocol as the AGENT over stdio so editors (Zed, JetBrains) can drive torus. The launcher intercepts the subcommand before the pi passthrough (serve pattern) and runs `runAcpAgentRole()` from this module. The agent process is the surface, never an engine session, and stdout is protocol-only (logs to stderr).

| Method | Behavior |
| --- | --- |
| `initialize` | Answers `loadSession: false`, `promptCapabilities.embeddedContext: false`, no `mcpCapabilities`, `authMethods: []` |
| Any `session/*` before `initialize` | `-32002` (LSP-style ServerNotInitialized, borrowed by convention) |
| `session/new` | Spawns a **fresh headless engine child** via `RpcChild` (`--mode rpc` + the canonical child extension set; no persona file, no `--model`) and returns an opaque `sessionId`; `mcpServers` params are ignored |
| `session/prompt` | Concatenates the text blocks into one task and streams the child's events back as `session/update` (mapping below). The engine acks the prompt command at preflight, before the run finishes, and `agent_settled` settles the request → `{stopReason: "end_turn"}` |
| `session/cancel` (notification) | Kills that session's child; the pending prompt settles `{stopReason: "cancelled"}` |
| Engine child death mid-prompt | Settles the prompt with a `-32603` JSON-RPC error naming the failure, with no trailing chunk: the error is the surface, no hang |
| A second in-flight prompt for the same session | Answers `-32602` |
| `session/load` | `-32601` method-not-found: children are fresh-per-session |
| `fs/*`, `terminal/*`, and every other unimplemented method | The same `-32601` method-not-found (capability-gated off at initialize) |

Event mapping: `text_delta` → `agent_message_chunk` (one `messageId` per prompt turn); `tool_execution_start` → `tool_call` (`pending`, `kind: "other"`) + `tool_call_update` `in_progress`; `tool_execution_end` → `tool_call_update` `completed`/`failed`. All other engine events are omitted.

EOF on stdin (or SIGINT/SIGTERM) kills all engine children and exits 0. Full guide: [docs/serve.md](serve.md).

### `prompts`

Builds the system prompt each turn: the active persona's body, the delegation policy (roster list + when to delegate), and any keyword-triggered execution mode.

No tools.

- **Commands:** `/persona-<name>` for every roster agent (one per `agents/*.md`): switch the main session to that persona
- **Shortcuts:** `alt+p` / `alt+shift+p`: cycle personas forward / backward (leader → builder → dreamer → explorer → librarian → looker → reviewer)
- **Hooks:** `session_start`: restore the saved persona and theme; `message_end`: keyword detection on user messages; `before_agent_start`: append persona + policy + armed mode to the system prompt
- **Env:** none read here (`persona-theme.ts` reads `TORUS_THEME_DEBUG` for theme debugging)
- **State:** persona persists per session at `$TORUS_STATE_DIR/persona/<session>.json`; orphans whose session is gone age out after 30 days
- **Interactions:** roster (agent bodies, `personaModel`), ui (statusline refresh), persona-theme (editor border)

Switching persona also switches the session model when the agent's frontmatter pins `model:`; otherwise the session model is untouched.

#### Keyword modes

Typing a keyword in a user message arms a one-shot mode injected into the next turn's system prompt:

| Keyword | Mode |
| --- | --- |
| `deepwork` | Full precision: the outcome is a contract, no scope reduction, no unverified claims |
| `blueprint` | Plan first: survey, write the plan, get approval before any edit |
| `team` | Multi-axis work: orchestrate via `torus_fanout` / `torus_chain` / team tools |

User keywords merge over these defaults via `~/.torus/keywords.json`:

```json
{ "refactor": "REFACTOR MODE: behavior-preserving changes only; tests must stay green." }
```

### `browser`

The fleet browser: a full-viewport TUI overlay listing live and recent delegations plus running team members.

No tools (internal stub definitions exist only to render torus tool calls in replayed transcripts).

- **Commands:** `/torus`: open the browser overlay
- **Shortcuts:** `alt+t`: open the browser
- **Hooks:** `session_start`: publishes the `FLEET_OPENER` global that notify's clickable rows invoke
- **Env:** none
- **Interactions:** registry (delegation records), transcript (replay source), theme-kit

List view: status/model/turns/tokens per run. Detail view: the live action feed, or the full session transcript once done (replays real tool-call components). Scrolling, follow mode, mouse wheel in both TUI modes (raw SGR takeover in regular; host-dispatched `handleMouse` events in fullscreen, where list rows are also clickable), stop (`x`), steer (`s`). Esc backs detail→list only when the list was visited; a strip-click-opened detail returns straight to the TUI.

### `comment-checker`

Comment discipline gate: challenges every comment the model adds in edit and write calls.

No tools or commands.

- **Hooks:** `tool_call`: capture added lines; `tool_result`: append the challenge
- **Env:** `TORUS_COMMENT_CHECKER=0` disables; `TORUS_COMMENT_CHECKER_PROMPT` overrides the challenge text

Captures added lines from edit/write tool calls, detects line comments/docstrings by file extension, and appends a mandatory challenge to the matching tool result. The challenge requires the model to justify or remove each comment.

### `hashline`

Anchored editing: read outputs carry per-line anchors, and edits address lines by those anchors.

| Tool | Purpose |
|---|---|
| `hashline_edit` | Batch edits by anchor: replace/append/prepend ops, ranges, EOF/BOF insertion, delete, rename, opt-in `rebase` |

- **Hooks:** `tool_result`: rewrite read outputs so every line carries a `{line}#{hash}|` anchor
- **Env:** `TORUS_HASHLINE=0` disables; `TORUS_FMT_CMD` = formatter command run after successful edits
- **Interactions:** guards' write-overwrite block and recovery guidance point here by name

`hashline_edit` applies batch edits with staleness detection: a hash mismatch self-heals by reporting current anchors, or remaps moved lines via the opt-in `rebase` flag. Reversed `pos`/`end` auto-swaps, and a missing `op` is inferred. Success returns a full-file anchor map, and successful native `edit`/`write` results carry an anchor-void notice so stale anchors are not reused.

### `interactive`

PTY-backed interactive command execution via `script -qec`.

| Tool | Purpose |
|---|---|
| `interactive_bash` | Run a command that needs interaction: password prompts, REPLs, package-manager confirmations |

- **Hooks:** `session_shutdown`: kill live children
- **Env:** `TORUS_INTERACTIVE=0` disables

In the TUI the child streams into a bordered overlay you can type into (takeover); `ctrl-]` detaches. Headless contexts run to completion synchronously. Line-oriented programs render correctly; full-screen apps (vim/htop) do not, so use plain bash for those.

### `vision`

Lets image-capable models see images.

| Tool | Purpose |
|---|---|
| `look_at` | Load 1–3 local image files (png/jpg/jpeg/webp/gif, ≤4 MB each) into the conversation as base64 image blocks with a goal annotation |

The tool checks the active model's input modalities before attaching (the same signal the engine's own image handling uses): a model without image input would silently drop the attachments, so `look_at` refuses with an error result naming the `looker` agent as the route instead. Zero successful attachments is an error too, so partial failures never read as success.

- **Interactions:** the `looker` roster agent is the designated consumer

### `guards`

Context hygiene and error recovery around tool calls.

No tools or commands.

- **Hooks:** `tool_call`: blocks; `tool_result`: truncation + guidance
- **Env:** `TORUS_GUARDS=0` disables everything; `TORUS_MAX_TOOL_OUTPUT` (default 16000) tunes the cap
- **Interactions:** exports `truncateText` (used by astgrep); documented in AGENTS.md conventions

| Guard | Behavior |
| --- | --- |
| Output truncation | Truncates oversized tool outputs |
| Bare dumps | Blocks bare `cat`/`head`/`tail`/`less`/`more` of absolute file paths; redirects to the read tool |
| Full-file rewrites | Blocks near-identical full-file rewrites via write; redirects to `hashline_edit`/edit |
| Memory-store bash | Blocks bash mutations of the torus memory store (mutating git verbs, `--no-verify`, redirects, file writes); redirects to `torus_remember`/`torus_forget`/`/reflect` |
| Retry guidance | Appends structured retry guidance to failed edit results and JSON parse failures |

### `sandbox`

Opt-in per-command isolation for agent bash calls, built on srt (`@anthropic-ai/sandbox-runtime`, pinned in `package.json`).

No tools or commands.

- **Hooks:** `session_start`: statusline chip `sbx:on`/`sbx:off`/`sbx:down`; `tool_call`: rewrite the bash command (fail-closed blocks); `tool_result`: annotate sandbox violations onto stderr; `session_shutdown`: chip clear + manager reset (kills socat bridges + proxies)
- **Env:** `TORUS_SANDBOX=off|full` (default off; opt in with `TORUS_SANDBOX=full`); `TORUS_SANDBOX_WRITABLE` extra writable roots, colon-separated; `TORUS_SANDBOX_NET_ADD` appends allowed hosts; `TORUS_SANDBOX_NET_ONLY` replaces the allowlist
- **Interactions:** `/doctor` reports mode/deps/state; delegated children confine to their own worktree cwd

#### Boundaries and failure modes

With `TORUS_SANDBOX` in the on family, every bash tool call is rewritten through bwrap (Linux) or Seatbelt (macOS):

| Boundary | Rule |
| --- | --- |
| Writes | Confined to the workspace + `/tmp` + `TORUS_SANDBOX_WRITABLE` extras + git plumbing (the repo's git common dir and the torus worktrees root; linked worktrees share refs/objects with the main repo) |
| Network | Restricted to a curated exact-host allowlist (npm/PyPI/crates/GitHub/Golang proxy hosts; keeps installs and git-over-https working) |

`interactive_bash` and user `!` commands are never wrapped. Fail-closed: a wrap failure blocks the call with an actionable reason. Missing bwrap/socat or init failure degrades to unsandboxed with a one-time stderr notice (`TORUS_SANDBOX=off` silences). `fs`-only mode is not expressible with srt (network restriction is schema-coupled), and unknown `TORUS_SANDBOX` values default to off with a one-time notice.

Known srt gaps: unreliable signal/exit-code propagation (upstream #602/#603/#635/#610), no SIGWINCH on Linux (#642), macOS raw-mode TUIs need `allowPty` (#480).

#### srt behavior notes

These notes describe the pinned `@anthropic-ai/sandbox-runtime`; `package.json` carries the exact pin.

- **User namespaces:** A Linux sandboxed command cannot create user or mount namespaces. Commands that sandbox themselves that way (rootless podman, Chromium's namespace sandbox, a nested bubblewrap) fail with `EPERM`. The upstream opt-out is `allowNestedUserNamespaces`, which torus does not expose.
- **Write precedence:** A `denyWrite` entry takes precedence over a nested `allowWrite`.
- **Credential files:** With `credentials.files` configured, an `allowRead` or `allowWrite` entry covering that path grants nothing.
- **aws-vault:** Its keyring backends need D-Bus and gpg sockets, which the sandbox blocks. Run `aws-vault exec` outside sandboxed bash (`interactive_bash` is never wrapped) and let only the resulting environment reach the sandbox.
- **git over SSH:** Pushes and fetches over SSH need the ssh-agent socket, a Unix socket the sandbox blocks; on Linux such sockets cannot be allowlisted by path. Use https remotes with the gh CLI.
- **Upstream watch items:** srt #738 (Node's built-in fetch ignores the sandbox proxy); srt #714 (masked credentials can round-trip via request bodies); srt #654 (`/tmp/claude` is shared across concurrent sandboxes).

#### SSH commit signing relay

Sandboxed `git` cannot reach `ssh-agent` (Unix sockets are blocked; see the srt behavior notes), so ssh-format commit signing fails inside the sandbox unless the opt-in relay is on.

- **Enable:** user-level policy `{"torus":{"sandbox":{"sign":{"relay":true}}}}` in the settings file resolved from `$PI_CODING_AGENT_DIR` (default `~/.pi/agent/settings.json`), or `TORUS_SANDBOX_SIGN=relay`. A trusted project layer may enable it too; `TORUS_SANDBOX_SIGN=off` forces it off.
- **Requires:** an agent on the host (`SSH_AUTH_SOCK`). With the private key in the agent, `user.signingKey` can reference the public key.
- **Mechanics:** wrapped `git` commands carry `GIT_CONFIG_*` env naming a generated wrapper as `gpg.ssh.program` and setting `gpg.format` to `ssh`; whether commits sign at all stays with the user's own `commit.gpgsign`. The wrapper relays the buffer to a host-side watcher that signs with the real agent via `ssh-keygen -Y sign` and returns the detached signature, so key material never enters the sandbox. Relay state lives on the session's private scratch dir and is torn down when the session ends.
- **Tradeoff:** the relay is a signing oracle for sandboxed code, equivalent in exposure to a forwarded agent socket. That is why it is opt-in.
- Push and fetch over SSH remain blocked; https remotes plus the `gh` CLI are the supported path.

### `approval`

Trust-on-denial UX for the sandbox network allowlist.

No tools or commands.

- **Hooks:** `session_start`: ctx capture
- **Env:** `TORUS_APPROVAL=0` leaves the approval slot absent, so unmatched hosts deny exactly as before the extension existed

When a sandboxed command contacts a non-allowlisted host, an interactive dialog offers Allow once / Always allow (this project) / Deny / Custom… (typed `host` or `*.domain` ⇒ allowed this session). "Always" persists to `$TORUS_STATE_DIR/sandbox-hosts.json`, outside the sandbox's writable roots, so the agent cannot self-escalate. It applies live (`updateConfig`) plus in fresh sessions (persisted hosts allow silently).

Headless sessions and delegated children auto-deny; dialog timeout 120 s ⇒ deny; in-flight dedup + per-session cache (denies sticky). Consumed by `sandbox` via the `globalThis` slot `torus.approval.v1` (resolved lazily).

### `doctor`

One-command health check.

- **Commands:** `/doctor`: engine pin drift vs the `package.json` pin, provider auth (`auth.json`), default provider, MCP wiring, LSP binary, `sg` (ast-grep), tmux, git identity, `~/.torus` writability, and a read-only `state-layout` scan for legacy flat-state residue; each check reports ok/warn/fail

No tools or hooks.

- **Interactions:** dynamic-imports `engine-child` + `registry`. Not loaded into children

### `astgrep`

Structural (AST) code search and rewrite through the `sg` binary; patterns with `$VARS` metavariables survive formatting drift.

| Tool | Purpose |
|---|---|
| `torus_astgrep` | Structural search or rewrite (pattern, language, paths, rewrite) |

- **Interactions:** `/doctor` reports the binary; imports `truncateText` from guards

Graceful error when `sg` is missing.

### `sessions`

Full-text search *inside* historical pi session transcripts, not filenames.

| Tool | Purpose |
|---|---|
| `torus_sessions` | Search transcript contents (query, limit); returns session id, date, project dir, and a match snippet per hit |

- **Interactions:** `findSessionFile(sessionId)` export resolves a session's transcript path (memory's idle reflection uses it to feed the current session's own activity)

Default root `~/.pi/agent/sessions`. Resume via pi's `/resume` or `pi --session-id <id>`.

### `monitor`

Periodic command watcher: runs a shell command on an interval, hashes its output, and desktop-notifies + stops when the output changes or the command fails.

| Tool | Purpose |
| --- | --- |
| `torus_monitor` | Start a monitor (name, command, intervalSec ≥ 5, stopOn) |
| `torus_monitor_stop` | Stop one monitor (name) |

- **Hooks:** `session_shutdown`: stop all
- **Env:** `TORUS_MONITOR=0` disables

Stops on `stopOn: change` (output hash changed) or `stopOn: fail` (command failed). History lands in `$TORUS_STATE_DIR/monitors/<name>.log`; at most 5 concurrent monitors (oldest evicted). When a monitor fires, a `torus.monitor-fired` transcript notification also lands in the session (name, reason, exit code, output tail; rendered like the fleet markers) and wakes the model: an idle session starts a turn, a streaming one gets it queued as a follow-up.

### `fleet`

The ambient fleet strip: a TUI statusline widget showing running delegations + external runs with spinners, per-entity colors, turns/tokens/age. Renders nothing when idle.

No tools or commands.

- **Shortcuts:** `alt+1`..`alt+9`: open the fleet browser directly in the Nth running agent's detail view
- **Hooks:** `session_start`: install the `torus-fleet` widget
- **Interactions:** `registry.ts` + `fleet/theme-kit.ts` (shared presentation kit also used by browser, notify, roster); opens the browser overlay via the shared `FLEET_OPENER` slot (the same path notify's clickable transcript lines use)

Rows are numbered oldest-running-first (numbers stay stable while agents run) and are the primary selector. Clicking a row opens the detail view, but only under fullscreen TUI mode: pi's regular inline mode enables no mouse reporting at all, so the strip advertises clicks only when `tui.mode === "fullscreen"`. External-run rows open the plain list. Shows up to 5 running delegations.

### `team`

Multi-agent orchestration: parallel fan-out, sequential chains, and persistent teams with long-lived members.

| Tool | Purpose |
| --- | --- |
| `torus_fanout` | 2–8 parallel delegations (per-run `model` override accepted) |
| `torus_chain` | 2–6 sequential steps, each fed the prior output, bounded to 4k chars (per-step `model` override accepted) |
| `team_create` | Create a persistent team (1–8 members); accepts `selfClaim` |
| `team_status` | Team state, orphaned tasks, stale tasks |
| `team_msg` | Message a member or `*` |
| `team_task_create` | Add a task (optional `dependsOn`) |
| `team_task_list` | List tasks (blocked tasks tagged `[blocked by …]`) |
| `team_task_update` | pending/in_progress/completed/deleted + reassign; `in_progress` refused while dependencies are unmet |
| `team_delete` | Graceful shutdown; keeps logs + mailboxes |
| `team_respawn` | Revive stopped members from spec |

- **Env:** `TORUS_TEAM_NOTIFY=0` disables the wake-up marker; `TORUS_TASK_STALE_MIN=<minutes>` sets the stale-task threshold (default 30; invalid values fall back to 30)
- **Interactions:** `team-runtime.ts` (spawn/mailbox/tasks), registry (team records → fleet/browser visibility)

#### Fan-out and chains

`torus_fanout` and `torus_chain` are thin wrappers over roster's `runDelegation`. Fan-out combines its start markers into one for the batch, and coalesces result markers: completions within a 5s window merge into one combined `torus.delegation-result` listing every run id, flushing early once the whole batch settles.

#### Persistent teams

Persistent teams spawn long-lived RPC-mode engine members with per-member file mailboxes (inbox/outbox), a shared locked tasklist (`tasks.json`), and a team spec on disk under the project store (`state/--<project>--/teams/<id>/team.json`, stamped with the creating project). A global id→project index at `~/.torus/teams.json` lets member children and explicit ids resolve teams from any cwd; pre-namespacing flat teams migrate on first spec rewrite, and default team resolution stays project-scoped.

A supervisor loop drives mail-driven cycles, model-chain fallback, and outbox delta logging. A member turn slower than 10 minutes keeps waiting: timeout is never treated as engine death. Teams rehydrate from disk on parent restart, and rehydrated log-only records defer to live run beacons, so a resume never shows a running member as a duplicate ✗ failed row.

Task dependencies: tasks may declare `dependsOn` (prerequisite task ids). Create rejects unknown ids, self-references, and cycles naming the chain. A task with an unmet existing dependency is blocked: `team_status` lists what it waits on, and claiming it is refused naming the blockers. Unknown dependency ids never block (they cannot complete, so create-time validation is the gate).

`team_status` surfaces two problem states (read-only; no timers, no auto-reap):

| State | Definition | Handling |
| --- | --- | --- |
| Orphaned | In-progress rows whose member has stopped | Crashed members never leave work lingering invisible; `team_task_update` reassigns or completes it |
| Stale | An in-progress row under an idle (not stopped, not working; stopped stays the orphan case, never both) member whose tasklist clock (`updatedAt`) has not moved for more than `TORUS_TASK_STALE_MIN` minutes | Renders a read-only `stale:` line naming the elapsed minutes and the nudge (`team_msg`) or release (`team-task`/`team_task_update`) path |

#### Transcript markers and wake-ups

Member lifecycle reaches the parent transcript. Spawning emits one combined `torus.delegation-start` for the batch. Stop/crash emits `torus.delegation-result`, and `team_delete` suppresses the per-member markers and toasts, emitting one combined result marker and one desktop toast for the batch. Each member is onboarded into the delegation registry: delegation log, run beacon, and fleet-overlay stop/steer, with the registry controls bridged onto the team mailbox/control slots.

All delegation/team markers are sent with `triggerTurn: false` (the engine's flag for whether a transcript message starts a model turn): they append at the turn boundary in order instead of being steered into the model's mid-run context. Live start feedback rides the tool `onUpdate` and an immediate statusline chip. The wake-up marker is the deliberate exception (`triggerTurn: true`).

Wake-ups are per member. When a member goes idle (or stops non-deliberately) while holding an unread outbox report (bootstrap "ready" handshakes don't count), its episode queues. All pending episodes flush as ONE combined `torus.team-wake` marker per team after a 10s coalescing window, rendered like the fleet markers; a member back to working before the flush defers to its next episode. The marker quotes each member's newest outbox tail and starts a run in an idle session: a queued user follow-up alone would strand pending episodes when the prior turn was interrupted. `TORUS_TEAM_NOTIFY=0` disables it.

Why the window: members finishing within minutes would otherwise queue one follow-up each, draining one turn boundary apart, every one a wasted model turn.

#### Member task self-claim (opt-in, default off)

`team_create` accepts `selfClaim` (persisted on the team spec). When on, each member's objective gains exactly one sentence teaching the claim protocol: members run `node runtime/bin/team-task.mjs <subcommand>` from the torus checkout root. Subcommands: `list <teamId>`, `claim <teamId> --as <name>`, `complete <teamId> <taskId> --as <name> [--force]`, `release <teamId> <taskId> --as <name>`; JSON-line output, exit 0 success / 1 refusal.

Members load no team tools, so that CLI, invoked via their bash, is their only structured path to the tasklist. The CLI is a second writer family over `tasks.json` and routes every write through the same directory-lock + mtime-CAS `updateTasksFile` as the lead's tools, so simultaneous claims cannot both win (the first pending, unassigned, unblocked task by id order is claimed, conditions re-checked inside the lock). `complete`/`release` verify the caller is the assignee (`--force` overrides `complete`). Default-off teams are unchanged: no sentence, byte-identical team spec.

### `notify`

Transcript rendering of delegation lifecycle events.

No tools or commands.

- **Hooks:** message renderers ×3 (the two delegation markers + `torus.memory-applied`)
- **Interactions:** registry `FLEET_OPENER`, browser, theme-kit

`torus.delegation-start` / `torus.delegation-result` render as one-line transcript entries ("▶ explore delegated · <preview>", "✓/✗ explore finished · alt+t …"). Both are wrapped in mouse regions that open the fleet browser focused on that delegation, and the `torus_delegate` call/result block reuses the same wrapper: result lines focus the run via the details `delegationId`; the call line opens the fleet list. Also renders `torus.memory-applied`, the ✿ dream/reflect summary line emitted by the memory extension after proposals are applied.

### `memory`

Durable, git-backed memory store at `~/.torus/memory` (entries + `profile.md`, auto-init git repo).

| Tool | Purpose |
| --- | --- |
| `torus_remember` | Add an entry (topic/content/tags/scope: project\|global\|profile/force/pinned); blocks near-duplicate topics unless `force: true` (updates the existing entry in place) |
| `torus_recall` | Query the store (query/scope) |
| `torus_memories` | List entries; warns about unparseable ones |
| `torus_forget` | Delete by exact filename; git history keeps it recoverable |

- **Commands:** `/reflect [focus]`: manual distillation; `/profile`: show the user profile
- **Hooks:** `agent_settled`: dream + schedule reflection; `context`: inject memory block; `session_compact`: re-arm injection
- **Env:** `TORUS_REFLECTION=0` disables idle reflection; `TORUS_REFLECT_TURNS=<n>` reflects after N settles since the last reflect (0 = idle-only, default 12); `TORUS_DREAMING=0` disables dream consolidation
- **Interactions:** sessions (transcript location), roster (dream/reflect delegations)

#### Injection order

Injects profile + up to 6 scoped entries into context once per session (re-armed after compaction), in this order:

1. Pinned entries, always first
2. The current session's own entries (marked `[session]`, restored when injection re-arms after compaction)
3. Entries scored relevant to the latest user message (lexical hybrid: whole-query topic match, tag-exact boost, 30-day recency nudge, newest-first tiebreak)
4. Newest entries filling the remaining slots

Tags are sanitized and content is capped (8 KB).

#### Dreams and reflection

Dreams (≥6h interval) and idle reflection (10 min idle or N settles since the last reflect, re-armed after each; fed that session's own transcript and delegation logs) delegate to the read-only `dreamer` agent and apply its validated proposals parent-side: entries capped per run, deletes constrained to bare filenames, profile lines capped. Both announce with a neutral start marker, never the dreamer-directed task text, and the reflect task opening matches what triggered it (idle vs turn threshold).

Every applied dream/reflect run emits a `torus.memory-applied` transcript line (✿ per-kind counts with entry topics and deleted filenames) so the session sees what changed. Dream scheduling ignores the dreamer's own delegation logs, so dreams cannot self-trigger.

#### Store versioning

The extension commits as `torus <torus@local>` (any other author in `git log` is an off-path write), its git spawns carry `TORUS_MEMORY_COMMIT=1`, and a store-local pre-commit hook (`core.hooksPath=.githooks`) refuses commits without it: agent-run `git commit` on the store fails.

### `goal`

Per-session standing objective, stored at `$TORUS_STATE_DIR/goal/<session>.json`.

| Tool | Purpose |
|---|---|
| `goal_complete` | Mark the objective complete with evidence (summary) |

- **Commands:** `/goal <text>` (set), `/goal note <text>`, `/goal pause`, `/goal resume`, `/goal off|clear`; bare `/goal` shows status
- **Hooks:** `session_start`: record session id, refresh chip; `context`: inject goal block

Active goals inject into every turn's context (goal + notes + completion instruction) and show as a chip in the unified `torus` statusline segment (`▶ <head>` warning, `⏸` dim when paused; nothing when unset, so there is no permanent no-goal chip).

### `todo`

Session-scoped todo list at `$TORUS_STATE_DIR/todo/<session>.json`.

| Tool | Purpose |
|---|---|
| `torus_todowrite` | Update the full list (id/content/status/priority, ≤30 items); merge semantics below |

- **Hooks:** `session_start`: restore chip; `context`: inject todo block

The write merges against the stored list: incoming items match prior ones by id, then by normalized content (paraphrases update instead of duplicating). Completed items omitted from a write are retained while the list has open items; once every stored item is completed the list closes itself, so the next write starts a fresh list (re-including an item by id still carries it across the boundary, and rewriting a stored item back to a live status reopens it). Pending items omitted are removed as intentional, `status: "dropped"` removes an item explicitly, and an empty write clears the list. Items carry stable ids (`t1`, `t2`, ...) shown in the context block, which injects the full list, completed items included, and collapses to a single closed line once everything is complete. The same file keeps monotone `tracked`/`donePeak` counters, so the ●done/○pending statusline chip (and the `/ tracked` summary) never regresses when completed items go missing from a rewrite.

### `work`

Plan-execution state: binds a torus-plan plan file to a session so execution survives compaction and restarts.

| Tool | Purpose |
| --- | --- |
| `work_start` | Bind a plan: absolute path or unique stem/prefix under the project's plans dir (`$TORUS_STATE_DIR/plans`, legacy `~/.torus/plans` still read). Approval gate: refuses unless the plan carries a column-zero `Approval: <user/date>` line or the recorded escape `Approval: skipped (--yes)`; `assumeApproved` binds an unmarked plan and journals `approval: "assumed"` in the start row. Creates or rebinds (rebinding resumes, elapsed spans runs). Parent sessions only |
| `work_note` | Append a typed ledger row (event: task-done\|verified\|blocked\|wave-gate\|note\|converge, + wave/task/verification/evidence/verifiedBy) and return the tail. With an explicit `slug` any session appends: slug resolution is exact → unique prefix → unique substring, with ambiguity/miss errors listing candidates so a paraphrased dispatch slug costs at most one retry. Delegated builders journal gotchas this way, and rows carry the writer's session id |
| `work_complete` | Complete the work (summary). Machine gate: refuses while any column-zero checkbox is unchecked or the plan is missing, then records elapsed and stops the per-turn block. Parent sessions only |

- **Hooks:** `context`: inject work block for the newest active binding of the session
- **Interactions:** delegated child engines load the extension but get only `work_note`: `work_start`/`work_complete` skip registration when `TORUS_ENGINE_CHILD=1`, so children can journal into a plan's ledger but never rebind or complete work

State at `$TORUS_STATE_DIR/work/<slug>.json` (plan↔session binding, status, elapsed); evidence in an append-only `$TORUS_STATE_DIR/work/<slug>.ledger.jsonl`. Progress is never cached: it is parsed live from the plan's column-zero checkbox rows (`- [ ]` / `- [x]`), so the plan file stays the single source of truth. While active, every turn injects a work block (plan path, done/total, next unchecked task, ledger tail).

Companion skill: `torus-execute` (writes checkboxes in the plan, journals via `work_note`, ends via `work_complete`). Plan coordinates (waves, tasks, slugs) stay in the plan and ledger; landed commits and code comments never carry them.

### `compact`

Folds the torus session context into the engine's compaction summary, so the goal, work, todo, and memory context blocks survive compaction instead of vanishing with the summarized turns.

- **Hooks:** `session_start`: record session id, repaint context chip; `message_end` + `session_compact`: repaint context chip; `session_before_compact`: generate a summary that carries the four context blocks (goal, work, todos, memory) as summarization focus
- **Interactions:** registered last in `pi.extensions` because hook composition across extensions is last-wins: this extension generates the whole summary itself and returns it as the compaction result, since the engine has no way for an extension to mutate the built-in summary's custom instructions

The hook fires for every compaction reason (`/compact`, context threshold, overflow recovery). When all four blocks are empty (no active goal, work, todos, or memories) the handler is a no-op and the engine's default compaction runs unchanged; the same fallback covers a failed summary call, and the handler never cancels a compaction.

The extension also owns the live context-usage chip: a `torus:ctx` statusline segment reading exactly `ctx NN%` (a rounded percentage of the model's context window, no thresholds, colors, or raw token counts), repainted on `session_start`, every `message_end`, and `session_compact`. When usage is unavailable (no active model, or the token estimate still unknown right after compaction), the segment is cleared via the same `undefined` convention the `torus:todo` chip uses.

### `worktrees`

Git-worktree lifecycle under one canonical root outside the repo (`~/.torus/worktrees/--<repo>--/<branch>`; the legacy bare-basename layout still resolves for existing worktrees).

| Tool | Purpose |
| --- | --- |
| `worktree_create` | Create a worktree (branch, base, setupCommand); sets up dependencies (explicit command or detected: go/npm/cargo/uv/pip) |
| `worktree_merge` | Merge back (branch, subject, strategy squash\|ff, keep, mainBranch): rebase → squash (or opt-in ff) → tree-identity proof → only then branch delete, with clean conflict aborts |
| `worktree_remove` | Remove (branch, force, teardownCommand); never deletes the branch |

- **Env:** `TORUS_WORKTREES_ROOT` (root override)
- **Interactions:** registration is skipped entirely when `TORUS_ENGINE_CHILD=1` (parent sessions only)

A `torus:worktree` statusline chip shows the active branch.

### `exit`

`/exit` as a faithful alias of pi's `/quit`.

- **Commands:** `/exit`

Same graceful shutdown as `/quit`, so `session_shutdown` events and extension disposal still fire.

### `session-title`

Auto-naming via the same surface `/name` and `--name` use (`pi.setSessionName`), modeled on OpenCode's hidden title agent.

- **Commands:** `/rename [focus hint]`: regenerate on demand from the whole session transcript (head+tail digest of user asks and assistant answers), with an optional focus hint; overwrites the existing name
- **Hooks:** `session_start`: reset attempt counter; `turn_end`: auto-title while unnamed
- **Env:** `TORUS_TITLE=0` disables auto-titling (`/rename` stays manual); `TORUS_TITLE_MODEL=provider/model` overrides the generator (default `zai/glm-5.3-flash`, falling back to the session model)
- **Interactions:** model cascade resolves through `ctx.modelRegistry`; sessions' search and pi's session picker display the names

After each completed turn while the session is still unnamed (first real user prompt as context), one cheap no-tools flash-model call runs in the background: silent on failure (max 3 attempts), never overwriting a user-set name, never running in delegated engine children. Titles are sanitized (thinking stripped, first line, ≤100 chars).

### `ask`

Structured user questions: labeled-option select dialogs (1–4 questions, 2–6 options each) via the TUI.

| Tool | Purpose |
|---|---|
| `torus_ask` | Ask structured questions (questions[] with question/header/options; options may carry description and monospace preview) |

The dialog always appends a `Custom…` free-text row and a `Chat more about this` row, so callers never add their own "Other"/"discuss" options. In the TUI, digits jump-commit an option, `n` attaches a note to the highlighted option, `tab` opens the custom field, and options with a `preview` (ASCII mockup, snippet, diagram) render side by side. Choosing `Chat more about this` returns a discuss-first directive instead of an answer. In non-interactive contexts the options are returned so the model decides and notes the choice.

### `ui`

The `torus` statusline segment and the torus startup banner.

- **Hooks:** `session_start`, `turn_start`, `model_select`, `message_end`, `tool_execution_start`, `tool_execution_end` (`torus_delegate` only)
- **Env:** `TORUS_ENGINE` (display only; the engine tag appears only when overridden); `TORUS_STATUSLINE_COST=0` disables the session-cost chip; `TORUS_BANNER=0` keeps pi's built-in startup header

Renders the brand, then the identity block (persona, shortened model id, thinking effort, all in the persona's truecolor RGB), then dim provider availability. Health and objective follow: the MCP connected count (`MCP N`, success/warning; polled as the `mcp` section describes) and the session goal as a compact chip (`▶ <48-char head>` warning while active, `⏸` dim while paused, absent when unset or complete; pushed by the goal extension). Model and effort are event-tracked module state, so every writer renders the same line.

Two more chips: a warning `delegate ×N` chip while `torus_delegate` executions are in flight (ref-counted), and a persistent session-cost chip on its own `torus:cost` statusline key beside the torus segment. Assistant `message_end` usage is folded through the shared engine-child tally reducer and rendered with `formatCost`: `$0` shows only once tokens were spent, and the chip stays absent until something measurable happens. Source of the persona color map used by persona-theming.

On `session_start` (interactive only) the same extension swaps pi's built-in startup header for a torus banner: the torus mark (a brand-teal ring with an amber glint, six half-block cells over two lines in the geometry of pi's own logo; terminals that misalign half blocks, Apple Terminal among them, get the `torus` text wordmark instead) with the payload and engine versions in the same shape `torus --version` prints, the engine's compact keybinding hints rebuilt through `keyHint`/`keyText` from the live keybinding config, and an onboarding line pointing at both torus and pi. `ctrl+o` keeps working because the component implements `setExpanded`: the expanded view adds the fleet row (`/roster`, `/doctor`, `alt+t`) and the launcher row (`torus serve`, `torus acp-agent`, `torus --help`) above the engine's full keybinding sheet. `quietStartup: true` leaves the header silenced, `quietStartup: "header"` drops the loaded-resources suffix, and `TORUS_BANNER=0` restores pi's own header. The hint rows mirror the engine's built-in header lists and follow the pinned engine, so pin bumps should re-check them.

## Shared modules

| Module | Provides | Consumers |
| --- | --- | --- |
| `extensions/registry.ts` | DelegationRecord store (globalThis-hosted), run beacons + foreign-process scan, team records, session/persona slots, log rehydration, tmux pane mgmt, `repoRoot()`, sanitize/redact/shellQuote/name gates | roster, team, browser, fleet, notify, memory, goal, prompts, ui, engine-child |
| `extensions/rpc.ts` | `RpcChild`: newline-JSON RPC client for engine children (prompt/steer/getState/kill) | roster, team-runtime, acp (serve) |
| `extensions/engine-child.ts` | `engineChildEnv` (sets `TORUS_ENGINE_CHILD=1`, carries the pinned `TORUS_STATE_DIR`), event parse/reduce, `childExtensionArgs` (the child set), `resolveEngineBin` | roster, team-runtime, doctor, ui, acp (serve) |
| `extensions/team-runtime.ts` | Team spec persistence, mailboxes, locked tasklist, member supervisor | team |
| `extensions/frontmatter.ts` | `---` header parser/stripper | roster, prompts, memory |
| `extensions/fsutil.ts` | `TORUS_HOME`, `TORUS_STATE_DIR` export + `displayPath`, best-effort readJson, atomic writeJson, sleep, splitList | registry, memory, goal, worktrees, prompts, team-runtime, ui |
| `extensions/osnotify.ts` | notify-send toasts (summary+body, @handle label, duration/preview/stats; grouped under a torus desktop entry; running-late ping after 45s, replaced in place by the finish toast via replaces-id; suppressed per member on team_delete in favor of one combined shutdown toast; failures critical+persistent, low-value toasts transient); `TORUS_NOTIFY=0` opt-out | registry, monitor, notify |
| `extensions/persona-theme.ts` | Persona-colored editor border | prompts |
| `extensions/transcript.ts` | Session transcript location/parsing, live tail | browser |
| `extensions/fleet/theme-kit.ts` | Shared fleet rendering (colors, spinner, tokens, icons) | browser, fleet, notify, roster |
| `extensions/hashline/core.ts` | Anchor hashing/parsing/edit semantics | hashline |

## Child set

Delegated children load: `mcp`, `comment-checker`, `hashline`, `vision`, `guards`, `astgrep`, `sessions` + the bundled packages below. Children get **no** roster/team/fleet/browser (they cannot recurse delegations), and worktree tools are additionally gated by `TORUS_ENGINE_CHILD`.

## Bundled packages

### `cc-safety-net`

Destructive-command and secret-access blocker.

- **Commands:** `/cc-safety-net`: help + policy

Registers a `tool_call` guard that parses bash commands (posix shell analysis; wrapping/reordering doesn't evade) and applies secret rules to read/edit/write/search tools. Malformed input fails toward blocking. Policy lives in `.cc-safety-net/`; in torus it is why `.npmrc` writes are agent-blocked (humans use `./make.sh npmrc`). Loaded in parent and children.

### `pi-web-access`

Web access suite.

| Tool | Purpose |
| --- | --- |
| `web_search` | Search (30+ providers, fallback chains, batch queries) |
| `fetch_content` | Fetch (readable/raw/answer modes; GitHub repos/PRs/issues, YouTube + local video with frame extraction, PDFs, images) |
| `get_search_content` | Bounded retrieval from the private cache, with findText |
| `source_check` | Claim-evidence artifact with passage citations |

- **Commands:** `/curator`, `/google-account`, `/search`, `/websearch`
- **Config:** `~/.pi/agent/web-search.json`
- **Interactions:** loaded in parent and children

### `pi-lsp-client`

LSP tools over a shared server pool (lazy spawn, refcount, idle reaping, crash retry); 40+ builtin servers, custom servers via `.pi/lsp-client.json`.

| Tool | Purpose |
|---|---|
| `lsp_diagnostics` / `lsp_goto_definition` / `lsp_find_references` / `lsp_symbols` / `lsp_prepare_rename` / `lsp_rename` | Language-server operations over the pool |

- **Commands:** `/lsp`: status / install / warmup
- **Interactions:** `/doctor` probes `typescript-language-server`; loaded in parent and children

## `torus serve`

`torus serve` boots an authenticated HTTP server over the delegation core (`extensions/serve/index.ts`): session-free `runDelegation()` calls with `parentSession: null`, the same production path memory reflect/dream and team respawn use. Every run lands in the shared registry (record + run beacon), is fleet-visible like any other delegation, and carries a unique `srv-` handle that also labels it in fleet views. The launcher intercepts the subcommand before the pi passthrough (`runtime/bin/torus.mjs`); the server is the process, never a pi manifest extension, and never starts implicitly. `TORUS_SERVE=0` refuses startup (exit 1).

Routes (plain `node:http`, no framework):

| Route | Auth | Behavior |
| --- | --- | --- |
| `GET /health` | none | `{ok: true, version}` |
| `POST /run` | bearer | `{agent, task, model?, cwd?, wait?}`: default responds `{delegationId}` immediately; `wait: true` awaits the outcome (10-min cap → 504) and returns `{ok, text, usage, model, delegationId, error?}`. Agent/model validation is roster's own pre-flight (invalid agent or model → 400 naming the reason, no engine spawned) |
| `GET /runs` | bearer | Delegation list from the shared registry (id, agent, model, handle, status, usage counters, `parentSession`) |
| `POST /hook/<slug>` | per-trigger secret (`X-Torus-Secret`) | Webhook trigger fire; see Webhooks below |
| anything else | none | 404 JSON |

- **Config:** `~/.torus/serve.json`, read-with-fallback to defaults (`port` 4747, `bind` `127.0.0.1`, `tokenPath`, `triggers`); `EADDRINUSE` fails startup with a clean error naming the port and the serve.json override
- **Auth:** bearer token in `~/.torus/serve/auth.json` (`{token, createdAt}`, mode 0600). First start mints 32 random bytes (hex) and prints `serve token: <token>` exactly once to stdout; subsequent starts read silently. Every `/run` and `/runs` request requires `Authorization: Bearer <token>`, compared constant-time (`crypto.timingSafeEqual` over sha256 digests); anything missing or wrong is 401 JSON
- **Triggers:** `triggers[]` entries are time-based delegations, validated at startup (max 8, unique slug `name` matching `AGENT_NAME_RE`, `everyMinutes` integer ≥ 5, `agent` must be a delegatable roster agent, non-empty `task`, optional `model`, optional `webhook.path`: unique, `/hook/`-prefixed, slug remainder). An invalid entry refuses startup naming the trigger and field; a missing/empty array schedules nothing. Each trigger runs one unref'd `setInterval` firing the same roster pre-flight path as `POST /run`, and a tick skips while that trigger's own previous run is still active (per-trigger, never global). `lastFired` persists to `~/.torus/serve/triggers-state.json` (atomic write) after each attempt, so a restart within the interval does not re-fire. Intervals clear on shutdown
- **Webhooks:** a `webhook` block adds a secret-authenticated `POST /hook/<slug>` route. The per-trigger secret is minted like the bearer token (persisted in triggers-state.json, printed once at first start). The JSON body (64 KiB cap → 413) renders into the trigger's task via `{{payload.<field>}}` (JSON-stringified, depth-capped at 8) and responds `{delegationId}` immediately; every request fires a new delegation with no skip gate. Wrong/missing secret → 401, unknown path → 404, non-POST → 405, malformed JSON → 400

Trust boundary: delegations inherit the serve process environment, provider credentials included, so the bearer token is the entire boundary; anyone holding it can spend the account's models. Bind stays loopback by default.

Full guide: [docs/serve.md](serve.md).

## Ambient model calls

Where torus itself spends model calls (and where it looks like it might but doesn't), recorded with the decision on adopting the engine's classifier Models API: `ctx.modelRegistry.classify()` with in-pin `@cf/cloudflare/clef*` catalog models. The bar for adoption: a genuine classification, a binary or few-label decision on short text, not generation.

| Call site | Trigger | Model today | Kind | Adoptable |
| --- | --- | --- | --- | --- |
| `session-title` (`generateTitle`, torus's only direct `modelRegistry.complete` call) | first `turn_end` with a real user prompt and no session name (background, 3 attempts); `/rename` regenerates from the transcript | fast chain head `zai/glm-5.3-flash` via `resolveTitleModel` (`TORUS_TITLE_MODEL` → authed fast default → session model) | Generation: a novel ≤50-char title from free text | No: `classify()` answers fixed-label choice/bool/score questions and cannot mint a title; picking among canned titles would gut the feature |
| `memory` dream + reflect (`runDelegation` to the `dreamer` agent; gating itself, `reflectDecision` over `reflect-state` counters, is pure arithmetic) | `agent_settled`: dream after 6 h with undreamed log activity, reflect after `TORUS_REFLECT_TURNS` settles or 10 min idle; `/reflect` | full engine-child delegation walking the agent's model chain (read-only tools) | Generation + tool use: reads store/transcript/logs, authors ENTRY:/DELETE:/PROFILE: blocks | No: a one-shot classifier over JSON state cannot read files or author structured proposals |
| `comment-checker` | every `edit`/`write` tool call | none: language comment-prefix table plus regexes over added lines | Deterministic check (no model) | No: no call to replace, and prefix matching is exact; a classifier would be slower and less reliable |
| `monitor` | each interval check cycle | none: `spawnSync` plus output-hash compare | Deterministic check (no model) | No: no call to replace |
| `prompts` persona switch | `alt+p` / `/persona-*` | none for inference: `modelRegistry.find` + `setModel` only selects the session model | Model selection (no call) | No: nothing is inferred |

Decision: no-op. No ambient call site is a genuine classification, so `TORUS_CLASSIFY_MODEL` is deliberately read nowhere and behavior is unchanged; revisit when a call site with a genuinely closed label set appears.

## Engine config surfaces

Engine-owned configuration torus users can ride directly; torus's own code touches none of it, so behavior follows the engine's docs (`mcp.md`, `models.md`, and the engine changelog under `node_modules/@earendil-works/pi-coding-agent/`). Sibling of [Ambient model calls](#ambient-model-calls).

| Surface | What it gives |
| --- | --- |
| Project MCP overrides | A file-configured server (project `.pi/mcp.json`, read only after project trust; user-level `~/.pi/agent/mcp.json` likewise) takes precedence over torus's in-session `registerMcpServer` registrations: context7 and grep_app can be replaced or disabled per-project without code; `/mcp` lists the overridden registration and `/reload` picks up file changes |
| MCP OAuth `clientRegistration: "cimd"` | Identifies pi by its Client ID Metadata Document on pi.dev instead of dynamic client registration, for authorization servers that allow-list clients by that URL; cannot be combined with `clientId` or `clientName` |
| `samplingParamsByThinkingLevel` | models.json per-model map of sampling parameters keyed by pi thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), merged over the model's `samplingParams` per key; applies only to the `openai-completions`, `openai-responses`, and `azure-openai-responses` APIs. The engine's built-in GLM catalog entries set none, so a user-supplied entry has full effect |
| Azure provider rename | The engine renamed `azure-openai-responses` to `azure` (engine changelog 1.0.3, inside torus's pin): rename the provider key in `auth.json`, `models.json`, and `settings.json` (`defaultProvider`, `enabledModels`, `modelThinkingLevels`); `AZURE_OPENAI_*` env vars are unchanged |

## Environment variables

| Variable | Consumer | Purpose |
| --- | --- | --- |
| `TORUS_PI_BIN` | launcher | Explicit engine binary path (overrides `node_modules/.bin/pi`) |
| `TORUS_ROOT` | launcher → registry | Payload root override (source layout otherwise) |
| `TORUS_ENGINE` | launcher sets, ui reads | Engine tag (display) |
| `TORUS_ENGINE_BIN` | launcher sets, roster/engine-child read | Engine binary for child spawns |
| `TORUS_ENGINE_CHILD` | engine-child sets, worktrees reads | Marks delegated children; gates worktree tool registration (internal) |
| `TORUS_MEMORY_COMMIT=1` | memory sets, store pre-commit hook reads | Marks in-process git spawns on the memory store; agent-run commits are refused (internal) |
| `TORUS_HOME` | fsutil | Base dir for torus state (default `~/.torus`) |
| `TORUS_STATE_DIR` | fsutil | Exported in every torus process (main session, delegated children, team members): this project's state root, so skills, prompts, and bash commands use `$TORUS_STATE_DIR/…` instead of hand-derived dashed keys. Main sessions compute it from cwd (kept fresh); engine children treat the inherited value as authoritative (the dispatching session pins them to its root, so `$TORUS_STATE_DIR` paths and ledger appends land in the dispatching project even from a worktree cwd). Explicit-cwd resolution (sandbox hosts) always computes fresh, and delegation logs land in the dispatching session's root: a child running in another cwd never grows its own state dir. Tool output abbreviates state paths to `$TORUS_STATE_DIR/…` (`$TORUS_HOME/…` for other projects') via `displayPath` |
| `TORUS_TMUX=0` | registry | Disable delegation tmux panes |
| `TORUS_NOTIFY=0` | osnotify | Disable desktop notifications |
| `TORUS_GUARDS=0` / `TORUS_MAX_TOOL_OUTPUT` | guards | Disable guards / output truncation cap (default 16000) |
| `TORUS_HASHLINE=0` / `TORUS_FMT_CMD` | hashline | Disable anchoring / post-edit formatter command |
| `TORUS_INTERACTIVE=0` | interactive | Disable `interactive_bash` overlay |
| `TORUS_MONITOR=0` | monitor | Disable monitors |
| `TORUS_STATUSLINE_COST=0` | ui | Disable the session-cost statusline chip |
| `TORUS_BANNER=0` | ui | Keep pi's built-in startup header instead of the torus banner |
| `TORUS_TEAM_NOTIFY=0` | team | Disable the per-member idle/crash wake-up markers (result markers still render) |
| `TORUS_TASK_STALE_MIN=<minutes>` | team | Stale-task threshold for `team_status`: an in_progress task under an idle member with no tasklist update for more than N minutes renders a read-only stale line (default 30; invalid values fall back to 30) |
| `TORUS_COMMENT_CHECKER=0` / `TORUS_COMMENT_CHECKER_PROMPT` | comment-checker | Disable / override the challenge text |
| `TORUS_WORKTREES_ROOT` | worktrees | Worktree root override (default `~/.torus/worktrees`) |
| `TORUS_APPROVAL=0` | approval | Disable the trust-on-denial dialog (unmatched hosts deny) |
| `TORUS_SANDBOX` / `TORUS_SANDBOX_WRITABLE` / `TORUS_SANDBOX_NET_ADD` / `TORUS_SANDBOX_NET_ONLY` | sandbox | Per-command sandbox (`off` \| `full`, default **off**: `full`/`on`/`1` sandboxes agent bash; unset runs unsandboxed; unknown values default to off with a notice; confines writes to workspace+tmp+extras, network restricted to a curated exact-host allowlist of 30 dev-workflow hosts, registries, GitHub incl. release assets, core toolchains) / extra writable roots, colon-separated / comma-separated extra allowed hosts (exact-host; over-broad entries dropped) / comma-separated hosts replacing the curated allowlist |
| `TORUS_REFLECTION=0` | memory | Disable idle reflection |
| `TORUS_REFLECT_TURNS=<n>` | memory | Reflect after N settles since the last reflect (0 = idle-only; default 12) |
| `TORUS_DREAMING=0` | memory | Disable dream consolidation |
| `TORUS_THEME_DEBUG` | persona-theme | Theme debugging |
| `TORUS_SERVE=0` | serve | Kill switch: `torus serve` refuses to start (exit 1) |
