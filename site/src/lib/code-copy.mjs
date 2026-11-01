// Copy buttons for markdown code fences. The landing's shell blocks render
// through components/CodeBlock.astro, which owns its copy button; every other
// page renders markdown through the unified pipeline, where fences arrive as
// bare <pre><code> with no affordance. This rehype plugin wraps each fence in
// a positioned figure and appends the same data-copy button CodeBlock emits,
// so one client handler (lib/copy-buttons.mjs) serves both.

const FENCE_CLASS = "code-fence";

// Copied fences must paste back runnable commands: a leading "$ " is prompt
// decoration, not payload. Lines without a prompt pass through untouched.
// (Same rule as CodeBlock, which strips the same prefix for the same reason.)
const PROMPT = /^\$\s+/;

/** Copy payload for a fence's text: prompts stripped, trailing newline dropped. */
export function copyPayload(text) {
	return text
		.split("\n")
		.map((line) => line.replace(PROMPT, ""))
		.join("\n")
		.replace(/\n$/, "");
}

function textOf(node) {
	if (node.type === "text") return node.value;
	if (Array.isArray(node.children)) return node.children.map(textOf).join("");
	return "";
}

function copyButton(payload) {
	return {
		type: "element",
		tagName: "button",
		properties: { className: ["copy"], type: "button", dataCopy: payload },
		children: [{ type: "text", value: "copy" }],
	};
}

function wrapFence(pre) {
	return {
		type: "element",
		tagName: "figure",
		properties: { className: [FENCE_CLASS] },
		children: [pre, copyButton(copyPayload(textOf(pre)))],
	};
}

function isFenceFigure(node) {
	return (node.properties?.className ?? []).includes(FENCE_CLASS);
}

function transformNode(node) {
	if (!Array.isArray(node.children)) return;
	node.children = node.children.map((child) => {
		if (child.type !== "element") return child;
		// Idempotent: a fence this plugin already wrapped is left alone, so a
		// second pass (or a rerender of a processed tree) never nests figures.
		if (child.tagName === "figure" && isFenceFigure(child)) return child;
		if (child.tagName === "pre") return wrapFence(child);
		transformNode(child);
		return child;
	});
}

/**
 * rehype plugin: every <pre> becomes a figure.code-fence holding the pre and a
 * copy button. The button sits outside the pre so the pre's horizontal
 * scrolling never carries it away; the fence content itself is untouched.
 */
export function rehypeCodeCopy() {
	return function transformer(tree) {
		transformNode(tree);
	};
}
