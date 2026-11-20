#!/usr/bin/env node
/**
 * fence — the CI-side entry for extensions/untrusted.ts: wrap untrusted
 * event fields in a torus-owned fence block before they reach an agent
 * prompt.
 *
 * CI events (GitHub webhooks, cron scrapes, mirror fetches) carry text that
 * attacker content can influence. Piping such text raw into a prompt template
 * is a prompt-injection surface; fence.mjs reads the fields as JSON on stdin
 * and emits the neutralized, byte-capped fence block — the shared preamble,
 * one `[untrusted: label]` … `[/untrusted]` fence per field — on stdout,
 * ready to redirect to a file.
 *
 * Invocation, from the torus checkout root under plain node
 * (no npm scripts, no flags):
 *   node runtime/bin/fence.mjs < fields.json > fenced.txt
 *   echo '{"label":"github-issue","content":"..."}' | node runtime/bin/fence.mjs
 *   echo '{"fields":{"title":"...","body":"..."}}' | node runtime/bin/fence.mjs
 *   node runtime/bin/fence.mjs --max-bytes 1024 < fields.json > fenced.txt
 *
 * stdin is a UTF-8 JSON object, either a single field
 * ({"label": "...", "content": "..."}) or several
 * ({"fields": {"label1": "content1", ...}}, insertion order preserved).
 * --max-bytes <N> overrides the default per-field body cap. Exit 0 writes
 * ONLY the fenced block to stdout; any refusal exits 1 with a named one-line
 * error on stderr and nothing on stdout.
 *
 * CI pipes content via stdin or a file, never argv: event payloads can blow
 * the kernel's per-exec argument budget (E2BIG / ARG_MAX) and argv leaks into
 * process listings. When the fenced output feeds a prompt, write it to a file
 * and reference that file with the pinned engine's `@path` include
 * (docs/cli.md of @earendil-works/pi-coding-agent: "@path — Include a text
 * file or image in the first prompt") instead of interpolating it into the
 * command line.
 *
 * The runtime module is TypeScript with .js import specifiers, so this
 * launcher registers a .js→.ts resolve hook (same mapping as
 * tests/resolve-ts-hook.mjs) and needs type stripping: Node with default
 * stripping (>=23.6, 22.18+) runs it as-is; an older Node is re-exec'd once
 * with --experimental-strip-types --no-warnings.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pre-strip-types Node cannot load the .ts runtime module; re-exec this
// script with the flag once (the env marker prevents any loop on nodes that
// lack the flag entirely — they exit with a bad-option error instead).
if (!process.features.typescript && !process.env["TORUS_FENCE_BOOTSTRAPPED"]) {
	const reexec = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", process.argv[1], ...process.argv.slice(2)],
		{ stdio: "inherit", env: { ...process.env, TORUS_FENCE_BOOTSTRAPPED: "1" } },
	);
	process.exit(reexec.status ?? 1);
}

const { registerHooks } = await import("node:module");
// Extensions import each other with .js specifiers over .ts sources; remap
// before the runtime module's graph loads (registered hooks only apply to
// imports that happen after this call, hence the dynamic import below).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js") && !specifier.includes("node_modules") && context.parentURL) {
			try {
				const tsPath = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, ".ts");
				if (existsSync(tsPath)) {
					return nextResolve(pathToFileURL(tsPath).href, context);
				}
			} catch {
				// fall through to default resolution
			}
		}
		return nextResolve(specifier, context);
	},
});

const runtime = await import(new URL("../../extensions/untrusted.ts", import.meta.url).href);
const { fenceField, fenceFields } = runtime;

const argv = process.argv.slice(2);

function refuse(message) {
	process.stderr.write(`fence: ${message}\n`);
	process.exit(1);
}

function maxBytes() {
	const values = [];
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--max-bytes") {
			if (index + 1 >= argv.length) refuse("--max-bytes requires a value");
			values.push(argv[index + 1]);
			index++;
			continue;
		}
		refuse(`unknown argument "${argv[index]}" — expected at most --max-bytes <N>`);
	}
	if (values.length === 0) return undefined;
	if (values.length > 1) refuse("--max-bytes given more than once");
	const raw = values[0];
	if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
		refuse(`--max-bytes must be a positive integer, got "${raw}"`);
	}
	return Number(raw);
}

function readStdin() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		process.stdin.on("data", (chunk) => chunks.push(chunk));
		process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
		process.stdin.on("error", reject);
	});
}

const max = maxBytes();
const raw = (await readStdin()).toString("utf8");
if (raw.trim().length === 0) {
	refuse("stdin is empty — expected a JSON object on stdin");
}

let parsed;
try {
	parsed = JSON.parse(raw);
} catch (error) {
	refuse(`malformed JSON on stdin: ${error instanceof Error ? error.message : String(error)}`);
}
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
	refuse('stdin must be a JSON object — {"label":...,"content":...} or {"fields":{...}}');
}

try {
	let block;
	if ("fields" in parsed) {
		const { fields } = parsed;
		if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
			refuse('"fields" must be an object mapping label to content');
		}
		block = fenceFields(fields, max === undefined ? undefined : { maxBytes: max });
	} else {
		const { label, content } = parsed;
		if (typeof label !== "string" || typeof content !== "string") {
			refuse('stdin needs "label" and "content" strings, or a "fields" object');
		}
		block = fenceField(label, content, max === undefined ? undefined : { maxBytes: max });
	}
	process.stdout.write(block);
} catch (error) {
	// The fence shapers throw RangeError on malformed labels; print the
	// message cleanly instead of a stack trace.
	refuse(error instanceof Error ? error.message : String(error));
}
