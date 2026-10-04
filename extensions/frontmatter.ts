/**
 * torus — shared YAML-ish frontmatter parsing.
 *
 * Agent files (roster), memory entries, persona prompts, and team role
 * prompts all carry the same `--- ... ---` header. One regex, one parser.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface Frontmatter {
	fields: Map<string, string>;
	body: string;
}

export function parseFrontmatter(raw: string): Frontmatter | null {
	const match = FRONTMATTER_RE.exec(raw);
	if (!match?.[1]) return null;
	const fields = new Map<string, string>();
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	return { fields, body: raw.slice(match[0].length) };
}

export function stripFrontmatter(raw: string): string {
	const match = FRONTMATTER_RE.exec(raw);
	return match ? raw.slice(match[0].length) : raw;
}
