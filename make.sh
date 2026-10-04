#!/usr/bin/env bash
# torus developer bootstrap. Subcommand-based; grow it as needed.
# Run npmrc yourself — the cc-safety-net guard blocks agents from touching
# the .npmrc basename, by design.
set -euo pipefail

cd "$(dirname "$0")"

cmd="${1:-help}"

case "$cmd" in
	typecheck)
		npx tsc --noEmit
		;;
	lint)
		npx biome check .
		;;
	test)
		npm test
		;;
	smoke)
		timeout 60 node runtime/bin/torus.mjs --list-models >/dev/null
		echo "smoke: keyless load ok"
		;;
	build)
		./scripts/build-binary.sh "${2:-}" ${3:+--target "$3"}
		;;
	link)
		npm link
		which torus || true
		;;
	check)
		./make.sh typecheck
		./make.sh lint
		./make.sh test
		./make.sh smoke
		echo "check: all green"
		;;
	npmrc)
		if [[ -f .npmrc ]]; then
			echo ".npmrc already exists:"
			cat .npmrc
			exit 0
		fi
		# before=null + min-release-age=0 clear the user-scope release-age
		# filters at project scope (npm precedence: project .npmrc > user
		# .npmrc). "null" is not a valid min-release-age duration — npm leaves
		# the cooldown active — so 0 disables it explicitly. legacy-peer-deps
		# matches how the repo installs while pi-lsp-client declares wildcard
		# peers on host-bundled packages. The payload ships this .npmrc, so the
		# launcher's first-run engine install clears the same filters.
		printf 'before=null\nmin-release-age=0\nlegacy-peer-deps=true\n' > .npmrc
		echo "created .npmrc:"
		cat .npmrc
		;;
	help)
		cat <<'EOF'
usage: ./make.sh <command>

commands:
  npmrc     create the project .npmrc (clears before/min-release-age filters, sets legacy-peer-deps)
  typecheck tsc --noEmit
  lint      biome check (lint + format + import order)
  test      node test suite (tests/)
  smoke     keyless engine load through the launcher
  build     build the single-file binary (scripts/build-binary.sh [dist-dir] [--target t])
  link      npm link the torus bin
  check     typecheck + test + smoke
  help      show this help
EOF
		;;
	*)
		echo "make.sh: unknown command '$1' (see ./make.sh help)" >&2
		exit 1
		;;
esac
