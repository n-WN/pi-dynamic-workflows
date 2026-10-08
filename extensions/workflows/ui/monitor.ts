/**
 * The /workflows monitor: a full-screen overlay.
 *
 *   runs  ->  run (phases, activity, log)  ->  phase (agents)  ->  agent (prompt, tool calls, output, result)
 *                  \->  timeline (one bar per agent on a time axis)
 *
 * It redraws live, answers ask() questions and agent permission prompts inline,
 * and controls runs: pause, stop, restart an agent, save a script as a command.
 */

import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	Markdown,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type DialogAnswer, DialogQueue, type DialogRequest } from "../child-ui.ts";
import { countAgents, elapsedOf, formatClock, formatCost, formatDuration, formatSpan, formatTokens, oneLine, plural, previewJson } from "../format.ts";
import { getRegistry, onRegistryChange, runsOfSession } from "../registry.ts";
import { WorkflowRun } from "../run.ts";
import { AGENT_ACTIVE, AGENT_FINAL, type AgentRecord, type AgentStatus, type QuestionRecord, type RunSnapshot } from "../types.ts";
import {
	activityTrack,
	agentIcon,
	box,
	countWords,
	fit,
	fitRight,
	hints,
	hintsFit,
	layoutLine,
	peakConcurrency,
	phaseGlyph,
	phaseState,
	progressBar,
	runIcon,
	runSpan,
	runStatusColor,
	section,
	shortModel,
	slotsGauge,
	spinner,
	spread,
	timeAxis,
	timelineBar,
	windowAround,
} from "./draw.ts";

type RunLike = WorkflowRun | RunSnapshot;
type Filter = "all" | "active" | "failed" | "done" | "queued";
const FILTERS: Filter[] = ["all", "active", "failed", "done", "queued"];
type Order = "start" | "duration";

type View =
	| { kind: "runs"; sel: number }
	| { kind: "run"; runId: string; sel: number }
	| { kind: "timeline"; runId: string; sel: number; order: Order }
	| { kind: "phase"; runId: string; phase: string; sel: number; filter: Filter }
	| { kind: "agent"; runId: string; agentId: number; scroll: number; expanded: boolean }
	| { kind: "script"; runId: string; scroll: number };

type Interaction =
	| { kind: "question"; run: WorkflowRun; q: QuestionRecord }
	| { kind: "dialog"; req: DialogRequest; resolve: (a: DialogAnswer) => void; fallback: () => Promise<DialogAnswer> };

type Mode =
	| { kind: "normal" }
	| { kind: "help" }
	| { kind: "save"; runId: string; input: Input; scope: "project" | "personal"; error?: string }
	| { kind: "answer"; target: Interaction; sel: number; input?: Input; remember?: boolean }
	| { kind: "confirm-stop"; runId: string }
	| { kind: "confirm-stop-agent"; runId: string; agentId: number }
	| { kind: "steer"; runId: string; agentId: number; input: Input; interrupt?: boolean };

export interface MonitorActions {
	sessionId(): string;
	pastRuns(): RunSnapshot[];
	save(run: RunLike, name: string, scope: "project" | "personal"): string;
	saveLocations(): { project: string; personal: string };
	openKey: string;
}

/** Smallest body height of the box; it grows with its content and does not shrink while open. */
const MIN_BODY = 10;
/** An agent without any activity for this long shows as quiet (it may hang). */
const QUIET_MS = 60_000;

function isLive(r: RunLike): r is WorkflowRun {
	return r instanceof WorkflowRun || typeof (r as unknown as WorkflowRun).elapsedMs === "function";
}

function elapsed(r: RunLike, now: number): number {
	return isLive(r) ? r.elapsedMs(now) : elapsedOf(r, undefined, now);
}

function statusOf(r: RunLike): RunSnapshot["status"] {
	return r.status;
}

function agentMatches(a: AgentRecord, f: Filter): boolean {
	switch (f) {
		case "all":
			return true;
		case "active":
			return AGENT_ACTIVE.has(a.status);
		case "failed":
			return a.status === "failed" || a.status === "stopped";
		case "done":
			return a.status === "done" || a.status === "cached";
		case "queued":
			return a.status === "queued";
	}
}

function shortHome(p: string): string {
	const home = process.env.HOME;
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Keep the start and the end of a long single-line text. */
function middleTruncate(text: string, width: number): string {
	if (text.length <= width) return text;
	const keep = Math.max(4, width - 1);
	const head = Math.ceil(keep * 0.45);
	return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

function agentDuration(a: AgentRecord, now: number): number {
	if (!a.startedAt) return 0;
	return (a.endedAt ?? now) - a.startedAt;
}

/** Time an agent waited for a free slot before it started. */
function agentWait(a: AgentRecord, now: number): number {
	if (a.status === "cached") return 0;
	return Math.max(0, (a.startedAt ?? (a.status === "queued" ? now : (a.endedAt ?? now))) - a.queuedAt);
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function metaOf(r: RunLike): RunSnapshot["meta"] {
	return isLive(r) ? r.prepared.meta : r.meta;
}

/** "418k tokens", or "418k / 2M tokens" in a warning color near the budget. */
function tokensText(theme: Theme, r: RunLike, word = "tokens"): string {
	const used = r.usage.totalTokens;
	const limit = r.tokenLimit;
	if (!limit) return theme.fg("muted", `${formatTokens(used)} ${word}`);
	const share = used / limit;
	const color = share >= 1 ? "error" : share >= 0.8 ? "warning" : "muted";
	return theme.fg(color, `${formatTokens(used)} / ${formatTokens(limit)} ${word}`);
}

const HELP: Record<View["kind"], Array<[string, string]>> = {
	runs: [
		["↑↓ j k", "select a run"],
		["enter →", "open the run"],
		["t", "timeline of the run"],
		["p", "pause or resume the run"],
		["x", "stop the run"],
		["s", "save the script as a /command"],
		["a", "answer a waiting question"],
		["esc q", "close"],
	],
	run: [
		["↑↓ j k", "select a phase"],
		["enter →", "agents of the phase"],
		["t", "timeline: one bar per agent"],
		["v", "read the script"],
		["p", "pause or resume"],
		["x", "stop the run"],
		["s", "save the script as a /command"],
		["a", "answer a waiting question"],
		["esc ←", "back"],
	],
	timeline: [
		["↑↓ j k", "select an agent"],
		["enter →", "agent detail"],
		["o", "order: by start or by duration"],
		["i r x m", "interrupt, restart, stop, or message the selected agent"],
		["esc ←", "back"],
	],
	phase: [
		["↑↓ j k", "select an agent"],
		["enter →", "agent detail"],
		["f", "filter: all, active, failed, done, queued"],
		["m", "send a message (the agent reads it after its current step)"],
		["i", "interrupt a hanging step: the agent goes on with its context"],
		["r", "restart the agent from the beginning"],
		["x", "stop the agent (the script gets null)"],
		["esc ←", "back"],
	],
	agent: [
		["↑↓ pgup pgdn", "scroll"],
		["g G", "top, bottom"],
		["enter e", "expand the prompt, tool calls, and result"],
		["m", "send a message (the agent reads it after its current step)"],
		["i", "interrupt a hanging step: the agent goes on with its context"],
		["r", "restart the agent from the beginning"],
		["x", "stop the agent (the script gets null)"],
		["esc ←", "back"],
	],
	script: [
		["↑↓ pgup pgdn", "scroll"],
		["esc ←", "back"],
	],
};

export class WorkflowMonitor implements Component {
	focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly actions: MonitorActions;
	private readonly stack: View[] = [];
	private mode: Mode = { kind: "normal" };
	private readonly dialogQueue: Interaction[] = [];
	private flash?: { text: string; level: "info" | "warning" | "error"; until: number };
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private past: RunSnapshot[] = [];
	private lastBodyHeight = 20;
	/** Scroll position of the agent detail ("lines 1-28 of 35"), for the box border. */
	private scrollPos?: string;
	private highWater = MIN_BODY;
	private lastViewKey = "";

	constructor(tui: TUI, theme: Theme, done: () => void, actions: MonitorActions, initialRunId?: string) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.actions = actions;
		this.past = actions.pastRuns();
		this.stack.push({ kind: "runs", sel: 0 });
		if (initialRunId && this.findRun(initialRunId)) this.stack.push({ kind: "run", runId: initialRunId, sel: 0 });
		const reg = getRegistry();
		reg.monitorOpen = true;
		reg.dialogs.sink = (req, fallback) =>
			new Promise<DialogAnswer>((resolve) => {
				this.dialogQueue.push({ kind: "dialog", req, resolve, fallback });
				this.tui.requestRender();
			});
		this.unsubscribe = onRegistryChange(() => this.tui.requestRender());
		this.timer = setInterval(() => {
			// Animate spinners and clocks while something runs.
			if (this.allRuns().some((r) => statusOf(r) === "running")) this.tui.requestRender();
		}, 150);
	}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.timer);
		const reg = getRegistry();
		reg.monitorOpen = false;
		reg.dialogs.sink = undefined;
		// Dialogs that nobody answered here go to the normal pi UI.
		for (const it of this.dialogQueue.splice(0)) {
			if (it.kind === "dialog") void it.fallback().then(it.resolve, () => it.resolve(undefined));
		}
	}

	invalidate(): void {}

	// -------------------------------------------------------------------------
	// Data
	// -------------------------------------------------------------------------

	private allRuns(): RunLike[] {
		const live = runsOfSession(this.actions.sessionId());
		const liveIds = new Set(live.map((r) => r.id));
		const past = this.past.filter((p) => !liveIds.has(p.id));
		const all: RunLike[] = [...live, ...past];
		const rank = (r: RunLike) => (statusOf(r) === "running" || statusOf(r) === "paused" ? 0 : 1);
		return all.sort((a, b) => rank(a) - rank(b) || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
	}

	private findRun(id: string): RunLike | undefined {
		return this.allRuns().find((r) => r.id === id);
	}

	private interactions(): Interaction[] {
		const runs = runsOfSession(this.actions.sessionId());
		// A dialog of an agent that ended, or of a question answered elsewhere, is stale: close it.
		for (const it of [...this.dialogQueue]) {
			if (it.kind !== "dialog") continue;
			if (it.req.signal?.aborted) {
				this.dialogQueue.splice(this.dialogQueue.indexOf(it), 1);
				it.resolve(it.req.kind === "confirm" ? false : undefined);
				continue;
			}
			if (it.req.questionId === undefined) continue;
			const q = runs.find((r) => r.id === it.req.runId)?.questions[it.req.questionId];
			if (!q || q.status !== "pending") {
				this.dialogQueue.splice(this.dialogQueue.indexOf(it), 1);
				it.resolve(undefined);
			}
		}
		const out: Interaction[] = [...this.dialogQueue];
		const withDialog = new Set(this.dialogQueue.filter((d) => d.kind === "dialog" && d.req.questionId !== undefined).map((d) => (d.kind === "dialog" ? `${d.req.runId}:${d.req.questionId}` : "")));
		for (const r of runs) for (const q of r.pendingQuestionList) if (!withDialog.has(`${r.id}:${q.id}`)) out.push({ kind: "question", run: r, q });
		return out;
	}

	private get view(): View {
		return this.stack[this.stack.length - 1];
	}

	private setFlash(text: string, level: "info" | "warning" | "error" = "info"): void {
		this.flash = { text, level, until: Date.now() + 5000 };
	}

	private phasesOf(run: RunLike): Array<{ title: string; planned: boolean }> {
		const titles = run.phases.map((p) => ({ title: p.title, planned: p.planned }));
		for (const a of run.agents) if (!titles.some((t) => t.title === a.phase)) titles.push({ title: a.phase, planned: false });
		return titles;
	}

	/** Rows of the timeline: phase headers and agents (by start), or agents only (by duration). */
	private timelineRows(run: RunLike, order: Order, now: number): Array<{ kind: "phase"; title: string; agents: AgentRecord[] } | { kind: "agent"; a: AgentRecord }> {
		if (order === "duration") {
			return [...run.agents]
				.sort((x, y) => agentDuration(y, now) - agentDuration(x, now) || x.id - y.id)
				.map((a) => ({ kind: "agent" as const, a }));
		}
		const rows: Array<{ kind: "phase"; title: string; agents: AgentRecord[] } | { kind: "agent"; a: AgentRecord }> = [];
		for (const p of this.phasesOf(run)) {
			const agents = run.agents.filter((a) => a.phase === p.title);
			if (!agents.length) continue;
			rows.push({ kind: "phase", title: p.title, agents });
			for (const a of agents) rows.push({ kind: "agent", a });
		}
		return rows;
	}

	// -------------------------------------------------------------------------
	// Input
	// -------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.mode.kind === "save") return this.handleSaveInput(data, this.mode);
		if (this.mode.kind === "steer") return this.handleSteerInput(data, this.mode);
		if (this.mode.kind === "answer") return this.handleAnswerInput(data, this.mode);
		if (this.mode.kind === "help") {
			this.mode = { kind: "normal" };
			this.tui.requestRender();
			return;
		}
		if (this.mode.kind === "confirm-stop" || this.mode.kind === "confirm-stop-agent") {
			const m = this.mode;
			const run = this.findRun(m.runId);
			if (data === "y" || data === "Y" || matchesKey(data, "enter")) {
				if (m.kind === "confirm-stop" && run && isLive(run)) {
					run.stop();
					this.setFlash(`Stopped ${run.name}. Completed agents stay saved; ask the agent to relaunch it to resume.`, "warning");
				} else if (m.kind === "confirm-stop-agent" && run && isLive(run)) {
					const agent = run.agents[m.agentId];
					if (run.stopAgent(m.agentId)) this.setFlash(`Stopping agent #${m.agentId} (${agent?.label ?? ""}). The script gets null for it.`, "warning");
					else this.setFlash("This agent is not running.");
				}
			}
			this.mode = { kind: "normal" };
			this.tui.requestRender();
			return;
		}

		const v = this.view;
		if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "h") {
			if (this.stack.length > 1) this.stack.pop();
			else this.done();
			this.tui.requestRender();
			return;
		}
		if (data === "q" || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (data === "?") {
			this.mode = { kind: "help" };
			this.tui.requestRender();
			return;
		}
		if (data === "a") {
			const it = this.interactions()[0];
			if (it) this.openAnswer(it);
			else this.setFlash("Nothing waits for an answer.");
			this.tui.requestRender();
			return;
		}
		const up = matchesKey(data, "up") || data === "k";
		const down = matchesKey(data, "down") || data === "j";
		const pageUp = matchesKey(data, "pageUp");
		const pageDown = matchesKey(data, "pageDown");
		const enter = matchesKey(data, "enter") || matchesKey(data, "right") || data === "l";

		switch (v.kind) {
			case "runs": {
				const runs = this.allRuns();
				if (up) v.sel = Math.max(0, v.sel - 1);
				else if (down) v.sel = Math.min(runs.length - 1, v.sel + 1);
				else if (pageUp) v.sel = Math.max(0, v.sel - 10);
				else if (pageDown) v.sel = Math.min(runs.length - 1, v.sel + 10);
				const run = runs[v.sel];
				if (run) {
					if (enter) this.stack.push({ kind: "run", runId: run.id, sel: 0 });
					else if (data === "t") this.stack.push({ kind: "timeline", runId: run.id, sel: 0, order: "start" });
					else this.runAction(data, run);
				}
				break;
			}
			case "run": {
				const run = this.findRun(v.runId);
				if (!run) break;
				const phases = this.phasesOf(run);
				if (up) v.sel = Math.max(0, v.sel - 1);
				else if (down) v.sel = Math.min(phases.length - 1, v.sel + 1);
				else if (enter && phases[v.sel]) this.stack.push({ kind: "phase", runId: run.id, phase: phases[v.sel].title, sel: 0, filter: "all" });
				else if (data === "v") this.stack.push({ kind: "script", runId: run.id, scroll: 0 });
				else if (data === "t") this.stack.push({ kind: "timeline", runId: run.id, sel: 0, order: "start" });
				else this.runAction(data, run);
				break;
			}
			case "timeline": {
				const run = this.findRun(v.runId);
				if (!run) break;
				const count = run.agents.length;
				if (up) v.sel = Math.max(0, v.sel - 1);
				else if (down) v.sel = Math.min(count - 1, v.sel + 1);
				else if (pageUp) v.sel = Math.max(0, v.sel - 10);
				else if (pageDown) v.sel = Math.min(count - 1, v.sel + 10);
				else if (data === "o") {
					v.order = v.order === "start" ? "duration" : "start";
					v.sel = 0;
				} else {
					const agents = this.timelineRows(run, v.order, Date.now()).flatMap((r) => (r.kind === "agent" ? [r.a] : []));
					const a = agents[v.sel];
					if (enter && a) this.stack.push({ kind: "agent", runId: run.id, agentId: a.id, scroll: 0, expanded: false });
					else if (a) this.agentAction(data, run, a);
				}
				break;
			}
			case "phase": {
				const run = this.findRun(v.runId);
				if (!run) break;
				const agents = run.agents.filter((a) => a.phase === v.phase && agentMatches(a, v.filter));
				if (up) v.sel = Math.max(0, v.sel - 1);
				else if (down) v.sel = Math.min(agents.length - 1, v.sel + 1);
				else if (pageUp) v.sel = Math.max(0, v.sel - 10);
				else if (pageDown) v.sel = Math.min(agents.length - 1, v.sel + 10);
				else if (data === "f") {
					v.filter = FILTERS[(FILTERS.indexOf(v.filter) + 1) % FILTERS.length];
					v.sel = 0;
				} else if (enter && agents[v.sel]) this.stack.push({ kind: "agent", runId: run.id, agentId: agents[v.sel].id, scroll: 0, expanded: false });
				else if (agents[v.sel]) this.agentAction(data, run, agents[v.sel]);
				break;
			}
			case "agent": {
				const run = this.findRun(v.runId);
				const agent = run?.agents[v.agentId];
				if (!run || !agent) break;
				if (up) v.scroll = Math.max(0, v.scroll - 1);
				else if (down) v.scroll++;
				else if (pageUp) v.scroll = Math.max(0, v.scroll - this.lastBodyHeight);
				else if (pageDown) v.scroll += this.lastBodyHeight;
				else if (matchesKey(data, "enter") || data === "e") v.expanded = !v.expanded;
				else if (data === "g") v.scroll = 0;
				else if (data === "G") v.scroll = 1e9;
				else this.agentAction(data, run, agent);
				break;
			}
			case "script": {
				if (up) v.scroll = Math.max(0, v.scroll - 1);
				else if (down) v.scroll++;
				else if (pageUp) v.scroll = Math.max(0, v.scroll - this.lastBodyHeight);
				else if (pageDown) v.scroll += this.lastBodyHeight;
				break;
			}
		}
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		const v = this.view;
		const step = event.wheelDelta > 0 ? 1 : -1;
		if (v.kind === "agent" || v.kind === "script") v.scroll = Math.max(0, v.scroll + step * 3);
		else v.sel = Math.max(0, v.sel + step);
		this.tui.requestRender();
		return { handled: true };
	}

	private runAction(data: string, run: RunLike): void {
		if (data === "p") {
			if (isLive(run) && !run.isFinal) {
				run.togglePause();
				this.setFlash(run.isPaused ? `Paused ${run.name}: running agents finish, no new agents start.` : `Resumed ${run.name}.`);
			} else this.setFlash("This run has ended.");
		} else if (data === "x") {
			if (isLive(run) && !run.isFinal) this.mode = { kind: "confirm-stop", runId: run.id };
			else this.setFlash("This run has ended.");
		} else if (data === "s") {
			const input = new Input();
			input.setValue(run.name);
			this.mode = { kind: "save", runId: run.id, input, scope: "project" };
		}
	}

	private agentAction(data: string, run: RunLike, agent: AgentRecord): void {
		if (data === "x") {
			if (isLive(run) && AGENT_ACTIVE.has(agent.status)) this.mode = { kind: "confirm-stop-agent", runId: run.id, agentId: agent.id };
			else this.setFlash("This agent is not running.");
		} else if (data === "r") {
			if (isLive(run) && run.restartAgent(agent.id)) this.setFlash(`Restarting agent #${agent.id} (${agent.label}).`);
			else this.setFlash("Only a running agent can restart.");
		} else if (data === "m") {
			if (isLive(run) && AGENT_ACTIVE.has(agent.status)) this.mode = { kind: "steer", runId: run.id, agentId: agent.id, input: new Input() };
			else this.setFlash("Only a running agent can get a message.");
		} else if (data === "i") {
			if (isLive(run) && AGENT_ACTIVE.has(agent.status)) this.mode = { kind: "steer", runId: run.id, agentId: agent.id, input: new Input(), interrupt: true };
			else this.setFlash("Only a running agent can be interrupted.");
		} else if (data === "p" || data === "s") {
			this.runAction(data, run);
		}
	}

	private openAnswer(it: Interaction): void {
		const needsText =
			(it.kind === "dialog" && (it.req.kind === "input" || it.req.kind === "editor")) ||
			(it.kind === "question" && !it.q.options?.length);
		let input: Input | undefined;
		if (needsText) {
			input = new Input();
			if (it.kind === "dialog" && it.req.prefill) input.setValue(it.req.prefill);
			if (it.kind === "question" && it.q.default) input.setValue(it.q.default);
		}
		this.mode = { kind: "answer", target: it, sel: 0, input };
	}

	private answerOptions(it: Interaction): string[] {
		if (it.kind === "dialog") {
			if (it.req.kind === "select") return it.req.options ?? [];
			if (it.req.kind === "confirm") return ["Yes", "No"];
			return [];
		}
		const opts = [...(it.q.options ?? [])];
		if (opts.length && it.q.default !== null && it.q.default !== undefined && !opts.includes(it.q.default)) opts.push(it.q.default);
		return opts;
	}

	private finishAnswer(it: Interaction, answer: DialogAnswer | null, cancelled: boolean, remember = false): void {
		if (it.kind === "dialog") {
			const i = this.dialogQueue.indexOf(it);
			if (i >= 0) this.dialogQueue.splice(i, 1);
			const value: DialogAnswer = cancelled
				? it.req.kind === "confirm"
					? false
					: undefined
				: it.req.kind === "confirm"
					? answer === "Yes"
					: answer === null
						? undefined
						: (answer as string);
			// The same answer for every agent of this run that asks the same question.
			if (remember && !cancelled) {
				getRegistry().dialogs.remember(it.req, value);
				this.setFlash(`Every agent of this run that asks "${oneLine(it.req.title, 60)}" gets this answer.`);
			}
			it.resolve(value);
		} else if (!cancelled) {
			it.run.answerQuestion(it.q.id, typeof answer === "string" ? answer : null, "human");
		}
		this.mode = { kind: "normal" };
		const next = this.interactions()[0];
		if (next && !cancelled) this.openAnswer(next);
	}

	private handleAnswerInput(data: string, mode: Extract<Mode, { kind: "answer" }>): void {
		const it = mode.target;
		if (matchesKey(data, "escape")) {
			// Esc on a permission prompt answers "no"; on a script question it only closes the panel.
			if (it.kind === "question" || (it.kind === "dialog" && it.req.questionId !== undefined)) {
				// Release the dialog queue; the question itself stays open in the run.
				if (it.kind === "dialog") this.finishAnswer(it, null, true);
				this.mode = { kind: "normal" };
				this.setFlash("The question stays open. Press a to answer it later.");
				this.tui.requestRender();
				return;
			}
			this.finishAnswer(it, null, true);
			this.tui.requestRender();
			return;
		}
		if (mode.input) {
			if (matchesKey(data, "enter")) {
				this.finishAnswer(it, mode.input.getValue(), false);
			} else {
				mode.input.handleInput(data);
			}
			this.tui.requestRender();
			return;
		}
		const options = this.answerOptions(it);
		const remember = !!mode.remember;
		if (matchesKey(data, "tab") && it.kind === "dialog" && DialogQueue.keyOf(it.req)) mode.remember = !mode.remember;
		else if (matchesKey(data, "up") || data === "k") mode.sel = Math.max(0, mode.sel - 1);
		else if (matchesKey(data, "down") || data === "j") mode.sel = Math.min(options.length - 1, mode.sel + 1);
		else if (matchesKey(data, "enter")) this.finishAnswer(it, options[mode.sel] ?? null, false, remember);
		else if (/^[1-9]$/.test(data) && options[Number(data) - 1] !== undefined) this.finishAnswer(it, options[Number(data) - 1], false, remember);
		else if (data === "y" && it.kind === "dialog" && it.req.kind === "confirm") this.finishAnswer(it, "Yes", false, remember);
		else if (data === "n" && it.kind === "dialog" && it.req.kind === "confirm") this.finishAnswer(it, "No", false, remember);
		this.tui.requestRender();
	}

	private handleSteerInput(data: string, mode: Extract<Mode, { kind: "steer" }>): void {
		if (matchesKey(data, "escape")) {
			this.mode = { kind: "normal" };
		} else if (matchesKey(data, "enter")) {
			const text = mode.input.getValue().trim();
			const run = this.findRun(mode.runId);
			this.mode = { kind: "normal" };
			if (mode.interrupt && run && isLive(run)) {
				void run.interruptAgent(mode.agentId, text, "human").then((ok) => {
					this.setFlash(
						ok
							? `Interrupted the current step of agent #${mode.agentId}; it goes on with its context. If it still hangs, r restarts it.`
							: `Agent #${mode.agentId} has no step to interrupt now. r restarts it; x stops it.`,
						ok ? "info" : "warning",
					);
					this.tui.requestRender();
				});
			} else if (text && run && isLive(run)) {
				void run.steerAgent(mode.agentId, text, "human").then((ok) => {
					this.setFlash(ok ? `Sent to agent #${mode.agentId}. It reads the message after its current step.` : `Agent #${mode.agentId} cannot take a message now.`, ok ? "info" : "warning");
					this.tui.requestRender();
				});
			}
		} else {
			mode.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	private handleSaveInput(data: string, mode: Extract<Mode, { kind: "save" }>): void {
		if (matchesKey(data, "escape")) {
			this.mode = { kind: "normal" };
		} else if (matchesKey(data, "tab")) {
			mode.scope = mode.scope === "project" ? "personal" : "project";
		} else if (matchesKey(data, "enter")) {
			const name = mode.input.getValue().trim();
			const run = this.findRun(mode.runId);
			if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
				mode.error = "Use lowercase letters, digits, and - (at most 64 characters).";
			} else if (run) {
				try {
					const path = this.actions.save(run, name, mode.scope);
					this.setFlash(`Saved ${path}. Run it as /${name} (after /reload in other sessions).`);
					this.mode = { kind: "normal" };
				} catch (err) {
					mode.error = (err as Error).message;
				}
			}
		} else {
			mode.input.handleInput(data);
			mode.error = undefined;
		}
		this.tui.requestRender();
	}

	// -------------------------------------------------------------------------
	// Render
	// -------------------------------------------------------------------------

	render(width: number): string[] {
		const th = this.theme;
		const now = Date.now();
		const rows = this.tui.terminal.rows || 30;
		const maxBody = Math.max(MIN_BODY, Math.floor(rows * 0.9) - 2);
		const inner = Math.max(20, width - 4);
		const banner = this.bannerLines(inner);
		const modeLines = this.modeLines(inner);
		const flash = this.flash && this.flash.until > now ? [th.fg(this.flash.level === "info" ? "accent" : this.flash.level, oneLine(this.flash.text, inner))] : [];
		const reserved = banner.length + modeLines.length + flash.length;
		const viewHeight = Math.max(3, maxBody - reserved);
		this.lastBodyHeight = viewHeight;
		const content = this.mode.kind === "help" ? this.helpContent(inner) : this.viewContent(inner, viewHeight, now);
		const lines = content.lines.slice(0, viewHeight);
		// The box fits its content and grows with it. It does not shrink while the same
		// view shows (no jumping); a new view starts small again.
		const v = this.view;
		const viewKey = `${this.stack.length}:${v.kind}:${"runId" in v ? v.runId : ""}:${v.kind === "phase" ? v.phase : v.kind === "agent" ? v.agentId : ""}`;
		if (viewKey !== this.lastViewKey) {
			this.lastViewKey = viewKey;
			this.highWater = MIN_BODY;
		}
		const natural = banner.length + lines.length + flash.length + modeLines.length;
		this.highWater = Math.min(maxBody, Math.max(this.highWater, natural, MIN_BODY));
		const bodyHeight = this.highWater;
		const body = [...banner, ...lines];
		while (body.length < bodyHeight - flash.length - modeLines.length) body.push("");
		body.push(...flash, ...modeLines);
		const footerText = this.mode.kind === "normal" ? hintsFit(th, content.footer, inner - 2) : this.modeFooter();
		return box(th, body, width, { title: content.title, right: content.right, footer: footerText, height: bodyHeight });
	}

	private helpContent(inner: number): { title: string; right?: string; lines: string[]; footer: Array<[string, string]> } {
		const th = this.theme;
		const items = HELP[this.view.kind];
		const keyW = Math.max(...items.map(([k]) => k.length)) + 2;
		const lines = [section(th, "Keys"), ...items.map(([k, w]) => `${th.fg("accent", k.padEnd(keyW))}${w}`)];
		lines.push("");
		for (const l of wrapTextWithAnsi("Mouse wheel scrolls. Questions and permission prompts of agents show at the top; press a to answer them.", inner)) lines.push(th.fg("dim", l));
		return { title: "Workflows › keys", lines, footer: [] };
	}

	private bannerLines(inner: number): string[] {
		const th = this.theme;
		const items = this.interactions();
		if (items.length === 0 || this.mode.kind === "answer") return [];
		const it = items[0];
		const what =
			it.kind === "question"
				? `${it.run.name} asks: ${it.q.question}`
				: `${it.req.source} asks: ${it.req.title}${it.req.message ? ` — ${it.req.message}` : ""}`;
		const more = items.length > 1 ? ` (+${items.length - 1} more)` : "";
		return [spread(th.fg("warning", `? ${oneLine(what, inner - 20)}${more}`), th.fg("warning", "a answer"), inner), ""];
	}

	private modeFooter(): string {
		const th = this.theme;
		switch (this.mode.kind) {
			case "help":
				return hints(th, [["any key", "close"]]);
			case "save":
				return hints(th, [
					["enter", "save"],
					["tab", "switch location"],
					["esc", "cancel"],
				]);
			case "answer":
				return this.mode.input
					? hints(th, [
							["enter", "send"],
							["esc", "close"],
						])
					: hints(th, [
							["↑↓", "select"],
							["enter", "answer"],
							["1-9", "pick"],
							...(this.mode.target.kind === "dialog" && DialogQueue.keyOf(this.mode.target.req) ? ([["tab", "same for all agents"]] as Array<[string, string]>) : []),
							["esc", this.mode.target.kind === "dialog" ? "deny" : "close"],
						]);
			case "confirm-stop":
				return hints(th, [
					["y", "stop the run"],
					["any key", "cancel"],
				]);
			case "confirm-stop-agent":
				return hints(th, [
					["y", "stop the agent"],
					["any key", "cancel"],
				]);
			case "steer":
				return hints(th, [
					["enter", this.mode.interrupt ? "interrupt" : "send"],
					["esc", "cancel"],
				]);
			default:
				return "";
		}
	}

	private modeLines(inner: number): string[] {
		const th = this.theme;
		const m = this.mode;
		if (m.kind === "confirm-stop") {
			const run = this.findRun(m.runId);
			return ["", th.fg("warning", `Stop the run ${run?.name ?? m.runId}? Running agents stop; completed results stay saved for a relaunch. (y/n)`)];
		}
		if (m.kind === "confirm-stop-agent") {
			const agent = this.findRun(m.runId)?.agents[m.agentId];
			return [
				"",
				th.fg("warning", `Stop agent #${m.agentId}${agent ? ` (${agent.label})` : ""}? The script gets null for it, and the run goes on without its result. (y/n)`),
			];
		}
		if (m.kind === "steer") {
			m.input.focused = this.focused;
			const agent = this.findRun(m.runId)?.agents[m.agentId];
			const who = `agent #${m.agentId}${agent ? ` (${agent.label})` : ""}`;
			if (m.interrupt) {
				return [
					"",
					section(th, `Interrupt ${who}`),
					m.input.render(inner)[0] ?? "",
					th.fg(
						"dim",
						oneLine(`Stops its current step (${oneLine(agent?.activity ?? "running", 40)}) and lets it go on with its context. Optional: a message, such as "skip the slow test".`, inner),
					),
				];
			}
			return [
				"",
				section(th, `Message to ${who}`),
				m.input.render(inner)[0] ?? "",
				th.fg("dim", "The agent reads it after its current step and continues with it. Use it to correct or focus the agent."),
			];
		}
		if (m.kind === "save") {
			m.input.focused = this.focused;
			const loc = this.actions.saveLocations();
			const radio = (on: boolean, label: string, path: string) =>
				`${on ? th.fg("accent", "(•)") : th.fg("dim", "( )")} ${on ? th.bold(label) : label} ${th.fg("dim", path)}`;
			const lines = [
				"",
				section(th, "Save this run's script as a command"),
				`Name  ${m.input.render(Math.max(10, inner - 8))[0] ?? ""}`,
				`Where ${radio(m.scope === "project", "project", loc.project)}   ${radio(m.scope === "personal", "personal", loc.personal)}`,
			];
			if (m.error) lines.push(th.fg("error", m.error));
			return lines;
		}
		if (m.kind === "answer") {
			const it = m.target;
			const lines = [""];
			if (it.kind === "question") {
				lines.push(section(th, `${it.run.name} asks`));
				for (const l of wrapTextWithAnsi(it.q.question, inner)) lines.push(th.bold(l));
				if (it.q.default !== null && it.q.default !== undefined) lines.push(th.fg("dim", `Default: ${it.q.default}`));
			} else {
				lines.push(section(th, `${it.req.source} asks`));
				for (const l of wrapTextWithAnsi(it.req.title, inner)) lines.push(th.bold(l));
				if (it.req.message) for (const l of wrapTextWithAnsi(it.req.message, inner).slice(0, 6)) lines.push(l);
			}
			if (m.input) {
				m.input.focused = this.focused;
				lines.push(m.input.render(inner)[0] ?? "");
			} else {
				const options = this.answerOptions(it);
				options.forEach((o, i) => {
					const sel = i === m.sel;
					lines.push(`${sel ? th.fg("accent", "❯") : " "} ${th.fg("dim", `${i + 1}.`)} ${sel ? th.fg("accent", o) : o}`);
				});
				if (it.kind === "dialog" && DialogQueue.keyOf(it.req)) {
					const n = getRegistry().dialogs.timesSeen(it.req);
					lines.push(
						`${m.remember ? th.fg("accent", "☑") : th.fg("dim", "☐")} ${m.remember ? "Same answer" : th.fg("muted", "Same answer")} for every agent of this run that asks this${n > 1 ? th.fg("dim", ` (asked ${n} times so far)`) : ""} ${th.fg("dim", "· tab")}`,
					);
				}
			}
			return lines;
		}
		return [];
	}

	private viewContent(inner: number, height: number, now: number): { title: string; right?: string; lines: string[]; footer: Array<[string, string]> } {
		const v = this.view;
		const th = this.theme;
		const nav: Array<[string, string]> = [];
		if (this.interactions().length > 0) nav.push(["a", "answer"]);
		switch (v.kind) {
			case "runs":
				return {
					title: "Workflows",
					right: this.runsSummary(),
					lines: this.runsLines(v, inner, height, now),
					footer: [...nav, ["↑↓", "select"], ["enter", "open"], ["t", "timeline"], ["p", "pause"], ["x", "stop"], ["s", "save"], ["esc", "close"]],
				};
			case "run": {
				const run = this.findRun(v.runId);
				if (!run) return this.missing(v.runId);
				return {
					title: `Workflows › ${run.name}`,
					right: this.runRight(run, now),
					lines: this.runLines(run, v, inner, height, now),
					footer: [...nav, ["↑↓", "phase"], ["enter", "agents"], ["t", "timeline"], ["v", "script"], ["p", "pause"], ["x", "stop"], ["s", "save"], ["esc", "back"]],
				};
			}
			case "timeline": {
				const run = this.findRun(v.runId);
				if (!run) return this.missing(v.runId);
				const lines = this.timelineLines(run, v, inner, height, now);
				const selected = this.timelineRows(run, v.order, now).flatMap((r) => (r.kind === "agent" ? [r.a] : []))[v.sel];
				return {
					title: `Workflows › ${run.name} › timeline`,
					right: this.runRight(run, now),
					lines,
					footer: [...nav, ["↑↓", "select"], ["enter", "detail"], ["o", v.order === "start" ? "by duration" : "by start"], ...this.agentKeys(run, selected), ["esc", "back"]],
				};
			}
			case "phase": {
				const run = this.findRun(v.runId);
				if (!run) return this.missing(v.runId);
				const agents = run.agents.filter((a) => a.phase === v.phase);
				const c = countAgents(agents);
				const models = [...new Set(agents.map((a) => shortModel(a.model)).filter(Boolean))];
				const right = [`${c.done + c.cached + c.failed + c.stopped + c.skipped}/${c.total} finished`, models.length === 1 ? models[0] : "", v.filter !== "all" ? `filter: ${v.filter}` : ""].filter(Boolean).join(" · ");
				const lines = this.phaseLines(run, v, inner, height, now);
				const selected = agents.filter((a) => agentMatches(a, v.filter))[v.sel];
				return {
					title: `Workflows › ${run.name} › ${v.phase}`,
					right: th.fg("muted", right),
					lines,
					footer: [...nav, ["↑↓", "select"], ["enter", "detail"], ["f", "filter"], ...this.agentKeys(run, selected), ["esc", "back"]],
				};
			}
			case "agent": {
				const run = this.findRun(v.runId);
				const agent = run?.agents[v.agentId];
				if (!run || !agent) return this.missing(v.runId);
				const lines = this.agentLines(run, agent, v, inner, height, now);
				const status = `${agentIcon(th, agent.status, now)} ${th.fg(this.agentColor(agent.status), agent.status)} ${th.fg("muted", formatSpan(agentDuration(agent, now)))}`;
				return {
					title: `${run.name} › ${agent.phase} › #${agent.id} ${agent.label}`,
					right: this.scrollPos ? `${th.fg("dim", this.scrollPos)}${th.fg("dim", " · ")}${status}` : status,
					lines,
					footer: [...nav, ["↑↓", "scroll"], ["enter", v.expanded ? "collapse" : "expand"], ...this.agentKeys(run, agent), ["esc", "back"]],
				};
			}
			case "script": {
				const run = this.findRun(v.runId);
				if (!run) return this.missing(v.runId);
				const source = isLive(run) ? run.prepared.source : "";
				let code = source;
				if (!code) {
					try {
						code = readFileSync(run.scriptPath, "utf8");
					} catch {
						code = "(script file not found)";
					}
				}
				const lines = highlightCode(code, "javascript").map((l, i) => `${th.fg("dim", String(i + 1).padStart(4))}  ${l}`);
				v.scroll = Math.min(v.scroll, Math.max(0, lines.length - height));
				return {
					title: `Workflows › ${run.name} › script`,
					right: th.fg("dim", middleTruncate(shortHome(run.scriptPath), Math.max(20, Math.floor(inner / 2)))),
					lines: lines.slice(v.scroll, v.scroll + height),
					footer: [["↑↓", "scroll"], ["esc", "back"]],
				};
			}
		}
	}

	/** Key hints for one agent: only the actions that apply to its state. */
	private agentKeys(run: RunLike, a: AgentRecord | undefined): Array<[string, string]> {
		if (!a || !isLive(run) || run.isFinal) return [];
		if (AGENT_ACTIVE.has(a.status)) return [["m", "message"], ["i", "interrupt"], ["r", "restart"], ["x", "stop"]];
		if (a.status === "queued") return [["x", "stop"]];
		return [];
	}

	private agentColor(s: AgentStatus): "accent" | "warning" | "success" | "error" | "muted" | "dim" {
		switch (s) {
			case "starting":
			case "running":
				return "accent";
			case "waiting":
			case "stopped":
				return "warning";
			case "done":
				return "success";
			case "failed":
				return "error";
			case "cached":
				return "muted";
			default:
				return "dim";
		}
	}

	private missing(id: string) {
		return { title: "Workflows", lines: [this.theme.fg("error", `Run ${id} is not available.`)], footer: [["esc", "back"]] as Array<[string, string]> };
	}

	private runsSummary(): string {
		const runs = this.allRuns();
		const active = runs.filter((r) => statusOf(r) === "running" || statusOf(r) === "paused").length;
		return this.theme.fg("muted", `${active} active · ${runs.length - active} finished`);
	}

	private runRight(run: RunLike, now: number): string {
		const th = this.theme;
		return `${runIcon(th, statusOf(run), now)} ${th.fg(runStatusColor(statusOf(run)), statusOf(run))} ${th.fg("muted", formatDuration(elapsed(run, now)))}`;
	}

	/** "Fetch 2/8" for a live run: the newest phase with work left, and its finished count. */
	private livePhase(r: RunLike): string {
		const open = r.agents.filter((a) => AGENT_ACTIVE.has(a.status) || a.status === "queued");
		const title = open[open.length - 1]?.phase ?? r.agents[r.agents.length - 1]?.phase;
		if (!title) return "starting the script";
		const inPhase = r.agents.filter((a) => a.phase === title);
		const finished = inPhase.filter((a) => AGENT_FINAL.has(a.status)).length;
		return `${title} ${finished}/${inPhase.length}`;
	}

	private phaseChain(run: RunLike, now: number): string {
		const th = this.theme;
		return this.phasesOf(run)
			.map((p) => {
				const agents = run.agents.filter((a) => a.phase === p.title);
				const state = phaseState(agents, p.planned, run.questions.filter((q) => q.phase === p.title));
				const pc = countAgents(agents);
				const count = agents.length ? th.fg("dim", `\u00a0${pc.total - pc.active - pc.queued}/${pc.total}`) : "";
				const name = p.title.replace(/ /g, "\u00a0");
				const title = state === "planned" || state === "empty" ? th.fg("dim", name) : name;
				// No-break spaces keep one phase on one line when the chain wraps.
				return `${phaseGlyph(th, state, now)}\u00a0${title}${count}`;
			})
			.join(th.fg("dim", "  →  "));
	}

	private runsLines(v: Extract<View, { kind: "runs" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		const runs = this.allRuns();
		if (runs.length === 0) {
			return [
				"",
				th.fg("muted", "No workflows in this session yet."),
				"",
				`Ask the agent to ${th.bold('"use a workflow"')} for a large task, or put the keyword ${th.fg("accent", th.bold("ultracode"))} in your prompt.`,
				`Run ${th.bold("/ultracode")} to let the agent decide when to use workflows. Saved workflows run as ${th.bold("/<name>")}.`,
			];
		}
		v.sel = Math.min(v.sel, runs.length - 1);

		// Columns. The state column gets the rest; narrow screens leave out the id, then the tokens.
		let nameW = clamp(Math.max(...runs.map((r) => r.name.length)), 12, 24);
		let barW = inner >= 110 ? 16 : inner >= 90 ? 12 : 8;
		let showId = true;
		let showTok = true;
		const agentsW = 10;
		const timeW = 6;
		const idW = Math.max(...runs.map((r) => r.id.length));
		const fixed = () => 4 + nameW + 1 + barW + 1 + agentsW + (showTok ? 7 : 0) + 1 + timeW + (showId ? idW + 1 : 0) + 1;
		const minState = 14;
		if (inner - fixed() < minState) showId = false;
		if (inner - fixed() < minState) showTok = false;
		if (inner - fixed() < minState) barW = 6;
		if (inner - fixed() < minState) nameW = Math.max(10, nameW - (minState - (inner - fixed())));
		const stateW = Math.max(8, inner - fixed());

		const listRoom = Math.max(3, Math.min(runs.length, height - (height >= 16 ? 9 : 0)));
		const { start, end } = windowAround(runs.length, v.sel, listRoom);
		const lines: string[] = [];
		for (let i = start; i < end; i++) {
			const r = runs[i];
			const sel = i === v.sel;
			const c = countAgents(r.agents);
			const status = statusOf(r);
			let state: string;
			if (status === "running" || status === "paused") {
				if (isLive(r) && r.pendingQuestionList.length) state = th.fg("warning", "waits for your answer (a)");
				else state = status === "paused" ? th.fg("warning", `paused · ${this.livePhase(r)}`) : th.fg("muted", this.livePhase(r));
			} else if (status === "failed") state = th.fg("error", `failed: ${oneLine(r.error ?? "", 80)}`);
			else state = th.fg(runStatusColor(status), status);
			const cells = [
				sel ? th.fg("accent", "❯") : " ",
				runIcon(th, status, now),
				fit(sel ? th.fg("accent", th.bold(r.name)) : th.bold(r.name), nameW),
				fit(state, stateW),
				progressBar(th, c, barW),
				fitRight(plural(c.total, "agent"), agentsW),
			];
			if (showTok) cells.push(fitRight(formatTokens(r.usage.totalTokens), 6));
			cells.push(fitRight(formatDuration(elapsed(r, now)), timeW));
			if (showId) cells.push(th.fg("dim", fit(r.id, idW)));
			lines.push(cells.join(" "));
		}

		const sel = runs[v.sel];
		if (sel && height - lines.length >= 8) {
			lines.push("");
			lines.push(`${section(th, "Selected")} ${th.fg("dim", sel.id)}`);
			for (const l of wrapTextWithAnsi(sel.description, inner).slice(0, 2)) lines.push(th.fg("muted", l));
			for (const l of wrapTextWithAnsi(this.phaseChain(sel, now), inner).slice(0, 2)) lines.push(l);
			if (sel.agents.length) {
				const span = runSpan(sel, now);
				const trackW = clamp(inner - 34, 10, 72);
				const peak = peakConcurrency(sel.agents, now);
				lines.push(
					`${th.fg("muted", "activity")} ${activityTrack(th, sel.agents, span, trackW, sel.limits.maxConcurrency, now)} ${th.fg("dim", `${formatClock(span.t1 - span.t0)} · peak ${peak}/${sel.limits.maxConcurrency} at once`)}`,
				);
			}
			const c = countAgents(sel.agents);
			const cost = formatCost(sel.usage.cost);
			const words = countWords(th, c);
			lines.push([words, `${tokensText(th, sel)}${cost ? th.fg("muted", ` · ${cost}`) : ""}`].filter(Boolean).join(th.fg("dim", " · ")));
			const lastLog = sel.logs[sel.logs.length - 1];
			if (lastLog) lines.push(th.fg("dim", `log: ${oneLine(lastLog.text, inner - 6)}`));
			if (statusOf(sel) === "failed" && sel.error) lines.push(th.fg("error", oneLine(sel.error, inner)));
			lines.push(th.fg("dim", middleTruncate(`script ${shortHome(sel.scriptPath)}`, inner)));
		}
		return lines;
	}

	private runLines(run: RunLike, v: Extract<View, { kind: "run" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		const c = countAgents(run.agents);
		const lines: string[] = [];
		for (const l of wrapTextWithAnsi(run.description, inner).slice(0, 2)) lines.push(th.fg("muted", l));
		const src = run.source.kind === "inline" ? "written for this task" : `${run.source.kind}${run.source.name ? ` ${run.source.name}` : ""}`;
		lines.push(th.fg("dim", [run.id, src, run.resumedFrom ? `resumed from ${run.resumedFrom}` : ""].filter(Boolean).join(" · ")));

		// Overall progress; the status words below use the bar's colors, so they are its legend.
		const finished = c.done + c.cached + c.failed + c.stopped + c.skipped;
		const pct = c.total ? Math.round((finished / c.total) * 100) : 0;
		const tail = ` ${fitRight(`${pct}%`, 4)} ${th.fg("dim", `${finished}/${c.total}`)}`;
		lines.push(`${progressBar(th, c, Math.max(10, inner - visibleWidth(tail)))}${tail}`);
		const live = isLive(run) && !run.isFinal;
		const cost = formatCost(run.usage.cost);
		const words = countWords(th, c) || th.fg("dim", "no agents yet");
		const gauge = live ? slotsGauge(th, c.active, run.limits.maxConcurrency) : "";
		const tokens = `${tokensText(th, run)}${cost ? th.fg("muted", ` · ${cost}`) : ""}`;
		// The status words stay whole; the tokens, then the slots, give way on a narrow screen.
		const right = [gauge, tokens].filter(Boolean).join("   ");
		const rightFit = visibleWidth(words) + visibleWidth(right) + 2 <= inner ? right : visibleWidth(words) + visibleWidth(gauge) + 2 <= inner ? gauge : "";
		lines.push(spread(words, rightFit, inner));

		for (const w of run.warnings) lines.push(th.fg("warning", `⚠ ${oneLine(w, inner - 2)}`));
		if (isLive(run) && run.scriptBusyMs(now) > 5000) {
			lines.push(th.fg("warning", oneLine(`⚠ The script has not answered for ${formatDuration(run.scriptBusyMs(now))} (a long synchronous loop?). x stops it.`, inner)));
		}
		if (statusOf(run) === "failed" && run.error) lines.push(th.fg("error", `✗ ${oneLine(run.error, inner - 2)}`));
		if (statusOf(run) === "completed") lines.push(`${th.fg("success", "✓ result")} ${oneLine(resultSummary(run.result), inner - 10)}`);
		lines.push("");

		const phases = this.phasesOf(run);
		v.sel = Math.min(v.sel, Math.max(0, phases.length - 1));
		const logRoom = Math.min(8, run.logs.length);
		const tableRoom = Math.max(3, height - lines.length - (logRoom ? logRoom + 2 : 0));
		lines.push(...this.phaseTable(run, phases, v.sel, inner, tableRoom, now));
		const info = metaOf(run).phaseInfo?.find((p) => p.title === phases[v.sel]?.title);
		if (info && (info.detail || info.model)) {
			lines.push(th.fg("dim", oneLine(`${info.title}: ${[info.detail ?? "", info.model ? `model ${info.model}` : ""].filter(Boolean).join(" · ")}`, inner)));
		}

		const logs = run.logs.slice(-Math.max(0, height - lines.length - 2));
		if (logs.length) {
			lines.push("");
			lines.push(section(th, "Log"));
			for (const l of logs) {
				const t = new Date(l.t).toTimeString().slice(0, 8);
				const color = l.level === "error" ? "error" : l.level === "warn" ? "warning" : l.level === "debug" ? "dim" : "text";
				lines.push(`${th.fg("dim", t)} ${th.fg(color, oneLine(l.text, inner - 10))}`);
			}
		}
		return lines;
	}

	/**
	 * Phase table: state, finished/total, extra counts, tokens, time, and an activity
	 * track on the run's time axis (how many agents of the phase ran when).
	 */
	private phaseTable(run: RunLike, phases: Array<{ title: string; planned: boolean }>, selected: number, inner: number, room: number, now: number): string[] {
		const th = this.theme;
		const span = runSpan(run, now);
		const cap = run.limits.maxConcurrency;
		const rows = phases.map((p) => {
			const agents = run.agents.filter((a) => a.phase === p.title);
			const qs = run.questions.filter((q) => q.phase === p.title);
			const pc = countAgents(agents);
			const starts = agents.map((a) => a.startedAt ?? Number.POSITIVE_INFINITY);
			const first = Math.min(...starts);
			const allFinal = agents.every((a) => AGENT_FINAL.has(a.status));
			const last = allFinal ? Math.max(...agents.map((a) => a.endedAt ?? 0)) : now;
			return {
				p,
				agents,
				qs,
				pc,
				state: phaseState(agents, p.planned, qs),
				tokens: agents.reduce((s, a) => s + a.usage.totalTokens, 0),
				time: Number.isFinite(first) ? formatSpan(Math.max(0, last - first)) : "",
			};
		});
		const withAgentsCount = rows.filter((r) => r.agents.length).length;
		const titleW = clamp(Math.max(5, ...phases.map((p) => p.title.length), withAgentsCount >= 2 ? 10 : 0), 6, 20);
		const doneW = 7;
		const extraW = 10;
		const tokW = 6;
		const timeW = Math.max(4, ...rows.map((r) => r.time.length), formatSpan(elapsed(run, now)).length);
		const fixedW = 4 + titleW + 1 + doneW + 1 + extraW + 1 + tokW + 1 + timeW + 1;
		const barW = inner - fixedW >= 52 ? 10 : 0;
		let trackW = inner - fixedW - (barW ? barW + 1 : 0);
		if (trackW < 12) trackW = 0;

		const head = [fit(section(th, "Phases"), 4 + titleW), fitRight(th.fg("dim", "done"), doneW), fit("", extraW), fitRight(th.fg("dim", "tokens"), tokW), fitRight(th.fg("dim", "time"), timeW)];
		if (barW) head.push(" ".repeat(barW));
		if (trackW) head.push(spread(th.fg("dim", "0:00"), th.fg("dim", `${live(run) ? "now " : ""}${formatClock(span.t1 - span.t0)}`), trackW));
		const out = [head.join(" ")];

		const extraOf = (pc: ReturnType<typeof countAgents>) =>
			[pc.active ? th.fg("accent", `${pc.active}⟳`) : "", pc.failed ? th.fg("error", `${pc.failed}✗`) : "", pc.stopped ? th.fg("warning", `${pc.stopped}■`) : "", pc.cached ? th.fg("muted", `${pc.cached}↺`) : ""]
				.filter(Boolean)
				.join(" ");
		const total = withAgentsCount >= 2 ? 1 : 0;
		const { start, end } = windowAround(rows.length, selected, Math.max(1, room - 1 - total));
		for (let i = start; i < end; i++) {
			const r = rows[i];
			const sel = i === selected;
			const quiet = r.state === "planned" || r.state === "empty";
			const title = sel ? th.fg("accent", th.bold(r.p.title)) : quiet ? th.fg("dim", r.p.title) : th.bold(r.p.title);
			const done = r.agents.length ? `${r.pc.total - r.pc.active - r.pc.queued}/${r.pc.total}` : r.qs.length ? "asked" : r.p.planned ? "planned" : "";
			const cells = [
				`${sel ? th.fg("accent", "❯") : " "} ${phaseGlyph(th, r.state, now)} ${fit(title, titleW)}`,
				fitRight(quiet || !r.agents.length ? th.fg("dim", done) : done, doneW),
				fit(extraOf(r.pc), extraW),
				fitRight(r.agents.length ? formatTokens(r.tokens) : "", tokW),
				fitRight(r.time, timeW),
			];
			if (barW) cells.push(r.agents.length ? progressBar(th, r.pc, barW) : th.fg("dim", "─".repeat(barW)));
			if (trackW) cells.push(activityTrack(th, r.agents, span, trackW, cap, now));
			out.push(cells.join(" "));
		}
		if (total) {
			const c = countAgents(run.agents);
			const peak = peakConcurrency(run.agents, now);
			const cells = [
				`    ${fit(th.fg("muted", "all agents"), titleW)}`,
				fitRight(th.fg("muted", `${c.total - c.active - c.queued}/${c.total}`), doneW),
				fit(th.fg("dim", `peak ${peak}/${cap}`), extraW),
				fitRight(th.fg("muted", formatTokens(run.usage.totalTokens)), tokW),
				fitRight(th.fg("muted", formatSpan(elapsed(run, now))), timeW),
			];
			if (barW) cells.push(progressBar(th, c, barW));
			if (trackW) cells.push(activityTrack(th, run.agents, span, trackW, cap, now));
			out.push(cells.join(" "));
		}
		return out;
	}

	private timelineLines(run: RunLike, v: Extract<View, { kind: "timeline" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		if (run.agents.length === 0) return [th.fg("muted", "No agents yet. The timeline shows one bar per agent once the script starts agents.")];
		const span = runSpan(run, now);
		const rows = this.timelineRows(run, v.order, now);
		const agentRows = rows.flatMap((r, i) => (r.kind === "agent" ? [i] : []));
		v.sel = clamp(v.sel, 0, agentRows.length - 1);
		const labelW = clamp(Math.floor(inner * 0.3), 18, 36);
		const durW = 6;
		const trackW = Math.max(10, inner - labelW - durW - 2);
		const [ticks, base] = timeAxis(th, span, trackW);
		const pad = " ".repeat(labelW + 1);
		const lines = [`${fit(th.fg("dim", v.order === "start" ? "by start" : "longest first"), labelW)} ${ticks}`, `${pad}${base}`];
		const room = Math.max(1, height - lines.length - 2);
		const { start, end } = windowAround(rows.length, agentRows[v.sel] ?? 0, room);
		for (let i = start; i < end; i++) {
			const r = rows[i];
			if (r.kind === "phase") {
				const state = phaseState(r.agents, true);
				const label = `${phaseGlyph(th, state, now)} ${th.fg("muted", th.bold(r.title.toUpperCase()))} ${th.fg("dim", plural(r.agents.length, "agent"))}`;
				lines.push(`${fit(label, labelW)} ${activityTrack(th, r.agents, span, trackW, run.limits.maxConcurrency, now)}`);
				continue;
			}
			const a = r.a;
			const sel = agentRows[v.sel] === i;
			const label = `${sel ? th.fg("accent", "❯") : " "} ${agentIcon(th, a.status, now)} ${th.fg("dim", `#${a.id}`)} ${sel ? th.fg("accent", a.label) : a.label}`;
			const dur = a.status === "cached" ? th.fg("muted", "reused") : a.startedAt ? formatSpan(agentDuration(a, now)) : th.fg("dim", "queued");
			lines.push(`${fit(label, labelW)} ${timelineBar(th, a, span, trackW, now)} ${fitRight(dur, durW)}`);
		}
		const waited = run.agents.map((a) => agentWait(a, now));
		const maxWait = Math.max(0, ...waited);
		const legend = layoutLine(
			[
				{ text: `${th.fg("success", "━")} done`, priority: 9 },
				{ text: `${th.fg("error", "━")} failed`, priority: 9 },
				{ text: `${th.fg("accent", "━")} running`, priority: 9 },
				{ text: `${th.fg("warning", "━")} waits for you`, priority: 3 },
				{ text: `${th.fg("dim", "···")} waited for a free slot`, priority: 6, shrink: () => `${th.fg("dim", "···")} waited`, min: 10 },
				{ text: `${th.fg("muted", "↺")} reused`, priority: 5 },
				{ text: maxWait >= 1000 ? th.fg("dim", `longest wait ${formatClock(maxWait)}`) : "", priority: 1 },
			],
			inner,
		);
		lines.push("");
		lines.push(legend);
		return lines;
	}

	private phaseLines(run: RunLike, v: Extract<View, { kind: "phase" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		const all = run.agents.filter((a) => a.phase === v.phase);
		const agents = all.filter((a) => agentMatches(a, v.filter));
		if (agents.length === 0) return [th.fg("muted", v.filter === "all" ? "No agents in this phase yet." : `No ${v.filter} agents. Press f to change the filter.`)];
		v.sel = Math.min(v.sel, agents.length - 1);
		// The list on top, a preview of the selected agent below when there is room.
		const previewRoom = height >= 18 ? Math.min(14, Math.max(8, Math.floor(height * 0.45))) : 0;
		const listRoom = Math.max(3, Math.min(agents.length, height - previewRoom));
		const { start, end } = windowAround(agents.length, v.sel, listRoom);
		const lines: string[] = [];
		// The model column shows only when the agents of the phase use different models.
		const models = new Set(all.map((a) => shortModel(a.model)));
		const modelW = models.size > 1 ? clamp(Math.max(...[...models].map((m) => m.length)), 8, 18) : 0;
		const idW = Math.max(3, ...agents.map((a) => String(a.id).length + 1));
		const labelW = clamp(Math.floor(inner * 0.3), 12, 36);
		const fixed = 4 + idW + 1 + labelW + 1 + (modelW ? modelW + 1 : 0) + 6 + 1 + 5 + 1;
		const detailW = Math.max(10, inner - fixed);
		for (let i = start; i < end; i++) {
			const a = agents[i];
			const sel = i === v.sel;
			const cells = [
				sel ? th.fg("accent", "❯") : " ",
				agentIcon(th, a.status, now),
				fit(th.fg("dim", `#${a.id}`), idW),
				fit(sel ? th.fg("accent", a.label) : a.label, labelW),
			];
			if (modelW) cells.push(fit(th.fg("muted", shortModel(a.model)), modelW));
			cells.push(
				fitRight(a.usage.totalTokens ? formatTokens(a.usage.totalTokens) : "", 6),
				fitRight(a.startedAt ? formatSpan(agentDuration(a, now)) : "", 5),
				fit(this.agentDetailText(run, a, detailW, now), detailW),
			);
			lines.push(cells.join(" "));
		}
		const selected = agents[v.sel];
		if (selected && previewRoom && height - lines.length >= 6) lines.push(...this.agentPreview(selected, inner, height - lines.length, now));
		return lines;
	}

	/** Short view of one agent under the agent list. */
	private agentPreview(a: AgentRecord, inner: number, room: number, now: number): string[] {
		const th = this.theme;
		const out = ["", `${section(th, "Selected")} ${th.fg("dim", `#${a.id}`)} ${th.bold(a.label)} ${th.fg("dim", "· enter for all details")}`];
		const wait = agentWait(a, now);
		out.push(
			th.fg(
				"muted",
				[
					`${a.status}`,
					shortModel(a.model),
					a.usage.totalTokens ? `${formatTokens(a.usage.totalTokens)} tokens` : "",
					a.toolCallCount ? plural(a.toolCallCount, "tool call") : "",
					wait >= 1000 ? `waited ${formatDuration(wait)}` : "",
					a.startedAt ? `ran ${formatDuration(agentDuration(a, now))}` : "",
				]
					.filter(Boolean)
					.join(" · "),
			),
		);
		out.push(th.fg("dim", oneLine(`prompt: ${a.prompt}`, inner)));
		if (AGENT_ACTIVE.has(a.status)) {
			for (const t of a.toolCalls.slice(-3)) {
				const icon = t.status === "running" ? th.fg("accent", spinner(now)) : t.status === "error" ? th.fg("error", "✗") : th.fg("success", "✓");
				out.push(`${icon} ${th.bold(t.name)} ${th.fg("muted", oneLine(t.summary, Math.max(10, inner - t.name.length - 4)))}`);
			}
			const tail = a.text.trim();
			if (tail) for (const l of wrapTextWithAnsi(tail, inner).slice(-2)) out.push(l);
		} else if (a.status === "done" || a.status === "cached") {
			out.push(...this.resultLines(a.result, inner));
		} else if (a.error) {
			for (const l of wrapTextWithAnsi(a.error, inner).slice(0, 3)) out.push(th.fg(a.status === "failed" ? "error" : "warning", l));
		}
		return out.slice(0, room);
	}

	private agentDetailText(run: RunLike, a: AgentRecord, width: number, now: number): string {
		const th = this.theme;
		switch (a.status as AgentStatus) {
			case "queued":
				return th.fg("dim", `queued for ${formatDuration(now - a.queuedAt)}, waits for a free slot`);
			case "starting":
			case "running": {
				// A long quiet time is the sign of a hanging step.
				const quiet = isLive(run) ? run.quietMs(a.id, now) : 0;
				if (quiet >= QUIET_MS) return `${th.fg("warning", `quiet ${formatDuration(quiet)}`)} ${th.fg("muted", oneLine(a.activity ?? "running", width))}`;
				return th.fg("muted", oneLine(a.activity ?? "running", width));
			}
			case "waiting":
				return th.fg("warning", oneLine(`waits for you: ${a.waitingFor ?? ""}`, width));
			case "done":
				return th.fg("text", oneLine(a.result === undefined || a.result === "" ? "(empty answer)" : resultSummary(a.result), width));
			case "cached":
				return th.fg("muted", oneLine(`saved result from ${a.fromRunId ?? "an earlier run"}`, width));
			case "failed":
			case "stopped":
			case "skipped":
				return th.fg(a.status === "failed" ? "error" : "warning", oneLine(a.error ?? a.status, width));
		}
	}

	/** A result as lines: markdown for text, highlighted JSON for data. */
	private resultLines(value: unknown, inner: number): string[] {
		if (typeof value === "string") {
			const text = value.trim();
			if (!text) return [this.theme.fg("dim", "(empty answer)")];
			try {
				return new Markdown(text, 0, 0, getMarkdownTheme()).render(inner);
			} catch {
				return wrapTextWithAnsi(text, inner);
			}
		}
		let json = "";
		try {
			json = JSON.stringify(value, null, 2) ?? "null";
		} catch {
			json = String(value);
		}
		return highlightCode(json, "json").flatMap((l) => wrapTextWithAnsi(l, inner));
	}

	private agentLines(run: RunLike, a: AgentRecord, v: Extract<View, { kind: "agent" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		const all: string[] = [];
		const wrap = (text: string, style?: (s: string) => string) => {
			for (const l of wrapTextWithAnsi(text, inner)) all.push(style ? style(l) : l);
		};
		const sep = th.fg("dim", " · ");
		const model = a.model ? `${shortModel(a.model)}${a.model.includes("/") ? th.fg("dim", ` (${a.model.slice(0, a.model.indexOf("/"))})`) : ""}` : "?";
		all.push(th.fg("muted", [`model ${model}`, a.thinking ? `thinking ${a.thinking}` : "", a.attempts > 1 ? `attempt ${a.attempts}` : ""].filter(Boolean).join(sep)));
		const wait = agentWait(a, now);
		const timing = [
			plural(a.turns, "turn"),
			`${formatTokens(a.usage.totalTokens)} tokens${formatCost(a.usage.cost) ? ` (${formatCost(a.usage.cost)})` : ""}`,
			a.status === "cached" ? `reused from ${a.fromRunId ?? "an earlier run"}` : "",
			wait >= 1000 ? `waited ${formatDuration(wait)} for a free slot` : "",
			a.startedAt ? `ran ${formatDuration(agentDuration(a, now))}` : "",
			a.interrupts ? plural(a.interrupts, "interrupted step") : "",
			a.stalls ? plural(a.stalls, "stall") : "",
		].filter(Boolean);
		all.push(th.fg("muted", timing.join(sep)));
		wrap(`tools ${a.tools.join(", ") || "none"}${a.opts.schema ? " · structured result (schema)" : ""}${a.opts.cwd ? ` · cwd ${a.opts.cwd}` : ""}`, (s) => th.fg("muted", s));
		if (a.transcriptPath) all.push(th.fg("dim", middleTruncate(`transcript ${shortHome(a.transcriptPath)}`, inner)));
		if (a.worktree) wrap(`worktree ${a.worktree.path} · branch ${a.worktree.branch}${a.worktree.changed ? ` · ${a.worktree.diffStat ?? "changed"}` : " · no changes"}`, (s) => th.fg("dim", s));
		if (a.waitingFor) wrap(`waits for you: ${a.waitingFor} (press a)`, (s) => th.fg("warning", s));
		const quiet = isLive(run) ? run.quietMs(a.id, now) : 0;
		if (quiet >= QUIET_MS) {
			wrap(
				`No activity for ${formatDuration(quiet)} (${a.activity ?? "running"}). If it hangs: i interrupts the step (the agent keeps its context), r restarts it, x stops it.`,
				(s) => th.fg("warning", s),
			);
		}
		if (a.error && (a.status === "failed" || a.status === "stopped" || a.status === "skipped")) {
			all.push("");
			all.push(section(th, a.status === "failed" ? "Error" : a.status === "stopped" ? "Stopped" : "Skipped"));
			wrap(a.error, (s) => th.fg(a.status === "failed" ? "error" : "warning", s));
			if (a.status === "failed" && a.transcriptPath) all.push(th.fg("dim", "The transcript above has the full conversation of this agent."));
		}
		all.push("");
		all.push(section(th, "Prompt"));
		const promptLines = wrapTextWithAnsi(a.prompt, inner);
		const shownPrompt = v.expanded ? promptLines : promptLines.slice(0, 6);
		for (const l of shownPrompt) all.push(l);
		if (!v.expanded && promptLines.length > 6) all.push(th.fg("dim", `… ${promptLines.length - 6} more lines (enter expands)`));
		if (a.steers?.length) {
			all.push("");
			all.push(section(th, "Messages sent to this agent"));
			for (const st of a.steers) for (const l of wrapTextWithAnsi(`${st.by === "human" ? "you" : "main agent"}: ${st.text}`, inner)) all.push(th.fg("accent", l));
		}
		all.push("");
		all.push(section(th, `Tool calls (${a.toolCallCount})`));
		if (a.toolCalls.length === 0) all.push(th.fg("dim", AGENT_FINAL.has(a.status) ? "none" : "none yet"));
		if (a.toolCallCount > a.toolCalls.length) all.push(th.fg("dim", `… ${a.toolCallCount - a.toolCalls.length} earlier calls`));
		const nameW = Math.min(18, Math.max(6, ...a.toolCalls.map((t) => t.name.length)));
		for (const t of a.toolCalls) {
			const icon = t.status === "running" ? th.fg("accent", spinner(now)) : t.status === "error" ? th.fg("error", "✗") : th.fg("success", "✓");
			const dur = t.endedAt ? (t.endedAt - t.startedAt < 100 ? "<0.1s" : `${((t.endedAt - t.startedAt) / 1000).toFixed(1)}s`) : formatClock(now - t.startedAt);
			all.push(`${icon} ${fit(th.bold(t.name), nameW)} ${fit(t.summary, Math.max(10, inner - nameW - 11))} ${fitRight(th.fg("dim", dur), 6)}`);
			if (v.expanded) {
				if (t.argsPreview) for (const l of wrapTextWithAnsi(t.argsPreview, inner - 4).slice(0, 8)) all.push(th.fg("dim", `    ${l}`));
				if (t.resultPreview) for (const l of wrapTextWithAnsi(t.resultPreview, inner - 4).slice(0, 8)) all.push(th.fg("toolOutput", `    ${l}`));
			}
		}
		if (AGENT_ACTIVE.has(a.status) && a.text.trim()) {
			all.push("");
			all.push(section(th, "Output (streaming)"));
			for (const l of wrapTextWithAnsi(a.text.trim(), inner).slice(-8)) all.push(l);
		}
		if (a.status === "done" || a.status === "cached") {
			all.push("");
			all.push(section(th, "Result"));
			const resLines = this.resultLines(a.result, inner);
			const shown = v.expanded ? resLines : resLines.slice(0, 16);
			for (const l of shown) all.push(l);
			if (!v.expanded && resLines.length > 16) all.push(th.fg("dim", `… ${resLines.length - 16} more lines (enter expands)`));
		}
		v.scroll = Math.min(v.scroll, Math.max(0, all.length - height));
		// The scroll position shows in the box border (the title line), not over the content.
		this.scrollPos = all.length > height ? `lines ${v.scroll + 1}-${Math.min(all.length, v.scroll + height)} of ${all.length}` : undefined;
		return all.slice(v.scroll, v.scroll + height);
	}
}

/** Markdown as one line of plain text: no heading marks, emphasis, code ticks, links, or table rules. */
export function plainText(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, "")
		.replace(/\s*\|\s*/g, " · ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Data as one readable line: "findings: [1] handler: GET /admin · line: 5 · issue: ...". */
export function compactValue(v: unknown, depth = 0): string {
	if (v === null || v === undefined) return String(v);
	if (typeof v === "string") return plainText(v);
	if (typeof v !== "object") return String(v);
	// A list shows its length and its first item (at the same depth).
	if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${v.length}] ${compactValue(v[0], depth)}`;
	const entries = Object.entries(v as Record<string, unknown>);
	if (entries.length === 0) return "{}";
	if (depth >= 2) return `{${plural(entries.length, "key")}}`;
	return entries.map(([k, x]) => `${k}: ${compactValue(x, depth + 1)}`).join(" · ");
}

/** One readable line for a result. */
function resultSummary(value: unknown): string {
	if (value === undefined) return "(no value returned)";
	if (typeof value === "string") return plainText(value) || "(empty text)";
	return compactValue(value);
}

function live(run: RunLike): boolean {
	return run.status === "running" || run.status === "paused";
}
