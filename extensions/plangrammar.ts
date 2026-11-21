/**
 * torus — plan grammar lint: machine checks for the plan file grammar.
 *
 * The plan skill (skills/torus-plan/SKILL.md) defines the grammar: wave
 * headings, one column-zero checkbox task row per task with indented detail
 * lines beneath it, a final verification wave of F-tasks, and a Stopping
 * condition section. The `work` tools parse the same column-zero checkbox
 * rows (extensions/work/index.ts TASK_RE) for progress and the completion
 * gate; this module is the lint half of that contract: given a plan's
 * markdown it returns line-addressed violations a CLI or test can assert on.
 *
 * Pure module: no imports, no environment reads. F-task rows are exempt
 * from the Acceptance-detail check — the grammar gives them their own
 * detail lines (review delegation, QA capture, ideal-state fidelity), so
 * the Acceptance requirement scopes to wave tasks.
 */

export interface PlanLintViolation {
	/** 1-based line number of the offending row; 0 for file-level absence. */
	line: number;
	message: string;
}

/** Column-zero checkbox rows only — indented rows are detail, not tasks. */
const TASK_RE = /^- \[( |x|X|~)\] (.*)$/;

/** Task titles in the final verification wave are `F<n>. <title>`. */
const F_TASK_RE = /^F\d+\./;

/** Wave headings; the em dash in `### Wave N — <outcome>` is grammar. */
const WAVE_HEADING_RE = /^### (Wave \d+ — |Final verification wave$)/;
const FINAL_WAVE_HEADING_RE = /^### Final verification wave$/;
const H3_HEADING_RE = /^### /;
const H2_HEADING_RE = /^## /;

/** `## Stopping condition`, modulo trailing whitespace. */
const STOPPING_HEADING_RE = /^## Stopping condition\s*$/;

/** Indented detail line carrying a task's agent-executable check. */
const ACCEPTANCE_RE = /^\s+Acceptance:/;

/**
 * Lint a plan's markdown against the plan grammar: wave headings, task
 * rows with Acceptance: detail lines, a final verification wave with
 * F-task rows, and a Stopping condition section. Violations are 1-indexed
 * by source line (0 for file-level absence), sorted by line, deduplicated.
 */
export function lintPlan(markdown: string): PlanLintViolation[] {
	const violations: PlanLintViolation[] = [];
	const add = (line: number, message: string) => violations.push({ line, message });

	const lines = markdown
		.replace(/^\uFEFF/, "")
		.replace(/\r\n?/g, "\n")
		.split("\n");

	const tasks: { line: number; title: string; isFTask: boolean; inFinalWave: boolean }[] = [];
	let finalWaveLine: number | null = null;
	let inFinalWave = false;
	let hasWaveHeading = false;
	let hasStoppingCondition = false;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (FINAL_WAVE_HEADING_RE.test(line)) {
			finalWaveLine = i + 1;
			inFinalWave = true;
			hasWaveHeading = true;
			continue;
		}
		if (H3_HEADING_RE.test(line)) {
			inFinalWave = false;
			if (WAVE_HEADING_RE.test(line)) hasWaveHeading = true;
			continue;
		}
		if (H2_HEADING_RE.test(line)) {
			if (STOPPING_HEADING_RE.test(line)) hasStoppingCondition = true;
			continue;
		}
		const match = TASK_RE.exec(line);
		if (match) {
			const title = (match[2] ?? "").trim();
			if (title.length === 0) continue;
			tasks.push({ line: i + 1, title, isFTask: F_TASK_RE.test(title), inFinalWave });
		}
	}

	if (!hasWaveHeading) add(0, "no wave heading");
	if (tasks.length === 0) add(0, "no column-zero task row");

	for (const task of tasks) {
		if (task.isFTask) continue;
		if (!hasAcceptanceDetail(lines, task.line)) {
			add(task.line, "task row has no Acceptance: detail line");
		}
	}

	if (finalWaveLine === null) {
		add(0, "no final verification wave section");
	} else if (!tasks.some((task) => task.isFTask && task.inFinalWave)) {
		add(finalWaveLine, "final verification wave has no F-task row");
	}

	if (!hasStoppingCondition) add(0, "no Stopping condition section");

	return dedupeByLine(violations).sort((a, b) => a.line - b.line);
}

/**
 * Does the task's detail block (the lines after its row, up to the next
 * task row, the next wave heading, or EOF) carry an Acceptance: line?
 */
function hasAcceptanceDetail(lines: string[], taskLine: number): boolean {
	for (let i = taskLine; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (TASK_RE.test(line) || H3_HEADING_RE.test(line)) return false;
		if (ACCEPTANCE_RE.test(line)) return true;
	}
	return false;
}

function dedupeByLine(violations: PlanLintViolation[]): PlanLintViolation[] {
	const seen = new Set<string>();
	const unique: PlanLintViolation[] = [];
	for (const violation of violations) {
		const key = `${violation.line}\u0000${violation.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(violation);
	}
	return unique;
}
