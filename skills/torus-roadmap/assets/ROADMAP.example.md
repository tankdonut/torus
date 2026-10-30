# Roadmap — Mosswind distribution

Created: 2026-10-02
Status: active

## Items

- R1. Self-contained release archive — done
  Evidence: v0.4.0 shipped as one tarball per platform; fresh-install checks passed on Linux, macOS, and Windows
  Decision: D1
- R2. Signed release artifacts — done
  Evidence: signing key rotated into the release pipeline; the install script verifies signatures since v0.4.1
- R3. Release feed generated in CI — in-flight
  Plan: derive the feed from the release manifest inside the release job; template reviewed in the packaging channel before v0.5.0
  Depends: R1, R2
- R4. Auto-update channel — planned
  Plan: check the feed on startup, stage updates behind a flag for one minor release
  Depends: R3
  Note: update prompts must respect a --no-update flag (maintainer request, 2026-10-18)
- R5. Storefront listing on Windows — deferred
  Note: blocked on a signed organization account for the storefront; revisit when the maintainers' paperwork clears
  Depends: R2
- R6. Plugin registry — dropped
  Decision: D2

## Now / Next / Later

- Now: R3
- Next: R4
- Later: none

## Decision log

- D1 (2026-10-02): Adopted this roadmap: Mosswind ships as a self-contained, signed binary first; channels follow; each channel lands as its own plan run
- D2 (2026-10-21): Dropped the plugin registry: no third-party plugins exist yet and the feed can list them if some appear; revisit on the first real plugin
