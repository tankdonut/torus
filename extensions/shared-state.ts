/**
 * Sanctioned global-state pattern: every `Symbol.for` key in extensions/ is
 * defined here.
 *
 * pi loads each manifest extension entry with its own module root, so a plain
 * module-level Map would be a DIFFERENT instance per entry (observed: the
 * browser entry saw an empty registry while the roster entry populated
 * another). State that must cross entries lives on globalThis instead,
 * addressed by a `Symbol.for` key so every module root resolves the same
 * property. This module imports nothing from extensions/, so every entry can
 * import it and reach the same keys without cycles.
 */

/** Read-or-initialize a globalThis slot keyed by a Symbol.for key. */
export function sharedState<T>(key: symbol, init: () => T): T {
	const store = globalThis as Record<symbol, unknown>;
	const existing = store[key] as T | undefined;
	if (existing !== undefined) return existing;
	const created = init();
	store[key] = created;
	return created;
}

/** Overwrite a globalThis slot: the write path for read/write keys. */
export function setSharedState(key: symbol, value: unknown): void {
	(globalThis as Record<symbol, unknown>)[key] = value;
}

// --- registry.ts (delegations) ---

export const REGISTRY_KEY = Symbol.for("torus.delegation-registry");
export const OBSERVERS_KEY = Symbol.for("torus.delegation-observers");
export const CONTROLS_KEY = Symbol.for("torus.delegation-controls");
export const PERSONA_KEY = Symbol.for("torus.session-persona");

/** Shared slot for the current session id, written on session_start. */
export const CURRENT_SESSION = Symbol.for("torus.current-session");

/** Shared slot for the fleet-overlay opener the notify layer clicks into. */
export const FLEET_OPENER = Symbol.for("torus.fleet-opener");

export const CUSTOM_SENDER_KEY = Symbol.for("torus.custom-sender");
export const TEAMS_KEY = Symbol.for("torus.teams.v1");

// --- ui/index.ts (statusline chips) ---

/** The absorbed lsp display text, so every ui module instance renders it. */
export const LSP_TEXT_KEY = Symbol.for("torus.statusline.lsp.v1");
/** Marks a wrapped setStatus so the wrapping stays idempotent. */
export const STATUS_WRAP_MARK = Symbol.for("torus.status-absorb.v1");
/** The torus statusline chips; undefined removes a chip. */
export const CHIPS_KEY = Symbol.for("torus.statusline.chips.v1");
/** The statusline widget's repaint hook, installed at widget creation. */
export const CHIPS_REPAINT_KEY = Symbol.for("torus.statusline.repaint.v1");
/** Fleet spend per session, folded per-record as a cost delta. */
export const FLEET_SPEND_KEY = Symbol.for("torus.statusline.fleet-spend.v1");
/** Model/effort/provider segment state, so rebinds re-seed instead of blanking. */
export const MODEL_STATE_KEY = Symbol.for("torus.statusline.model-state.v1");
/** Permission-mode chip state pushed by the automode extension. */
export const PERMISSION_KEY = Symbol.for("torus.status.permission.v1");

// --- monitor/index.ts ---

/** Live monitor entries, keyed by monitor name. */
export const MONITORS_KEY = Symbol.for("torus.monitors");
/** Background task entries, keyed by task id. */
export const BG_KEY = Symbol.for("torus.bg.v1");

// --- handles/index.ts ---

/** The active session's theme, so the markdown transformer can style mentions. */
export const THEME_SLOT = Symbol.for("torus.handles.theme.v1");

// --- sandbox/index.ts + doctor/index.ts ---

/** Shared sandbox state ({ mode, active }), written by sandbox, read by /doctor. */
export const SANDBOX_SLOT = Symbol.for("torus.sandbox.v1");

// --- platform.ts ---

/** Platform-gate decisions, consulted by tests and the /doctor platform check. */
export const PLATFORM_SLOT = Symbol.for("torus.platform.v1");

// --- wake-gate.ts ---

/** Queued wake episodes plus the agent-active latch that gates their flush. */
export const WAKE_GATE_KEY = Symbol.for("torus.wake-gate.v1");

// --- team/index.ts ---

/** Per-team member handles, keyed by team id. */
export const TEAM_CONTROLS_KEY = Symbol.for("torus.team-controls.v1");
/** Members marked for deliberate shutdown; other stops surface as failures. */
export const MEMBER_DELIBERATE_STOPS_KEY = Symbol.for("torus.member-deliberate-stops.v1");
/** Supervisor generation per member id: a respawn invalidates the prior closure's registry writes. */
export const MEMBER_GENERATIONS_KEY = Symbol.for("torus.member-generations.v1");
/** Per-member wake-up latch: unread reports queue one wake episode. */
export const MEMBER_HAS_NEWS_KEY = Symbol.for("torus.member-has-news.v1");
/** The live member spawner, so test substitutions are visible across module roots. */
export const MEMBER_SPAWNER_KEY = Symbol.for("torus.member-spawner.v1");
/** Members whose per-member result marker is suppressed by a batch caller (team_delete). */
export const TEAM_RESULT_MARKERS_SUPPRESSED_KEY = Symbol.for(
	"torus.team-result-markers-suppressed.v1",
);
