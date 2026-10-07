# Contributing to torus

PRs welcome — especially **new agents** and **new skills**, both designed as drop-in surfaces (a file in `agents/` or `skills/`). Issues are equally welcome: bug reports with a transcript snippet, or ideas for roster agents.

## Setup

```sh
git clone https://github.com/tankdonut/torus.git && cd torus
./make.sh npmrc   # one-time; .npmrc is agent-blocked by design, humans create it
npm install
```

Run `./runtime/bin/torus.mjs` and work against a real repo.

## The gate

`./make.sh check` runs typecheck + lint + test + smoke. The husky pre-commit hook runs typecheck + lint + test on every commit — if it passes locally, CI won't surprise you. Auto-fix formatting with `npm run lint:fix`.

## PR mechanics

Squash-merge is the rule, and **your PR title becomes the release commit verbatim** — release-please maps it to a version bump and changelog entry:

| Subject | Effect |
|---|---|
| `feat:` | minor bump, Features in changelog |
| `fix:` | patch bump, Bug Fixes in changelog |
| `chore:` `docs:` `test:` `ci:` | no bump, no changelog entry |
| `!` or `BREAKING CHANGE:` footer | minor while 0.x, major after 1.0 |

Details and rationale: [docs/release-workflow.md](docs/release-workflow.md).

## Gotchas

- A new extension needs both a `extensions/registry.ts` entry and the `pi.extensions` array in `package.json`.
- [docs/extensions.md](docs/extensions.md) is coverage-tested (`tests/docs-coverage.test.mjs`) — document new tools, commands, and env vars in the same PR.
- `agents/*.md` and `skills/*/SKILL.md` are contract-tested (`tests/agents-contract.test.mjs`, `tests/skills-spec.test.mjs`); the contracts live in [docs/agents.md](docs/agents.md) and [docs/skills.md](docs/skills.md).

## Everything else

[AGENTS.md](AGENTS.md) has the full layout, commands, and conventions. Security reports: [SECURITY.md](SECURITY.md).
