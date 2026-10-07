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
import { counters, layoutWithRight, progressBar, runIcon } from "./draw.ts";

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
		const shown = runs.slice(-MAX_LINES);
		shown.forEach((run, i) => {
			// The open key is shown once, on the last line.
			lines.push(this.runLine(run, width, now, dialogs.filter((d) => d.runId === run.id).length, i === shown.length - 1));
		});
		if (runs.length > MAX_LINES) {
			lines.unshift(truncateToWidth(th.fg("dim", `  +${runs.length - MAX_LINES} more workflows · /workflows`), width));
		}
		return lines;
	}

	private runLine(run: WorkflowRun, width: number, now: number, dialogs: number, withKey: boolean): string {
		const th = this.theme;
		const c = countAgents(run.agents);
		const name = th.bold(run.name);
		const elapsed = formatDuration(run.elapsedMs(now));
		const key = withKey ? th.fg("dim", `${this.openKey} /workflows`) : "";
		const line = (parts: Array<{ text: string; priority: number; shrink?: (w: number) => string; min?: number }>, right: string) =>
			layoutWithRight(parts, right, width);
		if (run.isFinal) {
			const what =
				run.status === "completed"
					? th.fg("success", `completed in ${elapsed}`)
					: run.status === "failed"
						? th.fg("error", `failed: ${oneLine(run.error ?? "", 60)}`)
						: th.fg("warning", `stopped after ${elapsed}`);
			const bad = c.failed + c.stopped;
			return line(
				[
					{ text: ` ${runIcon(th, run.status, now)} ${name}`, priority: 10 },
					{ text: what, priority: 9, shrink: (w) => truncateToWidth(what, w, "…"), min: 12 },
					{
						text: th.fg("muted", `${plural(c.total, "agent")}${bad ? th.fg("error", ` · ${bad} without result`) : ""}`),
						priority: 6,
						shrink: () => th.fg("muted", `${plural(c.total, "agent")}${bad ? th.fg("error", ` · ${bad}✗`) : ""}`),
					},
					{ text: run.delivered && !run.foreground ? th.fg("dim", "result sent to the agent") : "", priority: 2 },
				],
				key,
			);
		}
		const questions = run.pendingQuestionList.length + dialogs;
		if (questions > 0) {
			const q = run.pendingQuestionList[0];
			const text = th.fg("warning", q ? `asks: ${oneLine(q.question, 200)}` : "an agent waits for your answer");
			return line(
				[
					{ text: ` ${th.fg("warning", "?")} ${name}`, priority: 10 },
					{ text, priority: 9, shrink: (w) => truncateToWidth(text, w, "…"), min: 14 },
				],
				th.fg("warning", `${this.openKey} answer`),
			);
		}
		const phase = currentPhase(run);
		const phaseText = th.fg("muted", phase ? `${phase.title} ${phase.done}/${phase.total}` : "starting");
		const barWidth = Math.max(6, Math.min(24, Math.floor(width / 6)));
		const extras: string[] = [];
		if (run.status === "paused") extras.push(th.fg("warning", "paused"));
		if (run.warnings.length) extras.push(th.fg("warning", "⚠ large"));
		if (run.scriptBusyMs(now) > 5000) extras.push(th.fg("warning", "⚠ script busy"));
		return line(
			[
				{ text: ` ${runIcon(th, run.status, now)} ${name}`, priority: 10 },
				{ text: phaseText, priority: 7, shrink: (w) => truncateToWidth(phaseText, w, "…"), min: 8 },
				{ text: progressBar(th, c, barWidth), priority: 3, shrink: (w) => progressBar(th, c, w), min: 6 },
				{ text: counters(th, c), priority: 8 },
				{ text: th.fg("dim", `${formatTokens(run.usage.totalTokens)} tok`), priority: 4 },
				{ text: th.fg("dim", elapsed), priority: 6 },
				{ text: extras.join(" "), priority: 9 },
			],
			key,
		);
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		if (this.timer) clearInterval(this.timer);
		if (this.lingerTimer) clearTimeout(this.lingerTimer);
	}
}
