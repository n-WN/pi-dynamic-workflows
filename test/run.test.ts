import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentExecutor, AgentPlan, AttemptHandle, AttemptHooks, AttemptOutcome, ReplayData } from "../extensions/workflows/run.ts";
import { WorkflowRun } from "../extensions/workflows/run.ts";
import { prepareScript } from "../extensions/workflows/script.ts";
import type { AgentRecord, JournalEntry } from "../extensions/workflows/types.ts";

interface Behavior {
	delay?: number;
	value?: unknown;
	fail?: string;
	retryable?: boolean;
}

class FakeExecutor implements AgentExecutor {
	started: AgentRecord[] = [];
	running = 0;
	maxRunning = 0;
	behave: (rec: AgentRecord) => Behavior;
	constructor(behave: (rec: AgentRecord) => Behavior) {
		this.behave = behave;
	}
	plan(run: WorkflowRun, rec: AgentRecord): AgentPlan {
		if (rec.opts.model === "nope") throw new Error('model "nope" was not found');
		return { modelId: "fake/model", thinking: "off", tools: [], cwd: run.cwd, retries: rec.opts.retries ?? 0, prefixKey: "k", data: null };
	}
	start(_run: WorkflowRun, rec: AgentRecord, _plan: AgentPlan, hooks: AttemptHooks): AttemptHandle {
		this.started.push(rec);
		this.running++;
		this.maxRunning = Math.max(this.maxRunning, this.running);
		const b = this.behave(rec);
		let timer: ReturnType<typeof setTimeout>;
		let settle!: (o: AttemptOutcome) => void;
		const promise = new Promise<AttemptOutcome>((resolve) => {
			settle = (o) => {
				this.running--;
				resolve(o);
			};
			timer = setTimeout(() => {
				hooks.onFirstToken();
				hooks.onUsage({ totalTokens: 100, input: 60, output: 40 });
				const value = "value" in b ? b.value : `ok:${rec.prompt}`;
				settle(b.fail ? { ok: false, reason: "error", message: b.fail, retryable: !!b.retryable } : { ok: true, value });
			}, b.delay ?? 10);
		});
		return {
			promise,
			abort: (reason) => {
				clearTimeout(timer);
				settle({ ok: false, reason: "aborted", message: reason, retryable: false });
			},
		};
	}
}

const SHARED_CWD = mkdtempSync(join(tmpdir(), "wf-cwd-"));
const TEMP_DIRS: string[] = [SHARED_CWD];
after(async () => {
	// Let late persist timers of ended runs fire first (they write run.json once more).
	await new Promise((r) => setTimeout(r, 1200));
	for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

function makeRun(source: string, executor: AgentExecutor, extra: Partial<ConstructorParameters<typeof WorkflowRun>[0]> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "wf-test-"));
	TEMP_DIRS.push(dir);
	const scriptPath = join(dir, "script.js");
	const prepared = prepareScript(source, scriptPath);
	return new WorkflowRun({
		id: `wf-${Math.random().toString(36).slice(2, 8)}`,
		prepared,
		source: { kind: "inline" },
		sessionId: "test",
		cwd: SHARED_CWD,
		runDir: dir,
		scriptPath,
		transcriptDir: join(dir, "agents"),
		args: undefined,
		seed: 7,
		env: { cwd: dir, tools: [] },
		limits: { maxConcurrency: 2, maxAgents: 1000, maxItems: 4096 },
		prefixStaggerMs: 0,
		largeWorkflowAgents: 25,
		largeWorkflowTokens: 1_500_000,
		executor,
		...extra,
	});
}

const META = `export const meta = { name: "t", description: "test" }\n`;

async function finished(run: WorkflowRun): Promise<WorkflowRun> {
	run.start();
	await run.whenEnded();
	return run;
}

function replayFrom(run: WorkflowRun): ReplayData {
	const replay: ReplayData = { fromRunId: run.id, agents: new Map(), questions: new Map() };
	for (const line of readFileSync(join(run.runDir, "journal.jsonl"), "utf8").split("\n")) {
		if (!line.trim()) continue;
		const e = JSON.parse(line) as JournalEntry;
		if (e.type === "agent") replay.agents.set(e.id, e);
		else replay.questions.set(e.id, e);
	}
	return replay;
}

test("fan-out respects the concurrency limit and returns results in order", async () => {
	const ex = new FakeExecutor(() => ({ delay: 30 }));
	const run = await finished(makeRun(`${META}return await parallel([1,2,3,4,5].map((i) => () => agent("task " + i)))`, ex));
	assert.equal(run.status, "completed");
	assert.deepEqual(run.result, ["ok:task 1", "ok:task 2", "ok:task 3", "ok:task 4", "ok:task 5"]);
	assert.equal(ex.maxRunning, 2);
	assert.equal(run.usage.totalTokens, 500);
	assert.equal(run.agents.every((a) => a.status === "done"), true);
});

test("pipeline stages run per item and null stops an item", async () => {
	const ex = new FakeExecutor((rec) => ({ value: rec.prompt.includes("b") ? null : rec.prompt.toUpperCase() }));
	const run = await finished(
		makeRun(`${META}return await pipeline(["a","b","c"], (x) => agent("first " + x), (prev, x, i) => prev + "/" + x + i)`, ex),
	);
	assert.deepEqual(run.result, ["FIRST A/a0", null, "FIRST C/c2"]);
});

test("phases are scoped to parallel branches", async () => {
	const ex = new FakeExecutor(() => ({}));
	const run = await finished(
		makeRun(
			`${META}phase("A"); await agent("a1"); await parallel([() => { phase("B"); return agent("b1") }, () => agent("a2")]); await agent("a3"); await phase("C", () => agent("c1")); return 1`,
			ex,
		),
	);
	const byPrompt = Object.fromEntries(run.agents.map((a) => [a.prompt, a.phase]));
	assert.deepEqual(byPrompt, { a1: "A", b1: "B", a2: "A", a3: "A", c1: "C" });
	assert.deepEqual(
		run.phases.map((p) => p.title),
		["A", "B", "C"],
	);
});

test("a failed agent resolves to null; onError throw raises an AgentError", async () => {
	const ex = new FakeExecutor((rec) => (rec.prompt === "bad" ? { fail: "provider error 529" } : {}));
	const run = await finished(
		makeRun(
			`${META}const a = await agent("bad"); let e; try { await agent("bad", { onError: "throw" }) } catch (err) { e = err.name + ":" + err.reason + ":" + err.agentId } return { a, e }`,
			ex,
		),
	);
	assert.deepEqual(run.result, { a: null, e: "AgentError:failed:1" });
	assert.equal(run.agents[0].status, "failed");
	assert.match(run.agents[0].error ?? "", /529/);
});

test("retries run a failed attempt again", async () => {
	let n = 0;
	const ex = new FakeExecutor(() => (n++ === 0 ? { fail: "flaky", retryable: true } : { value: "second try" }));
	const run = await finished(makeRun(`${META}return await agent("x", { retries: 1 })`, ex));
	assert.equal(run.result, "second try");
	assert.equal(run.agents[0].attempts, 2);
});

test("resume reuses completed agents up to the first changed or unfinished one", async () => {
	const script = `${META}const a = await agent("A"); const b = await agent("B"); const c = await agent("C"); return [a, b, c]`;
	const ex1 = new FakeExecutor((rec) => (rec.prompt === "B" ? { fail: "boom" } : {}));
	const first = await finished(makeRun(script, ex1));
	assert.deepEqual(first.result, ["ok:A", null, "ok:C"]);

	const ex2 = new FakeExecutor(() => ({}));
	const second = await finished(makeRun(script, ex2, { replay: replayFrom(first), resumedFrom: first.id }));
	assert.deepEqual(second.result, ["ok:A", "ok:B", "ok:C"]);
	assert.equal(second.agents[0].status, "cached");
	// B failed before, so B and everything after it ran again (C too, though it had completed).
	assert.deepEqual(
		ex2.started.map((r) => r.prompt),
		["B", "C"],
	);

	// An edited prompt invalidates from that agent on.
	const ex3 = new FakeExecutor(() => ({}));
	const edited = script.replace('agent("A")', 'agent("A2")');
	const third = await finished(makeRun(edited, ex3, { replay: replayFrom(second) }));
	assert.deepEqual(
		ex3.started.map((r) => r.prompt),
		["A2", "B", "C"],
	);
	assert.deepEqual(third.result, ["ok:A2", "ok:B", "ok:C"]);
});

test("resume keeps the results of parallel siblings of a failed agent", async () => {
	const script = `${META}const r = await parallel([() => agent("A"), () => agent("B"), () => agent("C")]); const d = await agent("D"); return [...r, d]`;
	const first = await finished(makeRun(script, new FakeExecutor((rec) => (rec.prompt === "B" ? { fail: "rate limit" } : {}))));
	assert.deepEqual(first.result, ["ok:A", null, "ok:C", "ok:D"]);
	const ex = new FakeExecutor(() => ({}));
	const second = await finished(makeRun(script, ex, { replay: replayFrom(first) }));
	assert.deepEqual(second.result, ["ok:A", "ok:B", "ok:C", "ok:D"]);
	// A and C did not depend on B; D was called after B's result, so it runs again.
	assert.deepEqual(
		ex.started.map((r) => r.prompt),
		["B", "D"],
	);
	assert.deepEqual(
		second.agents.map((a) => a.status),
		["cached", "done", "cached", "done"],
	);
});

test("race returns the first acceptable value and stops the other agents", async () => {
	const ex = new FakeExecutor((rec) => ({ delay: rec.prompt === "slow" ? 2000 : 20 }));
	const run = await finished(makeRun(`${META}return await race([() => agent("slow"), () => agent("fast")])`, ex));
	assert.deepEqual(run.result, { index: 1, value: "ok:fast" });
	const slow = run.agents.find((a) => a.prompt === "slow");
	assert.equal(slow?.status, "skipped");
});

test("stop ends the run and stops running agents", async () => {
	const ex = new FakeExecutor(() => ({ delay: 5000 }));
	const run = makeRun(`${META}return await parallel([() => agent("a"), () => agent("b"), () => agent("c")])`, ex);
	run.start();
	await new Promise((r) => setTimeout(r, 100));
	run.stop();
	await run.whenEnded();
	assert.equal(run.status, "stopped");
	assert.deepEqual(
		run.agents.map((a) => a.status),
		["stopped", "stopped", "skipped"],
	);
});

test("pause holds new agents until resume", async () => {
	const ex = new FakeExecutor(() => ({ delay: 50 }));
	const run = makeRun(`${META}return await parallel([1,2,3,4].map((i) => () => agent("t" + i)))`, ex);
	run.start();
	for (let i = 0; i < 200 && ex.started.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
	run.pause();
	await new Promise((r) => setTimeout(r, 200));
	try {
		assert.equal(ex.started.length, 2, "only the two that started before the pause ran");
	} catch (err) {
		run.stop();
		throw err;
	}
	run.resume();
	await run.whenEnded();
	assert.equal(run.status, "completed");
	assert.equal(ex.started.length, 4);
});

test("script errors report the script line", async () => {
	const run = await finished(makeRun(`${META}\nconst x = null\nreturn x.field`, new FakeExecutor(() => ({}))));
	assert.equal(run.status, "failed");
	assert.match(run.error ?? "", /TypeError/);
	assert.equal(run.errorLine, 4);
});

test("bad options and the agent limit throw inside the script", async () => {
	const run = await finished(
		makeRun(
			`${META}const out = []; try { await agent("x", { model: "nope" }) } catch (e) { out.push(e.message) } try { agent("x", { colour: 1 }) } catch (e) { out.push(e.message) } await agent("1"); await agent("2"); try { await agent("3") } catch (e) { out.push(e.message) } return out`,
			new FakeExecutor(() => ({})),
			{ limits: { maxConcurrency: 2, maxAgents: 2, maxItems: 4096 } },
		),
	);
	const out = run.result as string[];
	assert.match(out[0], /model "nope" was not found/);
	assert.match(out[1], /unknown option "colour"/);
	assert.match(out[2], /limit of 2 agents/);
});

test("ask() returns the default without a human and the answer with one", async () => {
	const noUi = await finished(makeRun(`${META}return await ask("Proceed?", { options: ["yes", "no"], default: "no" })`, new FakeExecutor(() => ({}))));
	assert.equal(noUi.result, "no");

	const run = makeRun(`${META}return await ask("Proceed?", { options: ["yes", "no"], default: "no" })`, new FakeExecutor(() => ({})));
	run.subscribe({ canAsk: () => true, onQuestion: (r, q) => setTimeout(() => r.answerQuestion(q.id, "yes"), 20) });
	await finished(run);
	assert.equal(run.result, "yes");
	assert.equal(run.questions[0].answeredBy, "human");
});

test("clock and random restrictions, seeded random", async () => {
	const run = await finished(
		makeRun(
			`${META}const out = []; const D = Date; try { D["now"]() } catch (e) { out.push("now") } try { new D() } catch (e) { out.push("new") } out.push(new Date(0).toISOString()); out.push(random() === random() ? "same" : "differs"); return out`,
			new FakeExecutor(() => ({})),
		),
	);
	assert.deepEqual(run.result, ["now", "new", "1970-01-01T00:00:00.000Z", "differs"]);
});

test("a promise that never settles fails the run", { timeout: 10_000 }, async () => {
	const run = await finished(makeRun(`${META}await new Promise(() => {}); return 1`, new FakeExecutor(() => ({}))));
	assert.equal(run.status, "failed");
	assert.match(run.error ?? "", /never settle/);
});

test("the result must be JSON data", async () => {
	const run = await finished(makeRun(`${META}const o = {}; o.self = o; return o`, new FakeExecutor(() => ({}))));
	assert.equal(run.status, "failed");
	assert.match(run.error ?? "", /not JSON data/);
});

// ---------------------------------------------------------------------------
// Replay by inputs, compatibility, budget, stalls, timers, hardening
// ---------------------------------------------------------------------------

test("resume matches by inputs: a changed pipeline order keeps completed stage-2 results", async () => {
	const script = `${META}return await pipeline(["A", "B"], (x) => agent("s1 " + x), (r, x) => agent("s2 " + x))`;
	// Run 1: s1 A is slow, so B reaches stage 2 first; s2 A fails.
	const first = await finished(makeRun(script, new FakeExecutor((rec) => (rec.prompt === "s1 A" ? { delay: 80 } : rec.prompt === "s2 A" ? { fail: "boom" } : {}))));
	assert.deepEqual(
		first.agents.map((a) => a.prompt),
		["s1 A", "s1 B", "s2 B", "s2 A"],
	);
	const ex = new FakeExecutor(() => ({}));
	const second = await finished(makeRun(script, ex, { replay: replayFrom(first) }));
	// In run 2 the cached stage-1 results arrive in call order, so s2 A is called before s2 B.
	assert.deepEqual(
		ex.started.map((r) => r.prompt),
		["s2 A"],
	);
	assert.deepEqual(second.result, ["ok:s2 A", "ok:s2 B"]);
});

test("identical calls take saved results in order; a changed prompt runs again", async () => {
	const script = `${META}const a = await parallel([() => agent("same"), () => agent("same"), () => agent("other")]); return a`;
	const first = await finished(makeRun(script, new FakeExecutor(() => ({}))));
	const ex = new FakeExecutor(() => ({}));
	const edited = script.replace('agent("other")', 'agent("other 2")');
	const second = await finished(makeRun(edited, ex, { replay: replayFrom(first) }));
	assert.deepEqual(
		ex.started.map((r) => r.prompt),
		["other 2"],
	);
	assert.deepEqual(
		second.agents.map((a) => a.status),
		["cached", "cached", "done"],
	);
});

test("pipeline: every stage gets (previous, item, index); stage 1 gets the item as previous", async () => {
	const run = await finished(makeRun(`${META}return await pipeline(["a", "b"], (p, x, i) => p + ":" + x + ":" + i, (p, x, i) => p + "|" + i)`, new FakeExecutor(() => ({}))));
	assert.deepEqual(run.result, ["a:a:0|0", "b:b:1|1"]);
});

test("a task that throws at once rejects parallel(); it does not throw synchronously", async () => {
	const run = await finished(
		makeRun(
			`${META}let threw = false; let p
try { p = parallel([() => { throw new Error("boom") }]) } catch (e) { threw = true }
let message = null
try { await p } catch (e) { message = e.message }
return { threw, message }`,
			new FakeExecutor(() => ({})),
		),
	);
	assert.deepEqual(run.result, { threw: false, message: "boom" });
});

test("meta.phases objects: titles, details, and a default model per phase", async () => {
	const ex = new FakeExecutor(() => ({}));
	const script = `export const meta = { name: "t", description: "test", phases: [{ title: "Find", detail: "list files", model: "small/model" }, "Fix"] }
phase("Find"); const a = await agent("x"); const b = await agent("y", { model: "big/model" })
phase("Fix"); const c = await agent("z")
return [a, b, c]`;
	const run = await finished(makeRun(script, ex));
	assert.deepEqual(run.prepared.meta.phases, ["Find", "Fix"]);
	assert.equal(run.prepared.meta.phaseInfo?.[0].detail, "list files");
	assert.deepEqual(
		run.agents.map((a) => a.opts.model),
		["small/model", "big/model", undefined],
	);
});

test("effort is another name of thinking; options of other runtimes explain what to use", async () => {
	const ex = new FakeExecutor(() => ({}));
	const run = await finished(
		makeRun(
			`${META}const opts = { effort: "low" }; await agent("x", opts)
let msg = null; try { await agent("y", { agentType: "Explore" }) } catch (e) { msg = e.message }
return { msg, kept: Object.keys(opts) }`,
			ex,
		),
	);
	assert.equal(run.agents[0].opts.thinking, "low");
	assert.equal("effort" in run.agents[0].opts, false);
	const out = run.result as { msg: string; kept: string[] };
	assert.match(out.msg, /agentType" does not exist here: pi has no agent types/);
	assert.deepEqual(out.kept, ["effort"]);
});

test("token budget: the run pauses and asks; a raised budget goes on", async () => {
	const script = `${META}const out = []; for (const i of [1, 2, 3, 4]) out.push(await agent("step " + i)); return out`;
	const run = makeRun(script, new FakeExecutor(() => ({})), { tokenBudget: 250 });
	const asked: string[] = [];
	run.subscribe({
		canAsk: () => true,
		onQuestion: (r, q) => {
			asked.push(q.question);
			// The main agent cannot raise it; the human can.
			assert.equal(r.answerQuestion(q.id, q.options?.[1] ?? null, "agent"), false);
			setTimeout(() => r.answerQuestion(q.id, q.options?.[1] ?? null, "human"), 20);
		},
	});
	await finished(run);
	assert.equal(run.status, "completed");
	assert.equal((run.result as unknown[]).length, 4);
	assert.equal(asked.length, 1);
	assert.match(asked[0], /used its token budget: 300 of 250 tokens/);
	assert.equal(run.tokenLimit, 500);
	assert.equal(run.questions[0].kind, "budget");
	assert.equal(run.questions[0].answeredBy, "human");
	// Budget questions are not part of the replay journal.
	assert.equal(readFileSync(join(run.runDir, "journal.jsonl"), "utf8").includes('"type":"question"'), false);
});

test("token budget without a human: the run stops at the limit", async () => {
	const script = `${META}const out = []; for (const i of [1, 2, 3, 4]) out.push(await agent("step " + i)); return out`;
	const ex = new FakeExecutor(() => ({}));
	const run = await finished(makeRun(script, ex, { tokenBudget: 250 }));
	assert.equal(run.status, "stopped");
	assert.match(run.error ?? "", /token budget of 250 tokens/);
	assert.equal(ex.started.length, 3);
});

test("budget in the script: total, spent(), remaining()", async () => {
	const run = await finished(
		makeRun(`${META}await agent("x"); return { total: budget.total, spent: budget.spent(), remaining: budget.remaining() }`, new FakeExecutor(() => ({})), { tokenBudget: 1000 }),
	);
	assert.deepEqual(run.result, { total: 1000, spent: 100, remaining: 900 });
});

test("a stalled agent is aborted and starts again once, then fails", async () => {
	const ex = new FakeExecutor(() => ({ delay: 10_000 }));
	const run = await finished(makeRun(`${META}return await agent("hangs")`, ex, { stallMs: 120 }));
	assert.equal(run.result, null);
	const rec = run.agents[0];
	assert.equal(rec.status, "failed");
	assert.equal(rec.attempts, 2);
	assert.equal(rec.stalls, 2);
	assert.match(rec.error ?? "", /no activity for 0s \(stalled\)/);
	assert.ok(run.logs.some((l) => l.text.includes("It starts again once")));
});

test("setTimeout and clearTimeout; a timer keeps the script alive", async () => {
	const run = await finished(
		makeRun(
			`${META}const fired = []; setTimeout((x) => fired.push(x), 20, "a"); const id = setTimeout(() => fired.push("b"), 20); clearTimeout(id)
await new Promise((r) => setTimeout(r, 60)); return fired`,
			new FakeExecutor(() => ({})),
		),
	);
	assert.equal(run.status, "completed");
	assert.deepEqual(run.result, ["a"]);
});

test("hardening: no eval, guards cannot be replaced, no shared memory", async () => {
	const run = await finished(
		makeRun(
			`${META}const r = {}
try { eval("1"); r.eval = "ran" } catch (e) { r.eval = e.name }
try { new Function("return 1"); r.fn = "ran" } catch (e) { r.fn = e.name }
// The static check rejects Math.random; reach the runtime guard through a computed key.
Math["random"] = () => 0.5
try { Math["random"](); r.random = "replaced" } catch (e) { r.random = "guarded" }
Error.prepareStackTrace = () => "x"
r.stackHook = typeof Error.prepareStackTrace
r.wasm = typeof WebAssembly
r.atomics = typeof Atomics
return r`,
			new FakeExecutor(() => ({})),
		),
	);
	assert.deepEqual(run.result, { eval: "EvalError", fn: "EvalError", random: "guarded", stackHook: "undefined", wasm: "undefined", atomics: "undefined" });
});

test("token budget: no question when the script needs no new agent", async () => {
	const run = makeRun(`${META}return [await agent("a"), await agent("b"), await agent("c")]`, new FakeExecutor(() => ({})), { tokenBudget: 250 });
	let asked = 0;
	run.subscribe({ canAsk: () => true, onQuestion: () => asked++ });
	await finished(run);
	// The third agent goes over the limit, but nothing new would start after it.
	assert.equal(run.status, "completed");
	assert.equal(asked, 0);
	assert.equal(run.usage.totalTokens, 300);
});
