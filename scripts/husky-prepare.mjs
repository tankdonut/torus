// npm runs "prepare" on consumer installs from git (--omit=dev), where husky
// is not installed; wire git hooks only when the dev toolchain is present.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const huskyBin = fileURLToPath(new URL("../node_modules/.bin/husky", import.meta.url));

if (!existsSync(huskyBin)) process.exit(0);

const run = spawnSync(huskyBin, { stdio: "inherit" });
if (run.error) {
	console.error(run.error.message);
	process.exit(1);
}
process.exit(run.status ?? 1);
