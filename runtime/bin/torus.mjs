#!/usr/bin/env node
/**
 * torus launcher.
 *
 * Spawns the pinned stock pi engine with the torus package loaded via
 * --extension. Override the binary with TORUS_PI_BIN; the payload root is
 * exported as TORUS_ROOT and the binary as TORUS_ENGINE_BIN so extension
 * children spawn the same engine.
 *
 * Payload resolution (source tree OR compiled single-file binary):
 *   1. TORUS_ROOT env
 *   2. source checkout (repo layout two levels above this file)
 *   3. embedded payload (compiled binaries): extracted once to ~/.torus/runtime,
 *      hash-keyed — re-extracted only when the binary's payload hash changes
 *   4. compiled layout: <execPath>/../lib/torus, <execPath>/torus-payload
 *   5. ~/.torus/runtime
 *
 * If the engine is missing in the resolved payload — or the embedded payload
 * changed since the last run — the launcher bootstraps it via `npm install`
 * there (cooldown-safe pin).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractPayload, readMarker } from "./payload-extract.mjs";

function isTorusRoot(candidate) {
	try {
		return (
			existsSync(path.join(candidate, "extensions")) &&
			existsSync(path.join(candidate, "package.json"))
		);
	} catch {
		return false;
	}
}

/**
 * bun's os.homedir() reads the passwd entry and ignores $HOME; honor the
 * env first so sandboxed/overridden HOME behaves like node.
 */
function userHome() {
	return process.env["HOME"] || homedir();
}

/**
 * Compiled binaries embed the payload as bun file assets; null in every other
 * mode (node source run, uncompiled bun, TORUS_PI_BIN-only setups). Runs
 * before the source-checkout branch: a distributed binary is self-contained —
 * a source checkout at the build-time path is coincidence, not intent.
 */
/** Set when a compiled binary re-extracted its payload this run (hash changed). */
let payloadRefreshed = false;

async function embeddedRoot() {
	const bun = globalThis.Bun;
	if (!bun || !Array.isArray(bun.embeddedFiles) || bun.embeddedFiles.length === 0) return null;
	const assets = await import("./payload-assets.mjs");
	const root = path.join(userHome(), ".torus", "runtime");
	if (isTorusRoot(root) && readMarker(root) === assets.PAYLOAD_HASH) return root;
	const files = [];
	for (const file of assets.payloadFiles) {
		files.push({ path: file.path, bytes: Buffer.from(await bun.file(file.virtual).arrayBuffer()) });
	}
	files.push({ path: "package.json", bytes: Buffer.from(assets.PAYLOAD_PACKAGE_JSON, "utf8") });
	if (assets.PAYLOAD_NPMRC !== null) {
		files.push({ path: ".npmrc", bytes: Buffer.from(assets.PAYLOAD_NPMRC, "utf8") });
	}
	if (assets.PAYLOAD_PACKAGE_LOCK != null) {
		files.push({
			path: "package-lock.json",
			bytes: Buffer.from(assets.PAYLOAD_PACKAGE_LOCK, "utf8"),
		});
	}
	process.stderr.write(`torus: extracting embedded payload to ${root}...\n`);
	try {
		extractPayload(root, assets.PAYLOAD_HASH, assets.OWNED_TOP_LEVELS, files);
		payloadRefreshed = true;
	} catch (err) {
		process.stderr.write(`torus: payload extraction failed: ${err?.message ?? err}\n`);
		process.exit(1);
	}
	return root;
}

async function resolveRoot() {
	if (process.env["TORUS_ROOT"] && isTorusRoot(process.env["TORUS_ROOT"])) {
		return process.env["TORUS_ROOT"];
	}
	const embedded = await embeddedRoot();
	if (embedded) return embedded;
	const fromSource = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
	if (isTorusRoot(fromSource)) return fromSource;
	const execDir = path.dirname(process.execPath);
	const compiled = [
		path.join(execDir, "..", "lib", "torus"),
		path.join(execDir, "torus-payload"),
		path.join(execDir),
		path.join(userHome(), ".torus", "runtime"),
	];
	for (const candidate of compiled) {
		if (isTorusRoot(candidate)) return candidate;
	}
	process.stderr.write(
		`torus: no payload found (TORUS_ROOT unset, no source layout, none of ${compiled.join(", ")})\n`,
	);
	process.exit(1);
}

const root = await resolveRoot();

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const pin =
	pkg.dependencies?.["@earendil-works/pi-coding-agent"] ??
	pkg.devDependencies?.["@earendil-works/pi-coding-agent"];
const argv = process.argv.slice(2);

// torus serve — the authenticated delegation API (extensions/serve/index.ts).
// Intercepted before the pi passthrough: the server process IS the surface,
// not an extension inside an engine session. The serve module is TypeScript
// with .js import specifiers, so this plain .mjs launcher uses the same
// bootstrap as team-task.mjs: a .js→.ts resolve hook after an optional
// one-shot strip-types re-exec on older Node.
if (argv[0] === "serve") {
	if (!process.features.typescript && !process.env["TORUS_SERVE_BOOTSTRAPPED"]) {
		const reexec = spawnSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", process.argv[1], ...argv],
			{ stdio: "inherit", env: { ...process.env, TORUS_SERVE_BOOTSTRAPPED: "1" } },
		);
		process.exit(reexec.status ?? 1);
	}
	const { registerHooks } = await import("node:module");
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier.endsWith(".js") && !specifier.includes("node_modules") && context.parentURL) {
				try {
					const tsPath = fileURLToPath(new URL(specifier, context.parentURL)).replace(
						/\.js$/,
						".ts",
					);
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
	process.env["TORUS_ROOT"] = root;
	if (!process.env["TORUS_ENGINE_BIN"]) process.env["TORUS_ENGINE_BIN"] = resolveBinary();
	const serve = await import(new URL("../../extensions/serve/index.ts", import.meta.url).href);
	try {
		const handle = await serve.startServe();
		const shutdown = () => {
			void handle.close().then(() => process.exit(0));
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	} catch (err) {
		process.stderr.write(`torus: serve failed to start: ${err?.message ?? err}\n`);
		process.exit(1);
	}
	// The listening socket keeps the process alive; nothing below (engine
	// passthrough) applies to serve.
	await new Promise(() => {});
}

if (argv[0] === "--version") {
	process.stdout.write(`torus ${pkg.version}${pin ? ` (pi@${pin})` : ""}\n`);
	process.exit(0);
}

function resolveBinary() {
	const envBin = process.env["TORUS_PI_BIN"];
	if (envBin) return envBin;
	const local = path.join(root, "node_modules", ".bin", "pi");
	if (existsSync(local) && !payloadRefreshed) return local;

	const pkg = path.join(root, "package.json");
	if (!existsSync(pkg)) return "pi";
	process.stderr.write(
		`torus: ${payloadRefreshed ? "payload changed — installing" : "engine missing — bootstrapping"} (npm install in ${root})...\n`,
	);
	const install = spawnSync(
		"npm",
		["install", "--no-fund", "--no-audit", "--omit=dev", "--legacy-peer-deps"],
		{
			cwd: root,
			stdio: "inherit",
		},
	);
	if (install.status !== 0 || !existsSync(local)) {
		process.stderr.write(
			`torus: bootstrap failed — run npm install in ${root} or set TORUS_PI_BIN\n`,
		);
		process.exit(1);
	}
	return local;
}

const bin = resolveBinary();

if (pin) {
	const probe = spawnSync(bin, ["--version"], {
		stdio: ["ignore", "pipe", "ignore"],
		encoding: "utf8",
		timeout: 10000,
	});
	const actual = (probe.stdout ?? "").trim();
	if (probe.status === 0 && actual.length > 0 && actual !== pin) {
		process.stderr.write(
			`torus: engine pin drift — package.json pins pi@${pin}, binary reports ${actual}\n`,
		);
	}
}

const child = spawn(bin, ["--extension", root, ...argv], {
	stdio: "inherit",
	env: {
		...process.env,
		TORUS_ENGINE: "pi",
		TORUS_ENGINE_BIN: bin,
		TORUS_ROOT: root,
	},
});

child.on("error", (err) => {
	process.stderr.write(`torus: failed to start pi${pin ? `@${pin}` : ""}: ${err.message}\n`);
	process.stderr.write(
		`torus: install it (npm i -D @earendil-works/pi-coding-agent${pin ? `@${pin}` : ""}) or set TORUS_PI_BIN\n`,
	);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (code !== null) process.exit(code);
	if (signal) process.exit(signal === "SIGTERM" ? 143 : 130);
	process.exit(1);
});
