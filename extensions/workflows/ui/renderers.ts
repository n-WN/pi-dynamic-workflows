/**
 * Transcript rendering:
 * - the workflow tool row (live progress while the run goes on),
 * - the <workflow-result> card,
 * - the ultracode opt-in badge.
 */

import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Container, Markdown, Text } from "@earendil-works/pi-tui";
import { countAgents, formatCost, formatDuration, formatTokens, oneLine, plural } from "../format.ts";
import { getRegistry, onRegistryChange } from "../registry.ts";
import type { WorkflowRun } from "../run.ts";
import { peekMetaName, peekMetaPhases } from "../script.ts";
import { AGENT_ACTIVE, type RunStatus } from "../types.ts";
import { counters, progressBar, runIcon, runStatusColor, spinner } from "./draw.ts";

export interface WorkflowToolArgs {
	script?: string;
	name?: string;
	scriptPath?: string;
	args?: unknown;
	resumeFromRunId?: string;
	wait?: boolean;
}

export interface WorkflowToolDetails {
	status: "launched" | "done" | "declined" | "error";
	runId?: string;
	name?: string;
	description?: string;
	phases?: string[];
	scriptPath?: string;
	transcriptDir?: string;
	error?: string;
	feedback?: string;
	/** Final state, for sessions where the run is no longer in memory. */
	final?: { status: RunStatus; durationMs: number; agents: number; failed: number; tokens: number };
}

export interface ResultMessageDetails {
	runId: string;
	name: string;
	status: RunStatus;
	durationMs: number;
	agents: number;
	failed: number;
	stopped: number;
	cached: number;
	tokens: number;
	cost: number;
	preview: string;
	previewIsMarkdown: boolean;
	resultPath: string;
	scriptPath: string;
	error?: string;
}

function workflowNameOf(args: WorkflowToolArgs): string {
	return args.name ?? peekMetaName(args.script) ?? (args.scriptPath ? basename(args.scriptPath).replace(/\.js$/, "") : "workflow");
}

export function renderWorkflowCall(
	args: WorkflowToolArgs,
	theme: Theme,
	context: { argsComplete: boolean; executionStarted: boolean },
): Component {
	const name = workflowNameOf(args ?? {});
	const bits: string[] = [];
	if (args?.script) bits.push(`${args.script.split("\n").length} lines`);
	if (args?.name) bits.push("saved");
	if (args?.scriptPath) bits.push(oneLine(args.scriptPath, 50));
	if (args?.resumeFromRunId) bits.push(`resume ${args.resumeFromRunId}`);
	if (args?.wait) bits.push("wait");
	const phases = peekMetaPhases(args?.script);
	let text = `${theme.fg("toolTitle", theme.bold("workflow "))}${theme.fg("accent", theme.bold(name))}`;
	if (bits.length) text += theme.fg("muted", ` · ${bits.join(" · ")}`);
	if (phases?.length) text += `\n${theme.fg("dim", phases.join(" → "))}`;
	if (!context.argsComplete) text += `\n${theme.fg("accent", spinner())} ${theme.fg("muted", "writing the workflow script…")}`;
	return new Text(text, 0, 0);
}

/** Lines that summarize a run, for the tool row. */
export function runSummaryLines(run: WorkflowRun, theme: Theme, expanded: boolean, now = Date.now()): string[] {
	const c = countAgents(run.agents);
	const lines: string[] = [];
	const status = run.status;
	const head = [
		`${runIcon(theme, status, now)} ${theme.bold(run.name)}`,
		theme.fg(runStatusColor(status), `${status} ${formatDuration(run.elapsedMs(now))}`),
		`${plural(c.total, "agent")} ${counters(theme, c)}`.trim(),
		theme.fg("dim", `${formatTokens(run.usage.totalTokens)} tok`),
	].join(theme.fg("dim", " · "));
	lines.push(head);
	const phaseTitles = [...run.phases.map((p) => p.title)];
	for (const a of run.agents) if (!phaseTitles.includes(a.phase)) phaseTitles.push(a.phase);
	const phaseBits = phaseTitles.map((title) => {
		const agents = run.agents.filter((a) => a.phase === title);
		if (agents.length === 0) return theme.fg("dim", `○ ${title}`);
		const pc = countAgents(agents);
		const active = agents.some((a) => AGENT_ACTIVE.has(a.status) || a.status === "queued");
		const icon = active ? theme.fg("accent", spinner(now)) : pc.failed ? theme.fg("warning", "✓") : theme.fg("success", "✓");
		const finished = pc.total - pc.active - pc.queued;
		return `${icon} ${title} ${theme.fg("dim", `${finished}/${pc.total}`)}`;
	});
	if (!expanded) {
		if (phaseBits.length) lines.push(`  ${phaseBits.join(theme.fg("dim", "  ·  "))}`);
	} else {
		for (const title of phaseTitles) {
			const agents = run.agents.filter((a) => a.phase === title);
			const pc = countAgents(agents);
			lines.push(`  ${title.padEnd(18)} ${progressBar(theme, pc, 20)} ${counters(theme, pc)}`);
		}
		lines.push(theme.fg("dim", `  script ${run.scriptPath}`));
		lines.push(theme.fg("dim", `  transcripts ${run.transcriptDir}`));
		for (const l of run.logs.slice(-3)) lines.push(theme.fg("muted", `  log: ${oneLine(l.text, 100)}`));
	}
	for (const w of run.warnings) lines.push(theme.fg("warning", `  ⚠ ${w}`));
	const pendingQ = run.pendingQuestionList.length;
	if (pendingQ) lines.push(theme.fg("warning", `  ? waits for your answer: ${oneLine(run.pendingQuestionList[0].question, 80)} (/workflows, a)`));
	if (!run.isFinal) lines.push(theme.fg("dim", `  /workflows to watch · run ${run.id}`));
	else if (run.status === "failed" && run.error) lines.push(theme.fg("error", `  ${oneLine(run.error, 120)}`));
	return lines;
}

interface RowState {
	unsubscribe?: () => void;
	lastInvalidate?: number;
	pending?: ReturnType<typeof setTimeout>;
}

export function renderWorkflowResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context: { state: RowState; invalidate: () => void },
): Component {
	const d = result.details as WorkflowToolDetails | undefined;
	if (!d) {
		const t = result.content.find((c) => c.type === "text")?.text ?? "";
		return new Text(theme.fg("muted", oneLine(t, 200)), 0, 0);
	}
	if (d.status === "error") {
		return new Text(theme.fg("error", d.error ?? "The workflow did not start."), 0, 0);
	}
	if (d.status === "declined") {
		return new Text(theme.fg("warning", `Not started: the user declined.${d.feedback ? ` Note: ${d.feedback}` : ""}`), 0, 0);
	}
	const run = d.runId ? getRegistry().runs.get(d.runId) : undefined;
	if (run) {
		// Redraw this row while the run goes on (at most 4 times per second).
		const state = context.state;
		if (!state.unsubscribe && !run.isFinal) {
			const off = onRegistryChange(() => {
				const now = Date.now();
				const fire = () => {
					state.pending = undefined;
					state.lastInvalidate = Date.now();
					context.invalidate();
					if (run.isFinal) {
						state.unsubscribe?.();
					}
				};
				if (state.pending) return;
				const wait = Math.max(0, 250 - (now - (state.lastInvalidate ?? 0)));
				state.pending = setTimeout(fire, wait);
			});
			state.unsubscribe = () => {
				off();
				if (state.pending) clearTimeout(state.pending);
				state.pending = undefined;
			};
		}
		return new Text(runSummaryLines(run, theme, options.expanded).join("\n"), 0, 0);
	}
	// Not in memory (pi restarted): use the final state, or read it from the saved run.json.
	const name = d.name ?? "workflow";
	const final = d.final ?? savedFinal(d);
	if (final) {
		const f = final;
		return new Text(
			`${runIcon(theme, f.status)} ${theme.bold(name)} ${theme.fg(runStatusColor(f.status), `${f.status} in ${formatDuration(f.durationMs)}`)}${theme.fg("dim", ` · ${plural(f.agents, "agent")}${f.failed ? ` (${f.failed} failed)` : ""} · ${formatTokens(f.tokens)} tok · run ${d.runId}`)}`,
			0,
			0,
		);
	}
	return new Text(`${theme.fg("accent", "◆")} ${theme.bold(name)} ${theme.fg("muted", `launched · run ${d.runId ?? "?"}`)}${d.phases?.length ? `\n${theme.fg("dim", d.phases.join(" → "))}` : ""}`, 0, 0);
}

const savedFinalCache = new Map<string, WorkflowToolDetails["final"] | null>();

function savedFinal(d: WorkflowToolDetails): WorkflowToolDetails["final"] | undefined {
	if (!d.runId || !d.scriptPath) return undefined;
	const cached = savedFinalCache.get(d.runId);
	if (cached !== undefined) return cached ?? undefined;
	let out: WorkflowToolDetails["final"] | null = null;
	try {
		const snap = JSON.parse(readFileSync(join(dirname(d.scriptPath), "run.json"), "utf8")) as {
			status: RunStatus;
			startedAt: number;
			endedAt?: number;
			pausedMs?: number;
			agents: Array<{ status: string }>;
			usage: { totalTokens: number };
		};
		const status: RunStatus = snap.status === "running" || snap.status === "paused" ? "stopped" : snap.status;
		out = {
			status,
			durationMs: Math.max(0, (snap.endedAt ?? snap.startedAt) - snap.startedAt - (snap.pausedMs ?? 0)),
			agents: snap.agents.length,
			failed: snap.agents.filter((a) => a.status === "failed").length,
			tokens: snap.usage.totalTokens,
		};
	} catch {
		out = null;
	}
	savedFinalCache.set(d.runId, out);
	return out ?? undefined;
}

export function renderResultMessage(
	message: { content: unknown; details?: unknown },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const d = message.details as ResultMessageDetails | undefined;
	const container = new Box(options.outputPad, 1, (t: string) => theme.bg("customMessageBg", t));
	if (!d) {
		container.addChild(new Text(theme.fg("muted", "workflow result"), 0, 0));
		return container;
	}
	const icon = runIcon(theme, d.status);
	const parts = [
		`${formatDuration(d.durationMs)}`,
		`${plural(d.agents, "agent")}${d.failed ? ` · ${d.failed} failed` : ""}${d.cached ? ` · ${d.cached} reused` : ""}`,
		`${formatTokens(d.tokens)} tok`,
		formatCost(d.cost),
	].filter(Boolean);
	const header = `${icon} ${theme.fg("customMessageLabel", theme.bold("Workflow"))} ${theme.bold(d.name)} ${theme.fg(runStatusColor(d.status), d.status)} ${theme.fg("dim", `· ${parts.join(" · ")}`)}`;
	container.addChild(new Text(header, 0, 0));
	if (d.error && d.status !== "completed") container.addChild(new Text(theme.fg(d.status === "failed" ? "error" : "warning", oneLine(d.error, 300)), 0, 0));
	const preview = d.preview.trim();
	if (preview) {
		const maxLines = options.expanded ? Number.POSITIVE_INFINITY : 14;
		const lines = preview.split("\n");
		const shown = lines.slice(0, maxLines).join("\n");
		const inner = new Container();
		if (d.previewIsMarkdown) inner.addChild(new Markdown(shown, 0, 0, getMarkdownTheme()));
		else inner.addChild(new Text(highlightCode(shown, "json").join("\n"), 0, 0));
		container.addChild(inner);
		if (lines.length > maxLines) {
			container.addChild(new Text(theme.fg("dim", `… ${lines.length - maxLines} more lines (ctrl+o expands)`), 0, 0));
		}
	}
	container.addChild(new Text(theme.fg("dim", `run ${d.runId} · /workflows ${d.runId} · full result ${d.resultPath}`), 0, 0));
	return container;
}

export function renderOptInMessage(
	_message: { content: unknown; details?: unknown },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const d = _message.details as { keyword?: string } | undefined;
	const box = new Box(options.outputPad, 0, (t: string) => theme.bg("customMessageBg", t));
	box.addChild(
		new Text(
			`${theme.fg("accent", "⚡")} ${theme.fg("accent", theme.bold(d?.keyword ?? "ultracode"))} ${theme.fg("muted", "· the agent plans this request as a dynamic workflow")}`,
			0,
			0,
		),
	);
	return box;
}
