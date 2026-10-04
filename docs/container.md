# Container image

torus ships as a prebuilt image on GHCR: `ghcr.io/tankdonut/torus`, built by the `container` CI job from the multi-stage `Dockerfile` — the build stage compiles the single-file bun launcher from a source snapshot; the runtime stage is `node:26.8.2-slim` plus the agent runtime tools. Images are multi-arch (`linux/amd64` + `linux/arm64`); `latest` is published on merges to main, `X.Y.Z` and `X.Y` on version tags. The image runs as the non-root user `torus` (uid 1000), with `WORKDIR /workspace`, `TERM=xterm-256color`, and `ENTRYPOINT torus`.

## Quick start

```sh
docker run --rm -it -v "$PWD:/workspace" ghcr.io/tankdonut/torus
```

Anything after the image name goes to torus as argv. On first run the launcher extracts its embedded payload to `~/.torus/runtime` and npm-installs the pinned pi engine there — this needs network access and takes ~25–60 s; subsequent runs in the same container are instant. `--list-models` works with no credentials:

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

The suite's static drift guards (Dockerfile ARG pins, runtime deps, entrypoint/user, CI job shape) run in plain `npm test` with no docker; the dynamic smokes — engine boots keyless, tool inventory, tmux, bwrap — need a docker daemon.

## Versions & updating

`.tool-versions` (asdf format: `nodejs 26.8.2`, `bun 1.4.2`) is the single source of truth. CI reads it (`setup-node` `node-version-file`, `setup-bun` `bun-version-file`), `./make.sh image` passes it as build args, and the Dockerfile `ARG`s default to it. Renovate (`config:recommended`) maintains the node/bun pins and the Dockerfile base tags.

Two pins are renovate blind spots and must be bumped by hand: the Dockerfile `ARG AST_GREP_VERSION` and the global npm pins for `typescript-language-server`/`typescript`.

One GHCR note: the first publish creates the package as private by default — the owner marks it public once in the package settings.

## What's inside

Full-toolkit flavor:

| Tool | Version / source |
|------|------------------|
| node + npm | 26.8.2 (base image `node:26.8.2-slim`) |
| ast-grep — both the `sg` shim and `ast-grep` | 0.45.3 (GitHub release) |
| typescript-language-server / typescript | 5.3.0 / 7.0.2 (global npm) |
| tmux, bubblewrap, socat, git, ripgrep, notify-send (libnotify) | apt (distro packages) |
| bash, script, which | base image |
