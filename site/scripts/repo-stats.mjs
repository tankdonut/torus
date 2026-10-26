/**
 * Derives the repo facts rendered on the landing page (facts strip, repo card,
 * commit activity graph) from the repository itself, so no number on the site
 * is hand-maintained. Writes site/src/stats/repo.json, untracked and regenerated
 * by `npm run -w site build` and `npm run -w site dev` (their prebuild/predev
 * hooks); the pages workflow checks out with fetch-depth: 0 for exactly this.
 *
 *     node scripts/repo-stats.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = resolve(siteRoot, "..");
const outPath = resolve(siteRoot, "src", "stats", "repo.json");

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

const extensionDirs = pkg.pi?.extensions ?? [];

// The package manifest also loads vendored node_modules extensions; only the
// repo's own extensions/ trees carry its tools.
const ownExtensions = extensionDirs.filter((dir) => dir.startsWith("./extensions/"));

const readTree = (dir) => {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) out.push(...readTree(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
};

// Substring counting over the extension sources (not regex: the literal
// `pi.registerTool(` is what every registration call spells).
const countOccurrences = (needle) => {
	let count = 0;
	for (const dir of ownExtensions) {
		for (const file of readTree(resolve(repoRoot, dir))) {
			count += readFileSync(file, "utf8").split(needle).length - 1;
		}
	}
	return count;
};

const LANGUAGE_BY_SUFFIX = {
	".ts": "TypeScript",
	".mts": "TypeScript",
	".mjs": "JavaScript",
	".js": "JavaScript",
	".astro": "Astro",
	".css": "CSS",
	".md": "Markdown",
	".json": "JSON",
	".yml": "YAML",
	".yaml": "YAML",
	".sh": "Shell",
	".svg": "SVG",
};

const languageLines = new Map();
for (const file of git(["ls-files"]).split("\n")) {
	if (file === "" || /(^|\/)package-lock\.json$/.test(file)) continue;
	if (!existsSync(resolve(repoRoot, file))) continue;
	const suffix = file.slice(file.lastIndexOf("."));
	const language = LANGUAGE_BY_SUFFIX[suffix];
	if (!language) continue;
	const lines = readFileSync(resolve(repoRoot, file), "utf8").split("\n").length - 1;
	languageLines.set(language, (languageLines.get(language) ?? 0) + lines);
}
const totalLines = [...languageLines.values()].reduce((a, b) => a + b, 0);

const contributors = git(["shortlog", "-sn", "HEAD"])
	.split("\n")
	.filter((line) => line !== "")
	.map((line) => {
		const commits = Number.parseInt(line.trim().split("\t")[0] ?? "0", 10);
		const name = (line.split("\t")[1] ?? "").trim();
		return { name, commits, bot: name.endsWith("[bot]") || name === "renovate[bot]" };
	});

const commitDates = git(["log", "--format=%ad", "--date=short", "HEAD"]).split("\n");
const perDay = new Map();
for (const date of commitDates) {
	if (date === "") continue;
	perDay.set(date, (perDay.get(date) ?? 0) + 1);
}
// Fill every day from the first commit to HEAD so gaps read as gaps, not as
// missing columns.
const days = [];
const cursor = new Date(`${commitDates[commitDates.length - 1] ?? ""}T00:00:00Z`);
const last = new Date(`${commitDates[0] ?? ""}T00:00:00Z`);
while (cursor <= last) {
	const iso = cursor.toISOString().slice(0, 10);
	days.push({ date: iso, count: perDay.get(iso) ?? 0 });
	cursor.setUTCDate(cursor.getUTCDate() + 1);
}

const agents = git(["ls-files", "agents"])
	.split("\n")
	.filter((f) => f.endsWith(".md"));
const skills = git(["ls-files", "skills"])
	.split("\n")
	.filter((f) => f.endsWith("SKILL.md"));

const stats = {
	generatedAt: new Date().toISOString(),
	counts: {
		extensions: ownExtensions.length,
		tools: countOccurrences("pi.registerTool("),
		agents: agents.length,
		skills: skills.length,
	},
	git: {
		commits: Number.parseInt(git(["rev-list", "--count", "HEAD"]), 10),
		contributors,
		firstCommit: days[0]?.date ?? null,
		lastCommit: days[days.length - 1]?.date ?? null,
		days,
	},
	languages: [...languageLines.entries()]
		.map(([language, lines]) => ({
			language,
			share: totalLines === 0 ? 0 : Number((lines / totalLines).toFixed(4)),
			lines,
		}))
		.sort((a, b) => b.lines - a.lines),
	release: pkg.version,
	license: pkg.license,
};

mkdirSync(resolve(siteRoot, "src", "stats"), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(stats, null, "\t")}\n`);
console.log(
	`site: repo.json — ${stats.counts.extensions} extensions, ${stats.counts.tools} tools, ${stats.git.commits} commits, ${days.length} days`,
);
