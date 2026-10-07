/** Drawing helpers for the workflow UI: fixed-width cells, icons, bars, and boxes. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type AgentCounts, formatClock } from "../format.ts";
import type { AgentRecord, AgentStatus, QuestionRecord, RunStatus } from "../types.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinner(now = Date.now()): string {
	return SPINNER[Math.floor(now / 90) % SPINNER.length];
}

/** Exactly `width` visible columns: truncated with "…" or padded with spaces. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const t = truncateToWidth(text, width, "…");
	const pad = width - visibleWidth(t);
	return pad > 0 ? t + " ".repeat(pad) : t;
}

/** Right-align in `width` columns. */
export function fitRight(text: string, width: number): string {
	if (width <= 0) return "";
	const t = truncateToWidth(text, width, "…");
	const pad = width - visibleWidth(t);
	return pad > 0 ? " ".repeat(pad) + t : t;
}

/** Left text and right text on one line of `width` columns. */
export function spread(left: string, right: string, width: number): string {
	const rw = visibleWidth(right);
	if (rw >= width) return fit(right, width);
	return fit(left, Math.max(0, width - rw - 1)) + (width - rw - 1 >= 0 ? " " : "") + right;
}

export function agentIcon(theme: Theme, status: AgentStatus, now = Date.now()): string {
	switch (status) {
		case "queued":
			return theme.fg("dim", "·");
		case "starting":
		case "running":
			return theme.fg("accent", spinner(now));
		case "waiting":
			return theme.fg("warning", "?");
		case "done":
			return theme.fg("success", "✓");
		case "cached":
			return theme.fg("muted", "↺");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("warning", "■");
		case "skipped":
			return theme.fg("dim", "–");
	}
}

export function runIcon(theme: Theme, status: RunStatus, now = Date.now()): string {
	switch (status) {
		case "running":
			return theme.fg("accent", spinner(now));
		case "paused":
			return theme.fg("warning", "⏸");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "stopped":
			return theme.fg("warning", "■");
	}
}

export function runStatusColor(status: RunStatus): "accent" | "warning" | "success" | "error" {
	switch (status) {
		case "running":
			return "accent";
		case "paused":
		case "stopped":
			return "warning";
		case "completed":
			return "success";
		case "failed":
			return "error";
	}
}

/**
 * Progress bar: finished (green), failed (red), running (accent), queued (dim).
 * `planned` adds empty room for agents that do not exist yet.
 */
export function progressBar(theme: Theme, c: AgentCounts, width: number, planned = 0): string {
	if (width <= 0) return "";
	const total = Math.max(c.total + planned, 1);
	const seg = (n: number) => Math.round((n / total) * width);
	let ok = seg(c.done + c.cached);
	let bad = seg(c.failed + c.stopped);
	let active = seg(c.active);
	if (c.active > 0 && active === 0) active = 1;
	if (c.failed + c.stopped > 0 && bad === 0) bad = 1;
	const used = ok + bad + active;
	if (used > width) ok = Math.max(0, ok - (used - width));
	const rest = Math.max(0, width - ok - bad - active);
	return (
		theme.fg("success", "━".repeat(ok)) +
		theme.fg("error", "━".repeat(bad)) +
		theme.fg("accent", "━".repeat(active)) +
		theme.fg("dim", "─".repeat(rest))
	);
}

/** Status words in the colors of the progress bar, so the line is also its legend. */
export function countWords(theme: Theme, c: AgentCounts): string {
	const parts: string[] = [];
	if (c.done + c.cached) parts.push(theme.fg("success", `${c.done + c.cached} done${c.cached ? ` (${c.cached} reused)` : ""}`));
	if (c.active) parts.push(theme.fg("accent", `${c.active} running${c.waiting ? ` (${c.waiting} wait for you)` : ""}`));
	if (c.failed) parts.push(theme.fg("error", `${c.failed} failed`));
	if (c.stopped) parts.push(theme.fg("warning", `${c.stopped} stopped`));
	if (c.queued) parts.push(theme.fg("dim", `${c.queued} queued`));
	if (c.skipped) parts.push(theme.fg("dim", `${c.skipped} skipped`));
	return parts.join(theme.fg("dim", " · "));
}

/** Running agents against the concurrency limit: "slots ▮▮▮▯ 3/4". */
export function slotsGauge(theme: Theme, running: number, capacity: number): string {
	const cap = Math.max(1, capacity);
	const used = Math.min(running, cap);
	const cells = cap <= 16 ? theme.fg("accent", "▮".repeat(used)) + theme.fg("dim", "▯".repeat(cap - used)) + " " : "";
	return `${theme.fg("muted", "slots")} ${cells}${theme.fg(running ? "accent" : "dim", `${running}/${cap}`)}`;
}

// ---------------------------------------------------------------------------
// Phase state
// ---------------------------------------------------------------------------

export type PhaseState = "planned" | "empty" | "asks" | "active" | "done" | "partial" | "failed";

/**
 * State of a phase from its agents and questions. A finished phase with some
 * failed agents is "partial" (the script got null for those agents).
 */
export function phaseState(agents: readonly AgentRecord[], planned: boolean, questions: readonly QuestionRecord[] = []): PhaseState {
	if (agents.length === 0) {
		if (questions.some((q) => q.status === "pending")) return "asks";
		if (questions.length) return "done";
		return planned ? "planned" : "empty";
	}
	if (agents.some((a) => a.status === "queued" || a.status === "starting" || a.status === "running" || a.status === "waiting")) return "active";
	const bad = agents.filter((a) => a.status === "failed" || a.status === "stopped").length;
	if (bad === 0) return "done";
	return bad === agents.length ? "failed" : "partial";
}

export function phaseGlyph(theme: Theme, state: PhaseState, now = Date.now()): string {
	switch (state) {
		case "planned":
			return theme.fg("dim", "○");
		case "empty":
			return theme.fg("dim", "·");
		case "asks":
			return theme.fg("warning", "?");
		case "active":
			return theme.fg("accent", spinner(now));
		case "done":
			return theme.fg("success", "✓");
		case "partial":
			return theme.fg("warning", "⚠");
		case "failed":
			return theme.fg("error", "✗");
	}
}

// ---------------------------------------------------------------------------
// Time: activity tracks and the timeline
// ---------------------------------------------------------------------------

const LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

type TrackColor = "accent" | "success" | "error" | "warning" | "muted";

/** Time span of a run for its time axis. */
export function runSpan(run: { startedAt: number; endedAt?: number }, now: number): { t0: number; t1: number } {
	const t0 = run.startedAt;
	const t1 = Math.max(t0 + 1000, run.endedAt ?? now);
	return { t0, t1 };
}

/**
 * How many agents ran in each column of a time axis, as a sparkline.
 * Full height means `capacity` agents at once. A column where an agent failed
 * is red; columns with running agents use the accent color; finished work is green.
 */
export function activityTrack(
	theme: Theme,
	agents: readonly AgentRecord[],
	span: { t0: number; t1: number },
	width: number,
	capacity: number,
	now: number,
): string {
	if (width <= 0) return "";
	const dt = Math.max(1, (span.t1 - span.t0) / width);
	const load = new Array<number>(width).fill(0);
	const color = new Array<TrackColor | undefined>(width).fill(undefined);
	const rank: Record<TrackColor, number> = { muted: 0, success: 1, warning: 2, accent: 3, error: 4 };
	const paint = (i: number, c: TrackColor) => {
		const cur = color[i];
		if (!cur || rank[c] > rank[cur]) color[i] = c;
	};
	for (const a of agents) {
		if (a.startedAt === undefined) continue;
		const live = a.status === "starting" || a.status === "running" || a.status === "waiting";
		const start = Math.max(span.t0, a.startedAt);
		const end = Math.min(span.t1, live ? now : (a.endedAt ?? now));
		if (end <= start) continue;
		const first = Math.min(width - 1, Math.floor((start - span.t0) / dt));
		const last = Math.min(width - 1, Math.floor((end - span.t0 - 1e-6) / dt));
		const base: TrackColor = live ? "accent" : a.status === "done" ? "success" : "muted";
		for (let i = first; i <= last; i++) {
			const c0 = span.t0 + i * dt;
			const overlap = Math.min(end, c0 + dt) - Math.max(start, c0);
			if (overlap > 0) load[i] += overlap / dt;
			paint(i, base);
		}
		if (a.status === "failed") paint(last, "error");
		else if (a.status === "stopped") paint(last, "warning");
	}
	const cap = Math.max(1, capacity);
	let out = "";
	let run = "";
	let runColor: TrackColor | undefined;
	const flush = () => {
		if (run) out += runColor ? theme.fg(runColor, run) : run;
		run = "";
	};
	for (let i = 0; i < width; i++) {
		const v = load[i];
		const ch = v > 0.0001 ? LEVELS[Math.min(7, Math.max(0, Math.ceil((v / cap) * 8) - 1))] : " ";
		const c = v > 0.0001 ? color[i] : undefined;
		if (c !== runColor) {
			flush();
			runColor = c;
		}
		run += ch;
	}
	flush();
	return out;
}

/** Highest number of agents that ran at the same time. */
export function peakConcurrency(agents: readonly AgentRecord[], now: number): number {
	const points: Array<[number, number]> = [];
	for (const a of agents) {
		if (a.startedAt === undefined) continue;
		const live = a.status === "starting" || a.status === "running" || a.status === "waiting";
		const end = live ? now : (a.endedAt ?? now);
		if (end <= a.startedAt) continue;
		points.push([a.startedAt, 1], [end, -1]);
	}
	points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	let cur = 0;
	let peak = 0;
	for (const [, d] of points) {
		cur += d;
		peak = Math.max(peak, cur);
	}
	return peak;
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map((s) => s * 1000);

/** Tick step for a time axis: labels at least `minGap` columns apart. */
export function tickStep(spanMs: number, width: number, minGap = 9): number {
	for (const s of TICK_STEPS) if ((s / spanMs) * width >= minGap) return s;
	return TICK_STEPS[TICK_STEPS.length - 1];
}

/** Two lines: tick labels and a baseline with ┬ marks. */
export function timeAxis(theme: Theme, span: { t0: number; t1: number }, width: number): [string, string] {
	const total = span.t1 - span.t0;
	const step = tickStep(total, width);
	const labels = new Array<string>(width).fill(" ");
	const base = new Array<string>(width).fill("─");
	for (let t = 0; t <= total; t += step) {
		const col = Math.min(width - 1, Math.round((t / total) * width));
		base[col] = "┬";
		const text = formatClock(t);
		if (col + text.length <= width) for (let i = 0; i < text.length; i++) labels[col + i] = text[i];
	}
	return [theme.fg("dim", labels.join("")), theme.fg("borderMuted", base.join(""))];
}

/**
 * One agent on the timeline: dim dots while it waited for a slot, a bar while it
 * ran (colored by its status), ↺ for a result reused from an earlier run.
 */
export function timelineBar(theme: Theme, a: AgentRecord, span: { t0: number; t1: number }, width: number, now: number): string {
	if (width <= 0) return "";
	const dt = Math.max(1, (span.t1 - span.t0) / width);
	const col = (t: number) => Math.max(0, Math.min(width - 1, Math.floor((t - span.t0) / dt)));
	const cells = new Array<string>(width).fill(" ");
	const live = a.status === "starting" || a.status === "running" || a.status === "waiting";
	if (a.status === "cached") {
		cells[col(a.queuedAt)] = theme.fg("muted", "↺");
		return cells.join("");
	}
	const waitEnd = a.startedAt ?? (a.status === "queued" ? now : (a.endedAt ?? now));
	if (waitEnd > a.queuedAt + dt / 2) for (let i = col(a.queuedAt); i <= col(waitEnd - 1); i++) cells[i] = theme.fg("dim", "·");
	if (a.startedAt !== undefined) {
		const end = live ? now : (a.endedAt ?? now);
		const color = live ? (a.status === "waiting" ? "warning" : "accent") : a.status === "done" ? "success" : a.status === "failed" ? "error" : a.status === "stopped" ? "warning" : "muted";
		for (let i = col(a.startedAt); i <= col(Math.max(a.startedAt, end - 1)); i++) cells[i] = theme.fg(color, "━");
	}
	return cells.join("");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LinePart {
	text: string;
	/** Higher stays longer when the line is too wide. */
	priority: number;
	/** Draw the part in fewer columns (down to `min`). */
	shrink?: (width: number) => string;
	min?: number;
}

/**
 * Join parts with `sep`. While the line is too wide, take the lowest-priority part
 * (the rightmost on a tie): shrink it if it can shrink, else leave it out.
 */
export function layoutLine(parts: LinePart[], width: number, sep = "  "): string {
	const items = parts.filter((p) => p.text).map((p) => ({ ...p, w: visibleWidth(p.text) }));
	const sepW = visibleWidth(sep);
	const total = () => items.reduce((s, p) => s + p.w, 0) + Math.max(0, items.length - 1) * sepW;
	while (items.length > 1 && total() > width) {
		let low = 0;
		for (let i = 1; i < items.length; i++) if (items[i].priority <= items[low].priority) low = i;
		const p = items[low];
		const min = p.min ?? 1;
		if (p.shrink && p.w > min) {
			const target = Math.max(min, p.w - (total() - width));
			const next = p.shrink(target);
			const w = visibleWidth(next);
			if (w < p.w) {
				p.text = next;
				p.w = w;
				continue;
			}
		}
		items.splice(low, 1);
	}
	return truncateToWidth(items.map((p) => p.text).join(sep), width, "…");
}

/**
 * `layoutLine` with a right-aligned part that has the lowest priority: it shows
 * only when all other parts fit without shrinking.
 */
export function layoutWithRight(parts: LinePart[], right: string, width: number, sep = "  "): string {
	if (!right) return layoutLine(parts, width, sep);
	const natural = parts.filter((p) => p.text).map((p) => p.text).join(sep);
	if (visibleWidth(natural) + visibleWidth(right) + 2 <= width) return spread(natural, right, width);
	return layoutLine(parts, width, sep);
}

/** Compact counters: "37✓ 3⟳ 2✗ 1⏳". Empty parts are left out. */
export function counters(theme: Theme, c: AgentCounts): string {
	const parts: string[] = [];
	if (c.done + c.cached) parts.push(theme.fg("success", `${c.done + c.cached}✓`));
	if (c.active) parts.push(theme.fg("accent", `${c.active}⟳`));
	if (c.failed) parts.push(theme.fg("error", `${c.failed}✗`));
	if (c.stopped) parts.push(theme.fg("warning", `${c.stopped}■`));
	if (c.queued) parts.push(theme.fg("dim", `${c.queued} queued`));
	return parts.join(" ");
}

export interface BoxOptions {
	title: string;
	right?: string;
	footer?: string;
	/** Inner content height (lines are padded or cut). */
	height?: number;
}

/** A rounded box. Every returned line has exactly `width` columns. */
export function box(theme: Theme, lines: string[], width: number, opts: BoxOptions): string[] {
	const border = (s: string) => theme.fg("borderMuted", s);
	const inner = Math.max(1, width - 4);
	const out: string[] = [];
	const title = ` ${opts.title} `;
	const right = opts.right ? ` ${opts.right} ` : "";
	const topFill = Math.max(0, width - 3 - visibleWidth(title) - visibleWidth(right));
	out.push(
		truncateToWidth(
			border("╭─") + theme.fg("accent", theme.bold(title)) + border("─".repeat(topFill)) + right + border("╮"),
			width,
			"",
		),
	);
	const body = opts.height !== undefined ? lines.slice(0, opts.height) : lines;
	for (const l of body) out.push(`${border("│")} ${fit(l, inner)} ${border("│")}`);
	if (opts.height !== undefined) for (let i = body.length; i < opts.height; i++) out.push(`${border("│")} ${" ".repeat(inner)} ${border("│")}`);
	const footer = opts.footer ? ` ${opts.footer} ` : "";
	const bottomFill = Math.max(0, width - 3 - visibleWidth(footer));
	out.push(truncateToWidth(border("╰─") + theme.fg("dim", footer) + border("─".repeat(bottomFill)) + border("╯"), width, ""));
	return out;
}

/** Key hint: "enter open". */
export function hint(theme: Theme, key: string, what: string): string {
	return `${theme.fg("accent", key)} ${theme.fg("dim", what)}`;
}

export function hints(theme: Theme, items: Array<[string, string]>): string {
	return items.map(([k, w]) => hint(theme, k, w)).join(theme.fg("dim", " · "));
}

/**
 * Key hints that fit in `width`. The first items are the most important; the last
 * item (back or close) always stays. When items are left out, "? keys" is added.
 */
export function hintsFit(theme: Theme, items: Array<[string, string]>, width: number): string {
	if (visibleWidth(hints(theme, items)) <= width || items.length <= 1) return hints(theme, items);
	const last = items[items.length - 1];
	const head = items.slice(0, -1);
	while (head.length) {
		head.pop();
		const line = hints(theme, [...head, ["?", "keys"], last]);
		if (visibleWidth(line) <= width) return line;
	}
	return hints(theme, [["?", "keys"], last]);
}

export function section(theme: Theme, title: string): string {
	return theme.fg("muted", theme.bold(title.toUpperCase()));
}

/** Window of a list around the selected index. */
export function windowAround(total: number, selected: number, height: number): { start: number; end: number } {
	if (total <= height) return { start: 0, end: total };
	let start = Math.max(0, selected - Math.floor(height / 2));
	start = Math.min(start, total - height);
	return { start, end: start + height };
}

export function shortModel(id: string | undefined): string {
	if (!id) return "";
	const slash = id.indexOf("/");
	return slash >= 0 ? id.slice(slash + 1) : id;
}
