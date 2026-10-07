# Manual smoke checklist

The automated suite (`npm test`) covers headless behavior only. These smokes
exercise the interactive surfaces that need a real TTY (and for some, tmux).
Run the full list before cutting a release; each row is self-contained.

| # | Surface | Steps | Pass criteria |
|---|---|---|---|
| 1 | `interactive_bash` overlay | Ask the session to run `bash` (or anything prompting) via `interactive_bash`; type into the overlay; press `ctrl-]` | Bordered overlay streams child output; typing reaches the child; detach returns captured output to the conversation; child exits cleanly |
| 2 | Fleet browser open/detail | Start a delegation, press `alt+t` (or `/torus`), `enter` on the running row, scroll with `j/k` | Detail shows the live action feed; after completion it shows the full transcript; `esc` closes |
| 3 | Fleet stop/steer | In the detail view of a running delegation, press `x`; steer another with `s` + a message | `x` kills the child (row flips to failed/stopped); `s` logs `~ steer accepted` (or `REJECTED`) in the action feed |
| 4 | tmux delegation pane | Inside tmux, start any delegation | A right-hand pane titled `torus: @handle` opens, tails the live action feed, and closes on completion; `TORUS_TMUX=0` suppresses it |
| 5 | Statusline | While a delegation runs, watch the `torus` segment and fleet strip | Persona/model segment is stable; fleet strip shows the running agent with live turns/tokens; clears when idle |
| 5a | Fleet strip selection | With ≥1 delegation running, press `alt+1` (and with ≥2, start another then `alt+2`); in fullscreen TUI mode also click a strip row | `alt+N` opens the fleet browser directly in that agent's detail view (row numbers are oldest-running-first and stay stable); in fullscreen mode clicking a row does the same (regular inline mode has no mouse support — the strip hint hides the click affordance there); `alt+N` beyond the running count is a no-op |
| 6 | Transcript notifications | Idle the session while a delegation runs; then keep typing during another | `▶ agent delegated` / `✓ agent finished` lines render immediately when idle, deferred to turn end mid-stream; clicking the row opens the fleet detail |
| 7 | Persona cycling | Press `alt+p` repeatedly, then `alt+shift+p`; try `/persona-looker` | All personas appear in order (leader → builder → dreamer → explorer → librarian → looker → reviewer); the session model follows the persona; statusline reflects it |
| 8 | Dream/reflect nudge | Run `/reflect <focus>`; wait for completion | A `✿ dream applied` transcript line summarizes entries added/deleted (see memory extension); the memory store git log matches |
| 9 | Team lifecycle | `team_create` two members, `team_msg`, `team_task_create` + `team_task_update`, then `team_delete` | Members appear in the fleet browser with live state; tasklist mutations land; delete persists `shutdown` in `team.json`, stops members, keeps logs/mailboxes; `team_respawn` revives |
| 10 | `/doctor` | Run `/doctor` | Engine, auth, MCP, LSP, `sg`, tmux, git, and `~/.torus` writability each report ok/warn/fail with no crashes |
| 11 | Sandbox (default-on) | With `TORUS_SANDBOX` unset: one bash run of `touch /tmp/torus-sbx-ok && echo TMP_OK; touch ~/.torus-sbx-marker && echo HOME_WRITE_UNEXPECTED \|\| echo HOME_WRITE_BLOCKED; echo hi > sbx-smoke.txt && echo CWD_WRITE_OK; curl -sS -m 8 https://registry.npmjs.org -o /dev/null && echo CURATED_OK \|\| echo CURATED_FAIL; curl -sS -m 8 https://example.com -o /dev/null && echo NET_UNEXPECTED \|\| echo NET_BLOCKED`; then with `TORUS_SANDBOX=off`: a home-dir write and `curl https://example.com` | Unset: `TMP_OK`, `HOME_WRITE_BLOCKED` (raw `Read-only file system` visible to the agent), `CWD_WRITE_OK`, `CURATED_OK`, `NET_BLOCKED` (`CONNECT tunnel failed, response 403`); chip `sbx:on`. Off: home write and example.com both succeed; chip `sbx:off` |

Row 8 depends on the memory-applied notification (extensions/memory); the
remainder exercise pi/TUI behavior composed by torus.
| 12 | Sandbox trust approval | In a TUI session with `TORUS_SANDBOX=full` (`TORUS_APPROVAL` unset), bash-run `curl https://<unlisted-host>` and exercise each option: Allow once (curl succeeds; re-run prompts again); Always allow (succeeds; `~/.torus/sandbox/<slug>-hosts.json` appears; a fresh session runs the same curl with NO dialog); Deny (annotated 403, sticky for the session); Custom… typed `host` or `*.domain` (allowed this session); then `TORUS_APPROVAL=0` same curl ⇒ straight 403; also confirm a delegated child's curl gets 403 with no dialog in its pane | Headless legs verified 2026-10-03: `-p` run to an unlisted host denies in ~12 s (`CONNECT tunnel failed, response 403`), no dialog, no `~/.torus/sandbox` writes; interactive legs per steps |
| 13 | Container boots keyless and offline | `docker run --rm --network none torus:dev --list-models` (image from `./make.sh image`, or substitute `ghcr.io/tankdonut/torus`) | Engine loads and the model list prints instantly — payload + engine node_modules are baked at `/opt/torus`, nothing is extracted or installed on boot; exit 0 |
| 14 | Container test suite green | `./make.sh image-test` | Static drift guards pass in plain `npm test`; docker-gated engine/tmux/tool smokes pass under docker |
| 15 | Stateless stdio MCP server | Write a minimal stateless stdio MCP server fixture — a small node script that answers `tools/list` with one tool and `tools/call` with a canned result, holding no session state; register it under `mcpServers` in a project `.pi/mcp.json` (`command`: `node`, `args`: the script path); boot `torus`, check `/mcp`, invoke the tool once from the session; then remove the fixture + config entry and `/reload` | `/mcp` lists the server connected with its tool; the statusline MCP count includes it; the single invocation returns the canned result; after removal the server disappears from `/mcp` and the count drops |

Row 15's fixture server and handshake are pinned by the automated
engine-side test `tests/mcp-stateless.test.mjs` (connected tool + round-trip
+ unresponsive-server timeout); the manual row additionally covers `/mcp`
visibility, the statusline count, and removal via `/reload`.
