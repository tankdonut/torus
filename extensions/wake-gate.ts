import { emitTorusCustom, sharedState } from "./registry.js";

/**
 * One pending wake marker, held while the agent is mid-run. `customType`,
 * `details`, and `text` carry exactly what an ungated emit would have sent.
 */
export interface WakeEntry {
	customType: string;
	text: string;
	details?: Record<string, unknown>;
}

interface WakeGateState {
	pending: WakeEntry[];
	agentActive: boolean;
}

/**
 * Wake gate: the delivery-side batch for session-waking markers (team-wake
 * batches, monitor fires). pi's followUpMode default ("one-at-a-time") drains
 * each queued follow-up as its own model run, so N markers handed to pi while
 * the session is busy trickle out as N wasted turns once it settles — and pi
 * offers no way to un-queue them, which let a deleted team keep waking the
 * session for a minute straight. The gate holds entries in torus instead:
 * queued while a run is active, flushed as ONE marker when the run settles
 * (and immediately when idle). A single-entry flush keeps the original
 * customType so renderers and the model see the marker they always saw; only
 * multi-entry flushes wrap in "torus.wake-batch".
 */
const gateState = sharedState(
	Symbol.for("torus.wake-gate.v1"),
	(): WakeGateState => ({
		pending: [],
		agentActive: false,
	}),
);

export function wakeGateAgentStart(): void {
	gateState.agentActive = true;
}

/** Settle flushes the whole backlog at once; a run aborted mid-flight settles too. */
export function wakeGateAgentSettled(): void {
	gateState.agentActive = false;
	flushWakeGate();
}

export function queueWakeEntry(entry: WakeEntry): void {
	gateState.pending.push(entry);
	if (!gateState.agentActive) flushWakeGate();
}

/** Removes matching held entries (e.g. a deleted team's undelivered wake); returns the drop count. */
export function dropWakeEntries(match: (entry: WakeEntry) => boolean): number {
	const before = gateState.pending.length;
	gateState.pending = gateState.pending.filter((entry) => !match(entry));
	return before - gateState.pending.length;
}

export function flushWakeGate(): void {
	const entries = gateState.pending.splice(0);
	if (entries.length === 0) return;
	const single = entries.length === 1 ? entries[0] : undefined;
	const emitted = emitTorusCustom(
		single
			? {
					customType: single.customType,
					content: [{ type: "text", text: single.text }],
					display: true,
					details: single.details,
				}
			: {
					customType: "torus.wake-batch",
					content: [
						{
							type: "text",
							text: entries.map((entry) => entry.text).join("\n"),
						},
					],
					display: true,
					details: {
						count: entries.length,
						entries: entries.map((entry) => ({
							customType: entry.customType,
							details: entry.details,
						})),
					},
				},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	// No sender (child sessions, tests): the backlog is spent either way — a
	// marker that never reached a session must not resurrect on a later settle.
	void emitted;
}

export function _setWakeGateActiveForTesting(active: boolean): void {
	gateState.agentActive = active;
}

export function _resetWakeGateForTesting(): void {
	gateState.pending = [];
	gateState.agentActive = false;
}
