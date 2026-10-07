# torus as a pi package

torus is installable as a pi package: one git source that loads the extension pack, the skills, and the agent roster into a stock [pi](https://github.com/earendil-works/pi) — the same engine torus runs on. This page records what installs, how versioning and updates behave, and how to take only part of the pack. Running the full harness (launcher, binary, container image) is a different consumption model — see the [README](../README.md) and [release-workflow.md](release-workflow.md).

## What the package carries

The `pi` key in [`package.json`](../package.json) is the manifest, and that file is the source of truth for what loads — this page does not recount it:

- `pi.extensions` — the torus extensions plus the bundled third-party packs (`cc-safety-net`, `pi-web-access`, `pi-lsp-client`).
- `pi.skills` — `./skills`, the Agent-Skills-standard skill directories (see [skills.md](skills.md)).
- `keywords` carries `pi-package`, the keyword that makes a package discoverable in the [Pi package gallery](https://pi.dev/packages) once published to npm — torus is not on npm; see [npm, deliberately closed](#npm-deliberately-closed).

Dependency shape, per pi's package rules:

| Kind | Packages | Why |
|---|---|---|
| `peerDependencies` | `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` | Host-provided — pi supplies them at load time; bundling a copy would duplicate engine classes and registries |
| `dependencies` | `cc-safety-net`, `pi-web-access`, `pi-lsp-client` | Third-party extensions the pack wires in — a git-source install installs and connects them |

The roster rides along without launcher support: the `roster` extension resolves the repo root with a find-up scan for this repo's `package.json` (`repoRoot()` in `extensions/registry.ts`), and a package checkout is its own root — so the `agents/*.md` personas load from the checkout under stock pi. (`TORUS_ROOT` is a torus-launcher override; it is not set in this consumption model.)

## Install and update

```
pi install git:github.com/tankdonut/torus@vX.Y.Z
```

- The tag is pinned. Git sources record their ref, and `pi update --extensions` reconciles the checkout to the configured ref without moving it — upgrading is installing the new tag. Pi identifies a git package by repository URL without the ref, so the new declaration replaces the old one in place.
- The declaration lands in `~/.pi/agent/settings.json` (personal); `--local` writes it to the project's `.pi/settings.json`, which pi reads only after project trust is granted.
- `pi list` shows configured packages; `pi remove git:github.com/tankdonut/torus` removes this one.
- Like any package, this one executes extension code — review the source (this repository) before installing; the harness threat model is [SECURITY.md](../SECURITY.md).

## Consume-time granularity

torus is one package and stays one package. Granularity is not repo splitting — it is filtering at load time, through the settings object form of the package declaration. Filters narrow the manifest: they select from what `package.json` declares and never expose more.

| Form | Effect |
|---|---|
| omit the property | load everything the package declares of that type |
| `[]` | load none of that type |
| `!pattern` | exclude glob matches |
| `+path` | include one exact allowed path |
| `-path` | exclude one exact path |

Only the skills — extensions off:

```json
{
	"packages": [
		{
			"source": "git:github.com/tankdonut/torus@vX.Y.Z",
			"extensions": []
		}
	]
}
```

Everything but the roster:

```json
{
	"packages": [
		{
			"source": "git:github.com/tankdonut/torus@vX.Y.Z",
			"extensions": ["!extensions/roster"]
		}
	]
}
```

Excluding `roster` also drops the personas — `agents/*.md` load through that extension.

Drop specific extensions:

```json
{
	"packages": [
		{
			"source": "git:github.com/tankdonut/torus@vX.Y.Z",
			"extensions": ["-extensions/notify", "-extensions/goal"]
		}
	]
}
```

Or whitelist — `+path` entries name exact allowed paths:

```json
{
	"packages": [
		{
			"source": "git:github.com/tankdonut/torus@vX.Y.Z",
			"extensions": ["+extensions/memory", "+extensions/todo", "+extensions/work"]
		}
	]
}
```

`pi config` flips discovered resources interactively (Tab switches scope) — the same narrowing without hand-editing settings.

## npm, deliberately closed

The npm channel is closed on purpose (decision recorded in [release-workflow.md](release-workflow.md) §6):

- the unscoped name `torus` on the npm registry belongs to another owner;
- the shipped artifact is a compiled binary plus a container image, not a node package;
- `"private": true` in `package.json` makes an accidental `npm publish` impossible.

What would change it: extension-pack consumers materializing and the [gallery](https://pi.dev/packages) mattering enough to justify a scoped `@tankdonut/torus`. That is mechanically cheap through the existing release automation, at the cost of publish metadata, an npm token, and one more version-consistency surface. The `pi-package` keyword is already in place, so the package is gallery-eligible the day that happens. Until then, git-source is the channel.

## Skills travel without torus

Skills follow the [Agent Skills](https://agentskills.io) open standard, so they are portable independently of this package: copying `skills/<name>/` to another agent's skills location works with no torus installed at all. Import and export locations, and same-name collision rules, are in [skills.md](skills.md).
