# Internals

torus maintainer ledger: upstream issue tracking, build mechanics, and module wiring. The site deliberately does not render this page.

## srt upstream ledger

These notes describe the pinned `@anthropic-ai/sandbox-runtime`; `package.json` carries the exact pin. The user-facing sandbox reference lives in [docs/extensions.md](extensions.md).

Known srt gaps: unreliable signal/exit-code propagation (upstream #602/#603/#635/#610), no SIGWINCH on Linux (#642), macOS raw-mode TUIs need `allowPty` (#480).

- **User namespaces:** A Linux sandboxed command cannot create user or mount namespaces. Commands that sandbox themselves that way (rootless podman, Chromium's namespace sandbox, a nested bubblewrap) fail with `EPERM`. The upstream opt-out is `allowNestedUserNamespaces`, which torus does not expose.
- **Write precedence:** A `denyWrite` entry takes precedence over a nested `allowWrite`.
- **Credential files:** With `credentials.files` configured, an `allowRead` or `allowWrite` entry covering that path grants nothing.
- **aws-vault:** Its keyring backends need D-Bus and gpg sockets, which the sandbox blocks. Run `aws-vault exec` outside sandboxed bash (`interactive_bash` is never wrapped) and let only the resulting environment reach the sandbox.
- **Upstream watch items:** srt #738 (Node's built-in fetch ignores the sandbox proxy); srt #714 (masked credentials can round-trip via request bodies); srt #654 (`/tmp/claude` is shared across concurrent sandboxes).

## Shared modules

| Module | Provides | Consumers |
| --- | --- | --- |
| `extensions/registry.ts` | DelegationRecord store (globalThis-hosted), run beacons + foreign-process scan, team records, session/persona slots, log rehydration, tmux pane mgmt, `repoRoot()`, sanitize/redact/shellQuote/name gates | roster, team, browser, fleet, notify, memory, goal, prompts, ui, engine-child |
| `extensions/rpc.ts` | `RpcChild`: newline-JSON RPC client for engine children (prompt/steer/getState/kill) | roster, team-runtime, acp (serve) |
| `extensions/engine-child.ts` | `engineChildEnv` (sets `TORUS_ENGINE_CHILD=1`, carries the pinned `TORUS_STATE_DIR`), event parse/reduce, `childExtensionArgs` (the child set), `resolveEngineBin` | roster, team-runtime, doctor, ui, acp (serve) |
| `extensions/team-runtime.ts` | Team spec persistence, mailboxes, locked tasklist, member supervisor | team |
| `extensions/frontmatter.ts` | `---` header parser/stripper | roster, prompts, memory |
| `extensions/fsutil.ts` | `TORUS_HOME`, `TORUS_STATE_DIR` export + `displayPath`, best-effort readJson, atomic writeJson, sleep, splitList | registry, memory, goal, worktrees, prompts, team-runtime, ui |
| `extensions/osnotify.ts` | notify-send toasts (summary+body, @handle label, duration/preview/stats; grouped under a torus desktop entry; running-late ping after 45s, replaced in place by the finish toast via replaces-id; suppressed per member on team_delete in favor of one combined shutdown toast; failures critical+persistent, low-value toasts transient); `TORUS_NOTIFY=0` opt-out | registry, monitor, notify |
| `extensions/persona-theme.ts` | Persona-colored editor border | prompts |
| `extensions/transcript.ts` | Session transcript location/parsing, live tail | browser |
| `extensions/fleet/theme-kit.ts` | Shared fleet rendering (colors, spinner, tokens, icons) | browser, fleet, notify, roster |
| `extensions/hashline/core.ts` | Anchor hashing/parsing/edit semantics | hashline |
| `extensions/platform.ts` | Platform vocabulary, `PLATFORM_SUPPORT` and `GateDecision` types, `currentPlatform()` honoring `TORUS_PLATFORM`, `gateExtension()` load gate recording decisions on a shared slot with one-time skip notices, `platformDecisions()` for `/doctor`; never throws | every extension module, doctor |

## Container build mechanics

The user-facing image reference lives in [docs/container.md](container.md).

```sh
./make.sh image        # builds the Dockerfile, tags torus:dev (pins from .tool-versions)
./make.sh image-test   # container test suite against torus:dev (TORUS_IMAGE=<tag> to override)
```

The suite's static drift guards (Dockerfile ARG pins, runtime deps, entrypoint/user, baked payload wiring, CI job shape) run in plain `npm test` with no docker. The dynamic smokes need a docker daemon: engine boots keyless (also verified offline via `--network none`), tool inventory, tmux, bwrap.

The first GHCR publish creates the package as private by default. The owner marks it public once in the package settings.
