# Agent Skills portability — `skills/`

torus's skills (`skills/*/SKILL.md`) follow the [Agent Skills](https://agentskills.io) open standard. Compliance is machine-enforced by `tests/skills-spec.test.mjs`: one directory per skill containing exactly one `SKILL.md`, `---`-delimited frontmatter plus a non-empty markdown body, a `name` matching the directory (`^[a-z0-9-]{1,64}$`), a required `description` (≤1024 chars), and only the spec's optional fields beyond those two.

## Skill layout

| Piece | Required | Notes |
|---|---|---|
| `SKILL.md` | yes | Frontmatter (`name`, `description`) + instructions |
| Supporting files | no | `scripts/`, `references/`, `assets/` — whatever the skill ships (`torus-research` carries `assets/` and `bin/`) |

This is the spec's layout, so a skill moves between agents as a plain directory copy — no adapter, no conversion.

## Export — to Claude Code or Codex

Copy any `skills/<name>/` directory to the target agent's skills location:

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/skills/<name>/` |
| Codex | `~/.agents/skills/<name>/` |

The skill works unchanged: `SKILL.md` plus optional scripts, references, and assets are spec layout. See Claude Code's [skills documentation](https://code.claude.com/docs/en/skills).

## Import — external skills in torus

Drop any Agent-Skills-standard skill into:

- `~/.agents/skills/` — user-global, available in every session
- `.agents/skills/` — project-local

pi — the engine torus runs on — discovers these natively: project `.agents/skills/` directories are scanned from the working directory through its ancestors, stopping at the repository root when one exists. No torus code is involved; a discovered skill's name, description, and path enter the system prompt at startup like a bundled skill.

## Name collisions

| Agent | Same-name resolution |
|---|---|
| Claude Code | Tiered precedence: enterprise > personal > project |
| pi / torus | No tiers — the first discovered skill wins (a warning notes the collision) |

Keep skill names unique when sharing between agents; nothing re-ranks them for you.

## Delegation

Skills forward to delegated children via the delegation `skills` parameter — see the Delegation section of the [README](../README.md).
