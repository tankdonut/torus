#!/usr/bin/env bash
set -euo pipefail

DIST="dist/torus"
TARGET=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--target)
			TARGET="${2:?--target requires a value}"
			shift 2
			;;
		--target=*)
			TARGET="${1#*=}"
			shift
			;;
		*)
			if [[ -n "$1" ]]; then
				DIST="$1"
			fi
			shift
			;;	esac
done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rm -rf "$ROOT/dist"
mkdir -p "$ROOT/$DIST/bin"

# pack the payload dependency tree (pinned engine included) into one
# deterministic tar.gz — this step first generates the payload-native lock
# (npm resolves the payload manifest against the registry so installs on user
# machines never re-resolve), then npm ci's the tree inside a staging dir;
# requires network and fails loudly without it
node "$ROOT/scripts/pack-payload-tree.mjs"

# embed the payload (extensions, agents, skills, .npmrc, runtime package.json,
# payload lock, packed dependency tree) as file assets: generated file-loader
# imports + content hash
node "$ROOT/scripts/generate-payload-assets.mjs"

# cross-compile with --target (bun-linux-x64, bun-linux-arm64, bun-darwin-x64,
# bun-darwin-arm64, bun-windows-x64); windows targets get an .exe suffix
BIN="$DIST/bin/torus"
if [[ "$TARGET" == *windows* ]]; then
	BIN="$DIST/bin/torus.exe"
fi
if [[ -n "$TARGET" ]]; then
	bun build --compile --target "$TARGET" "$ROOT/runtime/bin/torus.mjs" --outfile "$ROOT/$BIN"
else
	bun build --compile "$ROOT/runtime/bin/torus.mjs" --outfile "$ROOT/$BIN"
fi

chmod +x "$ROOT/$BIN"
SIZE=$(( $(wc -c < "$ROOT/$BIN") ))
echo "built $ROOT/$BIN (single self-contained binary, $SIZE bytes)"
if (( SIZE > 400 * 1024 * 1024 )); then
	echo "build-binary.sh: binary exceeds 400 MiB ($SIZE bytes) — the embedded payload tree is too large" >&2
	exit 1
fi
echo "  payload: embedded; extracted to ~/.torus/runtime on first run (hash-keyed)"
echo "  tree:    embedded dependency tree ($((SIZE / (1024 * 1024))) MiB binary), runtime use lands separately"
echo "  engine:  npm-installed into the extracted payload on first run (network required)"
