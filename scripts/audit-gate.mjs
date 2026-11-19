#!/usr/bin/env node
/**
 * npm audit gate with an explicit, fail-closed allowlist.
 *
 * npm audit has no suppression mechanism, and an advisory with no patched
 * release — nothing to bump to — would otherwise block CI forever. The gate
 * keeps the audit's own severity bar (high and above fail) and suppresses
 * advisories only by GHSA id, each with a recorded reason.
 *
 * Fail-closed in both directions:
 *  - a high/critical advisory outside the allowlist fails the gate;
 *  - an allowlist entry that suppressed nothing also fails the gate: the
 *    audit stopped reporting it, so a fix must have shipped and the lock
 *    moved past it. Remove the entry. That failure is the removal reminder —
 *    it fires exactly when removal becomes possible, never before.
 *
 * Usage: node scripts/audit-gate.mjs   (after `npm ci`; needs the registry)
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** GHSA id -> why it does not block CI. Entries are removed, never added to,
 *  by hand once the audit stops reporting the id (the gate enforces this). */
export const ALLOWED = {};

/** @returns {{exit: number, lines: string[], blocking: string[], suppressed: string[], stale: string[]}} */
export function assess(report, allowlist) {
	if (report.error) {
		return {
			exit: 1,
			lines: [`audit-gate: npm audit itself failed: ${JSON.stringify(report.error)}`],
			blocking: [],
			suppressed: [],
			stale: [],
		};
	}
	const blocking = new Set();
	const suppressed = new Set();
	for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
		if (vuln.severity !== "high" && vuln.severity !== "critical") continue;
		for (const via of vuln.via ?? []) {
			if (typeof via === "string") continue; // transitive edge; judged at its own entry
			const id = (via.url ?? "").split("/").pop();
			if (!id) continue;
			if (allowlist[id]) suppressed.add(id);
			else blocking.add(`${via.title ?? id} (${id}, ${vuln.severity}) via ${pkg}`);
		}
	}
	const stale = Object.keys(allowlist).filter((id) => !suppressed.has(id));

	const lines = [];
	if (blocking.size > 0) {
		lines.push("audit-gate: blocking advisories at high or above:");
		for (const entry of blocking) lines.push(`  - ${entry}`);
	}
	if (stale.length > 0) {
		lines.push(
			`audit-gate: stale allowlist entries — the audit no longer reports ${stale.join(", ")};`,
			"  a fix must have shipped: remove the entries from scripts/audit-gate.mjs",
		);
	}
	if (lines.length === 0) {
		lines.push(
			suppressed.size > 0
				? `audit-gate: clean (${suppressed.size} suppressed by the allowlist; all entries still live)`
				: "audit-gate: clean",
		);
	}
	return {
		exit: blocking.size > 0 || stale.length > 0 ? 1 : 0,
		lines,
		blocking: [...blocking],
		suppressed: [...suppressed],
		stale,
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const res = spawnSync("npm", ["audit", "--json", "--audit-level=high"], { encoding: "utf8" });
	let report;
	try {
		report = JSON.parse(res.stdout ?? "");
	} catch {
		console.error("audit-gate: npm audit produced no parsable JSON (registry or install failure?)");
		console.error(res.stderr?.slice(0, 2000));
		process.exit(1);
	}
	const verdict = assess(report, ALLOWED);
	for (const line of verdict.lines) console.log(line);
	process.exit(verdict.exit);
}
