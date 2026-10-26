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

Open with `/roster`, then delegate something small and watch it in the tmux pane and the **alt+t** fleet view. The walkthrough lives in [docs/getting-started.md](docs/getting-started.md).

## Permission modes

torus starts guarded in default mode; automode adds an opt-in classifier for unattended work, and bypass disables every guard for one deliberate launch. The modes, the rules example, and the narrative live in [docs/getting-started.md](docs/getting-started.md).

## Configuration

User-level configuration lives in one file, `~/.torus/config.json` (`config.json` under `TORUS_HOME` when set). Every section, knob, env var, and config-adjacent file is documented in [docs/configuration.md](docs/configuration.md). Run `torus config status` to see each section's effective source, including a project-level `.torus/config.json`.

## Where to go next

| Want | Read |
| --- | --- |
| Install as a pi package (extension pack) | [docs/pi-packages.md](docs/pi-packages.md) |
| Every tool, command, and env var | [docs/extensions.md](docs/extensions.md) |
| The agent contract (add an agent) | [docs/writing-agents.md](docs/writing-agents.md) |
| Skills import/export | [docs/skills.md](docs/skills.md) |
| Container usage and flags | [docs/container.md](docs/container.md) |
| Harness overhead vs stock pi | [docs/efficiency.md](docs/efficiency.md) |
| Releases and versioning | [docs/release-workflow.md](docs/release-workflow.md) |
| Threat model and guards | [SECURITY.md](SECURITY.md) |

## Developing torus

PRs welcome, especially new agents and skills (both drop-in). [CONTRIBUTING.md](CONTRIBUTING.md) covers the gate and PR mechanics; [AGENTS.md](AGENTS.md) has the full layout and conventions. `./make.sh check` is the full gate.

## Security & license

torus runs an agent with file, shell, and network access on your machine. Read [SECURITY.md](SECURITY.md) before pointing it at untrusted repositories. MIT, see [LICENSE](LICENSE).
