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
	try {
		return JSON.stringify(run.result, null, 2) ?? "null";
	} catch {
		return String(run.result);
	}
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
	return `Duration ${formatDuration(run.elapsedMs())} · agents ${c.total} (${parts.join(", ")}) · tokens ${formatTokens(run.usage.totalTokens)}${cost ? ` · cost ${cost}` : ""}`;
}

/** The <workflow-result> message the main agent receives when a run ends. */
export function resultText(run: WorkflowRun, maxChars: number): string {
	const lines: string[] = [];
	lines.push(`<workflow-result run="${run.id}" name="${run.name}" status="${run.status}">`);
	lines.push(agentLine(run));
	if (run.status !== "completed" && run.error) lines.push(`${run.status === "failed" ? "Error" : "Stopped"}: ${run.error}`);
	if (run.status === "completed") {
		const body = resultBody(run);
		if (body.length > maxChars) {
			lines.push(`Result (first ${maxChars} of ${body.length} characters; the full result is in ${resultPath(run)}):`);
			lines.push(body.slice(0, maxChars));
		} else {
			lines.push("Result:");
			lines.push(body);
		}
	}
	const failed = run.agents.filter((a) => a.status === "failed" || (a.status === "stopped" && run.status === "completed"));
	if (failed.length) {
		lines.push(`Agents without a result (the script got null for them):`);
		for (const a of failed.slice(0, 20)) lines.push(`- #${a.id} "${a.label}" (${a.phase}): ${a.status}: ${oneLine(a.error ?? "", 200)}`);
		if (failed.length > 20) lines.push(`- … ${failed.length - 20} more (see /workflows ${run.id})`);
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
		resultPath: resultPath(run),
		scriptPath: run.scriptPath,
		error: run.error,
	};
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
		for (const a of failed.slice(0, 10)) lines.push(`- #${a.id} "${a.label}": ${oneLine(a.error ?? "", 160)}`);
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
