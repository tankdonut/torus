# Release workflow: semantic versioning for torus

Status: **implemented**. This document laid out torus's release workflow from first principles. The design now ships in-repo: release-please automation (§4), the tag-gated release job (§5), and version stamping. The `Release-As` bootstrap landed as `v0.1.0`, and tag-driven releases continue per §4–§5 (current version: `package.json`). Items marked **[DECISION]** record settled choices and their reasoning; §10 records each question's resolution, with one still open.

## 1. First principles

**What a release of torus is.** torus is distributed as (a) a single self-contained compiled binary and (b) a container image on `ghcr.io/tankdonut/torus`. A *release* is the act of cutting one named, immutable, verifiable version of both artifacts, anchored to a git tag, with notes explaining what changed. Everything else (the npm package under this repo's `package.json`) is a development harness, not a distribution channel (§6).

**Who consumes a version.** Today: the maintainer's own machines (binary) and container users pulling from GHCR (image; `latest` is already live). The repo is public, so assume unknown third parties arrive over time.

**What the version number means.** SemVer §4: `0.y.z` is initial development; anything MAY change. The de-facto contract consumers experience is npm's resolver semantics: `^0.3.0` means `>=0.3.0 <0.4.0-0`, i.e. **a 0.x minor bump is breaking for range consumers**. torus adopts that doctrine explicitly:

> **[DECISION] 0.x doctrine:** `0.MINOR.PATCH`: minor bumps may break (CLI flags, extension contracts, config); patch bumps are fixes only. `1.0.0` is a deliberate future commitment to API stability, not something an automation tool decides.

## 2. Version fan-out: one number, four surfaces

A single version `X.Y.Z` flows from one source of truth to every artifact:

| Surface | Form | Mechanism |
| --- | --- | --- |
| `package.json` `version` | `X.Y.Z` | **Source of truth**: moved only by the release flow (§4), never hand-edited |
| Git tag | `vX.Y.Z` | Created by release automation via the GitHub API (not annotated; the Release carries the notes); anchors the GitHub Release |
| GitHub Release | notes + 5 platform binaries + `sha256sums.txt` | CI release job attaches binaries built from the tag's SHA |
| Container image | `ghcr.io/tankdonut/torus:X.Y.Z` + `:X.Y` | Already wired: CI `docker/metadata-action` derives both from a `v*` tag |
| Binary self-report | `torus --version` → `X.Y.Z (+ engine pin)` | Version stamped into the payload manifest at build time (§5) |

The `v`-prefix tag convention is fixed by what already exists: `metadata-action`'s `type=semver` expects `vX.Y.Z` and the current CI push gate (`main || refs/tags/v*`) keys on it.

## 3. Bump rules

**Commit-driven.** History is squash-merged with conventional subjects (`feat:`, `fix:`, `chore:`, `docs:`), which maps directly (Conventional Commits v1.0.0):

- `fix:` → patch
- `feat:` → minor (during 0.x: the breaking-capable channel, per §1 doctrine)
- `BREAKING CHANGE:` footer or `!` → **minor while 0.x** (never an automated jump to 1.0.0), major after 1.0
- everything else (`chore:`, `docs:`, `test:`, `ci:`, unknown types) → no bump on its own; rides the next feat/fix

**[DECISION] Scopes carry no bump semantics.** Subjects may carry a Conventional Commits scope (`feat(extensions/hashline):`, `fix(agents):`); release-please ignores it for versioning, so `feat(anything):` is still the minor channel and `fix(anything):` still patch. Scopes exist for history readability. Convention: `area/name` when the change stays inside one item of an area (`fix(extensions/hashline):`, `feat(agents/leader):`), the bare area when it spans the area (`fix(agents):`, `chore(tests):`), no scope for cross-cutting work. Scope names copy the repo's directory segments so each area keeps one canonical spelling. `deps` is reserved for dependency bumps: the engine-pin rule below and Renovate's `commitMessagePrefix` prefixes.

**[DECISION] Engine-pin bumps are user-visible features, not chores.** Every binary and image ships the pinned engine (`@earendil-works/pi-coding-agent`), and first-run installs exactly that pin: an engine bump changes runtime behavior for every consumer. Rule: a PR that moves the engine pin (typically Renovate's) must land with a `feat(deps):` subject (or `feat(deps)!:` when the engine's own changelog says breaking). It then correctly drives a minor bump and appears in the changelog instead of riding silently as a patch-level `chore(deps):`.

**Engine-pin env audit (`env-hygiene`).** Every engine-pin bump re-runs `tests/env-hygiene.test.mjs` and re-verifies the launcher→child environment chain against the new engine's `.env` autoload behavior before merge. torus itself passes the environment through untouched (`runtime/bin/torus.mjs` spawn, `extensions/engine-child.ts` `engineChildEnv()`); the engine is the risk: 1.0.4 standalone binaries autoload launch-dir `.env*`, and upstream main (commit `1ffb6bd6`) removes that, so a bump can silently flip what environment a torus session starts with.

**Engine-pin MCP audit (`mcp-audit`).** Every engine-pin bump also runs `tests/mcp-stateless.test.mjs` before merge: a stateless stdio MCP fixture server (newline-delimited JSON-RPC, no session state) registered in a project `.pi/mcp.json`, connected through a real engine session, with a model-driven tool round-trip and a clean-timeout check for an unresponsive server. A failing run means the new pin's MCP client (protocol revision, stdio framing, `mcp.json` semantics) drifted from what torus documents: re-verify the `MCP spec status` note in `docs/extensions.md` against the new engine's `docs/mcp.md` and adjust the test fixture with the protocol changes.

**What counts as breaking (the public API surface):** CLI flags/commands and exit codes of `torus` itself; the extension load surface (`pi.extensions` entries and extension-module contracts); agent roster and skill file formats; payload bootstrap behavior (`~/.torus/runtime` layout, resolution order, first-run semantics); container entrypoint/`TORUS_ROOT` contract. Changes to any of these during 0.x → minor (post-1.0: major).

## 4. Release mechanism: release-please with a Release PR

**[DECISION] release-please** (GitHub App or workflow), configured for this repo's shape. Rationale over alternatives:

- **semantic-release**: has no 0.x handling at all: a breaking change on 0.3.0 unconditionally publishes 1.0.0 (`semver.inc("0.3.0","major")`). Violates §1 by construction. Rejected.
- **changesets**: exact human control, but a changeset file per PR is ritual a solo maintainer doesn't need when conventional subjects already carry the signal. Rejected for now.
- **Hand-rolled cut target** (`make.sh release`): viable fallback (~same manual cost), but no generated changelog and hand-maintained version bumping; more drift surface. Runner-up; nothing in this doc prevents adopting it later.

Configuration essentials:

- `bump-minor-pre-major: true`: breaking changes on 0.x bump the minor, not to 1.0.0. The 1.0.0 transition is a human act (a `Release-As: 1.0.0` note when the API is ready to commit).
- **Bootstrap for a zero-tag repo:** seed `.release-please-manifest.json` with `"." : "0.3.0"` and `bootstrap-sha: e2e4cb46` (the squashed init commit), so the first changelog starts from real post-init history and ignores nothing important. The first Release PR carries a `Release-As: v0.1.0` note, resetting the untagged `0.3.0` drift to the maintainer's chosen starting point: `package.json` (and lockfile) land at `0.1.0` in the release commit itself.
- Squash-merge + release-please is the explicitly recommended pairing.

**Per-release cost to the maintainer: one action.** Open the Release PR when ready, review it (version bump + generated CHANGELOG.md + release notes), merge. Automation then tags `vX.Y.Z`, creates the GitHub Release, and hands off to the CI release job through the §5 trigger bridge (a token-created tag does not fire `on: push` on its own). Nothing depends on the local machine; the whole path is cold-re-runnable after months idle.

**Changelog:** release-please maintains a generated `CHANGELOG.md` in-repo as part of each Release PR and mirrors it into the Release body. Generated, never hand-edited; hand-maintained changelogs rot.

## 5. Release job: what CI does on `v*` tag push

One trigger-chain fact drives this design: release-please creates the tag with the default `GITHUB_TOKEN`, and events created by `GITHUB_TOKEN` do not start workflow runs, so the tag push does **not** fire `ci.yml`'s bare `on: push` by itself. Without a bridge, the release below silently no-ops: no binaries attached, and the versioned `X.Y.Z`/`X.Y` GHCR tags never push (the container pipeline would keep firing on main pushes only).

**[DECISION] Bridge: `workflow_dispatch`.** Add `workflow_dispatch` to `ci.yml`'s triggers; the release-please workflow's final step dispatches `ci.yml` with `ref: vX.Y.Z` (`GITHUB_TOKEN` may trigger `workflow_dispatch`). The dispatched run checks out the tag ref, so the same-run artifact identity below holds unchanged, and a manually pushed tag still fires `on: push` natively, so both paths converge. (Rejected alternatives: hosting the build matrix inside the release-please workflow gated on `release_created`: duplicates the heavy build/container jobs; a GitHub App token so the tag push fires natively: extra credential surface for a solo maintainer.)

Inside that tag-ref run, one new job completes it, gated `if: startsWith(github.ref, 'refs/tags/v')` so main-push runs never publish:

1. **Gating:** `needs: [lint-typecheck, smoke, build, container-publish]`: publish only when everything is green, from the tag's SHA. Never publish on red. (The existing build matrix already compiles all 5 targets *from the tag*; the release job downloads that run's artifacts rather than reusing main-tip artifacts, which is the same SHA by construction. `container-publish` transitively gates on the container test suite and both platform builds.)
2. **Attach:** create/update the GitHub Release with the 5 binaries (`torus-<os>-<arch>[.exe]`) + a `sha256sums.txt`.
3. **Version consistency assertion:** verify `tag == package.json version == torus --version from the built linux binary == image tag pushed by the container pipeline`. A mismatch fails the release loudly (this is the anti-version-skew tripwire).
4. **[DECISION] Attestation from day one:** `actions/attest-build-provenance` (needs `id-token: write`) for binaries + image: one step, no keys, verifiable by anyone via `gh attestation verify`. Cutting it saves one workflow line; not worth it.

**Version stamping** (implemented): `runtime/bin/torus.mjs` intercepts `--version` before engine passthrough, printing torus version + engine pin; `scripts/payload-manifest.mjs` includes the repo `package.json` version in the payload manifest (folded into the payload hash, so version changes re-extract and self-heal `~/.torus/runtime` on next launch). The `/doctor` extension reports the same torus-version line.

## 6. Channels

- **Binary: GitHub Releases only.** Install = download from the Release for your platform, make it executable. Upgrade = replace the file (payload hash change self-heals the runtime). No install script for 0.x; revisit at 1.0 if third-party demand shows up.
- **Image: GHCR, already live.** `X.Y.Z` and `X.Y` tags are immutable once pushed (never re-point them; rollback = older tag). **[DECISION] `latest` keeps tracking `main`** (today's documented behavior in `docs/container.md:3`) as the dev channel through 0.x: it's the maintainer's own dogfood channel and CI-built either way. Stable consumers pin `X.Y` or `X.Y.Z`. Flip `latest` to track releases at 1.0, when "latest stable" starts meaning something.
- **pi package (git-source): live at v0.1.0, zero maintenance.** `pi install git:github.com/tankdonut/torus@vX.Y.Z` loads torus's extensions, skills, and roster into a stock pi: the extension-pack consumption model, distinct from running the harness itself. Git sources are ref-pinned and reconciled on update; the channel activates the moment the tag exists. No publish step, nothing to maintain.
- **npm: not a channel. [DECISION]** The unscoped name `torus` is taken on the registry by another owner, and the shipped artifact is a compiled binary, not a node package. Set `"private": true` in `package.json` so `npm publish` can never fire by accident. Revisit `@tankdonut/torus` only if extension-pack consumers materialize and the [pi package gallery](https://pi.dev/packages) matters (the `pi-package` keyword already makes it eligible); mechanically cheap via release-please, but it adds `publishConfig`/`files`/`repository` metadata, an npm token, and another version-consistency surface.

## 7. Upgrade & rollback semantics

- **Binary:** replace with the new one. New payload hash → re-extract + one `npm install` in `~/.torus/runtime` (self-heal, seconds). A pinned engine version that lingers from an older payload produces a drift warning, not breakage; documented recovery remains `rm -rf ~/.torus/runtime`.
- **Rollback:** re-download the previous tag's binary from Releases; or pin the previous image tag. Tags and Releases are immutable; rolling back never repaints history.
- **Engine availability:** the pin lives in `devDependencies` and the payload manifest; npm does not delete published versions. A pinned engine vanishing upstream is not a realistic failure mode for rollback purposes; a *broken* pinned engine is handled by a patch release moving the pin.

## 8. Honest limitations (accepted for 0.x)

- Only `linux-x64` binaries are smoke-executed in CI; darwin/windows/arm64 are cross-compiled, not run. Accepted explicitly. Adding macos/windows runners is a §10 question, not a blocker.
- Locally built images (`./make.sh image`) differ from CI-built published ones (builder, cache, base resolution). **CI is the only publisher**; local builds are dev-only. (This also sidesteps the local podman-shim vs runner divergence entirely.)

## 9. Landed implementation

Everything below shipped. Each row points at the file that enforces it.

| Landed piece | Enforcing file |
| --- | --- |
| `"private": true`, so an accidental `npm publish` can never fire | `package.json` |
| release-please config (`bump-minor-pre-major`) plus the Release PR workflow whose final step dispatches `ci.yml` at `ref: vX.Y.Z` | `release-please-config.json`, `.github/workflows/release-please.yml` |
| Version stamping: the payload manifest carries the version, the launcher intercepts `--version`, `/doctor` reports the torus version | `scripts/payload-manifest.mjs`, `runtime/bin/torus.mjs` |
| `workflow_dispatch` trigger plus the tag-gated release job (§5): attach binaries, checksums, version-consistency assertion, attestation | `.github/workflows/ci.yml` |
| Release/install docs and the image tag policy | `README.md`, `docs/container.md` |
| Engine-pin PR titles mapped to `feat(deps):` via `packageRules` → `commitMessagePrefix` | `renovate.json` |

The bootstrap reset (`0.3.0` → `0.1.0`) happened at the first release; the version now moves only via Release PRs.

## 10. Settled questions

1. **release-please vs hand-rolled cut**: settled on release-please (§4); the design stays tool-agnostic if a `make.sh release` target is ever wanted.
2. **`latest` image tag policy**: settled, `latest` tracks main through 0.x and flips at 1.0 (§6).
3. **Attestation now vs at 1.0**: settled, attestation has shipped since the first release (§5).
4. **Add darwin/windows CI smoke runners?** Still open: deferred, cross-compile-only until an external user base justifies it (§8).
5. **npm as non-goal**: settled, `"private": true` in `package.json` blocks accidental publishes (§6).
