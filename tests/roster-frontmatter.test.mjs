import assert from "node:assert/strict";
import { test } from "node:test";

// roster frontmatter contract: agents/*.md frontmatter IS the agent
// definition. parseAgentFile must accept the full field set, apply defaults,
// reject description-less files, and keep the body prompt intact for
// marker substitution.

const { parseAgentFile, AGENTS } = await import("../extensions/roster/index.ts");

test("parses the full frontmatter field set", () => {
	const raw = [
		"---",
		"name: librarian",
		"description: External-reference researcher",
		"chain: fast",
		"mode: child",
		"aliases: research, docs",
		"tools: read, bash",
		"---",
		"",
		"TORUS AGENT body text",
	].join("\n");
	const def = parseAgentFile("librarian.md", raw);
	assert.ok(def);
	assert.equal(def.name, "librarian");
	assert.equal(def.description, "External-reference researcher");
	assert.equal(def.chain, "fast");
	assert.deepEqual(def.commandAliases, ["research", "docs"]);
	assert.deepEqual(def.tools, ["read", "bash"]);
	assert.ok(def.promptBody?.includes("TORUS AGENT body text"));
	assert.ok(!def.promptBody.includes("name: librarian"), "frontmatter leaked into prompt body");
});

test("defaults: unknown chain falls back to primary, name falls back to filename", () => {
	const raw = "---\ndescription: x\n---\nbody";
	const def = parseAgentFile("build.md", raw);
	assert.ok(def);
	assert.equal(def.name, "build");
	assert.equal(def.chain, "primary");
	assert.equal(def.commandAliases, undefined);
});

test("rejects files without frontmatter or without description", () => {
	assert.equal(parseAgentFile("x.md", "no frontmatter at all"), null);
	assert.equal(parseAgentFile("x.md", "---\nname: x\n---\nbody"), null);
});

test("repo roster invariants: current agents load, leader present, librarian carries research alias", () => {
	assert.ok(AGENTS.length >= 5, `expected >=5 agents, got ${AGENTS.length}`);
	const leader = AGENTS.find((a) => a.name === "leader");
	assert.ok(leader, "leader persona missing");
	const librarian = AGENTS.find((a) => a.name === "librarian");
	assert.ok(librarian?.commandAliases?.includes("research"), "librarian alias research missing");
});
