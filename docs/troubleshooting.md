# Troubleshooting

Each section names a symptom, gives the recovery, and links to the page that owns the detail. Run `/doctor` before anything else; it checks the engine, auth, and tooling in one pass.

## Run `/doctor` first

`/doctor` checks the engine pin, provider auth, MCP wiring, LSP, ast-grep (`sg`), tmux, git identity, and torus home writability. Each check reports ok, warn, or fail, and the run prints the torus version line. The [doctor section of extensions.md](extensions.md#doctor) lists every check.

## Kill switches

Environment variables turn a subsystem off for one session. `TORUS_SERVE=0` makes `torus serve` refuse to start; `TORUS_SANDBOX=off` unwraps bash when the environment defaults to sandboxing. Per-extension switches work the same way: `TORUS_BANNER=0`, `TORUS_MONITOR=0`, and `TORUS_TEAM_NOTIFY=0` each disable their extension. The [environment-variables table in configuration.md](configuration.md#knob-sections-and-environment-variables) is the full list.

## Serve port conflicts

`EADDRINUSE` fails serve startup with a clean error naming the port and the serve section override. Set a different `port` in the serve section of the unified config; [serve.md](serve.md) documents the section and its defaults.

## Sandbox network denials

A sandboxed command that contacts an unlisted host fails with `CONNECT tunnel failed, response 403`. Interactive sessions get a trust dialog; Always allow persists the host to `$TORUS_STATE_DIR/sandbox-hosts.json`. Headless sessions and delegated children deny with no dialog. The [sandbox section of extensions.md](extensions.md#sandbox) documents the allowlist and the host knobs.

## Engine pin drift

An engine pin lingering from an older payload produces a drift warning, not breakage. Recover by removing the extracted runtime: `rm -rf ~/.torus/runtime`; the launcher re-extracts it on the next start. [updating.md](updating.md) covers the update and self-heal flow.

## Provider concurrency caps

An HTTP `429` carrying Z.ai business code `1302` means the provider account's concurrent-session cap rejected a parallel run. Set the model's entry in the `concurrency` map, or size fan-outs within the cap that `torus_roster` reports. The [providers section of extensions.md](extensions.md#providers) has the details.
