// Maps ./x.js specifiers to ./x.ts when only the TS source exists, so tests
// can import the extension modules (which use .js specifiers for bundler
// resolution) under node --experimental-strip-types.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// Every suite loads this hook and spawned engine children inherit the env, so
// defaulting TORUS_NOTIFY=0 here keeps test runs from firing real desktop
// toasts. osNotify reads the var at call time, so tests can still opt in.
process.env.TORUS_NOTIFY = "0";

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
