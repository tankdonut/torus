# Configuration

torus reads its settings from three layers with one precedence rule; this page is the canonical guide to all of them. It covers the unified `config.json` under the torus home and its registered sections, the single-value knob sections and the environment-variables table, the other files under the torus home, the project-level rules, the `torus.sandbox` file policy, engine-owned pi settings, and the CLI and in-session inspectors that report effective state.

## The three layers and precedence

torus resolves settings from three layers:

- **User layer**: `~/.torus/` holds the unified `config.json` and `acp.json`; the engine's user dir `~/.pi/agent/` holds `settings.json`, `models.json`, `mcp.json`, and auto-discovered skills.
- **Project layer**: files inside the working repository: `.torus/config.json`, the `.pi/` files (`settings.json`, `mcp.json`, `lsp-client.json`), `.agents/skills/`, and the `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` instruction chain. Project `.pi` files are trust-gated: torus reads them only for a project you have trusted.
- **Session layer**: environment variables and launcher flags, attached to the process rather than written to disk.

Precedence for any one setting, highest first: launcher flag over env var over user config over project config over built-in default. A flag wins by setting the env var for one session; a layer that is unset falls through to the layer beneath it.

## The unified config file

User-level torus config lives in one file: `config.json` under the torus home (`TORUS_HOME`, default `~/.torus`), the single user-level source for every section below. The file is user-level by construction, so a repo checkout cannot set it for a session.

| Section | Configures |
| --- | --- |
| `chains` | Model chains per tier plus compatible-provider endpoints |
| `automode` | Auto permission-mode rules and circuit-breaker settings |
| `serve` | HTTP server bind, port, token path, and scheduled triggers (auth is runtime state) |
| `keywords` | Keyword rows injected into the system prompt |
| `permissionMode` | Default permission mode (top-level key, not an object) |
| `roster` | Delegation background execution override |

A section that is not a JSON object warns, names the section, and reads as unset. A config.json that cannot be parsed reads as an empty config with one warning, so every consumer degrades to its defaults instead of failing.

## Knob sections and environment variables

Single-value knobs live in their own sections (`ui`, `sessionTitle`, `guards`, `hashline`, `interactive`, `monitor`, `notify`, `commentChecker`, `team`, `reflection`, `approval`, `roster`), one key each; the environment-variables table below maps each env var to its config key. Knob precedence is env over config over default, and a config value of the wrong type is ignored, so the default applies.

`permissionMode` is a top-level scalar rather than a section: `"auto"` or `"default"` sets the default permission mode under `TORUS_PERMISSION_MODE` (the `--permission-mode` launcher flag sets the env var for one session). A defined env value decides its tier outright, even when unrecognized; the config key counts only when exactly `"auto"` or `"default"`, and `"bypass"` is refused with a warning (bypass is startup-only: sessions must be launched with the flag or env var, so it can never be a sticky default); anything else warns and is treated as unset.

Rows carrying a config key also read that key from the [unified config](#the-unified-config-file) (env still wins); the rest are env-only.

| Variable | Consumer | Purpose |
| --- | --- | --- |
| `TORUS_PI_BIN` | launcher | Explicit engine binary path (overrides `node_modules/.bin/pi`) |
| `TORUS_ROOT` | launcher → registry | Payload root override (source layout otherwise) |
| `TORUS_ENGINE` | launcher sets, ui reads | Engine tag (display) |
| `TORUS_ENGINE_BIN` | launcher sets, roster/engine-child read | Engine binary for child spawns |
| `TORUS_ENGINE_CHILD` | engine-child sets, worktrees + work read | Marks delegated children; gates worktree tool registration (internal) |
| `TORUS_MEMORY_COMMIT=1` | memory sets, store pre-commit hook reads | Marks in-process git spawns on the memory store; agent-run commits are refused (internal) |
| `TORUS_HOME` | fsutil | Base dir for torus state (default `~/.torus`) |
| `TORUS_STATE_DIR` | fsutil | Exported in every torus process (main session, delegated children, team members): this project's state root, so skills, prompts, and bash commands use `$TORUS_STATE_DIR/…` instead of hand-derived dashed keys. Main sessions compute it from cwd (kept fresh); engine children treat the inherited value as authoritative (the dispatching session pins them to its root, so `$TORUS_STATE_DIR` paths and ledger appends land in the dispatching project even from a worktree cwd). Explicit-cwd resolution (sandbox hosts) always computes fresh, and delegation logs land in the dispatching session's root: a child running in another cwd never grows its own state dir. Tool output abbreviates state paths to `$TORUS_STATE_DIR/…` (`$TORUS_HOME/…` for other projects') via `displayPath` |
| `TORUS_TMUX=0` | registry | Disable delegation tmux panes |
| `TORUS_DELEGATE_BACKGROUND=0` | roster | Force delegation tools back to blocking even when called with `background: true` (config: `roster.delegateBackground`) |
| `TORUS_NOTIFY=0` | osnotify | Disable desktop notifications (config: `notify.enabled`) |
| `TORUS_PLATFORM` | platform | Force platform detection (`linux`/`darwin`/`win32`) for the extension load gate; invalid values warn and fall back to the host platform |
| `TORUS_GUARDS=0` / `TORUS_MAX_TOOL_OUTPUT` | guards | Disable guards / output truncation cap (default 16000) (config: `guards.enabled` / `guards.maxToolOutput`) |
| `TORUS_HASHLINE=0` / `TORUS_FMT_CMD` | hashline | Disable anchoring / post-edit formatter command (config: `hashline.enabled` / `hashline.fmtCmd`) |
| `TORUS_INTERACTIVE=0` | interactive | Disable `interactive_bash` overlay (config: `interactive.enabled`) |
| `TORUS_MONITOR=0` | monitor | Disable monitors (config: `monitor.enabled`) |
| `TORUS_STATUSLINE_COST=0` | ui | Disable the session-cost statusline chip (config: `ui.statuslineCost`) |
| `TORUS_BANNER=0` | ui | Keep pi's built-in startup header instead of the torus banner (config: `ui.banner`) |
| `TORUS_TITLE_MODEL=provider/model` | session-title | Override the session-title generator model (default: the authed fast default, then the session model; config: `sessionTitle.titleModel`) |
| `TORUS_TEAM_NOTIFY=0` | team | Disable the per-member idle/crash wake-up markers (result markers still render) (config: `team.teamNotify`) |
| `TORUS_TASK_STALE_MIN=<minutes>` | team | Stale-task threshold for `team_status`: an in_progress task under an idle member with no tasklist update for more than N minutes renders a read-only stale line (default 30; invalid values fall back to 30) (config: `team.taskStaleMin`) |
| `TORUS_COMMENT_CHECKER=0` / `TORUS_COMMENT_CHECKER_PROMPT` | comment-checker | Disable / override the challenge text (config: `commentChecker.enabled`; `TORUS_COMMENT_CHECKER_PROMPT` is env-only) |
| `TORUS_WORKTREES_ROOT` | worktrees | Worktree root override (default `$TORUS_HOME/worktrees`) |
| `TORUS_APPROVAL=0` | approval | Disable the trust-on-denial dialog (unmatched hosts deny; config: `approval.enabled`) |
| `TORUS_PERMISSION_MODE` | automode | Opt into LLM-classified bash auto-approval (`1`/`on`/`auto`; unset or `0`/`off`/`default` keeps the built-in gate; `bypass` disables every permission guard, startup-only) (config: top-level `permissionMode`) |
| `TORUS_PERMISSION_MODEL` | automode | Pin the permission classifier as `provider/model-id` (default: first available classifier, then the fast chain's first authed chat model, then the session model) |
| `TORUS_SANDBOX` / `TORUS_SANDBOX_WRITABLE` / `TORUS_SANDBOX_NET_ADD` / `TORUS_SANDBOX_NET_ONLY` / `TORUS_SANDBOX_DEFAULT` | sandbox | Per-command sandbox (`off` \| `full`, default **off**: `full`/`on`/`1` sandboxes agent bash; unset runs unsandboxed unless `TORUS_SANDBOX_DEFAULT=full` opts the environment into default-on; unknown values fall back to the effective default with a notice; confines writes to workspace+tmp+extras, network restricted to a curated exact-host allowlist of dev-workflow hosts, registries, GitHub incl. release assets, core toolchains, and `*.amazonaws.com`) / extra writable roots, colon-separated / comma-separated extra allowed hosts (exact-host; over-broad entries dropped) / comma-separated hosts replacing the curated allowlist / environment default for unset `TORUS_SANDBOX` (`full`/`on`/`1` enables; any other value is inert) |
| `TORUS_REFLECTION=0` | memory | Disable idle reflection (config: `reflection.enabled`) |
| `TORUS_REFLECT_TURNS=<n>` | memory | Reflect after N settles since the last reflect (0 = idle-only; default 12) (config: `reflection.reflectTurns`) |
| `TORUS_DREAMING=0` | memory | Disable dream consolidation (config: `reflection.dreaming`) |
| `TORUS_THEME_DEBUG` | persona-theme | Theme debugging |
| `TORUS_SERVE=0` | serve | Kill switch: `torus serve` refuses to start (exit 1) |

## Files under the torus home

Two files under the torus home are configuration; the rest of the directory is state torus mints as it runs.

`config.json` is the unified config file (above). `acp.json` under `TORUS_HOME` (default `~/.torus`) declares external ACP-speaking agents as delegatable children, which the [acp section](extensions.md#acp) of the extension reference consumes. Shape `{"agents": {"<name>": {"command": "…", "args": […], "env": {"KEY": "value"}}}}`; `args` defaults to `[]`, and `env` is merged over the inherited child environment. An absent file means no ACP agents and the engine delegation path is untouched. Malformed JSON, a non-object root, or a bad entry warns on stderr and skips only that entry.

Name resolution: an exact name match in `acp.json` **wins over a roster agent** of the same name. The requested name is looked up there before the roster, and a name resolving nowhere is rejected naming both the roster agents and the configured ACP agent set (`torus_roster` and the roster section of the system prompt list configured ACP agents too).

The remaining files are behavior side-effects, state rather than config: torus writes them as it runs, and nothing reads them back as settings.

| Path | Holds |
| --- | --- |
| `~/.torus/serve/auth.json` | The serve bearer token, minted at first start ([docs/serve.md](serve.md)) |
| `~/.torus/serve/triggers-state.json` | Per-trigger `lastFired` times and webhook secrets ([docs/serve.md](serve.md)) |
| `$TORUS_STATE_DIR/sandbox-hosts.json` | Hosts approved "Always allow (this project)" in the sandbox trust dialog (`$TORUS_STATE_DIR` is the per-project state root under `~/.torus/state/`) |
| `~/.torus/teams.json` | The global team index: team id to project key |
| `~/.torus/memory/` | The git-backed memory store |
| `~/.torus/runs/` | Run beacons that keep externally spawned delegations (`torus serve` runs) fleet-visible, pruned by age and count |

## Project-level configuration

A project-level `.torus/config.json` in the session's working directory is read with the same tolerance and may set exactly the knob sections `ui`, `sessionTitle`, `guards`, `hashline`, `interactive`, `monitor`, `notify`, `commentChecker`, `team`, and `reflection`, plus the automode section's `deny` and `ask` keys. `approval` is a knob section but deliberately not project-readable: a checked-in repo must not be able to silence the trust dialog. Knob precedence is env over the user file over the project file over default; the automode contribution is a tightening-only union (project `deny`/`ask` entries add to the user's rules, never replace them). Every other top-level key in the project file, and any widening automode key (`allow`, `environment`, `hardDeny`, `softDeny`, `softDenyExceptions`, `classifyAllShell`), is refused with one warning: a checked-in repo must not be able to widen its own permissions, redirect model traffic, inject prompt keywords, or opt sessions into automode. `torus config status` reports the project file's readable sections and refused keys.

Instructions and skills are project-level too: torus reads the `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` chain per directory (see [docs/instructions.md](instructions.md)), and project skills drop into `.agents/skills/` (see [docs/skills.md](skills.md)).

## The `torus.sandbox` file policy

Sandbox behavior is file-configured through pi settings files, layered under the env-only `TORUS_SANDBOX*` knobs the [sandbox section](extensions.md#sandbox) documents. The policy lives under `"torus" → "sandbox"` inside those files; everything else in them is ignored.

| Key | Shape |
| --- | --- |
| `mode` | `"off"` or `"full"` |
| `writable` | Extra writable roots |
| `hosts` | `add`, `only`, and `deny` host lists |
| `credentials` | `files` and `envVars` to mask inside the sandbox |
| `exempt` | Commands exempt from sandboxing |
| `env` | Env vars to set inside the sandbox |
| `sign.relay` | Boolean: relay ssh commit signing through the host agent |

Two layers read the policy:

- **User layer**: `settings.json` under `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`), read unconditionally.
- **Project layer**: `.pi/settings.json` in the working directory, read only for a trusted project, and additive-only: it may contribute `writable`, `hosts.add`, `hosts.deny`, `env`, and `sign.relay`. `mode`, `exempt`, `hosts.only`, and `credentials` are refused with a poison notice naming the key and the file: a committed file must not be able to weaken the sandbox. Project `env` keys never shadow user keys.

## Engine config surfaces

Engine-owned configuration torus users can ride directly; behavior follows the engine's docs (`mcp.md`, `models.md`, and the engine changelog under `node_modules/@earendil-works/pi-coding-agent/`). torus's own code touches none of it, with one exception: the `ui` extension reads `quietStartup` when it paints the startup banner.

| Surface | What it gives |
| --- | --- |
| Project MCP overrides | A file-configured server (project `.pi/mcp.json`, read only after project trust; user-level `~/.pi/agent/mcp.json` likewise) takes precedence over torus's in-session `registerMcpServer` registrations: context7 and grep_app can be replaced or disabled per-project without code; `/mcp` lists the overridden registration and `/reload` picks up file changes |
| MCP OAuth `clientRegistration: "cimd"` | Identifies pi by its Client ID Metadata Document on pi.dev instead of dynamic client registration, for authorization servers that allow-list clients by that URL; cannot be combined with `clientId` or `clientName` |
| `samplingParamsByThinkingLevel` | models.json per-model map of sampling parameters keyed by pi thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), merged over the model's `samplingParams` per key; applies only to the `openai-completions`, `openai-responses`, and `azure-openai-responses` APIs. The engine's built-in GLM catalog entries set none, so a user-supplied entry has full effect |
| Azure provider rename | The engine renamed `azure-openai-responses` to `azure` (engine changelog 1.0.3, inside torus's pin): rename the provider key in `auth.json`, `models.json`, and `settings.json` (`defaultProvider`, `enabledModels`, `modelThinkingLevels`); `AZURE_OPENAI_*` env vars are unchanged |
| `quietStartup` | A `~/.pi/agent/settings.json` key the `ui` extension honors: `true` silences the startup banner, and the string `"header"` keeps the header row while hiding the loaded-resources details (`TORUS_BANNER=0` restores pi's built-in header instead) |
| `.pi/lsp-client.json` | Custom LSP server declarations for the [pi-lsp-client section](extensions.md#pi-lsp-client) of the extension reference |
| `models.json` endpoints | The engine's own model-endpoint declarations under `~/.pi/agent/models.json`; delegated children rely on them, since they spawn without torus's provider registrations |

## CLI and in-session inspectors

The launcher owns these surfaces and intercepts each before the pi passthrough: the process is the surface, never an engine session.

| Surface | Purpose |
| --- | --- |
| `torus serve` | Authenticated HTTP server over the delegation core; routes and auth live in [docs/serve.md](serve.md) |
| `torus acp-agent` | ACP v1 agent over stdio for editors; see the [ACP agent section](serve.md#acp-agent-torus-acp-agent) of docs/serve.md |
| `torus config status` | Reports the unified config's effective state (below) |
| `torus --permission-mode auto\|default\|bypass` | Sets `TORUS_PERMISSION_MODE` for one session; bypass disables every permission guard and is startup-only |
| `torus --version` (`-v`) | Prints torus and engine versions |

`torus config status` prints one line per registered section with its effective source (`config.json` or `default`), one line per config.json key the registry does not know, and the project-level file's report: its readable sections and any refused ones.

In session, slash commands inspect the same surfaces: [`/doctor`](extensions.md#doctor) for extension health, [`/automode`](extensions.md#automode) for the live permission mode and rules, [`/login`](extensions.md#providers) for provider authentication, and [`/mcp`](extensions.md#mcp) for MCP server status, including file-configured overrides.

Schemas for what you can extend live next to their surfaces: agent frontmatter in [docs/agents.md](agents.md), skill manifests in [docs/skills.md](skills.md), and the pi-package manifest in [docs/pi-packages.md](pi-packages.md).
