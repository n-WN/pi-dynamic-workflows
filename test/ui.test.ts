import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DialogQueue, type DialogRequest, upgradeDialogQueue } from "../extensions/workflows/child-ui.ts";
import { formatSpan, parseTokens } from "../extensions/workflows/format.ts";
import { describeValue, fitResult } from "../extensions/workflows/results.ts";
import { prepareScript, scanPlan } from "../extensions/workflows/script.ts";
import type { AgentRecord, AgentStatus } from "../extensions/workflows/types.ts";
import { emptyUsage } from "../extensions/workflows/types.ts";
import {
	activityTrack,
	hintsFit,
	layoutLine,
	layoutWithRight,
	peakConcurrency,
	phaseState,
	tickStep,
	timelineBar,
} from "../extensions/workflows/ui/draw.ts";
import { keywordHits, styleKeywordHits } from "../extensions/workflows/ui/editor.ts";

/** A theme without colors: the text stays as it is. */
const plain = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;

function agent(id: number, status: AgentStatus, queuedAt: number, startedAt?: number, endedAt?: number): AgentRecord {
	return {
		id,
		label: `a${id}`,
		phase: "P",
		prompt: "x",
		opts: {},
		key: "k",
		groups: [],
		status,
		queuedAt,
		startedAt,
		endedAt,
		attempts: 1,
		tools: [],
		usage: emptyUsage(),
		turns: 0,
		toolCalls: [],
		toolCallCount: 0,
		text: "",
	};
}

test("layoutLine drops or shrinks the lowest-priority part first", () => {
	const parts = [
		{ text: "NAME", priority: 10 },
		{ text: "phase 1/2", priority: 7, shrink: (w: number) => "phase 1/2".slice(0, w).trimEnd(), min: 5 },
		{ text: "==========", priority: 3, shrink: (w: number) => "=".repeat(w), min: 4 },
		{ text: "12k tok", priority: 4 },
		{ text: "2s", priority: 6 },
	];
	assert.equal(layoutLine(parts, 100), "NAME  phase 1/2  ==========  12k tok  2s");
	// The bar shrinks first, then it goes; the tokens go next; the phase stays whole.
	assert.equal(layoutLine(parts, 37), "NAME  phase 1/2  =======  12k tok  2s");
	assert.equal(layoutLine(parts, 30), "NAME  phase 1/2  12k tok  2s");
	assert.equal(layoutLine(parts, 21), "NAME  phase 1/2  2s");
	assert.equal(layoutLine(parts, 16), "NAME  phase 1/2");
	assert.equal(layoutLine(parts, 12), "NAME  phase");
});

test("layoutWithRight shows the right part only when everything else fits", () => {
	const parts = [
		{ text: "left", priority: 9 },
		{ text: "middle", priority: 5 },
	];
	assert.equal(layoutWithRight(parts, "KEY", 20), "left  middle     KEY");
	assert.equal(layoutWithRight(parts, "KEY", 14), "left  middle");
});

test("hintsFit keeps the last hint and adds ? keys", () => {
	const items: Array<[string, string]> = [
		["↑↓", "select"],
		["enter", "open"],
		["t", "timeline"],
		["esc", "close"],
	];
	const all = hintsFit(plain, items, 200);
	assert.equal(all, "↑↓ select · enter open · t timeline · esc close");
	const cut = hintsFit(plain, items, 34);
	assert.ok(cut.endsWith("? keys · esc close"), cut);
	assert.ok(visibleWidth(cut) <= 34);
});

test("activityTrack shows load per column against the capacity", () => {
	const t0 = 0;
	// Two agents run in the first half, one in the second half; capacity 2.
	const agents = [agent(0, "done", 0, 0, 5000), agent(1, "done", 0, 0, 10_000)];
	const track = activityTrack(plain, agents, { t0, t1: 10_000 }, 10, 2, 10_000);
	assert.equal(track, "█████▄▄▄▄▄");
	// An agent that has not started draws nothing.
	assert.equal(activityTrack(plain, [agent(2, "queued", 0)], { t0, t1: 10_000 }, 5, 2, 10_000), "     ");
});

test("timelineBar draws the wait, the run, and reused results", () => {
	const span = { t0: 0, t1: 10_000 };
	assert.equal(timelineBar(plain, agent(0, "done", 0, 3000, 6000), span, 10, 10_000), "···━━━    ");
	assert.equal(timelineBar(plain, agent(1, "running", 0, 0), span, 10, 8000), "━━━━━━━━  ");
	assert.equal(timelineBar(plain, agent(2, "cached", 5000), span, 10, 10_000), "     ↺    ");
	assert.equal(timelineBar(plain, agent(3, "queued", 2000), span, 10, 5000), "  ···     ");
});

test("peak concurrency and tick steps", () => {
	const agents = [agent(0, "done", 0, 0, 10), agent(1, "done", 0, 5, 20), agent(2, "done", 0, 10, 30), agent(3, "cached", 0, 0, 0)];
	assert.equal(peakConcurrency(agents, 100), 2);
	assert.equal(tickStep(60_000, 60), 10_000);
	assert.equal(tickStep(10 * 60_000, 80), 120_000);
});

test("phase state", () => {
	assert.equal(phaseState([], true), "planned");
	assert.equal(phaseState([agent(0, "running", 0, 0)], false), "active");
	assert.equal(phaseState([agent(0, "done", 0, 0, 1)], false), "done");
	assert.equal(phaseState([agent(0, "done", 0, 0, 1), agent(1, "failed", 0, 0, 1)], false), "partial");
	assert.equal(phaseState([agent(1, "failed", 0, 0, 1)], false), "failed");
});

test("the keyword counts outside code, quotes, and /commands", () => {
	const hits = (t: string) => keywordHits(t, "ultracode").length;
	assert.equal(hits("ultracode: audit every route"), 1);
	assert.equal(hits("Please ULTRACODE this"), 1);
	assert.equal(hits('the keyword "ultracode" starts a workflow'), 0);
	assert.equal(hits("the keyword “ultracode” starts a workflow"), 0);
	assert.equal(hits("run `ultracode` or /ultracode"), 0);
	assert.equal(hits("```\nultracode\n```\nthen stop"), 0);
	assert.equal(hits("ultracodes and my-ultracode do not count"), 0);
	assert.equal(styleKeywordHits('"ultracode" then ultracode', "ultracode", (m) => `[${m}]`), '"ultracode" then [ultracode]');
});

test("scanPlan finds agent calls, fan-out, tools, isolation, models, and questions", () => {
	const src = `export const meta = { name: "p", description: "agent() in meta does not count", phases: ["A"] }
const r = await parallel(xs.map((x) => () => agent("look " + x, { readOnly: true, model: "small/model" })))
const w = await agent("write", { isolation: "worktree", tools: ["read", 'web_search'] })
const ok = await ask("Go on?", { options: ["yes", "no"] })
const t = obj.agent("not a call of the global")
return pipeline(r, (v) => agent("x", { model: "small/model" }))`;
	const plan = scanPlan(prepareScript(src, "p.js"));
	assert.deepEqual(plan, {
		agentCalls: 3,
		fanOut: ["parallel", "pipeline"],
		readOnly: 1,
		worktree: 1,
		models: ["small/model"],
		tools: ["read", "web_search"],
		asks: 1,
	});
});

test("fitResult keeps JSON valid and says what it left out", () => {
	const items = Array.from({ length: 50 }, (_, i) => ({ id: i, text: "x".repeat(80) }));
	const a = fitResult(items, 1000);
	const parsed = JSON.parse(a.text) as unknown[];
	assert.ok(parsed.length > 0 && parsed.length < 50);
	assert.match(a.note ?? "", new RegExp(`the first ${parsed.length} of 50 items`));

	const obj = { summary: "short", report: `${"line\n".repeat(400)}`, sources: items };
	const o = fitResult(obj, 1500);
	const po = JSON.parse(o.text) as Record<string, unknown>;
	assert.equal(po.summary, "short");
	assert.ok(typeof po.report === "string" && (po.report as string).length < obj.report.length);
	assert.match(o.note ?? "", /report \(cut/);
	assert.match(o.note ?? "", /sources \(left out: array of 50\)/);

	const s = fitResult(`para one\n\n${"word ".repeat(300)}`, 200);
	assert.ok(s.text.length <= 200 && s.text.endsWith("word"), s.text);
	assert.match(s.note ?? "", /of 1510 characters/);
	assert.equal(fitResult({ a: 1 }, 100).note, undefined);
	assert.equal(describeValue("abc"), "string, 3 characters");
});

test("formatSpan", () => {
	assert.equal(formatSpan(400), "<1s");
	assert.equal(formatSpan(42_500), "42s");
	assert.equal(formatSpan(62_000), "1:02");
	assert.equal(formatSpan(3_723_000), "1:02:03");
});

test("parseTokens", () => {
	assert.equal(parseTokens("500k"), 500_000);
	assert.equal(parseTokens("2M"), 2_000_000);
	assert.equal(parseTokens("1.5m tokens"), 1_500_000);
	assert.equal(parseTokens(" 750000 "), 750_000);
	assert.equal(parseTokens(1234.4), 1234);
	assert.equal(parseTokens("lots"), undefined);
	assert.equal(parseTokens("0"), undefined);
});

test("one answer for every agent of a run that asks the same question", async () => {
	const q = new DialogQueue();
	let shown = 0;
	q.sink = async (req) => {
		shown++;
		return req.kind === "confirm" ? true : "Allow";
	};
	const ask = (agentId: number, title = "Allow bash: npm test?", runId = "wf-1"): DialogRequest => ({ kind: "confirm", title, source: `a${agentId}`, runId, agentId });
	const first = ask(1);
	assert.equal(await q.run(first, async () => undefined, () => undefined), true);
	assert.equal(shown, 1);
	q.remember(first, true);
	const remembered: unknown[] = [];
	const second = { ...ask(2), onRemembered: (a: unknown) => remembered.push(a) };
	assert.equal(await q.run(second, async () => undefined, () => undefined), true);
	assert.equal(shown, 1, "the second agent got the remembered answer");
	assert.deepEqual(remembered, [true]);
	assert.equal(q.timesSeen(second), 2);
	// Another question, another run, or free text: asked again.
	await q.run(ask(3, "Allow bash: rm -rf build?"), async () => undefined, () => undefined);
	await q.run(ask(4, "Allow bash: npm test?", "wf-2"), async () => undefined, () => undefined);
	assert.equal(DialogQueue.keyOf({ kind: "input", title: "x", source: "s", runId: "wf-1" }), undefined);
	assert.equal(shown, 3);
});

test("a dialog queue of an older copy of the extension gets the current methods", async () => {
	// Shape of the queue before remembered answers existed.
	class OldQueue {
		tail: Promise<unknown> = Promise.resolve();
		pending: DialogRequest[] = [];
		sink?: (req: DialogRequest) => Promise<unknown>;
	}
	const old = new OldQueue();
	old.sink = async () => true;
	const q = upgradeDialogQueue(old as unknown as DialogQueue);
	assert.equal(q, old as unknown);
	assert.equal(q instanceof DialogQueue, true);
	const req: DialogRequest = { kind: "confirm", title: "Allow?", source: "a", runId: "wf-1" };
	assert.equal(await q.run(req, async () => undefined, () => undefined), true);
	q.remember(req, true);
	assert.equal(q.timesSeen(req), 1);
	assert.equal(await q.run({ ...req, source: "b" }, async () => undefined, () => undefined), true);
});
