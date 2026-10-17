import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { registerVision, mimeForPath } = await import("../extensions/vision/index.ts");

// 1x1 transparent PNG.
const PNG_1PX =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function captureTool() {
	const captured = { tool: null };
	registerVision({
		registerTool(tool) {
			captured.tool = tool;
		},
	});
	return captured;
}

async function run(tool, params, ctx) {
	return tool.execute("tc1", params, undefined, undefined, ctx);
}

test("mimeForPath maps supported extensions only", () => {
	assert.equal(mimeForPath("/tmp/a.PNG"), "image/png");
	assert.equal(mimeForPath("/tmp/b.webp"), "image/webp");
	assert.equal(mimeForPath("/tmp/c.txt"), null);
});

test("look_at refuses (red) on non-image-capable models instead of attaching", async () => {
	const { tool } = captureTool();
	const result = await run(
		tool,
		{ paths: ["/tmp/a.png"], goal: "see it" },
		{
			model: { id: "text-only", input: ["text"] },
		},
	);
	assert.equal(result.isError, true, "refusal must paint red");
	assert.equal(result.details.attached, 0);
	assert.ok(
		result.content[0].text.includes("not image-capable") &&
			result.content[0].text.includes("looker"),
		"refusal must name the capability gap and the looker route",
	);
});

test("look_at refuses when the model is unknown", async () => {
	const { tool } = captureTool();
	const result = await run(tool, { paths: ["/tmp/a.png"] }, {});
	assert.equal(result.isError, true);
	assert.equal(result.details.reason, "model-not-image-capable");
});

test("look_at attaches for image-capable models and reports skips", async (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-vision-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const png = path.join(dir, "dot.png");
	writeFileSync(png, Buffer.from(PNG_1PX, "base64"));

	const { tool } = captureTool();
	const result = await run(
		tool,
		{ paths: [png, path.join(dir, "nope.txt")], goal: "check the pixel" },
		{ model: { id: "vision-model", input: ["text", "image"] } },
	);
	assert.equal(result.isError, undefined, "capable model with one image is green");
	assert.equal(result.details.attached, 1);
	assert.equal(result.details.skipped.length, 1, "unsupported extension is skipped, not fatal");
	const image = result.content.find((block) => block.type === "image");
	assert.equal(image.mimeType, "image/png");
});

test("look_at goes red when nothing could be attached even on a capable model", async (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "torus-vision-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const { tool } = captureTool();
	const result = await run(
		tool,
		{ paths: [path.join(dir, "missing.png")] },
		{ model: { id: "vision-model", input: ["text", "image"] } },
	);
	assert.equal(result.isError, true, "zero attachments must not read as success");
	assert.equal(result.details.attached, 0);
});
