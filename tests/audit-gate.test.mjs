import assert from "node:assert/strict";
import test from "node:test";
import { assess } from "../scripts/audit-gate.mjs";

const ALLOW = { "GHSA-known": "reason" };

const report = (severity, ghsa, via) => ({
	vulnerabilities: {
		pkg: {
			severity,
			via: via ?? [
				{ title: "an advisory", url: `https://github.com/advisories/${ghsa}`, name: ghsa },
			],
		},
	},
});

test("audit-gate: allowed advisory is suppressed, gate passes, entry not stale", () => {
	const verdict = assess(report("high", "GHSA-known"), ALLOW);
	assert.equal(verdict.exit, 0);
	assert.deepEqual(verdict.suppressed, ["GHSA-known"]);
	assert.deepEqual(verdict.stale, []);
});

test("audit-gate: unknown high or critical advisory blocks", () => {
	for (const severity of ["high", "critical"]) {
		const verdict = assess(report(severity, "GHSA-other"), {});
		assert.equal(verdict.exit, 1, severity);
		assert.equal(verdict.blocking.length, 1, severity);
	}
});

test("audit-gate: moderate findings neither block nor satisfy an allowlist entry", () => {
	const verdict = assess(report("moderate", "GHSA-other"), {});
	assert.equal(verdict.exit, 0);
	assert.deepEqual(verdict.blocking, []);
});

test("audit-gate: a live tree with a fix shipped fails on the stale entry", () => {
	const verdict = assess({ vulnerabilities: {} }, ALLOW);
	assert.equal(verdict.exit, 1);
	assert.deepEqual(verdict.stale, ["GHSA-known"]);
	assert.match(verdict.lines.join("\n"), /remove the entries/);
});

test("audit-gate: mixed tree separates the allowed from the blocking", () => {
	const mixed = {
		vulnerabilities: {
			pkgA: {
				severity: "high",
				via: [{ title: "known one", url: "https://github.com/advisories/GHSA-known" }],
			},
			pkgB: {
				severity: "critical",
				via: [{ title: "unknown one", url: "https://github.com/advisories/GHSA-other" }],
			},
		},
	};
	const verdict = assess(mixed, ALLOW);
	assert.equal(verdict.exit, 1);
	assert.deepEqual(verdict.suppressed, ["GHSA-known"]);
	assert.equal(verdict.blocking.length, 1);
	assert.deepEqual(verdict.stale, []);
});

test("audit-gate: transitive via edges (strings) are judged at their own entry, never crash", () => {
	const chained = {
		vulnerabilities: {
			pkgA: { severity: "high", via: ["pkgB"] },
			pkgB: {
				severity: "moderate",
				via: [{ title: "mild", url: "https://github.com/advisories/GHSA-low" }],
			},
		},
	};
	const verdict = assess(chained, {});
	assert.equal(verdict.exit, 0);
});

test("audit-gate: an audit error payload fails the gate rather than passing silently", () => {
	const verdict = assess({ error: { summary: "ENOTFOUND registry" } }, {});
	assert.equal(verdict.exit, 1);
	assert.match(verdict.lines[0], /npm audit itself failed/);
});
