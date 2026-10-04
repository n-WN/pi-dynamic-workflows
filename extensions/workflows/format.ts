/** Plain-text formatting helpers (no colors). */

import type { AgentRecord, AgentStatus, RunSnapshot, RunStatus } from "./types.ts";

export function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Clock style for columns: 0:42, 12:03, 1:02:03. */
export function formatClock(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}M`;
}

export function formatCost(cost: number): string {
	if (!cost || cost <= 0) return "";
	if (cost < 0.01) return "<$0.01";
	return `$${cost.toFixed(2)}`;
}

export function oneLine(text: string, max = 120): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: `${text.slice(0, max)}\n… (${text.length - max} more characters)`, truncated: true };
}

export function slug(text: string, max = 40): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max) || "agent"
	);
}

/** Default agent label: the first meaningful line of the prompt. */
export function defaultLabel(prompt: string): string {
	const line = prompt.split("\n").find((l) => l.trim()) ?? prompt;
	return oneLine(line, 60);
}

export function summarizeToolArgs(name: string, args: unknown): string {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	switch (name) {
		case "bash":
		case "powershell":
			return oneLine(str(a.command).split("\n")[0] ?? "", 100);
		case "read":
		case "write":
		case "edit":
		case "ls":
			return oneLine(str(a.path) || str(a.file_path) || ".", 100);
		case "grep":
			return oneLine(`${str(a.pattern)}${a.path ? ` in ${str(a.path)}` : ""}`, 100);
		case "find":
			return oneLine(`${str(a.pattern) || str(a.glob)}${a.path ? ` in ${str(a.path)}` : ""}`, 100);
		case "submit_result":
			return "final result";
		default: {
			let json = "";
			try {
				json = JSON.stringify(args) ?? "";
			} catch {
				json = "";
			}
			return oneLine(json, 100);
		}
	}
}

export function previewJson(value: unknown, max = 400): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
	let s = "";
	try {
		s = JSON.stringify(value, null, 2) ?? "";
	} catch {
		s = String(value);
	}
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function statusWord(s: AgentStatus): string {
	switch (s) {
		case "queued":
			return "queued";
		case "starting":
			return "starting";
		case "running":
			return "running";
		case "waiting":
			return "waiting";
		case "done":
			return "done";
		case "cached":
			return "cached";
		case "failed":
			return "failed";
		case "stopped":
			return "stopped";
		case "skipped":
			return "skipped";
	}
}

export function runStatusWord(s: RunStatus): string {
	return s;
}

export interface AgentCounts {
	total: number;
	queued: number;
	active: number;
	done: number;
	cached: number;
	failed: number;
	stopped: number;
	skipped: number;
	waiting: number;
}

export function countAgents(agents: readonly AgentRecord[]): AgentCounts {
	const c: AgentCounts = { total: agents.length, queued: 0, active: 0, done: 0, cached: 0, failed: 0, stopped: 0, skipped: 0, waiting: 0 };
	for (const a of agents) {
		switch (a.status) {
			case "queued":
				c.queued++;
				break;
			case "starting":
			case "running":
				c.active++;
				break;
			case "waiting":
				c.active++;
				c.waiting++;
				break;
			case "done":
				c.done++;
				break;
			case "cached":
				c.cached++;
				break;
			case "failed":
				c.failed++;
				break;
			case "stopped":
				c.stopped++;
				break;
			case "skipped":
				c.skipped++;
				break;
		}
	}
	return c;
}

export function elapsedOf(run: Pick<RunSnapshot, "startedAt" | "endedAt" | "pausedMs">, pausedAt?: number, now = Date.now()): number {
	const end = run.endedAt ?? now;
	const pausedNow = pausedAt && !run.endedAt ? now - pausedAt : 0;
	return Math.max(0, end - run.startedAt - run.pausedMs - pausedNow);
}
