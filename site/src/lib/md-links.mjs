import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Repo-relative path -> site route (no base prefix; pages prepend
// import.meta.env.BASE_URL, the config pipeline prepends the configured base).
// Rendered docs map to their routes; the two generated artifacts map to their
// copied locations under /docs/. Everything else relative falls through to a
// GitHub blob URL in the rehype plugin below.
export const DOC_ROUTES = new Map([
	["README.md", "/"],
	["CHANGELOG.md", "/changelog/"],
	["SECURITY.md", "/security/"],
	["docs/getting-started.md", "/docs/getting-started/"],
	["docs/extensions.md", "/docs/extensions/"],
	["docs/configuration.md", "/docs/configuration/"],
	["docs/writing-agents.md", "/docs/writing-agents/"],
	["docs/serve.md", "/docs/serve/"],
	["docs/container.md", "/docs/container/"],
	["docs/pi-packages.md", "/docs/pi-packages/"],
	["docs/efficiency.md", "/docs/efficiency/"],
	["docs/instructions.md", "/docs/instructions/"],
	["docs/skills.md", "/docs/skills/"],
	["docs/efficiency.html", "/docs/efficiency.html"],
	["docs/bench-records.json", "/docs/bench-records.json"],
]);

const REPO_BLOB_BASE = "https://github.com/tankdonut/torus/blob/main/";
const SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

/** Site route joined onto the deploy base ("/torus" or "/"), always slash-separated. */
export function joinBase(base, route) {
	const prefix = base.endsWith("/") ? base : `${base}/`;
	if (route === "/") return prefix;
	return `${prefix}${route.slice(1)}`;
}

// Resolve a relative href against the repo path of the document containing it,
// the same way GitHub resolves links in a rendered markdown file.
function resolveRepoPath(fromRepoPath, target) {
	const segments = fromRepoPath ? fromRepoPath.split("/").slice(0, -1) : [];
	for (const segment of target.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (segments.length === 0) return null; // escapes the repo
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return segments.join("/");
}

function sourceRepoPath(file, repoRootPath) {
	let raw = file?.path ?? file?.history?.[0];
	if (!raw) return null;
	if (raw instanceof URL || (typeof raw === "string" && raw.startsWith("file://"))) {
		raw = fileURLToPath(raw);
	}
	if (typeof raw !== "string" || !raw.startsWith("/")) return null;
	const rel = relative(repoRootPath, raw);
	if (!rel || rel.startsWith("..")) return null;
	return rel.split(sep).join("/");
}

function walk(node, visit) {
	visit(node);
	if (Array.isArray(node?.children)) {
		for (const child of node.children) walk(child, visit);
	}
}

/**
 * Rewrites relative markdown links so they keep working on the rendered site:
 * links between rendered docs point at their site routes, links to generated
 * artifacts point at the copies under /docs/, and links to anything else in the
 * repo (unrendered docs, source files, manifests) point at the GitHub blob URL
 * so readers land somewhere real. Anchors and absolute URLs are untouched.
 */
export function rehypeRewriteDocLinks(options = {}) {
	const siteBase = options.siteBase ?? "/";
	const repoRootPath =
		options.repoRoot instanceof URL ? fileURLToPath(options.repoRoot) : String(options.repoRoot);
	return function transformer(tree, file) {
		const fromRepoPath = sourceRepoPath(file, repoRootPath);
		walk(tree, (node) => {
			if (node.type !== "element" || node.tagName !== "a") return;
			const href = node.properties?.href;
			if (typeof href !== "string" || href === "") return;
			const hashIndex = href.indexOf("#");
			const target = hashIndex === -1 ? href : href.slice(0, hashIndex);
			const hash = hashIndex === -1 ? "" : href.slice(hashIndex);
			if (target === "" || SCHEME.test(target)) return;
			const repoPath = resolveRepoPath(fromRepoPath, target);
			if (!repoPath) return;
			const route = DOC_ROUTES.get(repoPath);
			if (route) {
				node.properties.href = `${joinBase(siteBase, route)}${hash}`;
			} else {
				node.properties.href = `${REPO_BLOB_BASE}${repoPath}${hash}`;
			}
		});
	};
}
