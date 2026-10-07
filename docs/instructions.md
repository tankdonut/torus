# Instruction files — AGENTS.md in torus

torus has one instruction file: the repo's `AGENTS.md`. Discovery belongs to pi, the engine torus runs on — torus adds no instruction-file handling of its own.

## What torus loads

At startup the engine walks from the working directory up through every ancestor directory (plus the agent directory for a global file), loading **one context file per directory**. All levels stack, outermost first — the nearest file does not replace farther ones.

Within each directory, the first existing candidate wins and the rest are ignored:

| Candidate | Notes |
|---|---|
| `AGENTS.override.md` | Replaces `AGENTS.md` in the same directory only |
| `AGENTS.md`, `AGENTS.MD` | The standard name |
| `CLAUDE.md`, `CLAUDE.MD` | Engine fallback — read **only** when the directory has no `AGENTS.md` variant |

torus never reads or writes `CLAUDE.md` itself; a repo that ships an `AGENTS.md` at a given directory never falls through to `CLAUDE.md` there. Subdirectories below the working directory are not scanned — not eagerly, not lazily on file reads — the chain is fixed at startup from cwd upward.

Delegated child agents (`agents/*.md`) run the same engine in the same working directory, so each child's system prompt carries the same discovered `AGENTS.md` chain as the parent session. Don't confuse this with the `{{AGENTS}}` marker in roster prompts: that substitutes the *agent roster* (the available-agents block) into a child prompt at spawn — see the Markers section of [agents.md](agents.md).

## Claude Code interop

Claude Code adopted `AGENTS.md` (v2.1.277+), with different precedence rules. For a repo shared between torus and Claude Code:

| Question | Claude Code behavior |
|---|---|
| When is `AGENTS.md` read? | Only when no `CLAUDE.md` exists in cwd **or any parent** — a `CLAUDE.local.md` or `.claude/CLAUDE.md` there also blocks (default mode `claude-md-or-agents-md`) |
| What does **not** block | User-level `~/.claude/CLAUDE.md`, org-managed `CLAUDE.md`, and `.claude/rules/` files load **alongside** `AGENTS.md` |
| Subdirectory files | Attach **lazily** — only when Claude Code reads a file in that subdirectory, and only if that subdirectory has none of the `CLAUDE.md` variants (per-directory either/or) |
| Config switch | `claude-md-or-agents-md` (default: either) or `claude-md-and-agents-md` (both, `CLAUDE.md` first per directory) |

Details: [Claude Code memory docs](https://code.claude.com/docs/en/memory). Note the shape differences from torus: Claude Code stops at the first instruction file from cwd upward, reads `.claude/AGENTS.md` but not `AGENTS.override.md`; pi stacks every ancestor level and does the reverse (`AGENTS.override.md` yes, `.claude/AGENTS.md` no). Neither engine lazily attaches nested files the way Claude Code does — pi attaches none, Claude Code attaches on subdirectory reads.

The [agents.md](https://agents.md) spec itself defines no precedence beyond "nearest file to the edited file wins" — everything above is tooling-specific behavior.

## Codex interop

Codex layers global `~/.codex/AGENTS.md` → repo root → subdirectory, concatenating all levels root-down (nearest last, so it overrides earlier guidance). See [Codex's AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md) — the same "one file at repo root" layout works unchanged in torus.

## Sharing a repo

- Keep **one `AGENTS.md` at the repo root** — every tool above finds it.
- Ship **no `CLAUDE.md`** — or accept that Claude Code will prefer it and stop reading `AGENTS.md` in that directory (workaround: its `claude-md-and-agents-md` mode loads both).
- Pull shared extras into `AGENTS.md` with mentions (e.g. `@path/to/file` imports where the target tool supports them) rather than duplicating instruction files per directory — torus ignores subdirectory files entirely.
