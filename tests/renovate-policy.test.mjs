import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(path.join(root, "renovate.json"), "utf8"));

function ruleIndex(predicate) {
	return config.packageRules.findIndex(predicate);
}

test("workflow and container updates never automerge and override the general lane", () => {
	const manualIndex = ruleIndex(
		(rule) =>
			Array.isArray(rule.matchManagers) &&
			rule.matchManagers.includes("github-actions") &&
			rule.matchManagers.includes("dockerfile") &&
			rule.automerge === false,
	);
	assert.ok(
		manualIndex !== -1,
		"no rule gates both github-actions and dockerfile managers with automerge false",
	);

	const automergeIndex = ruleIndex(
		(rule) =>
			rule.automerge === true &&
			Array.isArray(rule.matchUpdateTypes) &&
			rule.matchUpdateTypes.includes("minor") &&
			rule.matchUpdateTypes.includes("patch"),
	);
	assert.ok(automergeIndex !== -1, "no general minor/patch automerge rule");
	assert.ok(
		manualIndex > automergeIndex,
		`manual gate (index ${manualIndex}) must sort after the general automerge rule (index ${automergeIndex}) so it wins`,
	);
});

test("osv vulnerability alerts are enabled", () => {
	assert.equal(config.osvVulnerabilityAlerts, true);
});

test("engine pins stay manual after the general automerge rule", () => {
	const engineIndex = ruleIndex(
		(rule) =>
			rule.automerge === false &&
			Array.isArray(rule.matchPackageNames) &&
			rule.matchPackageNames.includes("@earendil-works/pi-coding-agent"),
	);
	assert.ok(engineIndex !== -1, "no manual rule covers the engine pins");

	const automergeIndex = ruleIndex((rule) => rule.automerge === true);
	assert.ok(automergeIndex !== -1, "no automerge rule at all");
	assert.ok(
		engineIndex > automergeIndex,
		"engine-pin manual rule must sort after the automerge rules",
	);
});

test("minimum release age stays at 7 days", () => {
	assert.equal(config.minimumReleaseAge, "7 days");
});
