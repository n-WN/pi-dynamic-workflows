/**
 * Visual preview of the workflow UI without a model.
 *
 *   node dev/preview.ts [outDir] [--light]
 *
 * It runs a fake five-phase workflow (fake agents with delays, tool calls, and
 * failures), drives the real widget, monitor, approval dialog, tool row, and
 * result card through real key input, and writes:
 *   <outDir>/<name>.txt   plain text (no colors), for layout checks
 *   <outDir>/index.html   all captures with colors (screenshot it with a browser)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { addRun, getRegistry } from "../extensions/workflows/registry.ts";
import { resultDetails, resultText, statusText } from "../extensions/workflows/results.ts";
import type { AgentExecutor, AgentPlan, AttemptHandle, AttemptHooks, AttemptOutcome } from "../extensions/workflows/run.ts";
import { WorkflowRun } from "../extensions/workflows/run.ts";
import { prepareScript, scanPlan } from "../extensions/workflows/script.ts";
import type { AgentRecord } from "../extensions/workflows/types.ts";
import { ApprovalDialog, type ApprovalInfo } from "../extensions/workflows/ui/approval.ts";
import { WorkflowMonitor } from "../extensions/workflows/ui/monitor.ts";
import { renderResultMessage, runSummaryLines } from "../extensions/workflows/ui/renderers.ts";
import { WorkflowWidget } from "../extensions/workflows/ui/widget.ts";

const here = dirname(fileURLToPath(import.meta.url));
const light = process.argv.includes("--light");
const outDir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? join(tmpdir(), "wf-preview");
mkdirSync(outDir, { recursive: true });

initTheme(light ? "light" : "dark", false);
// The theme instance lives in an internal module; import it by file path (same module instance).
const themeModule = (await import(
	join(here, "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")
)) as { theme: import("@earendil-works/pi-coding-agent").Theme };
const theme = themeModule.theme;

const SESSION = "preview-session";
const ROWS = 40;
const fakeTui = { terminal: { rows: ROWS, columns: 120 }, requestRender() {} } as unknown as TUI;

// ---------------------------------------------------------------------------
// Fake agents
// ---------------------------------------------------------------------------

const REPORT = `## Findings

The market grew **18%** in 2026. Three vendors hold 71% of the share.

- Regulation: the EU rule starts in March 2027.
- Risk: two sources disagree on the 2025 base value.

| Vendor | Share |
| ------ | ----- |
| Acme   | 34%   |
| Globex | 22%   |
| Initech| 15%   |
`;

interface Behavior {
	delay: number;
	fail?: string;
	value?: unknown;
	tools?: Array<[string, string]>;
}

function behaviorOf(rec: AgentRecord): Behavior {
	const p = rec.prompt;
	if (p.startsWith("Plan")) return { delay: 500, value: { angles: ["market size", "regulation", "vendors", "pricing", "risks"] }, tools: [["web_search", "market size 2026"]] };
	if (p.startsWith("Search")) {
		if (p.includes("pricing")) return { delay: 700, fail: "Gateway 400: the search provider rejected the request." };
		return { delay: 500 + (p.length % 5) * 160, value: [`https://example.com/${p.length}`, `https://news.example.org/${p.length * 3}`], tools: [["web_search", p.slice(7)], ["web_fetch", "https://example.com/a"]] };
	}
	if (p.startsWith("Fetch")) {
		if (p.includes("/27")) return { delay: 2600, value: { claims: ["a slow source"] }, tools: [["web_fetch", p.slice(6)], ["bash", "pdftotext report.pdf -"], ["read", "report.txt"]] };
		return { delay: 350 + (p.length % 7) * 120, value: { claims: [`claim from ${p.slice(6, 40)}`] }, tools: [["web_fetch", p.slice(6)]] };
	}
	if (p.startsWith("Verify")) {
		if (p.endsWith("#3")) return { delay: 400, fail: "The model returned no submit_result call after 3 tries." };
		return { delay: 300 + (p.length % 4) * 100, value: { verdict: "supported", confidence: 0.8 } };
	}
	return { delay: 900, value: REPORT, tools: [["read", "notes/claims.json"], ["write", "report.md"]] };
}

class FakeExecutor implements AgentExecutor {
	plan(run: WorkflowRun, rec: AgentRecord): AgentPlan {
		const modelId = rec.opts.model ?? "ai-gateway-anthropic/claude-fable-5-1";
		return { modelId, thinking: rec.opts.thinking ?? "medium", tools: rec.opts.readOnly ? ["read", "grep", "find", "ls"] : ["read", "bash", "edit", "write", "web_search", "web_fetch"], cwd: run.cwd, retries: 0, prefixKey: "k", data: null };
	}
	start(_run: WorkflowRun, rec: AgentRecord, _plan: AgentPlan, hooks: AttemptHooks): AttemptHandle {
		const b = behaviorOf(rec);
		const timers: Array<ReturnType<typeof setTimeout>> = [];
		let settle!: (o: AttemptOutcome) => void;
		const promise = new Promise<AttemptOutcome>((resolve) => {
			settle = resolve;
		});
		const tools = b.tools ?? [];
		hooks.onFirstToken();
		tools.forEach(([name, summary], i) => {
			const at = Math.floor((b.delay * (i + 0.2)) / (tools.length + 0.5));
			timers.push(
				setTimeout(() => {
					const call = { id: `t${i}`, name, summary, status: "running" as const, startedAt: Date.now(), argsPreview: JSON.stringify({ q: summary }) };
					rec.toolCalls.push(call);
					rec.toolCallCount++;
					rec.activity = `${name}: ${summary}`;
					rec.text = `I check ${summary} now.`;
					hooks.onUsage({ totalTokens: 1800 + (rec.prompt.length % 9) * 400, input: 1500, output: 300 });
					hooks.onChange();
					timers.push(
						setTimeout(() => {
							Object.assign(call, { status: "done", endedAt: Date.now(), resultPreview: `results for ${summary}` });
							hooks.onChange();
						}, Math.max(40, Math.floor(b.delay / (tools.length + 1)) - 20)),
					);
				}, at),
			);
		});
		timers.push(
			setTimeout(() => {
				rec.turns = tools.length + 1;
				hooks.onUsage({ totalTokens: 2400 + (rec.prompt.length % 11) * 300, input: 2000, output: 400 });
				settle(b.fail ? { ok: false, reason: "error", message: b.fail, retryable: false } : { ok: true, value: b.value });
			}, b.delay),
		);
		return {
			promise,
			abort: (reason) => {
				for (const t of timers) clearTimeout(t);
				settle({ ok: false, reason: "aborted", message: String(reason), retryable: false });
			},
			steer: async () => true,
		};
	}
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const RESEARCH = `export const meta = {
  name: "deep-research",
  description: "Research a question across many web sources, cross-check the key claims, and return a cited report",
  phases: ["Scope", "Search", "Fetch", "Verify", "Synthesize"],
}

phase("Scope")
const plan = await agent("Plan the research angles for: " + args.question, { label: "plan angles", schema: { type: "object" } })

phase("Search")
const found = await parallel(plan.angles.map((a) => () => agent("Search " + a, { label: "search: " + a, readOnly: true })))

phase("Fetch")
const urls = [...new Set(found.filter(Boolean).flat())]
const facts = await pipeline(urls, (u) => agent("Fetch " + u, { label: u.replace("https://", ""), phase: "Fetch" }))

phase("Verify")
const claims = facts.filter(Boolean).flatMap((f) => f.claims)
const votes = await parallel(claims.map((c, i) => () => agent("Verify " + c + " #" + i, { label: "verify #" + i, model: "ai-gateway-anthropic/claude-opus-5-5" })))
log(\`\${votes.filter(Boolean).length} of \${claims.length} claims checked\`)

phase("Synthesize")
return await agent("Write the report", { label: "write report", isolation: "worktree" })
`;

const SMALL = `export const meta = { name: "audit-routes", description: "Audit each route file for missing auth checks", phases: ["Audit", "Summarize"] }
phase("Audit")
const r = await parallel(["a", "b", "c"].map((x) => () => agent("Search route " + x, { label: "routes/" + x + ".ts" })))
phase("Summarize")
return await agent("Summarize findings")
`;

const runDirs: string[] = [];

function makeRun(id: string, source: string, args: unknown, maxConcurrency: number): WorkflowRun {
	const dir = mkdtempSync(join(tmpdir(), "wf-preview-run-"));
	runDirs.push(dir);
	const scriptPath = join(dir, "script.js");
	writeFileSync(scriptPath, source);
	const run = new WorkflowRun({
		id,
		prepared: prepareScript(source, scriptPath),
		source: { kind: "inline" },
		sessionId: SESSION,
		cwd: dir,
		runDir: dir,
		scriptPath,
		transcriptDir: join(dir, "agents"),
		args,
		seed: 7,
		env: { cwd: dir, tools: [] },
		limits: { maxConcurrency, maxAgents: 1000, maxItems: 4096 },
		prefixStaggerMs: 0,
		largeWorkflowAgents: 25,
		largeWorkflowTokens: 1_500_000,
		executor: new FakeExecutor(),
	});
	addRun(run);
	return run;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

const captures: Array<{ name: string; width: number; lines: string[] }> = [];

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sequences
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\/g;

function capture(name: string, width: number, lines: string[]): void {
	captures.push({ name, width, lines });
	writeFileSync(join(outDir, `${name}.txt`), `${lines.map((l) => l.replace(ANSI, "")).join("\n")}\n`);
}

function renderComponent(c: Component, width: number): string[] {
	return c.render(width);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 20000): Promise<void> {
	const t0 = Date.now();
	while (!cond()) {
		if (Date.now() - t0 > timeoutMs) throw new Error("preview: condition timed out");
		await sleep(20);
	}
}

const KEY = { enter: "\r", esc: "\x1b", down: "j", up: "k" };

function monitorCaptures(tag: string, run: WorkflowRun, widths: number[]): void {
	for (const width of widths) {
		const m = new WorkflowMonitor(fakeTui, theme, () => {}, {
			sessionId: () => SESSION,
			pastRuns: () => [],
			save: () => "/tmp/x.js",
			saveLocations: () => ({ project: ".pi/workflows/", personal: "~/.pi/agent/workflows/" }),
			openKey: "alt+w",
		});
		m.focused = true;
		capture(`${tag}-monitor-runs-${width}`, width, renderComponent(m, width));
		// The research run is the first row while it runs.
		const runs = [...getRegistry().runs.values()];
		const idx = runs.filter((r) => r.status === "running" || r.status === "paused").includes(run) ? 0 : undefined;
		void idx;
		m.handleInput(KEY.enter);
		capture(`${tag}-monitor-run-${width}`, width, renderComponent(m, width));
		m.handleInput("t");
		capture(`${tag}-monitor-timeline-${width}`, width, renderComponent(m, width));
		m.handleInput("o");
		capture(`${tag}-monitor-timeline-duration-${width}`, width, renderComponent(m, width));
		m.handleInput("?");
		capture(`${tag}-monitor-help-${width}`, width, renderComponent(m, width));
		m.handleInput(KEY.esc);
		m.handleInput(KEY.esc);
		// Phase "Fetch" is the third phase.
		m.handleInput(KEY.down);
		m.handleInput(KEY.down);
		m.handleInput(KEY.enter);
		capture(`${tag}-monitor-phase-${width}`, width, renderComponent(m, width));
		m.handleInput(KEY.enter);
		capture(`${tag}-monitor-agent-${width}`, width, renderComponent(m, width));
		m.dispose();
	}
}

function agentCapture(tag: string, run: WorkflowRun, agentLabel: string, width: number): void {
	const m = new WorkflowMonitor(fakeTui, theme, () => {}, {
		sessionId: () => SESSION,
		pastRuns: () => [],
		save: () => "/tmp/x.js",
		saveLocations: () => ({ project: ".pi/workflows/", personal: "~/.pi/agent/workflows/" }),
		openKey: "alt+w",
	});
	const phases = [...new Set(run.agents.map((a) => a.phase))];
	const target = run.agents.find((a) => a.label === agentLabel);
	if (!target) return m.dispose();
	m.handleInput(KEY.enter);
	for (let i = 0; i < phases.indexOf(target.phase); i++) m.handleInput(KEY.down);
	m.handleInput(KEY.enter);
	const inPhase = run.agents.filter((a) => a.phase === target.phase);
	for (let i = 0; i < inPhase.indexOf(target); i++) m.handleInput(KEY.down);
	m.handleInput(KEY.enter);
	capture(`${tag}-agent-${agentLabel.replace(/[^a-z0-9]+/gi, "-")}-${width}`, width, renderComponent(m, width));
	m.dispose();
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

const small = makeRun("wf-small1", SMALL, undefined, 4);
small.start();
await small.whenEnded();

const research = makeRun("wf-res001", RESEARCH, { question: "How big is the market for agent tooling?" }, 4);

// Approval dialog for the research script.
const info: ApprovalInfo = {
	name: research.name,
	description: research.description,
	phases: research.prepared.meta.phases ?? [],
	source: "written for this task",
	lineCount: research.prepared.lineCount,
	scriptPath: research.scriptPath,
	script: RESEARCH,
	args: research.args,
	limits: "up to 4 at once · at most 1000 per run · guideline: fewer than 10",
	model: "ai-gateway-anthropic/claude-fable-5-1 · thinking medium",
	plan: scanPlan(research.prepared),
	agentTools: ["read", "bash", "edit", "write"],
	named: false,
	edited: false,
	notes: [],
};
for (const width of [80, 120]) {
	const d = new ApprovalDialog(fakeTui, theme, info, () => {});
	capture(`approval-${width}`, width, renderComponent(d, width));
}

research.start();
const widget = new WorkflowWidget(fakeTui, theme, () => SESSION, "alt+w");

await until(() => research.agents.filter((a) => a.phase === "Fetch" && (a.status === "running" || a.status === "done")).length >= 4);
await sleep(250);
for (const width of [60, 90, 130]) capture(`mid-widget-${width}`, width, renderComponent(widget, width));
capture("mid-toolrow-collapsed", 100, runSummaryLines(research, theme, false));
capture("mid-toolrow-expanded", 100, runSummaryLines(research, theme, true));
monitorCaptures("mid", research, [60, 80, 120]);
writeFileSync(join(outDir, "mid-status.txt"), statusText(research));

await research.whenEnded();
await sleep(50);
for (const width of [60, 90, 130]) capture(`end-widget-${width}`, width, renderComponent(widget, width));
capture("end-toolrow-collapsed", 100, runSummaryLines(research, theme, false));
monitorCaptures("end", research, [60, 80, 120]);
agentCapture("end", research, "write report", 100);
agentCapture("end", research, "verify #3", 100);
const card = renderResultMessage({ content: "", details: resultDetails(research) }, { expanded: false, outputPad: 1 }, theme);
capture("end-result-card", 100, renderComponent(card, 100));
writeFileSync(join(outDir, "end-result-text.txt"), resultText(research, 30000));
writeFileSync(join(outDir, "end-status.txt"), statusText(research));
widget.dispose();

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const BASIC = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5", "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

function color256(n: number): string {
	if (n < 16) return BASIC[n];
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `rgb(${v},${v},${v})`;
	}
	const i = n - 16;
	const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
	return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(line: string): string {
	let out = "";
	const st: { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; inverse?: boolean } = {};
	let open = false;
	const flush = () => {
		if (open) out += "</span>";
		const css: string[] = [];
		let fg = st.fg;
		let bg = st.bg;
		if (st.inverse) [fg, bg] = [bg ?? (light ? "#ffffff" : "#1e1e1e"), fg ?? (light ? "#222" : "#d4d4d4")];
		if (fg) css.push(`color:${fg}`);
		if (bg) css.push(`background:${bg}`);
		if (st.bold) css.push("font-weight:bold");
		if (st.dim) css.push("opacity:0.6");
		if (st.italic) css.push("font-style:italic");
		const deco = [st.underline ? "underline" : "", st.strike ? "line-through" : ""].filter(Boolean).join(" ");
		if (deco) css.push(`text-decoration:${deco}`);
		out += `<span style="${css.join(";")}">`;
		open = true;
	};
	flush();
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sequences
	const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\|([^\x1b]+)/g;
	for (const m of line.matchAll(re)) {
		if (m[2] !== undefined) {
			out += esc(m[2]);
			continue;
		}
		if (m[1] === undefined) continue;
		const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i];
			if (c === 0) Object.keys(st).forEach((k) => delete (st as Record<string, unknown>)[k]);
			else if (c === 1) st.bold = true;
			else if (c === 2) st.dim = true;
			else if (c === 3) st.italic = true;
			else if (c === 4) st.underline = true;
			else if (c === 7) st.inverse = true;
			else if (c === 9) st.strike = true;
			else if (c === 22) st.bold = st.dim = false;
			else if (c === 23) st.italic = false;
			else if (c === 24) st.underline = false;
			else if (c === 27) st.inverse = false;
			else if (c === 29) st.strike = false;
			else if (c === 39) st.fg = undefined;
			else if (c === 49) st.bg = undefined;
			else if (c >= 30 && c <= 37) st.fg = BASIC[c - 30];
			else if (c >= 90 && c <= 97) st.fg = BASIC[c - 90 + 8];
			else if (c >= 40 && c <= 47) st.bg = BASIC[c - 40];
			else if (c >= 100 && c <= 107) st.bg = BASIC[c - 100 + 8];
			else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
				const rgb = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
				if (c === 38) st.fg = rgb;
				else st.bg = rgb;
				i += 4;
			} else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
				if (c === 38) st.fg = color256(codes[i + 2]);
				else st.bg = color256(codes[i + 2]);
				i += 2;
			}
		}
		flush();
	}
	if (open) out += "</span>";
	return out;
}

const bg = light ? "#ffffff" : "#1e1e1e";
const fg = light ? "#222222" : "#d4d4d4";
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{background:${bg};color:${fg};font:13px/1.25 Menlo,Monaco,monospace;margin:12px}
h3{font:bold 12px sans-serif;color:#888;margin:14px 0 4px}
pre{margin:0;white-space:pre;font:inherit}
.frame{display:inline-block;border:1px dashed #444;padding:2px}
</style></head><body>
${captures.map((c) => `<h3>${esc(c.name)} (${c.width} columns)</h3><div class="frame"><pre>${c.lines.map(ansiToHtml).join("\n")}</pre></div>`).join("\n")}
</body></html>`;
writeFileSync(join(outDir, "index.html"), html);
for (const c of captures) writeFileSync(join(outDir, `${c.name}.html`), html.replace(/<body>[\s\S]*<\/body>/, `<body><div class="frame"><pre>${c.lines.map(ansiToHtml).join("\n")}</pre></div></body>`));
for (const d of runDirs) rmSync(d, { recursive: true, force: true });
console.log(`${captures.length} captures in ${outDir}`);
process.exit(0);
