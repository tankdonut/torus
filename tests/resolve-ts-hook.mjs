// Maps ./x.js specifiers to ./x.ts when only the TS source exists, so tests
// can import the extension modules (which use .js specifiers for bundler
// resolution) under node --experimental-strip-types.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

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
