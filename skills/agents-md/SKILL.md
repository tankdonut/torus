---
name: agents-md
description: "Creates and maintains AGENTS.md project instruction files — tables over file trees, hard line budgets, verified commands. Use when asked to create or update AGENTS.md, initialize agent docs for a repo, or refresh instructions after structure/commands change."
---

# agents-md

Generate and maintain the smallest AGENTS.md that makes an agent effective in this repo. Two modes: **create** (no file exists) and **update** (file exists — refresh affected sections, never regenerate wholesale unless asked).

## Workflow

1. **Survey — delegate the sweep, keep the facts** (before writing anything):
   - **Baseline fanout — always two explorers in parallel** (torus_fanout):
     a. **Structure**: project layout and entry points, config files, test layout, generated/legacy/vendored areas; report Area|Purpose|Entry-point rows with concrete paths.
     b. **Axioms & invariants** (the init-deep pass): hunt the rules that are enforced but scattered — guard layers and blocked paths (safety-nets, protected basenames, husky/pre-commit gates), keyword or behavior gates, version pins and engine locks, architecture invariants (zero-build, pinned runtimes, live-source loading), env-driven behavior switches, and forbidden patterns (`grep -rnE "DO NOT|NEVER|ALWAYS|DEPRECATED"`). Each axiom is a Conventions-bullet candidate that must cite the path enforcing it.
   - **Scale-up fanout** for bigger repos (>100 source files, layered docs, multi-package): add explorers with single-brief missions — (c) command/CI/hook surface (manifests, Makefiles, workflows, pre-commit), (d) docs inventory (README/CONTRIBUTING/policy pages → External References rows), (e) per-subtree conventions where nested AGENTS.md files are candidates. Add a `librarian` pass only when external docs must be inventoried.
   - **Survey yourself in parallel** (main session, cheap reads): package manager (lock files + manifests), commands (`package.json` scripts, `Makefile`/`make.sh`, task runners, CI workflows), existing docs/policies (`README.md`, `CONTRIBUTING.md`, `docs/`, `SECURITY.md`), and — update mode — every existing AGENTS.md.
   - Never write a row an explorer didn't ground in a real path you can verify; an axiom without an enforcing path is a guess — drop it.
2. **Scope**: root `AGENTS.md` always; a nested one ONLY where a subtree has different commands or rules (own build/test entry, divergent conventions). Closest file wins; nested files must be strictly shorter than root.
3. **Write** the smallest useful file using the template and rules below.
4. **Verify** (the gate — a file that fails this is not done):
   - Every path in every table exists on disk.
   - Every command exists in its manifest/CI and runs (or its script target is confirmed present).
   - Line count within budget (below).
   - No row duplicates content that `README.md`/`CONTRIBUTING.md` already carry — reference it instead.
   - Every Conventions bullet names the config, hook, or path that enforces it.

## Template

````markdown
# Agent Instructions

## Commands
| Task | Command |
|------|---------|
| Test one file | `<file-scoped command>` |
| Lint one file | `<file-scoped command>` |
| Typecheck | `<command>` |

## Layout
| Area | Purpose | Entry point |
|------|---------|-------------|
| `src/foo/` | <one line> | `src/foo/index.ts` |

## External References
| Need | File |
|------|------|
| Setup | `CONTRIBUTING.md` |
| Architecture | `docs/architecture.md` |

## Conventions
- <one rule per bullet; only non-obvious rules>

## Commit Attribution
<only if the repo mandates an AI-attribution footer — quote its exact required form>
````

Omit any section that adds no non-obvious value.

## Rules

1. **Tables over file trees.** Never paste directory listings or tree diagrams. Structure is a table: Area | Purpose | Entry point. Same for commands, references, and conventions wherever more than one item exists.
2. **Budget**: root ≤ 60 lines, hard cap 100. Nested files ≤ half their parent's budget.
3. **File-scoped commands first** (test one file, lint one file); full builds only when no narrower command exists.
4. **Reference, never copy** — existing docs/policies go in External References, not duplicated prose.
5. **One rule per bullet**, rationale only when it prevents a likely mistake. No restating linter/formatter/typechecker config; no quality slogans; no listing installed skills or plugins.
6. **Real conventions only** — mined from configs, CI, and DO-NOT comments in the code, not guessed from generic practice.
7. **`CLAUDE.md` is a symlink** to `AGENTS.md` when a Claude-compatible entrypoint is needed — never a divergent copy.
8. **Update discipline**: when structure/commands/conventions change, refresh the affected table rows and prune stale rows first; do not rewrite unaffected sections; re-run the verification gate on every edit.

## Anti-patterns

- welcome text, intros, conclusions, rationale paragraphs
- directory trees, file listings, or prose describing "the project structure"
- project-wide commands where file-scoped ones exist
- nested AGENTS.md repeating root instructions
- content duplicated from README/CONTRIBUTING/policy docs
- unverified commands or paths (if it can't be confirmed, it doesn't go in)
