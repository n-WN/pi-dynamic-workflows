/**
 * The /workflows monitor: a full-screen overlay with four levels.
 *
 *   runs  ->  run (phases, log)  ->  phase (agents)  ->  agent (prompt, tool calls, output, result)
 *
 * It redraws live, answers ask() questions and agent permission prompts inline,
 * and controls runs: pause, stop, restart an agent, save a script as a command.
 */

import { readFileSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, type TUI, type TuiMouseEvent, type TuiMouseEventResult, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DialogAnswer, DialogRequest } from "../child-ui.ts";
import { countAgents, elapsedOf, formatClock, formatCost, formatDuration, formatTokens, oneLine, plural, previewJson } from "../format.ts";
import { getRegistry, onRegistryChange, runsOfSession } from "../registry.ts";
import { WorkflowRun } from "../run.ts";
import { AGENT_ACTIVE, AGENT_FINAL, type AgentRecord, type AgentStatus, type QuestionRecord, type RunSnapshot } from "../types.ts";
import { agentIcon, box, counters, fit, fitRight, hints, progressBar, runIcon, runStatusColor, section, shortModel, spinner, spread, windowAround } from "./draw.ts";

type RunLike = WorkflowRun | RunSnapshot;
type Filter = "all" | "active" | "failed" | "done" | "queued";
const FILTERS: Filter[] = ["all", "active", "failed", "done", "queued"];

type View =
	| { kind: "runs"; sel: number }
	| { kind: "run"; runId: string; sel: number }
	| { kind: "phase"; runId: string; phase: string; sel: number; filter: Filter }
	| { kind: "agent"; runId: string; agentId: number; scroll: number; expanded: boolean }
	| { kind: "script"; runId: string; scroll: number };

type Interaction =
	| { kind: "question"; run: WorkflowRun; q: QuestionRecord }
	| { kind: "dialog"; req: DialogRequest; resolve: (a: DialogAnswer) => void; fallback: () => Promise<DialogAnswer> };

type Mode =
	| { kind: "normal" }
	| { kind: "save"; runId: string; input: Input; scope: "project" | "personal"; error?: string }
	| { kind: "answer"; target: Interaction; sel: number; input?: Input }
	| { kind: "confirm-stop"; runId: string };

export interface MonitorActions {
	sessionId(): string;
	pastRuns(): RunSnapshot[];
	save(run: RunLike, name: string, scope: "project" | "personal"): string;
	saveLocations(): { project: string; personal: string };
	openKey: string;
}

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

function phaseIcon(theme: Theme, agents: AgentRecord[], planned: boolean, now: number, questions: QuestionRecord[] = []): string {
	if (agents.length === 0) {
		if (questions.some((q) => q.status === "pending")) return theme.fg("warning", "?");
		if (questions.length) return theme.fg("success", "✓");
		return theme.fg("dim", planned ? "○" : "·");
	}
	if (agents.some((a) => AGENT_ACTIVE.has(a.status) || a.status === "queued")) return theme.fg("accent", spinner(now));
	if (agents.some((a) => a.status === "failed")) return theme.fg("warning", "✓");
	return theme.fg("success", "✓");
}

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

	// -------------------------------------------------------------------------
	// Input
	// -------------------------------------------------------------------------

	handleInput(data: string): void {
		if (this.mode.kind === "save") return this.handleSaveInput(data, this.mode);
		if (this.mode.kind === "answer") return this.handleAnswerInput(data, this.mode);
		if (this.mode.kind === "confirm-stop") {
			const run = this.findRun(this.mode.runId);
			if (data === "y" || data === "Y" || matchesKey(data, "enter")) {
				if (run && isLive(run)) {
					run.stop();
					this.setFlash(`Stopped ${run.name}. Completed agents stay saved; ask the agent to relaunch it to resume.`, "warning");
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
				else this.runAction(data, run);
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
		else if (v.kind === "runs" || v.kind === "run" || v.kind === "phase") v.sel = Math.max(0, v.sel + step);
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
			if (isLive(run) && run.stopAgent(agent.id)) this.setFlash(`Stopping agent #${agent.id} (${agent.label}). The script gets null for it.`, "warning");
			else this.setFlash("This agent is not running.");
		} else if (data === "r") {
			if (isLive(run) && run.restartAgent(agent.id)) this.setFlash(`Restarting agent #${agent.id} (${agent.label}).`);
			else this.setFlash("Only a running agent can restart.");
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

	private finishAnswer(it: Interaction, answer: DialogAnswer | null, cancelled: boolean): void {
		if (it.kind === "dialog") {
			const i = this.dialogQueue.indexOf(it);
			if (i >= 0) this.dialogQueue.splice(i, 1);
			if (cancelled) it.resolve(it.req.kind === "confirm" ? false : undefined);
			else if (it.req.kind === "confirm") it.resolve(answer === "Yes");
			else it.resolve(answer === null ? undefined : (answer as string));
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
		if (matchesKey(data, "up") || data === "k") mode.sel = Math.max(0, mode.sel - 1);
		else if (matchesKey(data, "down") || data === "j") mode.sel = Math.min(options.length - 1, mode.sel + 1);
		else if (matchesKey(data, "enter")) this.finishAnswer(it, options[mode.sel] ?? null, false);
		else if (/^[1-9]$/.test(data) && options[Number(data) - 1] !== undefined) this.finishAnswer(it, options[Number(data) - 1], false);
		else if (data === "y" && it.kind === "dialog" && it.req.kind === "confirm") this.finishAnswer(it, "Yes", false);
		else if (data === "n" && it.kind === "dialog" && it.req.kind === "confirm") this.finishAnswer(it, "No", false);
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
		const totalHeight = Math.max(12, Math.floor(rows * 0.9));
		const inner = Math.max(20, width - 4);
		const bodyHeight = totalHeight - 2;
		const banner = this.bannerLines(inner);
		const modeLines = this.modeLines(inner);
		const flash = this.flash && this.flash.until > now ? [th.fg(this.flash.level === "info" ? "accent" : this.flash.level, oneLine(this.flash.text, inner))] : [];
		const reserved = banner.length + modeLines.length + flash.length;
		const viewHeight = Math.max(3, bodyHeight - reserved);
		this.lastBodyHeight = viewHeight;
		const { title, right, lines, footer } = this.viewContent(inner, viewHeight, now);
		const body = [...banner, ...lines.slice(0, viewHeight)];
		while (body.length < banner.length + viewHeight) body.push("");
		body.push(...flash, ...modeLines);
		const footerText = this.mode.kind === "normal" ? footer : this.modeFooter();
		return box(th, body, width, { title, right, footer: footerText, height: bodyHeight });
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
							["esc", this.mode.target.kind === "dialog" ? "deny" : "close"],
						]);
			case "confirm-stop":
				return hints(th, [
					["y", "stop the run"],
					["any key", "cancel"],
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
			}
			return lines;
		}
		return [];
	}

	private phasesOf(run: RunLike): Array<{ title: string; planned: boolean }> {
		const titles = run.phases.map((p) => ({ title: p.title, planned: p.planned }));
		for (const a of run.agents) if (!titles.some((t) => t.title === a.phase)) titles.push({ title: a.phase, planned: false });
		return titles;
	}

	private viewContent(inner: number, height: number, now: number): { title: string; right?: string; lines: string[]; footer: string } {
		const v = this.view;
		const th = this.theme;
		const nav: Array<[string, string]> = [];
		const pending = this.interactions().length > 0;
		if (pending) nav.push(["a", "answer"]);
		switch (v.kind) {
			case "runs":
				return {
					title: "Workflows",
					right: this.runsSummary(),
					lines: this.runsLines(v, inner, height, now),
					footer: hints(th, [["↑↓", "select"], ["enter", "open"], ["p", "pause"], ["x", "stop"], ["s", "save"], ...nav, ["esc", "close"]]),
				};
			case "run": {
				const run = this.findRun(v.runId);
				if (!run) return this.missing(v.runId);
				return {
					title: `Workflows › ${run.name}`,
					right: this.runRight(run, now),
					lines: this.runLines(run, v, inner, height, now),
					footer: hints(th, [["↑↓", "phase"], ["enter", "agents"], ["v", "script"], ["p", "pause"], ["x", "stop"], ["s", "save"], ...nav, ["esc", "back"]]),
				};
			}
			case "phase": {
				const run = this.findRun(v.runId);
				if (!run) return this.missing(v.runId);
				const agents = run.agents.filter((a) => a.phase === v.phase);
				const c = countAgents(agents);
				return {
					title: `Workflows › ${run.name} › ${v.phase}`,
					right: th.fg("muted", `${c.done + c.cached + c.failed + c.stopped + c.skipped}/${c.total} · filter: ${v.filter}`),
					lines: this.phaseLines(run, v, inner, height, now),
					footer: hints(th, [["↑↓", "select"], ["enter", "detail"], ["f", "filter"], ["x", "stop agent"], ["r", "restart"], ...nav, ["esc", "back"]]),
				};
			}
			case "agent": {
				const run = this.findRun(v.runId);
				const agent = run?.agents[v.agentId];
				if (!run || !agent) return this.missing(v.runId);
				const status = `${agentIcon(th, agent.status, now)} ${agent.status} ${formatClock(agentDuration(agent, now))}`;
				return {
					title: `${run.name} › ${agent.phase} › #${agent.id} ${agent.label}`,
					right: status,
					lines: this.agentLines(run, agent, v, inner, height, now),
					footer: hints(th, [["↑↓", "scroll"], ["enter", v.expanded ? "collapse" : "expand"], ["x", "stop"], ["r", "restart"], ...nav, ["esc", "back"]]),
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
					right: th.fg("dim", oneLine(run.scriptPath, 50)),
					lines: lines.slice(v.scroll, v.scroll + height),
					footer: hints(th, [["↑↓", "scroll"], ["esc", "back"]]),
				};
			}
		}
	}

	private missing(id: string) {
		return { title: "Workflows", lines: [this.theme.fg("error", `Run ${id} is not available.`)], footer: hints(this.theme, [["esc", "back"]]) };
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
		const { start, end } = windowAround(runs.length, v.sel, height);
		const lines: string[] = [];
		for (let i = start; i < end; i++) {
			const r = runs[i];
			const sel = i === v.sel;
			const c = countAgents(r.agents);
			const status = statusOf(r);
			const statusText =
				status === "running" || status === "paused"
					? (() => {
							const phaseAgents = r.agents.filter((a) => AGENT_ACTIVE.has(a.status) || a.status === "queued");
							const phase = phaseAgents[phaseAgents.length - 1]?.phase ?? r.agents[r.agents.length - 1]?.phase ?? "starting the script";
							if (isLive(r) && r.pendingQuestionList.length) return th.fg("warning", "waits for your answer (a)");
							return status === "paused" ? th.fg("warning", `paused · ${phase}`) : th.fg("muted", phase);
						})()
					: status === "failed"
						? th.fg("error", `failed: ${oneLine(r.error ?? "", 40)}`)
						: th.fg(runStatusColor(status), status);
			const barW = Math.max(6, Math.min(18, Math.floor(inner / 7)));
			// Fixed columns: cursor, icon, name, bar, agents, tokens, time, id, and 8 separators.
			const fixed = 1 + 1 + 22 + barW + 10 + 7 + 7 + 10 + 8;
			const row = [
				sel ? th.fg("accent", "❯") : " ",
				runIcon(th, status, now),
				fit(sel ? th.fg("accent", th.bold(r.name)) : th.bold(r.name), 22),
				fit(statusText, Math.max(8, inner - fixed)),
				progressBar(th, c, barW),
				fitRight(plural(c.total, "agent"), 10),
				fitRight(formatTokens(r.usage.totalTokens), 7),
				fitRight(formatDuration(elapsed(r, now)), 7),
				fitRight(th.fg("dim", r.id), 10),
			].join(" ");
			lines.push(row);
		}
		const sel = runs[v.sel];
		if (sel && height - lines.length >= 8) {
			lines.push("");
			lines.push(section(th, "Selected"));
			lines.push(th.fg("muted", oneLine(sel.description, inner)));
			const titles = this.phasesOf(sel).map((p) => {
				const agents = sel.agents.filter((a) => a.phase === p.title);
				const pc = countAgents(agents);
				const qs = sel.questions.filter((q) => q.phase === p.title);
				return agents.length || qs.length
					? `${phaseIcon(th, agents, p.planned, now, qs)} ${p.title}${agents.length ? th.fg("dim", ` ${pc.total - pc.active - pc.queued}/${pc.total}`) : ""}`
					: th.fg("dim", `○ ${p.title}`);
			});
			if (titles.length) lines.push(titles.join(th.fg("dim", "  →  ")));
			const lastLog = sel.logs[sel.logs.length - 1];
			if (lastLog) lines.push(th.fg("dim", `log: ${oneLine(lastLog.text, inner - 6)}`));
			if (statusOf(sel) === "failed" && sel.error) lines.push(th.fg("error", oneLine(sel.error, inner)));
			lines.push(th.fg("dim", oneLine(`script ${shortHome(sel.scriptPath)}`, inner)));
		}
		return lines;
	}

	private runLines(run: RunLike, v: Extract<View, { kind: "run" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		const c = countAgents(run.agents);
		const lines: string[] = [];
		lines.push(th.fg("muted", oneLine(run.description, inner)));
		const cost = formatCost(run.usage.cost);
		const src = run.source.kind === "inline" ? "written for this task" : `${run.source.kind}${run.source.name ? ` ${run.source.name}` : ""}`;
		lines.push(
			[
				th.fg("dim", run.id),
				`${plural(c.total, "agent")} ${counters(th, c)}`.trim(),
				`${formatTokens(run.usage.totalTokens)} tokens${cost ? ` · ${cost}` : ""}`,
				`${run.limits.maxConcurrency} at once`,
				th.fg("dim", src),
				run.resumedFrom ? th.fg("muted", `resumed from ${run.resumedFrom}`) : "",
			]
				.filter(Boolean)
				.join(th.fg("dim", " · ")),
		);
		const pct = c.total ? Math.round(((c.done + c.cached + c.failed + c.stopped + c.skipped) / c.total) * 100) : 0;
		lines.push(`${progressBar(th, c, Math.max(10, inner - 6))} ${fitRight(`${pct}%`, 4)}`);
		for (const w of run.warnings) lines.push(th.fg("warning", `⚠ ${w}`));
		if (isLive(run) && run.scriptBusyMs(now) > 5000) {
			lines.push(th.fg("warning", `⚠ The script has not answered for ${formatDuration(run.scriptBusyMs(now))} (a long synchronous loop?). x stops it.`));
		}
		if (statusOf(run) === "failed" && run.error) lines.push(th.fg("error", `✗ ${oneLine(run.error, inner - 2)}`));
		if (statusOf(run) === "completed") {
			const preview = previewJson(run.result, 300);
			lines.push(th.fg("success", `✓ result: ${oneLine(preview || "(no value returned)", inner - 12)}`));
		}
		lines.push("");
		lines.push(section(th, "Phases"));
		const phases = this.phasesOf(run);
		v.sel = Math.min(v.sel, Math.max(0, phases.length - 1));
		const logRoom = Math.max(0, height - lines.length - phases.length - 2);
		const phaseRoom = Math.max(1, height - lines.length - Math.min(logRoom, 8) - 2);
		const { start, end } = windowAround(phases.length, v.sel, phaseRoom);
		for (let i = start; i < end; i++) {
			const p = phases[i];
			const agents = run.agents.filter((a) => a.phase === p.title);
			const pc = countAgents(agents);
			const sel = i === v.sel;
			const tokens = agents.reduce((s, a) => s + a.usage.totalTokens, 0);
			const startedAt = Math.min(...agents.map((a) => a.startedAt ?? Number.POSITIVE_INFINITY));
			const endedAt = agents.every((a) => AGENT_FINAL.has(a.status)) ? Math.max(...agents.map((a) => a.endedAt ?? 0)) : now;
			const dur = Number.isFinite(startedAt) ? formatClock(endedAt - startedAt) : "";
			const finished = pc.done + pc.cached + pc.failed + pc.stopped + pc.skipped;
			const barW = Math.max(6, Math.min(24, Math.floor(inner / 5)));
			const extra = [pc.active ? th.fg("accent", `${pc.active}⟳`) : "", pc.failed ? th.fg("error", `${pc.failed}✗`) : "", pc.queued ? th.fg("dim", `${pc.queued} queued`) : ""]
				.filter(Boolean)
				.join(" ");
			lines.push(
				[
					sel ? th.fg("accent", "❯") : " ",
					phaseIcon(th, agents, p.planned, now, run.questions.filter((q) => q.phase === p.title)),
					fit(sel ? th.fg("accent", th.bold(p.title)) : th.bold(p.title), 20),
					agents.length ? fitRight(`${finished}/${pc.total}`, 8) : fitRight(th.fg("dim", run.questions.some((q) => q.phase === p.title) ? "asked" : "planned"), 8),
					agents.length ? progressBar(th, pc, barW) : th.fg("dim", "─".repeat(barW)),
					fitRight(agents.length ? formatTokens(tokens) : "", 7),
					fitRight(dur, 7),
					extra,
				].join(" "),
			);
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

	private phaseLines(run: RunLike, v: Extract<View, { kind: "phase" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		const agents = run.agents.filter((a) => a.phase === v.phase && agentMatches(a, v.filter));
		if (agents.length === 0) return [th.fg("muted", v.filter === "all" ? "No agents in this phase yet." : `No ${v.filter} agents. Press f to change the filter.`)];
		v.sel = Math.min(v.sel, agents.length - 1);
		const { start, end } = windowAround(agents.length, v.sel, height);
		const lines: string[] = [];
		const labelW = Math.max(12, Math.min(36, Math.floor(inner * 0.3)));
		const modelW = Math.max(8, Math.min(18, Math.floor(inner * 0.14)));
		const fixed = 2 + 2 + 6 + labelW + modelW + 8 + 7 + 7;
		const detailW = Math.max(10, inner - fixed);
		for (let i = start; i < end; i++) {
			const a = agents[i];
			const sel = i === v.sel;
			const detail = this.agentDetailText(a, detailW);
			lines.push(
				[
					sel ? th.fg("accent", "❯") : " ",
					agentIcon(th, a.status, now),
					fit(th.fg("dim", `#${a.id}`), 5),
					fit(sel ? th.fg("accent", a.label) : a.label, labelW),
					fit(th.fg("muted", shortModel(a.model)), modelW),
					fitRight(a.usage.totalTokens ? formatTokens(a.usage.totalTokens) : "", 7),
					fitRight(a.startedAt ? formatClock(agentDuration(a, now)) : "", 6),
					fit(detail, detailW),
				].join(" "),
			);
		}
		return lines;
	}

	private agentDetailText(a: AgentRecord, width: number): string {
		const th = this.theme;
		switch (a.status as AgentStatus) {
			case "queued":
				return th.fg("dim", "queued");
			case "starting":
			case "running":
				return th.fg("muted", oneLine(a.activity ?? "running", width));
			case "waiting":
				return th.fg("warning", oneLine(`waits for you: ${a.waitingFor ?? ""}`, width));
			case "done":
				return th.fg("text", oneLine(previewJson(a.result, 200) || "(empty answer)", width));
			case "cached":
				return th.fg("muted", oneLine(`saved result from ${a.fromRunId ?? "an earlier run"}`, width));
			case "failed":
			case "stopped":
			case "skipped":
				return th.fg(a.status === "failed" ? "error" : "warning", oneLine(a.error ?? a.status, width));
		}
	}

	private agentLines(run: RunLike, a: AgentRecord, v: Extract<View, { kind: "agent" }>, inner: number, height: number, now: number): string[] {
		const th = this.theme;
		const all: string[] = [];
		const wrap = (text: string, style?: (s: string) => string) => {
			for (const l of wrapTextWithAnsi(text, inner)) all.push(style ? style(l) : l);
		};
		const meta = [
			`model ${a.model ?? "?"}`,
			a.thinking ? `thinking ${a.thinking}` : "",
			`attempt ${a.attempts}`,
			`${a.turns} turns`,
			`${formatTokens(a.usage.totalTokens)} tokens${formatCost(a.usage.cost) ? ` (${formatCost(a.usage.cost)})` : ""}`,
		]
			.filter(Boolean)
			.join(" · ");
		wrap(meta, (s) => th.fg("muted", s));
		wrap(`tools ${a.tools.join(", ") || "none"}${a.opts.schema ? " · structured result (schema)" : ""}${a.opts.cwd ? ` · cwd ${a.opts.cwd}` : ""}`, (s) => th.fg("muted", s));
		if (a.transcriptPath) all.push(th.fg("dim", middleTruncate(`transcript ${shortHome(a.transcriptPath)}`, inner)));
		if (a.worktree) wrap(`worktree ${a.worktree.path} · branch ${a.worktree.branch}${a.worktree.changed ? ` · ${a.worktree.diffStat ?? "changed"}` : " · no changes"}`, (s) => th.fg("dim", s));
		if (a.waitingFor) wrap(`waits for you: ${a.waitingFor} (press a)`, (s) => th.fg("warning", s));
		all.push("");
		all.push(section(th, "Prompt"));
		const promptLines = wrapTextWithAnsi(a.prompt, inner);
		const shownPrompt = v.expanded ? promptLines : promptLines.slice(0, 6);
		for (const l of shownPrompt) all.push(l);
		if (!v.expanded && promptLines.length > 6) all.push(th.fg("dim", `… ${promptLines.length - 6} more lines (enter expands)`));
		all.push("");
		all.push(section(th, `Tool calls (${a.toolCallCount})`));
		if (a.toolCalls.length === 0) all.push(th.fg("dim", "none yet"));
		if (a.toolCallCount > a.toolCalls.length) all.push(th.fg("dim", `… ${a.toolCallCount - a.toolCalls.length} earlier calls`));
		const nameW = Math.min(18, Math.max(6, ...a.toolCalls.map((t) => t.name.length)));
		for (const t of a.toolCalls) {
			const icon = t.status === "running" ? th.fg("accent", spinner(now)) : t.status === "error" ? th.fg("error", "✗") : th.fg("success", "✓");
			const dur = t.endedAt ? `${((t.endedAt - t.startedAt) / 1000).toFixed(1)}s` : formatClock(now - t.startedAt);
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
			const text = typeof a.result === "string" ? a.result : JSON.stringify(a.result, null, 2) ?? "";
			const resLines = wrapTextWithAnsi(text || "(empty)", inner);
			const shown = v.expanded ? resLines : resLines.slice(0, 14);
			for (const l of shown) all.push(l);
			if (!v.expanded && resLines.length > 14) all.push(th.fg("dim", `… ${resLines.length - 14} more lines (enter expands)`));
		}
		if (a.error && (a.status === "failed" || a.status === "stopped" || a.status === "skipped")) {
			all.push("");
			all.push(section(th, a.status === "failed" ? "Error" : "Stopped"));
			wrap(a.error, (s) => th.fg(a.status === "failed" ? "error" : "warning", s));
		}
		v.scroll = Math.min(v.scroll, Math.max(0, all.length - height));
		const out = all.slice(v.scroll, v.scroll + height);
		if (all.length > height) {
			const pos = `${v.scroll + 1}-${Math.min(all.length, v.scroll + height)}/${all.length}`;
			out[out.length - 1] = spread(out[out.length - 1] ?? "", th.fg("dim", pos), inner);
		}
		void run;
		return out;
	}
}
