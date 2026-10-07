/**
 * Approval dialog shown before a workflow starts.
 *
 * It shows the plan (name, phases, size, model, args) and lets the human run it,
 * run it and stop asking, read the script, edit it (ctrl+g), or decline with
 * feedback for the agent (tab).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { oneLine, plural, previewJson } from "../format.ts";
import type { ScriptPlan } from "../script.ts";
import { box, hints, section } from "./draw.ts";

export type ApprovalChoice =
	| { action: "run" }
	| { action: "run-always" }
	| { action: "run-session" }
	| { action: "edit" }
	| { action: "decline"; feedback?: string };

export interface ApprovalInfo {
	name: string;
	description: string;
	phases: string[];
	source: string;
	lineCount: number;
	scriptPath: string;
	script: string;
	args: unknown;
	limits: string;
	model: string;
	/** Facts from the script text: agent() calls, fan-out, tools, isolation, models, questions. */
	plan?: ScriptPlan;
	/** Tools an agent gets when the script does not choose. */
	agentTools?: string[];
	/** Saved, bundled, or file workflow: offer "don't ask again for <name>". */
	named: boolean;
	edited: boolean;
	resumeFrom?: string;
	notes: string[];
}

function shortHome(p: string): string {
	const home = process.env.HOME;
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Keep the start and the end of a long path. */
function middleCut(text: string, width: number): string {
	if (text.length <= width) return text;
	const keep = Math.max(4, width - 1);
	const head = Math.ceil(keep * 0.4);
	return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

interface Option {
	label: string;
	choice: ApprovalChoice | "view" | "feedback";
}

export class ApprovalDialog implements Component {
	focused = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly info: ApprovalInfo;
	private readonly done: (c: ApprovalChoice) => void;
	private readonly options: Option[];
	private sel = 0;
	private mode: "menu" | "script" | "feedback" = "menu";
	private scroll = 0;
	private readonly feedback = new Input();
	private codeLines?: string[];

	constructor(tui: TUI, theme: Theme, info: ApprovalInfo, done: (c: ApprovalChoice) => void) {
		this.tui = tui;
		this.theme = theme;
		this.info = info;
		this.done = done;
		this.options = [
			{ label: "Yes, run it", choice: { action: "run" } },
			...(info.named ? [{ label: `Yes, and don't ask again for ${info.name} in this project`, choice: { action: "run-always" } as ApprovalChoice }] : []),
			{ label: "Yes, and approve all workflows in this session", choice: { action: "run-session" } },
			{ label: "View the script", choice: "view" },
			{ label: "No, and tell the agent what to change", choice: "feedback" },
			{ label: "No", choice: { action: "decline" } },
		];
	}

	invalidate(): void {
		this.codeLines = undefined;
	}

	handleInput(data: string): void {
		if (this.mode === "feedback") {
			if (matchesKey(data, "escape")) this.mode = "menu";
			else if (matchesKey(data, "enter")) {
				const text = this.feedback.getValue().trim();
				this.done({ action: "decline", feedback: text || undefined });
				return;
			} else this.feedback.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "ctrl+g")) {
			this.done({ action: "edit" });
			return;
		}
		if (this.mode === "script") {
			if (matchesKey(data, "escape") || data === "v" || data === "q") this.mode = "menu";
			else if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "down") || data === "j") this.scroll++;
			else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 15);
			else if (matchesKey(data, "pageDown")) this.scroll += 15;
			else if (matchesKey(data, "enter") || data === "y") {
				this.done({ action: "run" });
				return;
			}
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || data === "n") {
			this.done({ action: "decline" });
			return;
		}
		if (matchesKey(data, "tab")) {
			this.mode = "feedback";
			this.tui.requestRender();
			return;
		}
		if (data === "v") {
			this.mode = "script";
			this.tui.requestRender();
			return;
		}
		if (data === "y") {
			this.done({ action: "run" });
			return;
		}
		if (matchesKey(data, "up") || data === "k") this.sel = Math.max(0, this.sel - 1);
		else if (matchesKey(data, "down") || data === "j") this.sel = Math.min(this.options.length - 1, this.sel + 1);
		else if (/^[1-9]$/.test(data) && this.options[Number(data) - 1]) this.select(Number(data) - 1);
		else if (matchesKey(data, "enter")) this.select(this.sel);
		this.tui.requestRender();
	}

	private select(i: number): void {
		const opt = this.options[i];
		if (!opt) return;
		if (opt.choice === "view") {
			this.mode = "script";
			this.scroll = 0;
		} else if (opt.choice === "feedback") {
			this.mode = "feedback";
		} else {
			this.done(opt.choice);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = Math.max(20, width - 4);
		const rows = this.tui.terminal.rows || 30;
		const maxBody = Math.max(10, Math.floor(rows * 0.8) - 2);
		const info = this.info;

		if (this.mode === "script") {
			this.codeLines ??= highlightCode(info.script, "javascript").map((l, i) => `${th.fg("dim", String(i + 1).padStart(4))}  ${l}`);
			const lines = this.codeLines;
			this.scroll = Math.min(this.scroll, Math.max(0, lines.length - maxBody));
			const shown = lines.slice(this.scroll, this.scroll + maxBody);
			return box(th, shown, width, {
				title: `Script · ${info.name}`,
				right: th.fg("dim", `${this.scroll + 1}-${Math.min(lines.length, this.scroll + maxBody)}/${lines.length}`),
				footer: hints(th, [
					["↑↓", "scroll"],
					["enter", "run"],
					["ctrl+g", "edit"],
					["esc", "back"],
				]),
			});
		}

		const LABEL = 10;
		const label = (k: string) => th.fg("muted", k.padEnd(LABEL));
		const lines: string[] = [];
		// A labeled row; long values wrap under the value column.
		const row = (k: string, value: string) => {
			wrapTextWithAnsi(value, Math.max(10, inner - LABEL)).forEach((l, i) => lines.push(`${i === 0 ? label(k) : " ".repeat(LABEL)}${l}`));
		};
		const dot = th.fg("dim", " · ");
		lines.push(`${th.fg("accent", "◆")} ${th.bold(info.name)}${info.edited ? th.fg("warning", "  (edited)") : ""}`);
		for (const l of wrapTextWithAnsi(info.description, inner - 2).slice(0, 3)) lines.push(`  ${th.fg("text", l)}`);
		lines.push("");
		if (info.phases.length) row("Phases", info.phases.map((p, i) => `${th.fg("dim", `${i + 1}`)} ${p}`).join(th.fg("dim", "  →  ")));
		const plan = info.plan;
		if (plan) {
			const calls = plan.agentCalls ? plural(plan.agentCalls, "agent() call") + " in the script" : "no agent() calls found in the script";
			const fan = plan.fanOut.length
				? `${plan.fanOut.join(", ")}: ${th.fg("warning", "the number of agents is known only at run time")}`
				: "no fan-out: one agent per call";
			row("Plan", [calls, fan].join(dot));
		}
		row("Agents", info.limits);
		if (plan) {
			const tools = [
				`by default ${th.bold((info.agentTools ?? []).join(", ") || "no tools")}`,
				plan.readOnly ? `read-only at ${plural(plan.readOnly, "call")}` : "",
				plan.tools.length ? `the script also names ${plan.tools.join(", ")}` : "",
			].filter(Boolean);
			row("Tools", tools.join(dot));
			if (plan.worktree) row("Isolation", `${plural(plan.worktree, "call")} in its own git worktree: changes go to new branches, not to your working tree`);
		}
		row("Model", [info.model, plan?.models.length ? `the script also names ${plan.models.join(", ")}` : ""].filter(Boolean).join(dot));
		if (plan?.asks) row("Questions", `${plural(plan.asks, "ask() call")}: the run can stop and wait for your answer`);
		row("Script", `${info.source} · ${info.lineCount} lines`);
		lines.push(`${" ".repeat(LABEL)}${th.fg("dim", middleCut(shortHome(info.scriptPath), inner - LABEL))}`);
		if (info.args !== undefined) row("Args", oneLine(previewJson(info.args, 300), 300));
		if (info.resumeFrom) row("Resume", `from ${info.resumeFrom}: unchanged completed agents reuse their results`);
		for (const n of info.notes) lines.push(th.fg("warning", `⚠ ${n}`));
		lines.push("");

		if (this.mode === "feedback") {
			this.feedback.focused = this.focused;
			lines.push(section(th, "Tell the agent what to change"));
			lines.push(this.feedback.render(inner)[0] ?? "");
			lines.push(th.fg("dim", "The workflow does not start. The agent gets your note and can revise the script."));
			return box(th, lines, width, {
				title: "Run workflow?",
				footer: hints(th, [
					["enter", "send"],
					["esc", "back"],
				]),
			});
		}

		this.options.forEach((o, i) => {
			const sel = i === this.sel;
			const num = th.fg("dim", `${i + 1}.`);
			lines.push(`${sel ? th.fg("accent", "❯") : " "} ${num} ${sel ? th.fg("accent", th.bold(o.label)) : o.label}`);
		});
		return box(th, lines.slice(0, maxBody), width, {
			title: "Run workflow?",
			right: th.fg("warning", "uses many tokens"),
			footer: hints(th, [
				["↑↓", "select"],
				["enter", "confirm"],
				["v", "script"],
				["ctrl+g", "edit"],
				["tab", "feedback"],
				["esc", "no"],
			]),
		});
	}
}
