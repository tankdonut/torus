// Maps ./x.js specifiers to ./x.ts when only the TS source exists, so tests
// can import the extension modules (which use .js specifiers for bundler
// resolution) under node --experimental-strip-types.

import { existsSync } from "node:fs";
import module, { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Every suite loads this hook and spawned engine children inherit the env, so
// defaulting TORUS_NOTIFY=0 here keeps test runs from firing real desktop
// toasts. osNotify reads the var at call time, so tests can still opt in.
process.env.TORUS_NOTIFY = "0";

// Share V8 compile output on disk: a full suite spawns ~90 child processes
// over the same TS import graph, so after the first one populates the cache
// the rest skip re-parsing and re-stripping those modules. Best-effort: an
// unwritable or unusable cache dir degrades to compiling without a cache.
try {
	module.enableCompileCache();
} catch {
	// No compile cache; only speed is affected, never correctness.
}

// Memoized resolution decisions keyed by `${specifier}\u0000${parentDir}`:
// the target .ts URL when the rewrite applies, or false when the specifier
// falls through to default resolution. A specifier+parent pair is statted
// at most once per process; the map is cleared whole when it fills up.
const RESOLUTION_MEMO_LIMIT = 4096;
const resolutionMemo = new Map();

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js") && !specifier.includes("node_modules") && context.parentURL) {
			try {
				const key = `${specifier}\u0000${fileURLToPath(context.parentURL)}`;
				const cached = resolutionMemo.get(key);
				if (cached !== undefined) {
					return nextResolve(cached || specifier, context);
				}
				const tsPath = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, ".ts");
				const resolved = existsSync(tsPath) ? pathToFileURL(tsPath).href : false;
				if (resolutionMemo.size >= RESOLUTION_MEMO_LIMIT) {
					resolutionMemo.clear();
				}
				resolutionMemo.set(key, resolved);
				return nextResolve(resolved || specifier, context);
			} catch {
				// fall through to default resolution
			}
		}
		return nextResolve(specifier, context);
	},
});
