// Bench task suite — fixed, read-only, repo-local prompts run by every config.
//
// Tasks are tiered so the report can show whether harness overhead scales with
// task difficulty: trivial (single lookup), aggregate (sweep many files), and
// reason (read + synthesize). Every prompt must stay read-only — the bench
// measures the harness layer, not side effects — and end with the same guard
// sentence. Prompts are executed verbatim against the working tree, so they
// must reference stable repo paths only.

/** @typedef {"trivial" | "aggregate" | "reason"} TaskTier */

/**
 * @typedef {object} BenchTask
 * @property {string} id        stable slug, used in tables and --tasks
 * @property {TaskTier} tier    difficulty tier
 * @property {string} prompt    verbatim prompt text (read-only)
 */

/** @type {ReadonlyArray<Readonly<BenchTask>>} */
export const TASKS = [
	{
		id: "readme-name",
		tier: "trivial",
		prompt: "Read README.md and state the project name in one sentence. Do not modify any files.",
	},
	{
		id: "agents-doc-headings",
		tier: "trivial",
		prompt: "Open docs/agents.md and list its section headings verbatim. Do not modify any files.",
	},
	{
		id: "register-tool-count",
		tier: "aggregate",
		prompt:
			'Count how many times "registerTool" appears across the files under extensions/ and report just the number. Do not modify any files.',
	},
	{
		id: "skills-inventory",
		tier: "aggregate",
		prompt:
			"List the name of every directory directly under skills/ that contains a SKILL.md, one per line. Do not modify any files.",
	},
	{
		id: "extension-registration",
		tier: "reason",
		prompt:
			"Read extensions/registry.ts and docs/extensions.md. In at most three bullets, explain what a new extension must do to get loaded. Do not modify any files.",
	},
	{
		id: "engine-pin-report",
		tier: "reason",
		prompt:
			"Read package.json and report, one per line: the version field, and the pinned version of @earendil-works/pi-coding-agent in devDependencies. Do not modify any files.",
	},
];

/** The read-only guard sentence every bench prompt must carry. */
export const READ_ONLY_GUARD = "Do not modify any files.";

/**
 * Resolve a comma-separated task-id list to task objects; empty selector
 * returns the full suite. Unknown ids throw so typos fail loud, not silently
 * as a smaller bench.
 * @param {string} selector
 */
export function selectTasks(selector) {
	if (selector.trim() === "") return [...TASKS];
	const ids = selector
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const tasks = [];
	for (const id of ids) {
		const task = TASKS.find((t) => t.id === id);
		if (!task)
			throw new Error(`unknown task id: ${id} (known: ${TASKS.map((t) => t.id).join(", ")})`);
		tasks.push(task);
	}
	return tasks;
}
