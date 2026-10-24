# torus

A multi-agent coding harness on the pinned stock [pi](https://github.com/earendil-works/pi) engine: a lead session that delegates to a roster of specialist agents (builder, explorer, librarian, reviewer, …) with live visibility into everything they do.

torus owns the harness layer: roster, delegation, ambient UI, memory. The engine beneath it is a pinned, replaceable dependency.

## What you get

- **Delegation & teams**: hand work to any agent with `/<agent> <task>`, or let the session delegate into parallel fan-outs, sequential pipelines, and persistent teams with shared tasklists that survive restarts.
- **Live visibility**: every delegation opens a tmux pane tailing what the agent does, live statusline entries, and **alt+t**, a fleet browser with live transcripts. Steer (`s`) or stop (`x`) a running agent mid-run.
- **Persistent memory**: git-backed notes injected into future sessions; `/reflect` distills a session into durable memory, and `/goal` pins a standing objective.
- **Personas**: the main session itself runs as any roster agent (**alt+p** to cycle); every agent is both a persona and a delegatable child.
- **Open-standard skills**: skills follow the [Agent Skills](https://agentskills.io) standard, so they work in Claude Code and Codex unchanged; external skills drop into `~/.agents/skills/`.
- **Guards by default**: context-integrity guards, credential redaction in delegation logs, and a read-only dreamer for memory writes; the full threat model is [SECURITY.md](SECURITY.md).

## Quickstart

**As a pi package**: you need [pi](https://github.com/earendil-works/pi) installed first; its README covers installation. Then one command loads the full extension pack, skills, and agent roster, with no clone and no build:

```sh
pi install git:github.com/tankdonut/torus@vX.Y.Z
```

Launcher-only surfaces (`torus serve`, `torus acp-agent`) are not part of this mode; see [docs/pi-packages.md](docs/pi-packages.md).

**As a single binary**: download `torus-<os>-<arch>` from [releases](https://github.com/tankdonut/torus/releases), make it executable, and run it. The first launch self-bootstraps the runtime:

```sh
chmod +x torus-<os>-<arch> && ./torus-<os>-<arch>
```

**In a container** (full toolchain, no host install):

```sh
docker run --rm -it -v "$PWD:/workspace" ghcr.io/tankdonut/torus
```

**From source** (contributor path). You need Node >= 22.12. Platform support is declared per extension, so on other platforms unsupported extensions skip loading with a notice instead of failing later; see [docs/extensions.md](docs/extensions.md). tmux is optional, since delegation panes only appear inside tmux:

```sh
git clone https://github.com/tankdonut/torus.git && cd torus
./make.sh npmrc      # one-time: writes .npmrc (agents are blocked from writing it by design)
npm install
./runtime/bin/torus.mjs
```

All paths need provider auth on first run: `/login zai` signs in to the built-in Z.ai provider (GLM models). In containers, mount credentials read-only instead; see [docs/container.md](docs/container.md).

## First five minutes

1. `/roster`: the agents, their model chains, and credentialed providers.
2. Delegate something small: `/explorer where does the roster load from?` Watch the right-hand pane, then **alt+t** for the live transcript.
3. Say `team` in a message (or `deepwork`, `blueprint`). Keyword gates switch the session's execution mode.
4. `/goal` to pin a standing objective; `/reflect` to distill the session into memory.

## Permission modes

torus starts in default mode: guards, sandboxing, and approval prompts judge tool calls as they run. Automode is an opt-in permission layer for unattended work: a decision model classifies each bash command, approves the safe ones, and asks before anything risky. Turn it on with `torus --permission-mode auto` or `TORUS_PERMISSION_MODE=auto`, or default it on with `"permissionMode": "auto"` in `~/.torus/config.json`; `1` and `on` also select auto mode, while unset, `0`, `off`, and `default` keep the built-in gate. The config key sets the default, the env var overrides it, and the flag sets the env var for one session. `/automode` reports the live status (naming where the mode came from) and switches the current session.

Your rules run first, from the `automode` section of `~/.torus/config.json` (a missing section falls back to the legacy `~/.torus/automode.json`; see [Configuration](#configuration)):

```json
{
  "deny": ["git push --force *", "npm publish *"],
  "ask": ["git push *", "npx *"],
  "allow": ["npm test *", "node --test *"],
  "environment": [
    "Source control: github.com/tankdonut and all repos under it",
    "Package registry: the default npm registry is fine"
  ],
  "softDeny": ["leave the staging database untouched"],
  "softDenyExceptions": ["pg_dump against staging for a nightly backup"],
  "hardDeny": ["never read or send ~/.ssh credentials anywhere"],
  "classifyAllShell": false
}
```

Entries are prefix patterns, evaluated in deny, ask, then allow order. Broad allow entries such as `*` match nothing and draw a warning at load. A fixed ask floor outranks every allow rule. It covers `sudo` and `su`, recursive forced `rm` on root or home paths, force pushes, recursive `chmod` or `chown` on root paths, and command substitution; floored commands ask no matter what the rules say.

The `environment`, `softDeny`, `softDenyExceptions`, and `hardDeny` entries are prose for the decision model, riding into every classifier and chat verdict so the judge knows what "external" means for you. Environment lines describe trusted infrastructure and posture (source control, registries, internal domains); hardDeny lines are absolute boundaries. softDeny lines deny unless cleared: a matching `softDenyExceptions` entry clears one for that command, and so does a recent user intent line, but only one that directly and specifically describes the exact command. The intent window holds your own messages since the last approval dialog, deny, or `/automode` mode toggle; a general request such as "clean up the repo" clears nothing.

`classifyAllShell` suspends allow rules while auto mode is on, sending every rule-allowed shell command to the decision model instead; deny and ask rules still apply, and the read-only fast path and session cache still run. `/automode` prints the effective configuration and `/automode denied` lists the last denials from the audit log. `/automode setup` drafts `environment` entries from the repo's git remotes and `ask` entries from repeated audit denials, then writes them into config.json's `automode` section. `/automode setup apply <file>` lands a reviewed draft file (`environment` and `ask` entries only) through the same merge; the `automode-setup` skill drafts one from git remotes, the audit log, session transcripts, delegation logs, and memory.

Read-only commands such as `ls`, `git status`, and version probes pass without a model call. An "Always this session" answer replays without asking again. Three consecutive decision-model denies switch the session to asking for everything.

The judge is a classifier model. Pin one with `TORUS_PERMISSION_MODEL=provider/model-id`. Without a pin, automode takes the first available classifier, such as `typesafe/jev-latest` behind a `TYPESAFE_API_KEY` or a local decision model from a llama.cpp router; a local router works offline with no API key.

With no classifier reachable, the fast model chain judges the command in one shot (`glm-5.3-flash` first; `chains.json` overrides under the torus home are honored), falling back to the session model. If every model path fails, the command still runs unjudged, and its tool result carries an `[automode]` notice.

Every decision appends one JSON line to `automode.log` under the session's project state directory, or `~/.torus/automode.log` when no project state exists. Automode only adds gates: denials from guards, `cc-safety-net`, sandbox, and approval still win over anything automode decides. The full pipeline order is in [docs/extensions.md](docs/extensions.md).

## Configuration

User-level configuration lives in one file, `~/.torus/config.json` (`config.json` under `TORUS_HOME` when set). The file is user-level by construction: a repository checkout cannot set it for a session. Each top-level section replaces a standalone legacy file:

| Section | Legacy file | Configures |
| --- | --- | --- |
| `chains` | `chains.json` | Model chains per tier plus compatible-provider endpoints |
| `automode` | `automode.json` | Auto permission-mode rules and circuit-breaker settings |
| `serve` | `serve.json` | HTTP server bind, port, and scheduled triggers (`tokenPath` stays in serve.json; auth is runtime state) |
| `keywords` | `keywords.json` | Keyword rows injected into the system prompt |
| `permissionMode` | none | Default permission mode, a top-level `"auto"` or `"default"` key |

A section present in config.json shadows its legacy file: torus serves the config section and warns, naming both files and pointing at `torus config migrate`. A section missing from config.json falls back to its legacy file, so you can move over one section at a time.

Single-value settings live in their own knob sections, one key each:

| Env var | Config key | Value |
| --- | --- | --- |
| `TORUS_APPROVAL` | `approval.enabled` | boolean |
| `TORUS_BANNER` | `ui.banner` | boolean |
| `TORUS_STATUSLINE_COST` | `ui.statuslineCost` | boolean |
| `TORUS_TITLE_MODEL` | `sessionTitle.titleModel` | string |
| `TORUS_GUARDS` | `guards.enabled` | boolean |
| `TORUS_MAX_TOOL_OUTPUT` | `guards.maxToolOutput` | number |
| `TORUS_HASHLINE` | `hashline.enabled` | boolean |
| `TORUS_FMT_CMD` | `hashline.fmtCmd` | string |
| `TORUS_INTERACTIVE` | `interactive.enabled` | boolean |
| `TORUS_MONITOR` | `monitor.enabled` | boolean |
| `TORUS_NOTIFY` | `notify.enabled` | boolean |
| `TORUS_COMMENT_CHECKER` | `commentChecker.enabled` | boolean |
| `TORUS_TEAM_NOTIFY` | `team.teamNotify` | boolean |
| `TORUS_TASK_STALE_MIN` | `team.taskStaleMin` | number |
| `TORUS_REFLECTION` | `reflection.enabled` | boolean |
| `TORUS_REFLECT_TURNS` | `reflection.reflectTurns` | number |
| `TORUS_DREAMING` | `reflection.dreaming` | boolean |

Precedence is config, then env, then flag: a config value beats the built-in default, a set env var beats config, and a launcher flag (which sets the env var for one session) beats both. A config value of the wrong type is ignored and the default applies. Plumbing that decides where state and processes live before config is read stays env-only: `TORUS_ROOT`, `TORUS_PI_BIN`, the `TORUS_ENGINE*` family, `TORUS_HOME`, `TORUS_STATE_DIR`, `TORUS_WORKTREES_ROOT`, `TORUS_PLATFORM`, `TORUS_MEMORY_COMMIT`, `TORUS_THEME_DEBUG`, `TORUS_SANDBOX`, `TORUS_SERVE`, and `TORUS_TMUX`. The remaining vars (`TORUS_TITLE`, `TORUS_PERMISSION_MODEL`, `TORUS_COMMENT_CHECKER_PROMPT`) are env-only too; [docs/extensions.md](docs/extensions.md) carries the full table.

A second, project-level `.torus/config.json` in the working directory may set the knob sections above plus the automode section's `deny` and `ask` keys only. For knobs the user file wins over the project file, and env still beats both. The automode contribution is additive: project `deny` and `ask` entries union with the user's rules, so a repository can guardrail sessions working in it (never force-push here, always ask before publishing) but never widen them; its `allow`, `environment`, `hardDeny`, `softDeny`, `softDenyExceptions`, and `classifyAllShell` keys are ignored with a notice, and `chains`, `serve`, `keywords`, and `permissionMode` never come from the project file (a checked-in repo cannot redirect model traffic, inject prompt keywords, or opt a session into automode). `torus config status` shows the project file, its readable sections, and any refused keys.

Inspect and fold the file with the launcher subcommand:

- `torus config status` prints each section's effective source: config.json, the legacy file, or default, plus any config.json keys outside the registry.
- `torus config migrate` prints the fold plan and writes nothing; `torus config migrate --yes` folds every legacy file that has no config.json section yet into config.json in one atomic write. Existing sections and unknown keys survive verbatim, and the legacy files are left in place, so nothing is destroyed.

## Where to go next

| Want | Read |
| --- | --- |
| Install as a pi package (extension pack) | [docs/pi-packages.md](docs/pi-packages.md) |
| Every tool, command, and env var | [docs/extensions.md](docs/extensions.md) |
| The agent contract (add an agent) | [docs/agents.md](docs/agents.md) |
| Skills import/export | [docs/skills.md](docs/skills.md) |
| Container usage and flags | [docs/container.md](docs/container.md) |
| Harness overhead vs stock pi | [docs/efficiency.md](docs/efficiency.md) |
| Releases and versioning | [docs/release-workflow.md](docs/release-workflow.md) |
| Threat model and guards | [SECURITY.md](SECURITY.md) |

## Developing torus

PRs welcome, especially new agents and skills (both drop-in). [CONTRIBUTING.md](CONTRIBUTING.md) covers the gate and PR mechanics; [AGENTS.md](AGENTS.md) has the full layout and conventions. `./make.sh check` is the full gate.

## Security & license

torus runs an agent with file, shell, and network access on your machine. Read [SECURITY.md](SECURITY.md) before pointing it at untrusted repositories. MIT, see [LICENSE](LICENSE).
