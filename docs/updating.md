# Updating and versions

Every release cuts one named, immutable version: the same number stamps the binary, the container image, and the git tag the pi package pins. This page covers what a 0.x version promises, how each channel upgrades and rolls back, and how to recover a runtime left behind by an upgrade. For install steps, see [getting-started.md](getting-started.md).

## What 0.x versioning promises

torus versions as `0.MINOR.PATCH`, and the number tells you what an upgrade may change:

- **A minor bump may break**: CLI flags, extension contracts, and configuration can all change.
- **A patch bump is fixes only**: a patch release changes no public surface.
- **1.0.0 is a deliberate commitment** to API stability, made by hand when the time comes; no automation tool decides it.

Read the changelog before taking a minor bump. Take patches as they arrive. The current version lives in [`package.json`](../package.json).

## Channels

- **Binary**: GitHub Releases only. Install by downloading `torus-<os>-<arch>` for your platform and making it executable; see [getting-started.md](getting-started.md). Upgrade by replacing the file.
- **Image**: GHCR. The `X.Y.Z` and `X.Y` tags are immutable once pushed, so rollback means pinning an older tag. `latest` tracks `main` as the development channel through 0.x; stable consumers pin `X.Y` or `X.Y.Z`. The tag policy detail is in [container.md](container.md#versions-updating).
- **pi package**: git source. The install pins a tag, and `pi update --extensions` reconciles the checkout to that tag without moving it. Upgrading means installing the new tag; see [pi-packages.md](pi-packages.md).

## Checking which version you run

`torus --version` prints the torus version and the pinned engine version in one line. The `/doctor` command reports the same line from inside a session.

## Upgrading the binary

Replace the old binary with the new one; that is the whole upgrade. The new binary carries a new payload hash, so the next launch re-extracts the payload and runs one `npm install` in `~/.torus/runtime`. The repair finishes in seconds.

## Recovering the runtime

A pinned engine left over from an older payload produces a drift warning at launch, not breakage. The documented recovery is:

```sh
rm -rf ~/.torus/runtime
```

The next launch rebuilds the directory from the current payload. A pinned engine that breaks outright is not yours to fix: a patch release moves the pin, so take the patch.

## Rollback

Tags and releases are immutable, so rolling back repaints no history:

- **Binary**: re-download the previous tag's binary from the [releases page](https://github.com/tankdonut/torus/releases) and replace the current file.
- **Image**: pin the previous `X.Y` or `X.Y.Z` tag.
- **pi package**: install the previous tag; git sources record their ref.
