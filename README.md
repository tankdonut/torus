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

torus starts in default mode: guards, sandboxing, and approval prompts judge tool calls as they run. Automode is an opt-in permission layer for unattended work: a decision model classifies each bash command, approves the safe ones, and asks before anything risky. Turn it on with `torus --permission-mode auto` or `TORUS_PERMISSION_MODE=auto`; `1` and `on` also select it, while unset, `0`, `off`, and `default` keep the built-in gate. `/automode` reports the live status and switches the current session.

Your rules run first, from `~/.torus/automode.json`:

```json
{
  "deny": ["git push --force*", "npm publish*"],
  "ask": ["git push*", "npx *"],
  "allow": ["npm test*", "node --test*"]
}
```

Entries are prefix patterns, evaluated in deny, ask, then allow order. Broad allow entries such as `*` match nothing and draw a warning at load. A fixed ask floor outranks every allow rule. It covers `sudo` and `su`, recursive forced `rm` on root or home paths, force pushes, recursive `chmod` or `chown` on root paths, and command substitution; floored commands ask no matter what the rules say.

Read-only commands such as `ls`, `git status`, and version probes pass without a model call. An "Always this session" answer replays without asking again. Three consecutive decision-model denies switch the session to asking for everything.

The judge is a classifier model. Pin one with `TORUS_PERMISSION_MODEL=provider/model-id`. Without a pin, automode takes the first available classifier, such as `typesafe/jev-latest` behind a `TYPESAFE_API_KEY` or a local decision model from a llama.cpp router; a local router works offline with no API key.

With no classifier reachable, the session model judges the command in one shot. If every model path fails, the command still runs unjudged, and its tool result carries an `[automode]` notice.

Every decision appends one JSON line to `~/.torus/automode.log` for review. Automode only adds gates: denials from guards, `cc-safety-net`, sandbox, and approval still win over anything automode decides. The full pipeline order is in [docs/extensions.md](docs/extensions.md).

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
