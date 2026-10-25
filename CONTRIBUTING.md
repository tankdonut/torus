# Contributing to torus

PRs welcome, especially **new agents** and **new skills**, both designed as drop-in surfaces (a file in `agents/` or `skills/`). Issues are equally welcome: bug reports with a transcript snippet, or ideas for roster agents.

## Setup

```sh
git clone https://github.com/tankdonut/torus.git && cd torus
./make.sh npmrc   # one-time; .npmrc is agent-blocked by design, humans create it
npm install
./runtime/bin/torus.mjs
```

Prerequisites and the other install paths: the [README quickstart](README.md#quickstart).

## The gate

`./make.sh check` runs typecheck + lint + test + smoke (boots the launcher keyless: `node runtime/bin/torus.mjs --list-models`). The husky pre-commit hook runs typecheck + lint + test on every commit. If it passes locally, CI won't surprise you. Auto-fix formatting with `npm run lint:fix`.

## PR mechanics

Squash-merge is the rule, and **your PR title becomes the release commit verbatim**. release-please maps it to a version bump and changelog entry: `feat:` bumps the minor, `fix:` the patch, `!` or a `BREAKING CHANGE:` footer is breaking (minor while 0.x, major after 1.0), and `chore:`, `docs:`, `test:`, `ci:` bump nothing.

The scope is optional and never changes the bump: `fix(extensions/hashline):` names one item, `fix(agents):` the whole area, no scope for cross-cutting changes. Copy scope names from the repo's directory segments. Since your PR title becomes the commit verbatim, the scope belongs in the title.

Details, rationale, and the full subject-to-effect table: [docs/release-workflow.md](docs/release-workflow.md).

## Gotchas

- A new extension needs both a `extensions/registry.ts` entry and the `pi.extensions` array in `package.json`.
- [docs/extensions.md](docs/extensions.md) is coverage-tested (`tests/docs-coverage.test.mjs`). Document new tools, commands, and env vars in the same PR.
- All hand-written docs follow [docs/style.md](docs/style.md); `tests/docs-style.test.mjs` and markdownlint (via `npm run lint`) enforce its rules.
- `agents/*.md` and `skills/*/SKILL.md` are contract-tested (`tests/agents-contract.test.mjs`, `tests/skills-spec.test.mjs`); the contracts live in [docs/agents.md](docs/agents.md) and [docs/skills.md](docs/skills.md).

## Everything else

[AGENTS.md](AGENTS.md) has the full layout, commands, and conventions. Security reports: [SECURITY.md](SECURITY.md).
