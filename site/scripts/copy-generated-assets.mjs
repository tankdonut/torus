import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repoDocs = resolve(siteRoot, "..", "docs");
const outDir = resolve(siteRoot, "public", "docs");

mkdirSync(outDir, { recursive: true });
for (const name of ["efficiency.html", "bench-records.json"]) {
	copyFileSync(resolve(repoDocs, name), resolve(outDir, name));
	console.log(`site: copied docs/${name} -> site/public/docs/${name}`);
}
