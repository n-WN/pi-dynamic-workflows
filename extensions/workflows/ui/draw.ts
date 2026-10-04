/** Drawing helpers for the workflow UI: fixed-width cells, icons, bars, and boxes. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentCounts } from "../format.ts";
import type { AgentStatus, RunStatus } from "../types.ts";

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
