# torus

A multi-agent coding harness on the pinned stock [pi](https://github.com/earendil-works/pi) engine: a lead session that delegates to a roster of specialist agents — builder, explorer, librarian, reviewer, … — with live visibility into everything they do.

torus owns the harness layer — roster, delegation, ambient UI, memory. The engine beneath it is a pinned, replaceable dependency.

## What you get

- **Delegation & teams** — hand work to any agent with `/<agent> <task>`, or let the session delegate: parallel fan-outs, sequential pipelines, and persistent teams with shared tasklists that survive restarts.
- **Live visibility** — every delegation opens a tmux pane tailing what the agent does, live statusline entries, and **alt+t**, a fleet browser with live transcripts — steer (`s`) or stop (`x`) a running agent mid-run.
- **Persistent memory** — git-backed notes injected into future sessions; `/reflect` distills a session into durable memory, and `/goal` pins a standing objective.
- **Personas** — the main session itself runs as any roster agent (**alt+p** to cycle); every agent is both a persona and a delegatable child.
- **Open-standard skills** — skills follow the [Agent Skills](https://agentskills.io) standard: they work in Claude Code and Codex unchanged, and external skills drop into `~/.agents/skills/`.
- **Guards by default** — context-integrity guards, credential redaction in delegation logs, and a read-only dreamer for memory writes; the full threat model is [SECURITY.md](SECURITY.md).

## Quickstart

From source (Node per `engines.node`; tmux optional — delegation panes only appear inside tmux):

```sh
git clone https://github.com/tankdonut/torus.git && cd torus
./make.sh npmrc      # one-time; agent-blocked by design
npm install
./runtime/bin/torus.mjs
```

Authenticate the built-in GLM provider with `/login zai` on first run.

In a container — full toolchain, no host install:

```sh
docker run --rm -it -v "$PWD:/workspace" ghcr.io/tankdonut/torus
```

As a single binary — download from [releases](https://github.com/tankdonut/torus/releases) (`torus-<os>-<arch>`, `chmod +x`); the first launch self-bootstraps the runtime. Or load just the extension pack into a stock pi: `pi install git:github.com/tankdonut/torus@vX.Y.Z` — take only part of it via consume-time filtering; see [docs/pi-packages.md](docs/pi-packages.md).

## First five minutes

1. `/roster` — the agents, their model chains, and credentialed providers.
2. Delegate something small: `/explorer where does the roster load from?` — watch the right-hand pane, then **alt+t** for the live transcript.
3. Say `team` in a message (or `ultrawork`, `hyperplan`) — keyword gates switch the session's execution mode.
4. `/goal` to pin a standing objective; `/reflect` to distill the session into memory.

## Where to go next

| Want | Read |
|---|---|
| Every tool, command, and env var | [docs/extensions.md](docs/extensions.md) |
| The agent contract (add an agent) | [docs/agents.md](docs/agents.md) |
| Skills import/export | [docs/skills.md](docs/skills.md) |
| Container usage and flags | [docs/container.md](docs/container.md) |
| Harness overhead vs stock pi | [docs/efficiency.md](docs/efficiency.md) |
| Releases and versioning | [docs/release-workflow.md](docs/release-workflow.md) |
| Threat model and guards | [SECURITY.md](SECURITY.md) |

## Developing torus

PRs welcome — especially new agents and skills, both drop-in. [CONTRIBUTING.md](CONTRIBUTING.md) covers the gate and PR mechanics; [AGENTS.md](AGENTS.md) has the full layout and conventions. `./make.sh check` is the full gate.

## Security & license

torus runs an agent with file, shell, and network access on your machine — read [SECURITY.md](SECURITY.md) before pointing it at untrusted repositories. MIT, see [LICENSE](LICENSE).
