import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// The docs render in place from the repo root: no copies under site/src. The
// allowlist is exact files, so maintainer docs (agents.md, style.md,
// release-workflow.md, smoke-checklist.md) and README/AGENTS/CONTRIBUTING stay
// unrendered. Ids are the repo-relative paths, which is what the link rewriter
// and the "View source" links key off.
const docs = defineCollection({
	loader: glob({
		base: new URL("../../", import.meta.url),
		pattern: [
			"docs/getting-started.md",
			"docs/extensions.md",
			"docs/configuration.md",
			"docs/writing-agents.md",
			"docs/serve.md",
			"docs/container.md",
			"docs/pi-packages.md",
			"docs/updating.md",
			"docs/troubleshooting.md",
			"docs/efficiency.md",
			"docs/instructions.md",
			"docs/skills.md",
			"SECURITY.md",
			"CHANGELOG.md",
		],
		generateId: ({ entry }) => entry,
	}),
});

export const collections = { docs };
