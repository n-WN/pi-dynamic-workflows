/**
 * Task panel below the editor: one live line per workflow run of this session.
 * It shows finished runs for a few seconds, then hides. It draws nothing when idle.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { countAgents, formatDuration, formatTokens, oneLine, plural } from "../format.ts";
import { getRegistry, onRegistryChange, runsOfSession } from "../registry.ts";
import type { WorkflowRun } from "../run.ts";
import { AGENT_ACTIVE } from "../types.ts";
import { counters, progressBar, runIcon, spread } from "./draw.ts";

const LINGER_MS = 8000;
const MAX_LINES = 3;

export function currentPhase(run: WorkflowRun): { title: string; done: number; total: number } | undefined {
	let title: string | undefined;
	for (let i = run.agents.length - 1; i >= 0; i--) {
		if (AGENT_ACTIVE.has(run.agents[i].status) || run.agents[i].status === "queued") {
			title = run.agents[i].phase;
			break;
		}
	}
	title ??= run.agents[run.agents.length - 1]?.phase;
	if (!title) return undefined;
	const inPhase = run.agents.filter((a) => a.phase === title);
	const done = inPhase.filter((a) => a.status === "done" || a.status === "cached" || a.status === "failed" || a.status === "stopped" || a.status === "skipped").length;
	return { title, done, total: inPhase.length };
}

export class WorkflowWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly sessionId: () => string;
	private readonly openKey: string;
	private readonly unsubscribe: () => void;
	private timer?: ReturnType<typeof setInterval>;
	private lingerTimer?: ReturnType<typeof setTimeout>;

	constructor(tui: TUI, theme: Theme, sessionId: () => string, openKey: string) {
		this.tui = tui;
		this.theme = theme;
		this.sessionId = sessionId;
		this.openKey = openKey;
		this.unsubscribe = onRegistryChange(() => this.refresh());
		this.refresh();
	}

	private visibleRuns(now = Date.now()): WorkflowRun[] {
		return runsOfSession(this.sessionId()).filter((r) => !r.isFinal || now - (r.endedAt ?? 0) < LINGER_MS);
	}

	private refresh(): void {
		const runs = this.visibleRuns();
		const animate = runs.some((r) => r.status === "running");
		if (animate && !this.timer) {
			this.timer = setInterval(() => this.tui.requestRender(), 120);
		} else if (!animate && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		const lingering = runs.filter((r) => r.isFinal);
		if (lingering.length && !this.lingerTimer) {
			const until = Math.max(...lingering.map((r) => (r.endedAt ?? 0) + LINGER_MS)) - Date.now();
			this.lingerTimer = setTimeout(() => {
				this.lingerTimer = undefined;
				this.refresh();
			}, Math.max(50, until + 50));
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const now = Date.now();
		const runs = this.visibleRuns(now);
		if (runs.length === 0) return [];
		const th = this.theme;
		const lines: string[] = [];
		const dialogs = getRegistry().dialogs.pending.filter((d) => d.questionId === undefined && runs.some((r) => r.id === d.runId));
		for (const run of runs.slice(-MAX_LINES)) lines.push(this.runLine(run, width, now, dialogs.filter((d) => d.runId === run.id).length));
		if (runs.length > MAX_LINES) {
			lines.unshift(truncateToWidth(th.fg("dim", `  +${runs.length - MAX_LINES} more workflows · /workflows`), width));
		}
		return lines;
	}

	private runLine(run: WorkflowRun, width: number, now: number, dialogs: number): string {
		const th = this.theme;
		const c = countAgents(run.agents);
		const name = th.bold(run.name);
		const elapsed = formatDuration(run.elapsedMs(now));
		const right = th.fg("dim", `${this.openKey} /workflows`);
		if (run.isFinal) {
			const what =
				run.status === "completed"
					? th.fg("success", `completed in ${elapsed}`)
					: run.status === "failed"
						? th.fg("error", `failed: ${oneLine(run.error ?? "", 60)}`)
						: th.fg("warning", `stopped after ${elapsed}`);
			const tail = run.delivered && !run.foreground ? th.fg("dim", " · result sent to the agent") : "";
			return spread(` ${runIcon(th, run.status, now)} ${name} ${what} · ${plural(c.total, "agent")}${tail}`, right, width);
		}
		const questions = run.pendingQuestionList.length + dialogs;
		if (questions > 0) {
			const q = run.pendingQuestionList[0];
			const text = q ? `asks: ${oneLine(q.question, 60)}` : "an agent waits for your answer";
			return spread(` ${th.fg("warning", "?")} ${name} ${th.fg("warning", text)}`, th.fg("warning", `${this.openKey} answer`), width);
		}
		const phase = currentPhase(run);
		const phaseText = phase ? `${phase.title} ${phase.done}/${phase.total}` : "starting";
		const barWidth = Math.max(6, Math.min(24, Math.floor(width / 6)));
		const bar = progressBar(th, c, barWidth);
		const extras: string[] = [];
		if (run.status === "paused") extras.push(th.fg("warning", "paused"));
		if (run.warnings.length) extras.push(th.fg("warning", "⚠ large"));
		if (run.scriptBusyMs(now) > 5000) extras.push(th.fg("warning", "⚠ script busy"));
		const left = [
			` ${runIcon(th, run.status, now)} ${name}`,
			th.fg("muted", phaseText),
			bar,
			counters(th, c),
			th.fg("dim", `${formatTokens(run.usage.totalTokens)} tok`),
			th.fg("dim", elapsed),
			...extras,
		]
			.filter(Boolean)
			.join("  ");
		return spread(left, right, width);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		if (this.timer) clearInterval(this.timer);
		if (this.lingerTimer) clearTimeout(this.lingerTimer);
	}
}
