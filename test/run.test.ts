import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

function makeRun(source: string, executor: AgentExecutor, extra: Partial<ConstructorParameters<typeof WorkflowRun>[0]> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "wf-test-"));
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
