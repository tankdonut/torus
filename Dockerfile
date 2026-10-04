# torus container image — multi-stage, pinned toolchain.
#
# build stage: compile the single-file bun binary from a source snapshot
# (COPY . . pruned by .dockerignore; the payload .npmrc is generated inside
# the stage via ./make.sh npmrc and never committed).
# runtime stage: node-slim base (the launcher npm-bootstraps the pinned pi
# engine into ~/.torus/runtime on first run, so node+npm must ship) plus the
# tools the agent needs at runtime: tmux, bubblewrap, socat, git, ripgrep,
# notify-send, ast-grep (sg) and a pinned typescript-language-server.

ARG NODE_VERSION=26.8.2
ARG BUN_VERSION=1.4.2
ARG AST_GREP_VERSION=0.45.3

FROM node:${NODE_VERSION}-slim AS build

# global ARGs only apply to FROM; re-declare to use inside the stage
ARG BUN_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils unzip \
    && rm -rf /var/lib/apt/lists/*

# scripts/build-binary.sh drives the compile with bun (installer needs unzip).
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /build
COPY . .

# TARGETARCH is injected by buildx (CI); plain local builds leave it empty
# and the arch falls back to uname -m.
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in \
        amd64|x86_64) BUN_TARGET="bun-linux-x64" ;; \
        arm64|aarch64) BUN_TARGET="bun-linux-arm64" ;; \
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    ./make.sh npmrc \
    && ./scripts/build-binary.sh dist/torus --target "$BUN_TARGET"

FROM node:${NODE_VERSION}-slim

# tmux bubblewrap socat git ripgrep libnotify-bin ca-certificates: agent
# runtime deps. curl + unzip: only to fetch/extract the pinned ast-grep
# release below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tmux bubblewrap socat git ripgrep libnotify-bin ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

# ARGs do not cross stages — re-declare.
ARG TARGETARCH
ARG AST_GREP_VERSION

# ast-grep publishes rust-triple zip assets per release tag (note: tags carry
# no "v" prefix). Resolve the exact asset URL from the GitHub API so a rename
# cannot silently miss the pin; the zip ships both `ast-grep` and a `sg`
# deprecation shim that execs it — install both.
RUN set -eux; \
    arch="${TARGETARCH:-$(uname -m)}"; \
    case "$arch" in \
        amd64|x86_64) SG_TRIPLE="x86_64-unknown-linux-gnu" ;; \
        arm64|aarch64) SG_TRIPLE="aarch64-unknown-linux-gnu" ;; \
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    asset="$(curl -fsSL "https://api.github.com/repos/ast-grep/ast-grep/releases/tags/${AST_GREP_VERSION}" \
        | grep -oE 'https://[^" ]+/app-'"${SG_TRIPLE}"'\.zip"' \
        | tr -d '"' \
        | head -n 1)"; \
    [ -n "$asset" ]; \
    curl -fsSL "$asset" -o /tmp/sg.zip; \
    unzip -j /tmp/sg.zip sg ast-grep -d /usr/local/bin; \
    chmod 755 /usr/local/bin/sg /usr/local/bin/ast-grep; \
    rm -f /tmp/sg.zip; \
    sg --version

RUN npm i -g typescript-language-server@5.3.0 typescript@7.0.2

# node images ship a `node` user at UID 1000 — free the uid for torus so
# `id -u` in the container is 1000.
RUN userdel --remove node \
    && useradd --uid 1000 --create-home --shell /bin/bash torus \
    && mkdir -p /workspace && chown torus:torus /workspace

COPY --from=build --chown=torus:torus /build/dist/torus/bin/torus /usr/local/bin/torus

ENV TERM=xterm-256color
WORKDIR /workspace
USER torus
ENTRYPOINT ["torus"]
