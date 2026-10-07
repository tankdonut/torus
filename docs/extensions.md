# Extension reference

torus is composed through the `pi.extensions` manifest in `package.json`. Load order is the array order below; a new extension only loads after it is added there. Delegated children load a child-safe subset (see [Child set](#child-set)) via spawn args — children cannot recurse delegations.

Each entry: purpose, tools (exact names), slash commands, hooks, and env vars. Sources: the extension sources under `extensions/`; `tests/docs-coverage.test.mjs` keeps this file honest (every manifest entry, registered tool name, and `TORUS_*` env read must appear here).

## Torus-native extensions

### `mcp`
Registers two remote MCP servers in-session via pi's `registerMcpServer`: **context7** (library docs lookup) and **grep_app** (public GitHub code search). The connected-server count renders in the unified `torus` statusline segment (`MCP 2`, next to pi-lsp-client's own `LSP N` chip): a server counts only once its `mcp__<server>__<tool>` entries appear in the active tool set; registered-but-down shows `MCP 0` in warning color, connected shows success. The `ui` extension polls the count on `session_start` and every `turn_start`, plus a short settle-poll after each `session_start` (pi emits no event when a connection comes up, so the poll repaints the count as background connections settle — without it the statusline would read `MCP 0` until the first prompt). No filesystem or state.
No tools, commands, or hooks. No env.
Interactions: `/doctor` probes the wiring; loaded into every delegated child.
MCP spec status: the pinned engine speaks the MCP **2025-11-25** revision (its own docs cite `modelcontextprotocol.io/specification/2025-11-25`, e.g. the server resources page). The **2026-07-28** GA revision is the ecosystem's direction — protocol sessions, the `initialize` handshake, and stream resumability are gone, making stateless servers the default posture — and the TypeScript SDK's v2 line (`@modelcontextprotocol/server` + client) implements it while v1.x is maintenance-only. torus holds no SDK dependency of its own: when the engine moves to an SDK line speaking 2026-07-28, torus rides the normal `feat(deps)` engine-pin bump. Until then, prefer MCP servers that work stateless-agnostically (most stdio servers do).

### `providers`
GLM model routing. Does not re-register the built-in `zai` provider (stock pi provides the GLM models — authenticate via `/login zai`); registers the `opencode-go` gateway as an OpenAI-completions tail fallback **only when both env vars are present**. Exports the model fallback chains every delegation path walks: primary `zai/glm-5.3 → zai/glm-5.3-flash → opencode-go/glm-5.3-flash`, fast `zai/glm-5.3-flash → opencode-go/glm-5.3-flash`.
No tools, commands, or hooks. Env: `TORUS_OCGO_API_KEY` + `TORUS_OCGO_BASE_URL` (both required).
Interactions: roster and team-runtime resolve chains through it; the `ui` statusline shows provider availability.

### `roster`
The delegation core. Parses `agents/*.md` into the roster (frontmatter = definition); spawns the pinned engine as a child per delegation (RPC mode with JSON-mode fallback), walking the agent's model chain on no-work failures. Emits `torus.delegation-start` / `torus.delegation-result` transcript messages, streams per-turn snapshots into the shared registry, and supports mid-run stop (`x`) and steer (`s`). Start markers reach the parent model's context (custom messages convert to user messages), so background runs pass neutral `announce` text instead of the task preview — a dreamer-directed task ("You are reflecting…") would read there as an instruction. `torus_delegate` passes `announce: false`: the tool block is that call's transcript surface (live `onUpdate` + statusline chip, call/result lines are mouse regions opening the fleet), so no deferred start marker lands next to the result at completion; its result details carry `turns`, `usage`, and `delegationId` for the renderer.
Tools: `torus_roster` (list agents, chains, credentialed providers), `torus_delegate` (run one self-contained task on a roster agent; accepts `agent`, `task`, `handle`, `skills`, `cwd`, `model`; live `renderCall`/`renderResult`). `model` takes `primary`/`fast` (chain shorthands, resolved to the chain's first credentialed candidate) or an exact available id — validated pre-flight (invalid values reject naming the valid candidates, no spawn) and the walk falls back down the agent's own chain on no-work failures. The `skills` argument resolves names and paths against the same set the main window loaded: pi's auto-discovered skills plus the **torus payload package's `pi.skills`** (`repoRoot()`/`TORUS_ROOT` manifest — the launcher loads it via `--extension <payload-root>`, and delegation children get manifest skills only through this resolver since they spawn with bare extension files); delegation-cwd manifests are deliberately ignored. Everything under those roots passes path containment, everything else is rejected.
Commands: `/roster`; one command per agent file — session-mode `/leader` toggles the persona; child agents (`/builder`, `/dreamer`, `/explorer`, `/librarian` + alias `/research`, `/looker`, `/reviewer`) delegate the argument text, wait for that session's running delegations to quiesce (10-min cap), and inject the result as a follow-up user message.
Hooks: `session_start` (record session id; rehydrate past delegations from `~/.torus/logs`).
Interactions: heavy consumer of the shared registry; memory's dream/reflect and team's fanout/chain call `runDelegation()`; prompts, ui, notify, browser, and fleet all consume its state.

### `prompts`
System-prompt composition and persona switching. Appends the active persona's prompt, the delegation policy section, and any keyword-triggered execution mode to the system prompt each turn; owns the persona cycle (`alt+p` forward, `alt+shift+p` backward — leader → builder → dreamer → explorer → librarian → looker → reviewer), per-session persistence (`~/.torus/persona/<session>.json`), and the persona-themed editor border. Switching persona also switches the session model.
No tools. Commands: `/persona-<name>` for every agent (7). Hooks: `session_start` (restore persona + theme), `message_end` (keyword gates `ultrawork` / `hyperplan` / `team`; user-extendable via `~/.torus/keywords.json`), `before_agent_start` (inject persona + policy + mode).
Env: none directly (`persona-theme.ts` reads `TORUS_THEME_DEBUG`).

### `browser`
The fleet browser — full-viewport TUI overlay listing live and recent delegations plus running team members. List view: status/model/turns/tokens per run; detail view: the live action feed or the full session transcript once done (replays real tool-call components). Scrolling, follow mode, mouse wheel in both TUI modes (raw SGR takeover in regular; host-dispatched `handleMouse` events in fullscreen, where list rows are also clickable), stop (`x`), steer (`s`). Esc backs detail→list only when the list was visited; a strip-click-opened detail returns straight to the TUI.
No tools (internal stub definitions exist only to render torus tool calls in replayed transcripts). Commands: `/torus`. Shortcut: `alt+t`.
Hooks: `session_start` (publishes the `FLEET_OPENER` global that notify's clickable rows invoke).

### `comment-checker`
Comment discipline gate. Captures added lines from edit/write tool calls, detects line comments/docstrings by file extension, and appends a mandatory challenge to the matching tool result requiring the model to justify or remove each comment.
No tools or commands. Hooks: `tool_call` (capture), `tool_result` (challenge).
Env: `TORUS_COMMENT_CHECKER=0` disables; `TORUS_COMMENT_CHECKER_PROMPT` overrides the challenge text.

### `hashline`
Anchored editing. Read-tool results are rewritten so every line carries a `{line}#{hash}|` anchor; `hashline_edit` applies batch edits addressed by those anchors with staleness detection (hash mismatch self-heals by reporting current anchors, or remaps moved lines via the opt-in `rebase` flag; reversed `pos`/`end` auto-swaps; missing `op` is inferred), plus delete/rename file modes and an optional post-edit formatter. Success returns a full-file anchor map, and successful native `edit`/`write` results carry an anchor-void notice so stale anchors are not reused.
Tools: `hashline_edit` (replace/append/prepend ops by anchor, ranges, EOF/BOF insertion, delete, rename, opt-in rebase).
Hooks: `tool_result` (anchors read outputs).
Env: `TORUS_HASHLINE=0` disables; `TORUS_FMT_CMD` = formatter command run after successful edits.
Interactions: guards' write-overwrite block and recovery guidance point here by name.

### `interactive`
PTY-backed interactive command execution via `script -qec`. In the TUI the child streams into a bordered overlay the user can type into (takeover); `ctrl-]` detaches; headless contexts run to completion synchronously. Line-oriented programs render correctly; full-screen apps (vim/htop) do not — use plain bash for those.
Tools: `interactive_bash` (password prompts, REPLs, package-manager confirmations).
Hooks: `session_shutdown` (kill live children).
Env: `TORUS_INTERACTIVE=0` disables.

### `vision`
Lets image-capable models see images: loads 1–3 local image files (png/jpg/jpeg/webp/gif, ≤4 MB each) into the conversation as base64 image blocks with a goal annotation. The `looker` roster agent is its designated consumer.
Tools: `look_at` (paths + goal).

### `guards`
Context hygiene and error recovery. Truncates oversized tool outputs, blocks bare `cat`/`head`/`tail`/`less`/`more` dumps of absolute file paths (redirect to the read tool), blocks near-identical full-file rewrites via write (redirect to `hashline_edit`/edit), blocks bash mutations of the torus memory store (mutating git verbs, `--no-verify`, redirects, file writes — redirect to `torus_remember`/`torus_forget`/`/reflect`), and appends structured retry guidance to failed edit results and JSON parse failures.
No tools or commands. Hooks: `tool_call` (blocks), `tool_result` (truncation + guidance).
Env: `TORUS_GUARDS=0` disables everything; `TORUS_MAX_TOOL_OUTPUT` (default 16000) tunes the cap.
Interactions: exports `truncateText` (used by astgrep); documented in AGENTS.md conventions.

### `sandbox`
Opt-in per-command isolation (enable with `TORUS_SANDBOX=full`; unset runs unsandboxed) for agent bash calls, built on `@anthropic-ai/sandbox-runtime` (pinned 0.0.77). With `TORUS_SANDBOX` in the on family, every bash tool call is rewritten through bwrap (Linux) or Seatbelt (macOS): writes confined to the workspace + `/tmp` + `TORUS_SANDBOX_WRITABLE` extras + git plumbing (the repo's git common dir and the torus worktrees root — linked worktrees share refs/objects with the main repo), network restricted to a curated exact-host allowlist (npm/PyPI/crates/GitHub/Golang proxy hosts — keeps installs and git-over-https working) with `TORUS_SANDBOX_NET_ADD` appending and `TORUS_SANDBOX_NET_ONLY` replacing. `interactive_bash` and user `!` commands are never wrapped. Fail-closed: a wrap failure blocks the call with an actionable reason; missing bwrap/socat or init failure degrades to unsandboxed with a one-time stderr notice (`TORUS_SANDBOX=off` silences). `fs`-only mode is not expressible with srt 0.0.77 (network restriction is schema-coupled) — unknown TORUS_SANDBOX values default to off with a one-time notice.
No tools or commands. Hooks: `session_start` (statusline chip `sbx:on`/`sbx:off`/`sbx:down`), `tool_call` (rewrites bash command; fail-closed blocks), `tool_result` (annotates sandbox violations onto stderr), `session_shutdown` (chip clear + manager reset — kills socat bridges + proxies). `/doctor` reports mode/deps/state.
Env: `TORUS_SANDBOX=off|full` (default full); `TORUS_SANDBOX_WRITABLE` extra writable roots, colon-separated.
Interactions: delegated children confine to their own worktree cwd. Known srt 0.0.77 gaps: unreliable signal/exit-code propagation (upstream #602/#603/#635/#610), no SIGWINCH on Linux (#642), macOS raw-mode TUIs need `allowPty` (#480); versions past 0.0.77 are blocked by the npm mirror date cutoff until it catches up.

### `approval`
Trust-on-denial UX for the sandbox network allowlist: when a sandboxed command contacts a non-allowlisted host, an interactive dialog offers Allow once / Always allow (this project) / Deny / Custom… (typed `host` or `*.domain` ⇒ allowed this session). "Always" persists to `~/.torus/sandbox/<slug>-hosts.json` — outside the sandbox's writable roots, so the agent cannot self-escalate — and applies live (`updateConfig`) plus in fresh sessions (persisted hosts allow silently). Headless sessions and delegated children auto-deny; dialog timeout 120 s ⇒ deny; in-flight dedup + per-session cache (denies sticky). Consumed by `sandbox` via the `globalThis` slot `torus.approval.v1` (resolved lazily).
No tools or commands. Hooks: `session_start` (ctx capture).
Env: `TORUS_APPROVAL=0` leaves the slot absent — unmatched hosts deny, exactly as before the extension existed.

### `doctor`
One-command health check: engine pin drift vs the `package.json` pin, provider auth (`auth.json`), default provider, MCP wiring, LSP binary, `sg` (ast-grep), tmux, git identity, and `~/.torus` writability — each ok/warn/fail.
Commands: `/doctor`. No tools or hooks.
Interactions: dynamic-imports `engine-child` + `registry`. Not loaded into children.

### `astgrep`
Native-tool wrapper around the `sg` binary for structural (AST) code search and rewrite — patterns with `$VARS` metavariables survive formatting drift; graceful error when `sg` is missing.
Tools: `torus_astgrep` (pattern, language, paths, rewrite).
Interactions: `/doctor` reports the binary; imports `truncateText` from guards.

### `sessions`
Full-text search *inside* historical pi session transcripts (not just filenames): session id, date, project dir, and a match snippet per hit. Resume via pi's `/resume` or `pi --session-id <id>`.
Tools: `torus_sessions` (query, limit). Default root `~/.pi/agent/sessions`. `findSessionFile(sessionId)` export resolves a session's transcript path (memory's idle reflection uses it to feed the current session's own activity).

### `monitor`
Periodic command watcher: runs a shell command on an interval, hashes its output, and desktop-notifies + stops when the output changes (`stopOn: change`) or the command fails (`stopOn: fail`). History lands in `~/.torus/monitors/<name>.log`; max 5 concurrent monitors (oldest evicted). When a monitor fires, a `torus.monitor-fired` transcript notification also lands in the session (name, reason, exit code, output tail; rendered like the fleet markers) and wakes the model — an idle session starts a turn, a streaming one gets it queued as a follow-up.
Tools: `torus_monitor` (name, command, intervalSec ≥5, stopOn), `torus_monitor_stop` (name).
Hooks: `session_shutdown` (stop all). Env: `TORUS_MONITOR=0` disables.

### `fleet`
The ambient fleet strip — a TUI statusline widget showing up to 5 running delegations + external runs with spinners, per-entity colors, turns/tokens/age; renders nothing when idle. Rows are numbered oldest-running-first (numbers stay stable while agents run) and are the primary selector: `alt+1`..`alt+9` opens the fleet browser directly in that agent's detail view; clicking a row does the same but only under fullscreen TUI mode (pi's regular inline mode enables no mouse reporting at all, so the strip advertises clicks only when `tui.mode === "fullscreen"`); external-run rows open the plain list.
No tools or commands. Hooks: `session_start` (installs the `torus-fleet` widget). Shortcuts: `alt+1`..`alt+9` (detail on the Nth running agent).
Interactions: `registry.ts` + `fleet/theme-kit.ts` (shared presentation kit also used by browser, notify, roster); opens the browser overlay via the shared `FLEET_OPENER` slot (same path notify's clickable transcript lines use).

### `team`
Multi-agent orchestration. `torus_fanout` (2–8 parallel delegations) and `torus_chain` (2–6 sequential steps, each fed the prior output, bounded to 4k chars) are thin wrappers over roster's `runDelegation`. persistent teams spawn long-lived RPC-mode engine members with per-member file mailboxes (inbox/outbox), a shared locked tasklist (`tasks.json`), a team spec on disk (`~/.torus/teams/<id>/team.json`), and a supervisor loop (mail-driven cycles, model-chain fallback, outbox delta logging; a member turn slower than 10 minutes keeps waiting — timeout is never treated as engine death). Teams rehydrate from disk on parent restart, and rehydrated log-only records defer to live run beacons so a resume never shows a running member as a duplicate ✗ failed row. `team_status` surfaces orphaned tasks — in-progress rows whose member has stopped — so crashed members never leave work lingering invisible (`team_task_update` reassigns or completes it). Member lifecycle reaches the parent transcript too: spawning emits one combined `torus.delegation-start` for the batch (fan-out combines its start markers the same way, and coalesces result markers — completions within a 5s window merge into one combined `torus.delegation-result` listing every run id, flushing early once the whole batch settles), stop/crash emits `torus.delegation-result` (team_delete suppresses the per-member markers and toasts, emitting one combined result marker and one desktop toast for the batch), and each member is onboarded into the delegation registry — delegation log, run beacon, and fleet-overlay stop/steer, with the registry controls bridged onto the team mailbox/control slots. All delegation/team markers are sent with `triggerTurn: false`: they append at the turn boundary in order instead of being steered into the model's mid-run context, while live start feedback rides the tool `onUpdate` and an immediate statusline chip; the wake-up marker is the deliberate exception (`triggerTurn: true`, below). Wake-ups are per member: when a member goes idle (or stops non-deliberately) while holding an unread outbox report (bootstrap "ready" handshakes don't count), its episode queues and all pending episodes flush as ONE combined `torus.team-wake` marker per team after a 10s coalescing window (rendered like the fleet markers; a member back to working before the flush defers to its next episode) — N members finishing within minutes would otherwise queue N follow-ups that drain one turn boundary apart, each a wasted model turn. The marker quotes each member's newest outbox tail and is sent with `triggerTurn: true` so an idle session always starts a run; a queued user follow-up alone would strand pending when the prior turn was interrupted. `TORUS_TEAM_NOTIFY=0` disables it.
Tools: `torus_fanout` (per-run `model` override accepted), `torus_chain` (per-step `model` override accepted), `team_create` (1–8 members), `team_status`, `team_msg` (member or `*`), `team_task_create`, `team_task_list`, `team_task_update` (pending/in_progress/completed/deleted + reassign), `team_delete` (graceful shutdown, keeps logs/mailboxes), `team_respawn` (revive stopped members from spec).
Interactions: `team-runtime.ts` (spawn/mailbox/tasks), registry (team records → fleet/browser visibility).

### `notify`
Transcript rendering of delegation lifecycle events: `torus.delegation-start` / `torus.delegation-result` render as one-line transcript entries ("▶ explore delegated · <preview>", "✓/✗ explore finished · alt+t …"); both are wrapped in mouse regions that open the fleet browser focused on that delegation, and the `torus_delegate` call/result block reuses the same wrapper (result lines focus the run via the details `delegationId`; the call line opens the fleet list). Also renders `torus.memory-applied` — the ✿ dream/reflect summary line emitted by the memory extension after proposals are applied.
No tools or commands. Hooks: message renderers ×3. Interactions: registry `FLEET_OPENER`, browser, theme-kit.

### `memory`
Durable, git-backed memory store at `~/.torus/memory` (entries + `profile.md`, auto-init git repo). Injects profile + up to 6 scoped entries into context once per session (re-armed after compaction): pinned entries always first, then the current session's own entries (marked `[session]`, restored when injection re-arms after compaction), then entries scored relevant to the latest user message (lexical hybrid — whole-query topic match, tag-exact boost, 30-day recency nudge, newest-first tiebreak), with newest entries filling the remaining slots. `torus_remember` blocks near-duplicate topics unless `force: true` (updates the existing entry in place); tags are sanitized and content capped (8 KB). Dreams (≥6h interval) and idle reflection (10 min idle or N settles since the last reflect, re-armed after each; fed that session's own transcript and delegation logs) delegate to the read-only `dreamer` agent and apply its validated proposals parent-side (entries capped per run, deletes constrained to bare filenames, profile lines capped); both announce with a neutral start marker — never the dreamer-directed task text — and the reflect task opening matches the trigger (just-idled vs turn threshold). Every applied dream/reflect run emits a `torus.memory-applied` transcript line (✿ per-kind counts with entry topics and deleted filenames) so the session sees what changed. `torus_memories` surfaces unparseable entry files, and dream scheduling ignores the dreamer's own delegation logs so dreams cannot self-trigger.
Tools: `torus_remember` (topic/content/tags/scope: project|global|profile/force/pinned), `torus_recall` (query/scope), `torus_memories` (list; warns about unparseable entries), `torus_forget` (delete by exact filename; git history keeps it recoverable).
Commands: `/reflect [focus]` — manual distillation; `/profile` — show the user profile.
Hooks: `agent_settled` (dream + schedule reflection), `context` (inject memory block), `session_compact` (re-arm injection).
Env: `TORUS_REFLECTION=0` (no idle reflection), `TORUS_REFLECT_TURNS=<n>` (reflect after N settles since the last reflect; 0 = idle-only, default 12), `TORUS_DREAMING=0` (no dream consolidation). Store versioning is enforced: the extension commits as `torus <torus@local>` (any other author in `git log` is an off-path write), its git spawns carry `TORUS_MEMORY_COMMIT=1`, and a store-local pre-commit hook (`core.hooksPath=.githooks`) refuses commits without it — agent-run `git commit` on the store fails.

### `goal`
Per-session standing objective stored at `~/.torus/goal/<session>.json`; active goals inject into every turn's context (goal + notes + completion instruction) and show as a chip in the unified `torus` statusline segment (`▶ <head>` warning, `⏸` dim when paused; nothing when unset — no permanent no-goal chip).
Tools: `goal_complete` (summary) — mark the objective complete with evidence.
Commands: `/goal <text>` (set), `/goal note <text>`, `/goal pause`, `/goal resume`, `/goal off|clear`; bare `/goal` shows status.
Hooks: `session_start` (record session id, refresh chip), `context` (inject goal block).

### `todo`
Session-scoped todo list at `~/.torus/todo/<session>.json`. The write-only tool replaces the full list; pending items inject as a context block each turn; a statusline chip shows ●done/○pending counts.
Tools: `torus_todowrite` (content/status/priority, ≤30 items).
Hooks: `session_start` (restore chip), `context` (inject todo block).

### `work`
Plan-execution state binding a torus-plan plan file to a session so execution survives compaction and restarts. State at `~/.torus/work/<slug>.json` (plan↔session binding, status, elapsed); evidence in an append-only `~/.torus/work/<slug>.ledger.jsonl`. Progress is never cached — it is parsed live from the plan's column-zero checkbox rows (`- [ ]` / `- [x]`), so the plan file stays the single source of truth. While active, every turn injects a work block (plan path, done/total, next unchecked task, ledger tail).
Tools: `work_start` (plan: absolute path or unique stem/prefix under `~/.torus/plans`; creates or rebinds — rebinding resumes, elapsed spans runs; parent sessions only), `work_note` (event: task-done|verified|blocked|wave-gate|note, + wave/task/verification/evidence/verifiedBy; appends a typed ledger row, returns the tail; with an explicit `slug` any session appends — slug resolution is exact → unique prefix → unique substring, with ambiguity/miss errors listing candidates so a paraphrased dispatch slug costs at most one retry — delegated builders journal gotchas this way, and rows carry the writer's session id), `work_complete` (summary; machine gate — refuses while any column-zero checkbox is unchecked or the plan is missing, then records elapsed and stops the per-turn block; parent sessions only).
Hooks: `context` (inject work block for the newest active binding of the session). Delegated child engines load the extension but get only `work_note` — `work_start`/`work_complete` skip registration when `TORUS_ENGINE_CHILD=1`, so children can journal into a plan's ledger but never rebind or complete work.
Companion skill: `torus-execute` (writes checkboxes in the plan, journals via `work_note`, ends via `work_complete`). Plan coordinates (waves, tasks, slugs) stay in the plan and ledger; landed commits and code comments never carry them.

### `worktrees`
Git-worktree lifecycle under one canonical root outside the repo (`~/.torus/worktrees/<repo>/<branch>`). Create sets up dependencies (explicit command or detected: go/npm/cargo/uv/pip); merge = rebase → squash (or opt-in ff) → tree-identity proof → only then branch delete, with clean conflict aborts; remove never deletes the branch. A `torus:worktree` statusline chip shows the active branch.
Tools: `worktree_create` (branch, base, setupCommand), `worktree_merge` (branch, subject, strategy squash|ff, keep, mainBranch), `worktree_remove` (branch, force, teardownCommand).
Env: `TORUS_WORKTREES_ROOT` (root override). Registration is skipped entirely when `TORUS_ENGINE_CHILD=1` — parent sessions only.

### `exit`
`/exit` as a faithful alias of pi's `/quit` — same graceful shutdown, so `session_shutdown` events and extension disposal still fire.

### `session-title`
Auto-naming via the same surface `/name` and `--name` use (`pi.setSessionName`), modeled on OpenCode's hidden title agent: after each completed turn while the session is still unnamed (first real user prompt as context), one cheap no-tools flash-model call in the background — silent on failure (max 3 attempts), never overwriting a user-set name, never running in delegated engine children. Titles are sanitized (thinking stripped, first line, ≤100 chars). `/rename` regenerates on demand from the whole session transcript (head+tail digest of user asks and assistant answers) with an optional focus hint, and overwrites the existing name.
Commands: `/rename [focus hint]`.
Hooks: `session_start` (reset attempt counter), `turn_end` (auto-title while unnamed).
Env: `TORUS_TITLE=0` disables auto-titling (`/rename` stays manual); `TORUS_TITLE_MODEL=provider/model` overrides the generator (default `zai/glm-5.3-flash`, falling back to the session model).
Interactions: model cascade resolves through `ctx.modelRegistry`; sessions' search and pi's session picker display the names.

### `ask`
Structured user questions: labeled-option select dialogs (1–4 questions, 2–6 options each) via the TUI; `allowCustom: true` per question adds a `Custom…` option that opens a text input and records the typed answer verbatim. In non-interactive contexts the options are returned so the model decides and notes the choice.
Tools: `torus_ask` (questions[] with question/header/options/allowCustom).

### `ui`
The `torus` statusline segment: brand, identity block (persona, shortened model id, thinking effort — all in the persona's truecolor RGB), dim provider availability; the engine tag appears only when `TORUS_ENGINE` is overridden. Health and objective follow: the MCP connected count (`MCP N`, success/warning) polled on `session_start`/`turn_start` with a settle-poll that repaints while startup connections are still coming up, and the session goal as a compact chip (`▶ <48-char head>` warning while active, `⏸` dim while paused, absent when unset or complete — pushed by the goal extension). Model and effort are event-tracked module state, so every writer renders the same line. Plus a warning `delegate ×N` chip while `torus_delegate` executions are in flight (ref-counted), and a persistent session-cost chip on its own `torus:cost` statusline key beside the torus segment: assistant `message_end` usage is folded through the shared engine-child tally reducer and rendered with `formatCost` — `$0` shows only once tokens were spent, and the chip stays absent until something measurable happens. Source of the persona color map used by persona-theming.
Hooks: `session_start`, `turn_start`, `model_select`, `message_end`, `tool_execution_start`, `tool_execution_end` (torus_delegate only). Env: `TORUS_ENGINE` (display only); `TORUS_STATUSLINE_COST=0` disables the session-cost chip.

## Shared modules

| Module | Provides | Consumers |
|---|---|---|
| `extensions/registry.ts` | DelegationRecord store (globalThis-hosted), run beacons + foreign-process scan, team records, session/persona slots, log rehydration, tmux pane mgmt, `repoRoot()`, sanitize/redact/shellQuote/name gates | roster, team, browser, fleet, notify, memory, goal, prompts, ui, engine-child |
| `extensions/rpc.ts` | `RpcChild` — newline-JSON RPC client for engine children (prompt/steer/getState/kill) | roster, team-runtime |
| `extensions/engine-child.ts` | `engineChildEnv` (sets `TORUS_ENGINE_CHILD=1`), event parse/reduce, `childExtensionArgs` (the child set), `resolveEngineBin` | roster, team-runtime, doctor, ui |
| `extensions/team-runtime.ts` | Team spec persistence, mailboxes, locked tasklist, member supervisor | team |
| `extensions/frontmatter.ts` | `---` header parser/stripper | roster, prompts, memory |
| `extensions/fsutil.ts` | `TORUS_HOME`, best-effort readJson, atomic writeJson, sleep, splitList | registry, memory, goal, worktrees, prompts, team-runtime, ui |
| `extensions/osnotify.ts` | notify-send toasts (summary+body, @handle label, duration/preview/stats; grouped under a torus desktop entry; running-late ping after 45s, replaced in place by the finish toast via replaces-id, suppressed per member on team_delete in favor of one combined shutdown toast; failures critical+persistent, low-value toasts transient), `TORUS_NOTIFY=0` opt-out | registry, monitor, notify |
| `extensions/persona-theme.ts` | Persona-colored editor border | prompts |
| `extensions/transcript.ts` | Session transcript location/parsing, live tail | browser |
| `extensions/fleet/theme-kit.ts` | Shared fleet rendering (colors, spinner, tokens, icons) | browser, fleet, notify, roster |
| `extensions/hashline/core.ts` | Anchor hashing/parsing/edit semantics | hashline |

## Child set

Delegated children load: `mcp`, `comment-checker`, `hashline`, `vision`, `guards`, `astgrep`, `sessions` + the bundled packages below. Children get **no** roster/team/fleet/browser — they cannot recurse delegations — and worktree tools are additionally gated by `TORUS_ENGINE_CHILD`.

## Bundled packages

### `cc-safety-net`
Destructive-command and secret-access blocker. Registers a `tool_call` guard that parses bash commands (posix shell analysis — wrapping/reordering doesn't evade) and applies secret rules to read/edit/write/search tools; malformed input fails toward blocking. Registers `/cc-safety-net` (help + policy). Policy lives in `.cc-safety-net/`; in torus it is why `.npmrc` writes are agent-blocked (humans use `./make.sh npmrc`). Loaded in parent and children.

### `pi-web-access`
Web access suite. Tools: `web_search` (30+ providers, fallback chains, batch queries), `fetch_content` (readable/raw/answer modes; GitHub repos/PRs/issues, YouTube + local video with frame extraction, PDFs, images), `get_search_content` (bounded retrieval from the private cache with findText), `source_check` (claim-evidence artifact with passage citations). Commands: `/curator`, `/google-account`, `/search`, `/websearch`. Config: `~/.pi/agent/web-search.json`. Loaded in parent and children.

### `pi-lsp-client`
LSP tools: `lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`, `lsp_symbols`, `lsp_prepare_rename`, `lsp_rename` — over a shared server pool (lazy spawn, refcount, idle reaping, crash retry). Command `/lsp` (status / install / warmup); 40+ builtin servers; custom servers via `.pi/lsp-client.json`. Loaded in parent and children; `/doctor` probes `typescript-language-server`.

## Environment variables

| Variable | Consumer | Purpose |
|---|---|---|
| `TORUS_OCGO_API_KEY` + `TORUS_OCGO_BASE_URL` | providers | Register the `opencode-go` tail-fallback provider (both required) |
| `TORUS_PI_BIN` | launcher | Explicit engine binary path (overrides `node_modules/.bin/pi`) |
| `TORUS_ROOT` | launcher → registry | Payload root override (source layout otherwise) |
| `TORUS_ENGINE` | launcher sets, ui reads | Engine tag (display) |
| `TORUS_ENGINE_BIN` | launcher sets, roster/engine-child read | Engine binary for child spawns |
| `TORUS_ENGINE_CHILD` | engine-child sets, worktrees reads | Marks delegated children; gates worktree tool registration (internal) |
| `TORUS_MEMORY_COMMIT=1` | memory sets, store pre-commit hook reads | Marks in-process git spawns on the memory store; agent-run commits are refused (internal) |
| `TORUS_HOME` | fsutil | Base dir for torus state (default `~/.torus`) |
| `TORUS_TMUX=0` | registry | Disable delegation tmux panes |
| `TORUS_NOTIFY=0` | osnotify | Disable desktop notifications |
| `TORUS_GUARDS=0` / `TORUS_MAX_TOOL_OUTPUT` | guards | Disable guards / output truncation cap (default 16000) |
| `TORUS_HASHLINE=0` / `TORUS_FMT_CMD` | hashline | Disable anchoring / post-edit formatter command |
| `TORUS_INTERACTIVE=0` | interactive | Disable `interactive_bash` overlay |
| `TORUS_MONITOR=0` | monitor | Disable monitors |
| `TORUS_STATUSLINE_COST=0` | ui | Disable the session-cost statusline chip |
| `TORUS_TEAM_NOTIFY=0` | team | Disable the per-member idle/crash wake-up markers (result markers still render) |
| `TORUS_COMMENT_CHECKER=0` / `TORUS_COMMENT_CHECKER_PROMPT` | comment-checker | Disable / override the challenge text |
| `TORUS_WORKTREES_ROOT` | worktrees | Worktree root override (default `~/.torus/worktrees`) |
| `TORUS_APPROVAL=0` | approval | Disable the trust-on-denial dialog (unmatched hosts deny) |
| `TORUS_SANDBOX` / `TORUS_SANDBOX_WRITABLE` / `TORUS_SANDBOX_NET_ADD` / `TORUS_SANDBOX_NET_ONLY` | sandbox | Per-command sandbox (`off` \| `full`, default **off** — `full`/`on`/`1` sandboxes agent bash; unset runs unsandboxed; unknown values default to off with a notice; confines writes to workspace+tmp+extras, network restricted to a curated exact-host allowlist of 30 dev-workflow hosts — registries, GitHub incl. release assets, core toolchains) / extra writable roots, colon-separated / comma-separated extra allowed hosts (exact-host; over-broad entries dropped) / comma-separated hosts replacing the curated allowlist |
| `TORUS_REFLECTION=0` | memory | Disable idle reflection |
| `TORUS_REFLECT_TURNS=<n>` | memory | Reflect after N settles since the last reflect (0 = idle-only; default 12) |
| `TORUS_DREAMING=0` | memory | Disable dream consolidation |
| `TORUS_THEME_DEBUG` | persona-theme | Theme debugging |
