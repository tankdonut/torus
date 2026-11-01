import assert from "node:assert/strict";
import { test } from "node:test";
import { copyPayload, rehypeCodeCopy } from "../site/src/lib/code-copy.mjs";

const fence = (text, lang = "sh") => ({
	type: "element",
	tagName: "pre",
	properties: {},
	children: [
		{
			type: "element",
			tagName: "code",
			properties: { className: [`language-${lang}`] },
			children: [{ type: "text", value: text }],
		},
	],
});

const paragraph = (text) => ({
	type: "element",
	tagName: "p",
	properties: {},
	children: [{ type: "text", value: text }],
});

const run = (tree) => rehypeCodeCopy()(tree);

const findFirst = (node, tagName) => {
	if (node.type === "element" && node.tagName === tagName) return node;
	for (const child of node.children ?? []) {
		const hit = findFirst(child, tagName);
		if (hit) return hit;
	}
	return null;
};

test("copyPayload strips shell prompts per line and drops the trailing newline", () => {
	assert.equal(copyPayload("$ torus doctor\nchecking\nok\n"), "torus doctor\nchecking\nok");
	assert.equal(copyPayload("no prompt here"), "no prompt here");
	assert.equal(copyPayload("$ spaced   flags\n$ second"), "spaced   flags\nsecond");
});

test("a fence becomes a positioned figure with a data-copy button", () => {
	const tree = { type: "root", children: [paragraph("intro"), fence("$ torus doctor\nok\n")] };
	run(tree);
	const figure = tree.children[1];
	assert.equal(figure.tagName, "figure");
	assert.deepEqual(figure.properties.className, ["code-fence"]);
	assert.equal(figure.children.length, 2);
	assert.equal(figure.children[0].tagName, "pre");
	const button = figure.children[1];
	assert.equal(button.tagName, "button");
	assert.equal(button.properties.type, "button");
	assert.equal(button.properties.dataCopy, "torus doctor\nok");
	assert.deepEqual(
		button.children.map((child) => child.value),
		["copy"],
	);
	// The fence content itself is untouched.
	assert.equal(figure.children[0].children[0].children[0].value, "$ torus doctor\nok\n");
});

test("fences anywhere in the tree get buttons; other nodes pass through", () => {
	const tree = {
		type: "root",
		children: [
			{
				type: "element",
				tagName: "li",
				properties: {},
				children: [fence("plain text")],
			},
			paragraph("outro"),
		],
	};
	run(tree);
	const figure = tree.children[0].children[0];
	assert.equal(figure.tagName, "figure");
	assert.equal(figure.children[1].properties.dataCopy, "plain text");
	assert.equal(tree.children[1].tagName, "p");
	assert.equal(tree.children[1].children[0].value, "outro");
});

test("a second pass leaves wrapped fences alone (idempotent)", () => {
	const tree = { type: "root", children: [fence("$ x")] };
	run(tree);
	run(tree);
	const figure = tree.children[0];
	assert.equal(figure.tagName, "figure");
	assert.equal(figure.children[0].tagName, "pre");
	assert.equal(figure.children[1].properties.dataCopy, "x");
	// No nested second wrapper around the pre.
	assert.equal(findFirst(figure, "figure"), figure);
});
