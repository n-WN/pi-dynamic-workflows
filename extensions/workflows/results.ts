/** Agent-facing text about runs: result messages and status reports. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { countAgents, formatCost, formatDuration, formatTokens, oneLine, previewJson } from "./format.ts";
import type { WorkflowRun } from "./run.ts";
import { AGENT_ACTIVE } from "./types.ts";
import type { ResultMessageDetails } from "./ui/renderers.ts";

function resultBody(run: WorkflowRun): string {
	if (run.result === undefined) return "(the script returned no value)";
	if (typeof run.result === "string") return run.result;
	return stringify(run.result, 2);
}

function stringify(value: unknown, indent?: number): string {
	try {
		return JSON.stringify(value, null, indent) ?? "null";
	} catch {
		return String(value);
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

/** "string, 41210 characters", "array of 37", "object with 5 keys". */
export function describeValue(v: unknown): string {
	if (typeof v === "string") return `string, ${v.length} characters`;
	if (Array.isArray(v)) return `array of ${v.length}`;
	if (isPlainObject(v)) return `object with ${Object.keys(v).length} keys`;
	return v === null ? "null" : typeof v;
}

/** Cut text at a paragraph or line end near `max` characters. */
function cutText(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = text.lastIndexOf("\n\n", max);
	if (cut < max * 0.7) cut = text.lastIndexOf("\n", max);
	if (cut < max * 0.7) cut = text.lastIndexOf(" ", max);
	if (cut < max * 0.7) cut = max;
	return text.slice(0, cut).trimEnd();
}

/** Whole items of an array that fit in `max` characters as pretty JSON. */
function fitItems(items: unknown[], max: number): unknown[] {
	const kept: unknown[] = [];
	let size = 4;
	for (const item of items) {
		const n = stringify(item, 2).length + 4;
		if (size + n > max) break;
		kept.push(item);
		size += n;
	}
	return kept;
}

/**
 * A result as text in at most about `max` characters. Data stays valid JSON: the
 * text keeps whole array items or object fields, and `note` says what it left out.
 */
export function fitResult(value: unknown, max: number): { text: string; note?: string } {
	const full = typeof value === "string" ? value : stringify(value, 2);
	if (full.length <= max) return { text: full };
	if (typeof value === "string") {
		const text = cutText(value, max);
		return { text, note: `the first ${text.length} of ${value.length} characters` };
	}
	if (Array.isArray(value)) {
		const kept = fitItems(value, max);
		if (kept.length) return { text: stringify(kept, 2), note: `the first ${kept.length} of ${value.length} items, as valid JSON` };
	} else if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		const left: string[] = [];
		let size = 4;
		for (const [k, v] of Object.entries(value)) {
			const n = stringify(v, 2).length + k.length + 6;
			const room = max - size - k.length - 10;
			if (size + n <= max) {
				out[k] = v;
				size += n;
			} else if (typeof v === "string" && room >= 400) {
				const part = cutText(v, room);
				out[k] = part;
				size += part.length + k.length + 10;
				left.push(`${k} (cut: the first ${part.length} of ${v.length} characters)`);
			} else if (Array.isArray(v) && room >= 400 && fitItems(v, room).length) {
				const items = fitItems(v, room);
				out[k] = items;
				size += stringify(items, 2).length + k.length + 6;
				left.push(`${k} (the first ${items.length} of ${v.length} items)`);
			} else {
				left.push(`${k} (left out: ${describeValue(v)})`);
			}
		}
		if (Object.keys(out).length) return { text: stringify(out, 2), note: `valid JSON; fields cut or left out: ${left.join("; ")}` };
	}
	const text = cutText(full, max);
	return { text, note: `the first ${text.length} of ${full.length} characters; the JSON is cut and not valid` };
}

/** Per-phase totals in phase order. */
export function phaseTotals(run: WorkflowRun): Array<{ title: string; agents: number; failed: number; tokens: number }> {
	const titles = [...run.phases.map((p) => p.title)];
	for (const a of run.agents) if (!titles.includes(a.phase)) titles.push(a.phase);
	return titles
		.map((title) => {
			const agents = run.agents.filter((a) => a.phase === title);
			return {
				title,
				agents: agents.length,
				failed: agents.filter((a) => a.status === "failed" || a.status === "stopped").length,
				tokens: agents.reduce((s, a) => s + a.usage.totalTokens, 0),
			};
		})
		.filter((p) => p.agents > 0);
}

function phaseLine(run: WorkflowRun): string | undefined {
	const phases = phaseTotals(run);
	if (phases.length < 2) return undefined;
	return `Phases: ${phases.map((p) => `${p.title} ${p.agents} ${p.agents === 1 ? "agent" : "agents"}${p.failed ? ` (${p.failed} without result)` : ""}, ${formatTokens(p.tokens)} tokens`).join(" → ")}`;
}

export function resultPath(run: WorkflowRun): string {
	return join(run.runDir, "result.json");
}

function agentLine(run: WorkflowRun): string {
	const c = countAgents(run.agents);
	const parts = [`${c.done} done`];
	if (c.cached) parts.push(`${c.cached} reused`);
	if (c.failed) parts.push(`${c.failed} failed`);
	if (c.stopped) parts.push(`${c.stopped} stopped`);
	if (c.skipped) parts.push(`${c.skipped} skipped`);
	if (c.active) parts.push(`${c.active} running`);
	const cost = formatCost(run.usage.cost);
	const budget = run.tokenLimit ? ` of a ${formatTokens(run.tokenLimit)} budget` : "";
	return `Duration ${formatDuration(run.elapsedMs())} · agents ${c.total} (${parts.join(", ")}) · tokens ${formatTokens(run.usage.totalTokens)}${budget}${cost ? ` · cost ${cost}` : ""}`;
}

/** The <workflow-result> message the main agent receives when a run ends. */
export function resultText(run: WorkflowRun, maxChars: number): string {
	const lines: string[] = [];
	lines.push(`<workflow-result run="${run.id}" name="${run.name}" status="${run.status}">`);
	lines.push(agentLine(run));
	const phases = phaseLine(run);
	if (phases) lines.push(phases);
	if (run.status !== "completed" && run.error) lines.push(`${run.status === "failed" ? "Error" : "Stopped"}: ${run.error}`);
	if (run.status === "completed") {
		const body = resultBody(run);
		if (body.length > maxChars) {
			const fitted = run.result === undefined ? { text: body } : fitResult(run.result, maxChars);
			lines.push(`Result (${fitted.note ?? "cut"}; the full result is in ${resultPath(run)}):`);
			lines.push(fitted.text);
		} else {
			lines.push("Result:");
			lines.push(body);
		}
	}
	const failed = run.agents.filter((a) => a.status === "failed" || (a.status === "stopped" && run.status === "completed"));
	if (failed.length) {
		lines.push(`Agents without a result (the script got null for them):`);
		failed.slice(0, 20).forEach((a, i) => {
			const transcript = i < 5 && a.transcriptPath ? ` Transcript: ${a.transcriptPath}` : "";
			lines.push(`- #${a.id} "${a.label}" (${a.phase}): ${a.status}: ${oneLine(a.error ?? "", 200)}${transcript}`);
		});
		if (failed.length > 20) lines.push(`- … ${failed.length - 20} more (see /workflows ${run.id})`);
		if (failed.length > 5) lines.push(`Transcripts of all agents: ${run.transcriptDir}`);
	}
	const trees = run.agents.filter((a) => a.worktree?.changed);
	if (trees.length) {
		lines.push("Worktrees with changes (the main working tree is unchanged):");
		for (const a of trees.slice(0, 30)) {
			const w = a.worktree;
			if (w) lines.push(`- #${a.id} "${a.label}": branch ${w.branch}${w.diffStat ? ` (${w.diffStat})` : ""} at ${w.path}`);
		}
		lines.push("Merge the branches you want (git merge <branch>), then clean up (git worktree remove <path>; git branch -D <branch>).");
	}
	for (const w of run.warnings) lines.push(`Warning: ${w}`);
	const answered = run.questions.filter((q) => q.status === "answered" || q.status === "defaulted");
	if (answered.length) {
		lines.push("Questions asked during the run:");
		for (const q of answered.slice(0, 10)) lines.push(`- ${oneLine(q.question, 120)} → ${q.answer ?? "(no answer)"}${q.answeredBy === "default" ? " (default)" : ""}`);
	}
	const logs = run.logs.filter((l) => l.level !== "debug").slice(-8);
	if (logs.length) {
		lines.push("Last log lines:");
		for (const l of logs) lines.push(`- ${oneLine(l.text, 200)}`);
	}
	lines.push(`Script: ${run.scriptPath}`);
	if (run.status !== "completed" || failed.length) {
		lines.push(
			`To relaunch: workflow({ resumeFromRunId: "${run.id}" }). Completed agents with unchanged inputs reuse their saved results; agents without a result run again, and so do agents that the script called after one of those results. To change the script first, edit ${run.scriptPath} and pass it as scriptPath together with resumeFromRunId.`,
		);
	}
	lines.push("</workflow-result>");
	return lines.join("\n");
}

/** Details for the result card renderer. */
export function resultDetails(run: WorkflowRun): ResultMessageDetails {
	const c = countAgents(run.agents);
	const isString = typeof run.result === "string";
	const preview = run.status === "completed" ? (isString ? (run.result as string) : previewJson(run.result, 6000)) : "";
	return {
		runId: run.id,
		name: run.name,
		status: run.status,
		durationMs: run.elapsedMs(),
		agents: c.total,
		failed: c.failed,
		stopped: c.stopped,
		cached: c.cached,
		tokens: run.usage.totalTokens,
		cost: run.usage.cost,
		preview: preview.length > 6000 ? `${preview.slice(0, 6000)}\n…` : preview,
		previewIsMarkdown: isString,
		fields: run.status === "completed" ? previewFields(run.result) : undefined,
		phases: phaseTotals(run),
		resultPath: resultPath(run),
		scriptPath: run.scriptPath,
		error: run.error,
	};
}

/** Fields of an object result for the card: long text as markdown, the rest as short JSON. */
function previewFields(value: unknown): ResultMessageDetails["fields"] {
	if (!isPlainObject(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.length === 0 || entries.length > 12) return undefined;
	let budget = 6000;
	return entries.map(([key, v]) => {
		if (typeof v === "string" && (v.includes("\n") || v.length > 100)) {
			const text = cutText(v, Math.max(300, budget));
			budget = Math.max(0, budget - text.length);
			return { key, text: text.length < v.length ? `${text}\n…` : text, markdown: true };
		}
		const json = stringify(v);
		return { key, text: json.length > 300 ? `${json.slice(0, 299)}…` : json, markdown: false };
	});
}

/** Status report for workflow_control status. */
export function statusText(run: WorkflowRun): string {
	const lines: string[] = [];
	lines.push(`Run ${run.id} "${run.name}": ${run.status}. ${agentLine(run)}`);
	const titles = [...run.phases.map((p) => p.title)];
	for (const a of run.agents) if (!titles.includes(a.phase)) titles.push(a.phase);
	if (titles.length) {
		lines.push("Phases:");
		for (const t of titles) {
			const agents = run.agents.filter((a) => a.phase === t);
			if (!agents.length) {
				lines.push(`- ${t}: not started`);
				continue;
			}
			const c = countAgents(agents);
			const bits = [`${c.done + c.cached}/${c.total} done`];
			if (c.active) bits.push(`${c.active} running`);
			if (c.queued) bits.push(`${c.queued} queued`);
			if (c.failed) bits.push(`${c.failed} failed`);
			bits.push(`${formatTokens(agents.reduce((s, a) => s + a.usage.totalTokens, 0))} tokens`);
			lines.push(`- ${t}: ${bits.join(", ")}`);
		}
	}
	const running = run.agents.filter((a) => AGENT_ACTIVE.has(a.status));
	if (running.length) {
		lines.push("Running agents:");
		for (const a of running.slice(0, 16)) lines.push(`- #${a.id} "${a.label}" (${a.phase}): ${oneLine(a.activity ?? "running", 120)}`);
	}
	const failed = run.agents.filter((a) => a.status === "failed");
	if (failed.length) {
		lines.push("Failed agents:");
		for (const a of failed.slice(0, 10)) lines.push(`- #${a.id} "${a.label}": ${oneLine(a.error ?? "", 160)}${a.transcriptPath ? ` Transcript: ${a.transcriptPath}` : ""}`);
	}
	const pending = run.pendingQuestionList;
	if (pending.length) {
		lines.push("Questions that wait for an answer (workflow_control answer):");
		for (const q of pending) lines.push(`- question ${q.id}: ${q.question}${q.options?.length ? ` (options: ${q.options.join(" | ")})` : ""}`);
	}
	if (run.status === "failed" && run.error) lines.push(`Error: ${run.error}`);
	const logs = run.logs.slice(-5);
	if (logs.length) {
		lines.push("Recent log:");
		for (const l of logs) lines.push(`- ${oneLine(l.text, 160)}`);
	}
	lines.push(`Script: ${run.scriptPath}`);
	return lines.join("\n");
}

export function writeResultFile(run: WorkflowRun): void {
	try {
		writeFileSync(resultPath(run), JSON.stringify({ status: run.status, result: run.result ?? null, error: run.error ?? null }, null, 2));
	} catch {
		// best effort
	}
}
