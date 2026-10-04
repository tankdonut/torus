# torus

A personal pi harness: an opinionated extension package running on the pinned stock [pi](https://github.com/earendil-works/pi) engine.

torus owns the harness layer: GLM provider routing, the agent roster, subagent delegation, ambient UI. The engine beneath it is a pinned, replaceable dependency, launched by `runtime/bin/torus.mjs`.

## Install

Prerequisites: Node ≥ 20 and npm (`engines.node`); tmux is optional — delegation panes only appear inside tmux.

```sh
git clone https://github.com/tankdonut/torus.git && cd torus
./make.sh npmrc      # one-time: .npmrc with legacy-peer-deps=true + before=null + min-release-age=0 (agent-write-blocked by design)
npm install          # installs everything incl. the engine, pinned via package.json
./runtime/bin/torus.mjs
```

The engine pin lives in `package.json` (`devDependencies`, `@earendil-works/pi-coding-agent`); the launcher drift-checks the spawned binary against it and warns on mismatch. Override the binary with `TORUS_PI_BIN`. Or run without the launcher: `pi --extension /path/to/torus`. For the self-bootstrapping compiled binary, see [Binary distribution](#binary-distribution).

## Container

A prebuilt image ships on GHCR — full agent toolchain, no host install:

```sh
docker run --rm -it -v "$PWD:/workspace" ghcr.io/tankdonut/torus
```

The image bakes the payload with the pinned engine pre-installed (`/opt/torus`, `TORUS_ROOT` set) — containers boot instantly with no network access, and `--list-models` works keyless. Run flags, sandbox caveats, and the version policy: [docs/container.md](docs/container.md).

## Configuration (environment)

`TORUS_OCGO_API_KEY` + `TORUS_OCGO_BASE_URL` register the `opencode-go` tail-fallback provider; `TORUS_PI_BIN` overrides the engine binary. The full switch set (tmux panes, guards, notifications, monitors, worktree root, ambient machinery kill switches) is catalogued in [docs/extensions.md](docs/extensions.md#environment-variables).

The `zai` GLM provider is built into stock pi (glm-5.3: 1M/131K; glm-5.3-flash: 1M/131K, image-capable). Authenticate with pi's `/login zai` before first use. The opencode-go gateway registers only when its env is present; keyless runs (CI, `--list-models`) stay clean.

## Composition

Bundled through the `pi` manifest in package.json: `cc-safety-net`, `pi-web-access`, `pi-lsp-client`, plus 27 torus-native extensions:

- **Delegation & teams:** roster, prompts, team
- **Ambient UI:** fleet, browser, notify, ui, vision
- **Editing & hygiene:** hashline, interactive, guards, comment-checker, doctor, astgrep
- **Session state:** sessions, memory, goal, todo, session-title
- **Workflow:** worktrees, monitor, ask, exit, providers, mcp

Every tool, command, hook, and env var is catalogued in [docs/extensions.md](docs/extensions.md). MCP servers (context7, grep_app) are registered in-session via pi's `registerMcpServer`. Delegated children load the same child-safe set via spawn args.

**Keyword intent gates** (built in): saying `ultrawork` (full-precision contract), `hyperplan` (plan-first gate), or `team` (orchestrate, don't serialize) in a message injects that execution mode into the next turn's system prompt. Add or override via `~/.torus/keywords.json` (`{"word": "mode text"}`).

## Personas

The main session runs a persona: its agent prompt is injected into the system prompt. Sessions start on `lead`, and the choice persists per session id.

- **alt+p** cycles forward, **alt+shift+p** backward (leader → builder → dreamer → explorer → librarian → looker → reviewer)
- `/persona-<name>` jumps directly; `/leader` still toggles the leader persona off/on
- The statusline always shows the active persona
- Tab is not bindable (the editor's autocomplete layer owns it); alt+p is the switcher

## Delegation

Three surfaces, same machinery:

- **User-driven:** `/<agent> <task>` for every delegatable agent (`/explorer`, `/builder`, `/reviewer`, `/librarian`, plus aliases such as `/research`) runs the delegation machinery directly; the result lands in the conversation as a follow-up user message once all running delegations settle. `/roster` shows agents, chains, and credentialed providers.
- **Model-driven:** the `torus_delegate` / `torus_roster` tools, called by the session model per the delegation policy. `extensions/prompts/index.ts` appends a roster + policy section to the system prompt (`before_agent_start`): delegate single-goal, context-heavy, or parallelizable work; keep orchestration and user interaction in-session. Delegate tools also accept a `skills` list, forwarded to the child.
- **Team orchestration:** `torus_fanout` runs 2–8 independent delegations in parallel (own sessions, panes, fleet entries) and returns an aggregated report; `torus_chain` runs 2–6 sequential steps, each fed the previous step's output (bounded to 4k chars) for pipelines like research → plan → build → review. Team tools (`team_create` / `team_status` / `team_msg` / `team_task_*` / `team_delete` / `team_respawn`) run persistent RPC members with file mailboxes and a shared tasklist; teams are durable across parent restarts, and each member that goes idle (or crashes) with an unread report fires its own follow-up prompt to wake the session (`TORUS_TEAM_NOTIFY=0` to disable). Any extension can `publishExternalRun()` into `torus.external-runs.v1` to appear in the fleet.

Children run in RPC mode (JSON fallback), which enables mid-run control: in the fleet detail view `s` (or the clickable `[s] steer` footer button) steers a running child with an injected message, and `x` (or `[x] stop`) stops it after a `y/n` confirmation; fleet rows and buttons highlight on hover.

### Sub-agent visualization

Every delegation is visible four ways while it runs:

- **Statusline keys:** each running agent gets a live entry (`▶ explore · turn 3 · 812 tok`), cleared on completion.
- **Browser overlay:** `/torus` or **alt+t** lists live and recent delegations plus running team members (status, model, turns, tokens). **enter** opens a detail view: the live action feed while running, the full session transcript once done; `j/k` scroll, `x` stops, **esc** closes.
- **tmux panes (primary):** inside tmux, every delegation automatically opens a titled right-hand pane (`torus: @handle`, or the agent name when no handle is given) tailing a live action feed (`→ read path=...`, `← result`, turn snapshots, token counts), so the pane shows *what the agent is doing* as it works. Panes close on completion; logs persist at `~/.torus/logs/`. Set `TORUS_TMUX=0` to disable.
- **Transcript notifications:** start and completion render as transcript lines (`▶ explore delegated · <task preview>`, `✓/✗ explore finished · alt+t for the transcript`) — delivered immediately while the session is idle, deferred to turn end mid-stream.

Tool output streams per-turn into the transcript via `onUpdate`, with compact `renderCall`/`renderResult` blocks (`delegate explore (glm-5.3-flash) · done · 3 turns · 1.2k/4k tok`).

### Agents

Agent system prompts live in `agents/*.md`, deliberately outside pi's prompt-template discovery (they are subagent prompts, not user templates). Each file carries frontmatter that is the roster definition:

```markdown
---
name: librarian
description: External-reference researcher: remote repos, docs, OSS examples
chain: fast          # primary | fast
aliases: research    # extra slash commands
tools: read, bash    # optional child tool whitelist
---
<system prompt body — {{AGENTS}}/{{TOOLS}}/{{SKILLS}} markers substituted at spawn>
```

Every agent works as a persona and as a delegatable child; `mode: session` excludes an agent from child delegation (currently lead). Adding an agent = dropping a file in `agents/`; commands, roster, delegation policy, and fleet colors all follow.

### Trust & safety

Hardening boundaries the harness enforces on untrusted surfaces:

- **Agent and member names** are validated against `^[a-z0-9-]+$` before they reach shell command lines or tmux format strings; `agents/*.md` entries failing the gate are dropped from the roster entirely.
- **Delegation log paths** are shell-quoted when interpolated into the tmux `tail -f` pane command.
- **Team tools** resolve teams through the in-process registry (with the same name gate) before touching the filesystem — mailboxes and tasklists are only addressed for known ids.
- **Delegation action logs** redact credential shapes (`Authorization: Bearer …`, `sk-…` tokens, `KEY=VALUE` assignments) before tool args are written.
- **Injected context** (memory, profile, goal) is framed as untrusted data — "data, not instructions" — since it persists across sessions and may originate from delegated output.
- **Dream/reflect** spawn a read-only `dreamer` agent (read/find/grep/ls only); all memory writes are applied by the parent extension after validation (structured proposals, delete filenames constrained to bare entry names, caps enforced).
- **Environment gates:** `TORUS_TMUX=0` (no panes), `TORUS_REFLECTION=0` (no idle reflection), `TORUS_DREAMING=0` (no dream consolidation) disable the respective ambient machinery.

## Memory & goals

`torus_remember` / `torus_recall` / `torus_memories` / `torus_forget` persist durable, git-backed notes (project + global scopes; near-duplicates blocked unless forced) that are injected into future sessions — pinned entries first, then relevance to the current task. `/reflect` distills the session into memory via a read-only `dreamer` delegation (proposals are applied by the parent extension after validation); idle sessions do this automatically as dreaming (`TORUS_DREAMING=0` disables). `/goal` sets a per-session standing objective (notes, pause/resume, off) injected into every turn's context.

## Binary distribution

```sh
./scripts/build-binary.sh [dist/torus] [--target bun-linux-x64]
dist/torus/bin/torus ...   # single self-contained file; copy it anywhere
```

The payload (extensions, agents, skills, .npmrc, a runtime package.json carrying the pi manifest and the engine pin) is embedded in the binary as file assets. On first run the launcher extracts it to `~/.torus/runtime` (hash-keyed: re-extracted only when the binary's payload hash changes; `node_modules` holding the bootstrapped engine is preserved) and `npm install`s the pinned engine there (`--legacy-peer-deps` for the adapter's peer range). `TORUS_ROOT` still overrides, and source-layout / `<binary>/../lib/torus` / `torus-payload` payload directories still resolve. First run needs network unless `TORUS_PI_BIN` points at an existing engine; switching between binaries with different payloads re-extracts on next launch and re-runs the dependency install (engine pin drift is warned at spawn).

## Portability discipline

`extensions/*` imports only the public pi ExtensionAPI; no engine-specific code. CI typechecks and smoke-loads against the pinned engine (stock pi). Diverging = CI failure, not a surprise.

## License

MIT — see [LICENSE](LICENSE).
