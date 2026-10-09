# Container image

torus ships as a prebuilt image on GHCR: `ghcr.io/tankdonut/torus`, built by the `container` CI job from the multi-stage `Dockerfile` — the build stage compiles the single-file bun launcher from a source snapshot and bakes the payload tree with its npm dependencies (the pinned pi engine included) installed; the runtime stage is the `.tool-versions`-pinned `node:*-slim` base plus the agent runtime tools, with the baked payload at `/opt/torus` (`TORUS_ROOT`) so containers boot without network access. Images are multi-arch (`linux/amd64` + `linux/arm64`); `latest` is published on merges to main, `X.Y.Z` and `X.Y` on version tags. The image runs as the non-root user `torus` (uid 1000), with `WORKDIR /workspace`, `TERM=xterm-256color`, and `ENTRYPOINT torus`.

## Quick start

```sh
docker run --rm -it -v "$PWD:/workspace" ghcr.io/tankdonut/torus
```

Anything after the image name goes to torus as argv. The payload and its npm dependencies (the pinned pi engine included) are baked into the image at `/opt/torus`, and `TORUS_ROOT` points the launcher there — containers boot instantly, never extract to `~/.torus/runtime`, and need no network access. `--list-models` works with no credentials:

```sh
docker run --rm ghcr.io/tankdonut/torus --list-models
```

## Provider auth

Keyless runs (CI, `--list-models`) stay clean; real agent use needs provider auth. Mount it read-only:

```sh
-v ~/.pi/agent/auth.json:/home/torus/.pi/agent/auth.json:ro
```

## Sandboxing

Not supported inside the container. `TORUS_SANDBOX` defaults to off and should stay off there — the container itself is the isolation boundary, and bwrap's nested user namespaces conflict with container-runtime policy on most hosts (verified: rootless podman, GitHub runners, and Ubuntu 24.04+ hosts with `apparmor_restrict_unprivileged_userns=1`). `torus /doctor` reports the live sandbox state. The image still ships bwrap + socat as part of the full-toolkit inventory below; they are simply not exercised in-container.

## Local build & test

```sh
./make.sh image        # builds the Dockerfile, tags torus:dev (pins from .tool-versions)
./make.sh image-test   # container test suite against torus:dev (TORUS_IMAGE=<tag> to override)
```

The suite's static drift guards (Dockerfile ARG pins, runtime deps, entrypoint/user, baked payload wiring, CI job shape) run in plain `npm test` with no docker; the dynamic smokes — engine boots keyless (also verified offline via `--network none`), tool inventory, tmux, bwrap — need a docker daemon.

## Versions & updating

`.tool-versions` is the single source of truth for the node and bun versions. CI reads it (`setup-node` `node-version-file`, `setup-bun` `bun-version-file`); `./make.sh image` and the CI publish build pass it as build args — the Dockerfile declares `NODE_VERSION`/`BUN_VERSION` without defaults, so Renovate's asdf updates move the container image versions with no separate bump.

Two pins are renovate blind spots and must be bumped by hand: the Dockerfile `ARG AST_GREP_VERSION` and the global npm pins for `typescript-language-server`/`typescript`.

One GHCR note: the first publish creates the package as private by default — the owner marks it public once in the package settings.

Image tag semantics: `latest` tracks `main` (the dev channel); `X.Y.Z` and `X.Y` are immutable release tags — [docs/release-workflow.md](release-workflow.md) §6.

## What's inside

Full-toolkit flavor:

| Tool | Version / source |
|------|------------------|
| node + npm | pinned by `.tool-versions` (base image `node:<pin>-slim`) |
| torus payload + pi engine | baked at `/opt/torus` from the repo payload manifest (engine pin promoted from devDependencies), deps resolved through the baked repo `package-lock.json` |
| ast-grep — both the `sg` shim and `ast-grep` | 0.45.3 (GitHub release) |
| typescript-language-server / typescript | 5.3.0 / 7.0.2 (global npm) |
| tmux, bubblewrap, socat, git, ripgrep, notify-send (libnotify) | apt (distro packages) |
| bash, script, which | base image |
