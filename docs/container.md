# Container image

torus ships as a prebuilt multi-arch image (`linux/amd64` + `linux/arm64`) on GHCR: `ghcr.io/tankdonut/torus`, built by container CI. Each platform builds exactly once per run (amd64 on the test runner, arm64 on a native ARM runner) and pushes by digest. The multi-arch tags are assembled from those digests only after the container test suite has passed against the amd64 build. The build stage compiles the single-file bun launcher from a source snapshot and bakes the payload tree with its npm dependencies.

| Fact | Value |
| ------ | ------- |
| Payload | baked at `/opt/torus` (`TORUS_ROOT`) with npm deps and the pinned pi engine; containers boot offline |
| Base image | `.tool-versions`-pinned `node:*-slim`, pulled via `mirror.gcr.io` (avoids Docker Hub rate limits) |
| Runs as | non-root user `torus` (uid 1000), `WORKDIR /workspace` |
| Env / entrypoint | `TERM=xterm-256color`; `ENTRYPOINT torus` |
| Tags | `latest` on merges to main; `X.Y.Z` and `X.Y` immutable on version tags |

## Quickstart

```sh
docker run --rm -it -v "$PWD:/workspace" ghcr.io/tankdonut/torus
```

Anything after the image name goes to torus as argv. The payload and its npm dependencies (the pinned pi engine included) are baked into the image at `/opt/torus`, and `TORUS_ROOT` points the launcher there. Containers boot instantly, never extract to `~/.torus/runtime`, and need no network access. `--list-models` works with no credentials:

```sh
docker run --rm ghcr.io/tankdonut/torus --list-models
```

## Provider auth

Keyless runs (CI, `--list-models`) stay clean; real agent use needs provider auth. Mount it read-only:

```sh
-v ~/.pi/agent/auth.json:/home/torus/.pi/agent/auth.json:ro
```

## Sandboxing

Not supported inside the container. `TORUS_SANDBOX` (and `TORUS_SANDBOX_DEFAULT`) default to off and should stay off there. The container itself is the isolation boundary, and bwrap's nested user namespaces conflict with container-runtime policy on most hosts (verified: rootless podman, GitHub runners, and Ubuntu 24.04+ hosts with `apparmor_restrict_unprivileged_userns=1`). `torus /doctor` reports the live sandbox state. The image still ships bwrap + socat as part of the full-toolkit inventory below; they are not exercised in-container.

## Local build & test

```sh
./make.sh image        # builds the Dockerfile, tags torus:dev (pins from .tool-versions)
./make.sh image-test   # container test suite against torus:dev (TORUS_IMAGE=<tag> to override)
```

The suite's static drift guards (Dockerfile ARG pins, runtime deps, entrypoint/user, baked payload wiring, CI job shape) run in plain `npm test` with no docker. The dynamic smokes need a docker daemon: engine boots keyless (also verified offline via `--network none`), tool inventory, tmux, bwrap.

## Versions & updating

`.tool-versions` is the single source of truth for the node and bun versions. CI reads it (`setup-node` `node-version-file`, `setup-bun` `bun-version-file`); `./make.sh image` and the CI platform builds pass it as build args. The Dockerfile declares `NODE_VERSION`/`BUN_VERSION` without defaults, so Renovate's asdf updates move the container image versions with no separate bump.

Two pins are renovate blind spots and must be bumped by hand: the Dockerfile `ARG AST_GREP_VERSION` and the global npm pins for `typescript-language-server`/`typescript`.

One GHCR note: the first publish creates the package as private by default. The owner marks it public once in the package settings.

Image tag semantics: `latest` tracks `main` (the dev channel); `X.Y.Z` and `X.Y` are immutable release tags ([docs/release-workflow.md](release-workflow.md) §6).

## What's inside

Full-toolkit flavor:

| Tool | Version / source |
| ------ | ------------------ |
| node + npm | pinned by `.tool-versions` (base image `node:<pin>-slim`) |
| torus payload + pi engine | baked at `/opt/torus` from the repo payload manifest (engine pin promoted from devDependencies), deps resolved through the baked repo `package-lock.json` |
| ast-grep (both the `sg` shim and `ast-grep`) | 0.45.3 (GitHub release) |
| typescript-language-server / typescript | 5.3.0 / 7.0.2 (global npm) |
| tmux, bubblewrap, socat, git, ripgrep, notify-send (libnotify) | apt (distro packages) |
| bash, script, which | base image |
