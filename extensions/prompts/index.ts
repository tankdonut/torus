/**
 * torus — system-prompt roster section.
 *
 * Tells the model the roster exists, what each agent costs relative to the
 * session model, and when delegation is the right move.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "../frontmatter.js";
import {
	projectStateDir,
	pruneOrphanSessionFiles,
	readJsonFallback,
	torusHome,
	writeJson,
} from "../fsutil.js";
import { applyPersonaTheme } from "../persona-theme.js";
import { repoRoot, sessionPersona, setSessionPersona } from "../registry.js";
import { AGENTS, personaModel } from "../roster/index.js";
import { sessionFileExists } from "../sessions/index.js";
import { refreshToruStatus } from "../ui/index.js";

const AGENTS_DIR = path.join(repoRoot(), "agents");
const PERSONA_ORPHAN_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-project persona state dir, resolved at call time (sessions can cd). */
function personaDir(): string {
	return path.join(projectStateDir(), "persona");
}

/** Pre-project layout: read-only now, except the move-on-write unlink. */
function legacyPersonaDir(): string {
	return path.join(torusHome(), "persona");
}

function personaFile(sessionId: string): string {
	return path.join(personaDir(), `${sessionId}.json`);
}

function legacyPersonaFile(sessionId: string): string {
	return path.join(legacyPersonaDir(), `${sessionId}.json`);
}

export function persistPersona(sessionId: string, name: string | null): void {
	try {
		writeJson(personaFile(sessionId), { persona: name });
	} catch {
		// persistence is best-effort; persona still applies to this process
		return;
	}
	try {
		// move-on-write: a stale legacy twin must not resurrect cleared state
		unlinkSync(legacyPersonaFile(sessionId));
	} catch {
		// legacy twin absent or already migrated
	}
}

export function restorePersona(sessionId: string): string | null {
	const parsed = readJsonFallback<{ persona?: string | null } | null>(
		personaFile(sessionId),
		legacyPersonaFile(sessionId),
		null,
	);
	return typeof parsed?.persona === "string" ? parsed.persona : null;
}

/**
 * Orphan-only GC for per-project persona state: a `<sessionId>.json` is
 * deleted only when its session file is gone (`exists === false`) AND the
 * state is older than 30 days. Live sessions and unreadable session roots
 * (`null`) keep everything; the legacy dir is never touched.
 */
export function prunePersonaOrphans(
	exists: (sessionId: string) => boolean | null = (id) => sessionFileExists(id),
): number {
	return pruneOrphanSessionFiles(personaDir(), exists, PERSONA_ORPHAN_MIN_AGE_MS);
}

const delegatable = AGENTS.filter((a) => a.mode !== "session");

const switcherOrder = [...AGENTS.filter((a) => a.mode === "session"), ...delegatable];

function nextPersona(current: string | null, reverse = false): string {
	if (switcherOrder.length === 0) return current ?? "leader";
	const index = switcherOrder.findIndex((a) => a.name === current);
	const next = reverse
		? index <= 0
			? switcherOrder.length - 1
			: index - 1
		: index === -1 || index === switcherOrder.length - 1
			? 0
			: index + 1;
	return switcherOrder[next]?.name ?? switcherOrder[0]?.name ?? "leader";
}

async function personaPrompt(): Promise<string> {
	const name = sessionPersona();
	if (!name) return "";
	const agent = AGENTS.find((a) => a.name === name);
	if (!agent) return "";
	const body =
		agent.promptBody ??
		(await readFile(path.join(AGENTS_DIR, `${agent.name}.md`), "utf8").catch(() => ""));
	if (!body) return "";
	let prompt = stripFrontmatter(body);
	const rosterText = delegatable.map((a) => `- ${a.name}: ${a.description}`).join("\n");
	prompt = prompt
		.replaceAll("{{AGENTS}}", rosterText)
		.replaceAll("{{TOOLS}}", "")
		.replaceAll("{{SKILLS}}", "")
		.replaceAll("{{DYNAMIC}}", "");
	return `\n${prompt.trim()}\n`;
}

function delegationPolicy(): string {
	const agents = delegatable.map((a) => `- ${a.name}: ${a.description}`).join("\n");
	return `

## torus roster (delegation)

You can delegate self-contained tasks to subagents via the torus_delegate tool. Available agents:
${agents}

Delegate when: the subtask is single-goal, context-heavy (large searches, file sweeps), or parallelizable (torus_fanout), or a pipeline (torus_chain). Keep orchestration, ambiguous decisions, and anything requiring user interaction here. Task text must be self-contained — the subagent sees nothing of this conversation. Call torus_roster to check model availability. Watch live delegations with alt+t.
`;
}

export function detectKeyword(text: string, keywords: Record<string, string>): string | null {
	for (const word of Object.keys(keywords)) {
		const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const lead = /^[a-z0-9]/i.test(word) ? "\\b" : "";
		const trail = /[a-z0-9]$/i.test(word) ? "\\b" : "";
		if (new RegExp(`${lead}${escaped}${trail}`, "i").test(text)) return word;
	}
	return null;
}

export const DEFAULT_KEYWORDS: Record<string, string> = {
	ultrawork:
		"FULL PRECISION: the requested outcome is a contract — no scope reduction, no partial completion, no 'should work' claims without executed evidence. Define pass conditions before editing, verify each increment on the real surface, and report failures explicitly.",
	hyperplan:
		"PLAN-FIRST: no implementation until a plan exists. Survey the affected surface, write the plan (waves, per-wave verification command, stopping condition — /skill:torus-plan for the full protocol), and get user approval before the first edit.",
	team: "TEAM MODE: this is multi-axis work — orchestrate through torus_fanout/torus_chain or the team_* tools instead of doing every axis serially yourself. One axis per delegated run, results synthesized centrally.",
};

export function mergeKeywords(user: Record<string, string>): Record<string, string> {
	return { ...DEFAULT_KEYWORDS, ...user };
}

function loadKeywords(): Record<string, string> {
	try {
		const user = JSON.parse(
			readFileSync(path.join(homedir(), ".torus", "keywords.json"), "utf8"),
		) as Record<string, string>;
		return mergeKeywords(user);
	} catch {
		return { ...DEFAULT_KEYWORDS };
	}
}

let pendingKeyword: { word: string; text: string } | null = null;

export function registerPrompts(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!sessionPersona()) {
			const sessionId = ctx.sessionManager.getSessionId();
			const restored = restorePersona(sessionId);
			setSessionPersona(restored ?? switcherOrder[0]?.name ?? null);
		}
		prunePersonaOrphans();
		refreshToruStatus(ctx);
		applyPersonaTheme(ctx, sessionPersona());
	});

	const applyPersona = (name: string, ctx: ExtensionContext) => {
		setSessionPersona(name);
		persistPersona(ctx.sessionManager.getSessionId(), name);
		applyPersonaTheme(ctx, name);
		const modelId = personaModel(name);
		if (modelId) {
			const [provider, id] = modelId.split("/");
			const model = provider && id ? ctx.modelRegistry.find(provider, id) : undefined;
			if (model) void pi.setModel(model);
		}
		ctx.ui.notify(`persona: ${name}`, "info");
		refreshToruStatus(ctx);
	};

	pi.registerShortcut("alt+p", {
		description: "Cycle torus persona (leader/builder/dreamer/explorer/librarian/looker/reviewer)",
		handler: async (ctx) => {
			applyPersona(nextPersona(sessionPersona()), ctx);
		},
	});

	pi.registerShortcut("alt+shift+p", {
		description: "Cycle torus persona backwards",
		handler: async (ctx) => {
			applyPersona(nextPersona(sessionPersona(), true), ctx);
		},
	});

	for (const agent of switcherOrder) {
		pi.registerCommand(`persona-${agent.name}`, {
			description: `Switch persona to ${agent.name}`,
			handler: async (_args, ctx) => {
				applyPersona(agent.name, ctx);
			},
		});
	}

	pi.on("message_end", (event) => {
		if (event.message.role !== "user" || pendingKeyword) return;
		const rawContent = event.message.content;
		const text =
			typeof rawContent === "string"
				? rawContent
				: rawContent
						.filter(
							(block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
						)
						.map((block) => block.text)
						.join("\n");
		const keywords = loadKeywords();
		const word = detectKeyword(text, keywords);
		if (word) pendingKeyword = { word, text: keywords[word] ?? "" };
	});

	pi.on("before_agent_start", async (event) => {
		const persona = await personaPrompt();
		const mode = pendingKeyword
			? `\n\n[torus mode: ${pendingKeyword.word}]\n${pendingKeyword.text}\n`
			: "";
		pendingKeyword = null;
		return { systemPrompt: event.systemPrompt + persona + delegationPolicy() + mode };
	});
}

export default function promptsExtension(pi: ExtensionAPI): void {
	registerPrompts(pi);
}
