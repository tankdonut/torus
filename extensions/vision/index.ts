/**
 * torus — vision.
 *
 * `look_at` loads image files into the conversation as ImageContent blocks
 * so an image-capable model can actually see them; non-image models get a
 * red refusal pointing at the looker agent instead of silently omitted
 * images. The looker roster agent consumes this tool as a vision specialist.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_IMAGES = 3;
const MAX_BYTES = 4 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

export function mimeForPath(file: string): string | null {
	return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? null;
}

const lookAtTool = defineTool({
	name: "look_at",
	label: "Look At",
	description:
		"Load image file(s) into the conversation so you can see them (screenshots, diagrams, photos). Pass 1-3 absolute paths and what you want to determine from them; the images are attached to your next view of the conversation. Refuses (red) when the active model is not image-capable: delegate to the looker agent instead.",
	parameters: Type.Object({
		paths: Type.Array(
			Type.String({ description: "Absolute image file paths (png/jpg/jpeg/webp/gif)" }),
			{
				minItems: 1,
				maxItems: MAX_IMAGES,
			},
		),
		goal: Type.Optional(Type.String({ description: "What to look for or determine" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		// Same capability signal the engine's read tool uses: attached images are
		// silently dropped for models without image input, which reads as success.
		const model = ctx?.model;
		if (!model?.input?.includes("image")) {
			return {
				content: [
					{
						type: "text" as const,
						text: `look_at refused: the current model (${model?.id ?? "unknown"}) is not image-capable, so attached images would be omitted from the request. Delegate the sighting to the looker agent instead; it runs an image-capable model.`,
					},
				],
				details: { attached: 0, skipped: [], reason: "model-not-image-capable" },
				isError: true,
			};
		}
		const content: Array<
			{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
		> = [];
		const skipped: string[] = [];

		for (const raw of params.paths.slice(0, MAX_IMAGES)) {
			const mime = mimeForPath(raw);
			if (!mime) {
				skipped.push(`${raw}: unsupported extension (png/jpg/jpeg/webp/gif only)`);
				continue;
			}
			let size = 0;
			try {
				size = statSync(raw).size;
			} catch {
				skipped.push(`${raw}: not readable`);
				continue;
			}
			if (size > MAX_BYTES) {
				skipped.push(
					`${raw}: ${Math.round(size / 1024)}KB exceeds the ${Math.round(MAX_BYTES / 1024)}KB limit — downscale first`,
				);
				continue;
			}
			try {
				const data = readFileSync(raw).toString("base64");
				content.push({ type: "image", data, mimeType: mime });
			} catch (err) {
				skipped.push(`${raw}: ${String(err)}`);
			}
		}

		const header =
			content.length > 0
				? `${content.length} image(s) attached${params.goal ? ` — goal: ${params.goal}` : ""}`
				: "no images could be attached";
		content.unshift({
			type: "text",
			text: skipped.length > 0 ? `${header}\nSkipped: ${skipped.join("; ")}` : header,
		});

		if (content.length === 1) {
			return { content, details: { attached: 0, skipped }, isError: true };
		}
		return { content, details: { attached: content.length - 1, skipped } };
	},
});

export function registerVision(pi: ExtensionAPI): void {
	pi.registerTool(lookAtTool);
}

export default function visionExtension(pi: ExtensionAPI): void {
	registerVision(pi);
}
