/**
 * The single home for every torus.* marker customType pi carries: the bare
 * union producers stamp on their events and its `torus.`-prefixed marker
 * spelling. Marker strings are compatibility-critical: transcripts written by
 * older builds still carry the prefixed spelling, which parseMarkerType
 * normalizes on read.
 */
export const MARKER = {
	delegationStart: "delegation-start",
	delegationResult: "delegation-result",
	memoryApplied: "memory-applied",
	monitorFired: "monitor-fired",
	bgExit: "bg-exit",
	teamWake: "team-wake",
	wakeBatch: "wake-batch",
	workLedger: "work-ledger",
} as const;

export type TorusMarkerType = (typeof MARKER)[keyof typeof MARKER];

/** The marker types the wake gate delivers (every wake-carrying member). */
export type WakeMarkerType = Extract<
	TorusMarkerType,
	"delegation-result" | "monitor-fired" | "bg-exit" | "team-wake"
>;

/** The pi marker spelling (`torus.`-prefixed) of every bare marker type. */
export const TORUS_MARKER = {
	delegationStart: "torus.delegation-start",
	delegationResult: "torus.delegation-result",
	memoryApplied: "torus.memory-applied",
	monitorFired: "torus.monitor-fired",
	bgExit: "torus.bg-exit",
	teamWake: "torus.team-wake",
	wakeBatch: "torus.wake-batch",
	workLedger: "torus.work-ledger",
} as const satisfies Record<keyof typeof MARKER, `torus.${TorusMarkerType}`>;

/**
 * Pi marker type for a torus customType: emitTorusCustom customTypes are
 * `torus.`-prefixed while the union is bare. Idempotent, so older callers and
 * spool records that still carry the prefixed spelling round-trip unchanged.
 */
export function markerType(type: TorusMarkerType): `torus.${TorusMarkerType}` {
	return `torus.${type}`;
}

/** Bare union member for a marker string in either spelling; undefined for unknown types. */
export function parseMarkerType(marker: string): TorusMarkerType | undefined {
	const bare = marker.replace(/^torus\./, "");
	return Object.values(MARKER).find((type) => type === bare);
}
