# Release workflow — semantic versioning for torus

Status: **implemented**. This document laid out torus's release workflow from first principles; the design is now live — release-please automation (§4), the tag-gated release job (§5), and version stamping all ship in-repo, and the first live release will be `v0.1.0` via the documented `Release-As` bootstrap. Items marked **[DECISION]** record settled choices and their reasoning; §10 lists the questions still genuinely open.

## 1. First principles

**What a release of torus is.** torus is distributed as (a) a single self-contained compiled binary and (b) a container image on `ghcr.io/tankdonut/torus`. A *release* is the act of cutting one named, immutable, verifiable version of both artifacts, anchored to a git tag, with notes explaining what changed. Everything else — the npm package under this repo's `package.json` — is a development harness, not a distribution channel (§6).

**Who consumes a version.** Today: the maintainer's own machines (binary) and container users pulling from GHCR (image; `latest` is already live). The repo is public, so assume unknown third parties arrive over time.

**What the version number means.** SemVer §4: `0.y.z` is initial development — anything MAY change. The de-facto contract consumers experience is npm's resolver semantics: `^0.3.0` means `>=0.3.0 <0.4.0-0`, i.e. **a 0.x minor bump is breaking for range consumers**. torus adopts that doctrine explicitly:

> **[DECISION] 0.x doctrine:** `0.MINOR.PATCH` — minor bumps may break (CLI flags, extension contracts, config); patch bumps are fixes only. `1.0.0` is a deliberate future commitment to API stability, not something an automation tool decides.

## 2. Version fan-out — one number, four surfaces

A single version `X.Y.Z` flows from one source of truth to every artifact:

| Surface | Form | Mechanism |
|---|---|---|
| `package.json` `version` | `X.Y.Z` | **Source of truth** — moved only by the release flow (§4), never hand-edited |
| Git tag | `vX.Y.Z` | Created by release automation via the GitHub API (not annotated — the Release carries the notes); anchors the GitHub Release |
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

**[DECISION] Engine-pin bumps are user-visible features, not chores.** Every binary and image ships the pinned engine (`@earendil-works/pi-coding-agent`), and first-run installs exactly that pin — an engine bump changes runtime behavior for every consumer. Rule: a PR that moves the engine pin (typically Renovate's) must land with a `feat(deps):` subject (or `feat(deps)!:` when the engine's own changelog says breaking). It then correctly drives a minor bump and appears in the changelog instead of riding silently as a patch-level `chore(deps):`.

**What counts as breaking (the public API surface):** CLI flags/commands and exit codes of `torus` itself; the extension load surface (`pi.extensions` entries and extension-module contracts); agent roster and skill file formats; payload bootstrap behavior (`~/.torus/runtime` layout, resolution order, first-run semantics); container entrypoint/`TORUS_ROOT` contract. Changes to any of these during 0.x → minor (post-1.0: major).

## 4. Release mechanism — release-please with a Release PR

**[DECISION] release-please** (GitHub App or workflow), configured for this repo's shape. Rationale over alternatives:

- **semantic-release**: has no 0.x handling at all — a breaking change on 0.3.0 unconditionally publishes 1.0.0 (`semver.inc("0.3.0","major")`). Violates §1 by construction. Rejected.
- **changesets**: exact human control, but a changeset file per PR is ritual a solo maintainer doesn't need when conventional subjects already carry the signal. Rejected for now.
- **Hand-rolled cut target** (`make.sh release`): viable fallback (~same manual cost), but no generated changelog and hand-maintained version bumping — more drift surface. Runner-up; nothing in this doc prevents adopting it later.

Configuration essentials:

- `bump-minor-pre-major: true` — breaking changes on 0.x bump the minor, not to 1.0.0. The 1.0.0 transition is a human act (a `Release-As: 1.0.0` note when the API is ready to commit).
- **Bootstrap for a zero-tag repo:** seed `.release-please-manifest.json` with `"." : "0.3.0"` and `bootstrap-sha: e2e4cb46` (the squashed init commit), so the first changelog starts from real post-init history and ignores nothing important. The first Release PR carries a `Release-As: v0.1.0` note, resetting the untagged `0.3.0` drift to the maintainer's chosen starting point — `package.json` (and lockfile) land at `0.1.0` in the release commit itself.
- Squash-merge + release-please is the explicitly recommended pairing.

**Per-release cost to the maintainer: one action** — open the Release PR when ready, review it (version bump + generated CHANGELOG.md + release notes), merge. Automation then tags `vX.Y.Z`, creates the GitHub Release, and hands off to the CI release job through the §5 trigger bridge (a token-created tag does not fire `on: push` on its own). Nothing depends on the local machine; the whole path is cold-re-runnable after months idle.

**Changelog:** release-please maintains a generated `CHANGELOG.md` in-repo as part of each Release PR and mirrors it into the Release body. Generated, never hand-edited — hand-maintained changelogs rot.

## 5. Release job — what CI does on `v*` tag push

One trigger-chain fact drives this design: release-please creates the tag with the default `GITHUB_TOKEN`, and events created by `GITHUB_TOKEN` do not start workflow runs — so the tag push does **not** fire `ci.yml`'s bare `on: push` by itself. Without a bridge, the release below silently no-ops: no binaries attached, and the versioned `X.Y.Z`/`X.Y` GHCR tags never push (the container job would keep firing on main pushes only).

**[DECISION] Bridge: `workflow_dispatch`.** Add `workflow_dispatch` to `ci.yml`'s triggers; the release-please workflow's final step dispatches `ci.yml` with `ref: vX.Y.Z` (`GITHUB_TOKEN` may trigger `workflow_dispatch`). The dispatched run checks out the tag ref, so the same-run artifact identity below holds unchanged, and a manually pushed tag still fires `on: push` natively — both paths converge. (Rejected alternatives: hosting the build matrix inside the release-please workflow gated on `release_created` — duplicates the heavy build/container jobs; a GitHub App token so the tag push fires natively — extra credential surface for a solo maintainer.)

Inside that tag-ref run, one new job completes it, gated `if: startsWith(github.ref, 'refs/tags/v')` so main-push runs never publish:

1. **Gating:** `needs: [lint-typecheck, smoke, build, container]` — publish only when everything is green, from the tag's SHA. Never publish on red. (The existing build matrix already compiles all 5 targets *from the tag*; the release job downloads that run's artifacts rather than reusing main-tip artifacts — same SHA by construction.)
2. **Attach:** create/update the GitHub Release with the 5 binaries (`torus-<os>-<arch>[.exe]`) + a `sha256sums.txt`.
3. **Version consistency assertion:** verify `tag == package.json version == torus --version from the built linux binary == image tag pushed by the container job`. A mismatch fails the release loudly (this is the anti-version-skew tripwire).
4. **[DECISION] Attestation from day one:** `actions/attest-build-provenance` (needs `id-token: write`) for binaries + image — one step, no keys, verifiable by anyone via `gh attestation verify`. Cutting it saves one workflow line; not worth it.

**Version stamping** (implemented): `runtime/bin/torus.mjs` intercepts `--version` before engine passthrough, printing torus version + engine pin; `scripts/payload-manifest.mjs` includes the repo `package.json` version in the payload manifest (folded into the payload hash, so version changes re-extract and self-heal `~/.torus/runtime` on next launch). The `/doctor` extension reports the same torus-version line.

## 6. Channels

- **Binary — GitHub Releases only.** Install = download from the Release for your platform, make it executable. Upgrade = replace the file (payload hash change self-heals the runtime). No install script for 0.x; revisit at 1.0 if third-party demand shows up.
- **Image — GHCR, already live.** `X.Y.Z` and `X.Y` tags are immutable once pushed (never re-point them; rollback = older tag). **[DECISION] `latest` keeps tracking `main`** (today's documented behavior in `docs/container.md:3`) as the dev channel through 0.x — it's the maintainer's own dogfood channel and CI-built either way. Stable consumers pin `X.Y` or `X.Y.Z`. Flip `latest` to track releases at 1.0, when "latest stable" starts meaning something.
- **pi package (git-source) — live at v0.1.0, zero maintenance.** `pi install git:github.com/tankdonut/torus@vX.Y.Z` loads torus's extensions, skills, and roster into a stock pi — the extension-pack consumption model, distinct from running the harness itself. Git sources are ref-pinned and reconciled on update; the channel activates the moment the tag exists. No publish step, nothing to maintain.
- **npm — not a channel. [DECISION]** The unscoped name `torus` is taken on the registry by another owner, and the shipped artifact is a compiled binary, not a node package. Set `"private": true` in `package.json` so `npm publish` can never fire by accident. Revisit `@tankdonut/torus` only if extension-pack consumers materialize and the [pi package gallery](https://pi.dev/packages) matters (the `pi-package` keyword already makes it eligible) — mechanically cheap via release-please, but it adds `publishConfig`/`files`/`repository` metadata, an npm token, and another version-consistency surface.

## 7. Upgrade & rollback semantics

- **Binary:** replace with the new one. New payload hash → re-extract + one `npm install` in `~/.torus/runtime` (self-heal, seconds). A pinned engine version that lingers from an older payload produces a drift warning, not breakage; documented recovery remains `rm -rf ~/.torus/runtime`.
- **Rollback:** re-download the previous tag's binary from Releases; or pin the previous image tag. Tags and Releases are immutable — rolling back never repaints history.
- **Engine availability:** the pin lives in `devDependencies` and the payload manifest; npm does not delete published versions. A pinned engine vanishing upstream is not a realistic failure mode for rollback purposes; a *broken* pinned engine is handled by a patch release moving the pin.

## 8. Honest limitations (accepted for 0.x)

- Only `linux-x64` binaries are smoke-executed in CI; darwin/windows/arm64 are cross-compiled, not run. Accepted explicitly. Adding macos/windows runners is a §10 question, not a blocker.
- Locally built images (`./make.sh image`) differ from CI-built published ones (builder, cache, base resolution). **CI is the only publisher**; local builds are dev-only. (This also sidesteps the local podman-shim vs runner divergence entirely.)

## 9. Implementation checklist (on sign-off)

1. `"private": true` in `package.json`; version stays `0.3.0` until the bootstrap Release PR resets it to `0.1.0` (sync `package-lock.json`).
2. release-please config (`bump-minor-pre-major: true`, bootstrap manifest `"." : "0.3.0"`, `bootstrap-sha: e2e4cb46`) + its workflow, whose final step dispatches `ci.yml` at `ref: vX.Y.Z` on `release_created`.
3. Version stamping: payload manifest carries the version; launcher `--version` interception; `/doctor` torus-version line.
4. `ci.yml`: add `workflow_dispatch` trigger + the release job (§5): tag-ref gate, attach artifacts from the tag-run build, checksums, version-consistency assertion, attestation.
5. Docs: README release/install section, `docs/container.md` tag-policy + stale-line fix.
6. Renovate: map engine-pin PR titles to `feat(deps):` via `packageRules` → `commitMessagePrefix` scoped to `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (retitle-on-merge remains the backstop).

## 10. Open questions

1. **release-please vs hand-rolled cut** — recommended: release-please (§4). If you'd rather own a `make.sh release` target, say so; the rest of the design is tool-agnostic.
2. **`latest` image tag policy** — recommended: keep `latest` = main through 0.x, flip at 1.0 (§6).
3. **Attestation now vs at 1.0** — recommended: now; it is one workflow step (§5).
4. **Add darwin/windows CI smoke runners?** — recommended: defer; accept cross-compile-only until an external user base justifies it.
5. **npm as non-goal** — recommended: yes + `"private": true` guard (§6).
