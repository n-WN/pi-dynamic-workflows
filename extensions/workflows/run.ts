/**
 * WorkflowRun: one execution of a workflow script.
 *
 * The run owns the script worker and the agent queue. It answers each agent()
 * call from the replay cache or by starting an agent attempt through the
 * AgentExecutor, keeps all state as plain data for the UI, and persists it.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countAgents, defaultLabel, elapsedOf } from "./format.ts";
import { type CallScope, ScriptHost, type SerializedError } from "./sandbox.ts";
import type { PreparedScript } from "./script.ts";
import {
	AGENT_FINAL,
	type AgentCallOptions,
	type AgentRecord,
	addUsage,
	emptyUsage,
	type JournalEntry,
	type LogEntry,
	type PhaseRecord,
	type QuestionRecord,
	type RunSnapshot,
	type RunStatus,
	type UsageTotals,
	type WorkflowSource,
	type WorktreeInfo,
} from "./types.ts";

export const DEFAULT_PHASE = "Agents";

export type AbortReason = "stopped" | "restart" | "timeout" | "cancelled" | "run-ended";

export type AttemptOutcome =
	| { ok: true; value: unknown; worktree?: WorktreeInfo }
	| {
			ok: false;
			reason: "error" | "aborted" | "timeout" | "max_turns" | "validation";
			message: string;
			retryable: boolean;
			worktree?: WorktreeInfo;
	  };

export interface AttemptHooks {
	/** Record fields changed (activity, tool calls, text). */
	onChange(): void;
	/** Usage of one finished model response. */
	onUsage(usage: Partial<UsageTotals>): void;
	/** The first response token arrived (releases agents held for the prompt cache). */
	onFirstToken(): void;
}

export interface AttemptHandle {
	promise: Promise<AttemptOutcome>;
	abort(reason: AbortReason): void;
	/** Send a message to the running agent. Resolves false when it cannot take one now. */
	steer?(text: string, by: "human" | "agent"): Promise<boolean>;
}

/** What one agent call resolves to before it runs. */
export interface AgentPlan {
	modelId: string;
	thinking: string;
	tools: string[];
	cwd: string;
	retries: number;
	/** Agents with the same key share a prompt-cache prefix. */
	prefixKey: string;
	/** Extra data the executor needs (model object, schema, ...). */
	data: unknown;
}

export interface AgentExecutor {
	/** Validate and resolve options. Throw an Error with a clear message for bad options. */
	plan(run: WorkflowRun, rec: AgentRecord): AgentPlan;
	start(run: WorkflowRun, rec: AgentRecord, plan: AgentPlan, hooks: AttemptHooks): AttemptHandle;
}

export interface RunHooks {
	/** Any state change. Consumers throttle. */
	onChange?(run: WorkflowRun): void;
	onEnd?(run: WorkflowRun): void;
	onQuestion?(run: WorkflowRun, q: QuestionRecord): void;
	/** A question got an answer (from anyone), or the run ended while it waited. */
	onQuestionClosed?(run: WorkflowRun, q: QuestionRecord): void;
	onWarning?(run: WorkflowRun, text: string): void;
	/** Whether a human can answer ask() now. False: ask() returns its default at once. */
	canAsk?(): boolean;
}

export interface ReplayData {
	fromRunId: string;
	agents: Map<number, Extract<JournalEntry, { type: "agent" }>>;
	questions: Map<number, Extract<JournalEntry, { type: "question" }>>;
}

export interface WorkflowRunInit {
	id: string;
	prepared: PreparedScript;
	source: WorkflowSource;
	sessionId: string;
	cwd: string;
	runDir: string;
	scriptPath: string;
	transcriptDir: string;
	args: unknown;
	seed: number;
	env: Record<string, unknown>;
	limits: { maxConcurrency: number; maxAgents: number; maxItems: number };
	prefixStaggerMs: number;
	largeWorkflowAgents: number;
	largeWorkflowTokens: number;
	targetAgents?: number;
	executor: AgentExecutor;
	replay?: ReplayData;
	resumedFrom?: string;
	foreground?: boolean;
}

interface PendingCall {
	callId: number;
	onError: "null" | "throw";
	isolation: boolean;
}

interface LiveAttempt {
	handle: AttemptHandle;
	reason?: AbortReason;
}

const MAX_LOGS = 400;

function hashKey(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export class WorkflowRun {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly prepared: PreparedScript;
	readonly source: WorkflowSource;
	readonly sessionId: string;
	readonly cwd: string;
	readonly runDir: string;
	readonly scriptPath: string;
	readonly transcriptDir: string;
	readonly args: unknown;
	readonly seed: number;
	readonly env: Record<string, unknown>;
	readonly limits: { maxConcurrency: number; maxAgents: number; maxItems: number };
	readonly createdAt = Date.now();
	readonly resumedFrom?: string;
	readonly targetAgents?: number;

	status: RunStatus = "running";
	startedAt = Date.now();
	endedAt?: number;
	pausedMs = 0;
	pausedAt?: number;
	phases: PhaseRecord[] = [];
	agents: AgentRecord[] = [];
	logs: LogEntry[] = [];
	logCount = 0;
	questions: QuestionRecord[] = [];
	usage: UsageTotals = emptyUsage();
	result?: unknown;
	error?: string;
	errorLine?: number;
	warnings: string[] = [];
	foreground: boolean;
	delivered = false;
	/** Arbitrary data the extension keeps per run (for example a parent tool context). */
	attachments = new Map<string, unknown>();

	private readonly executor: AgentExecutor;
	private readonly hooks = new Set<RunHooks>();
	private readonly replay?: ReplayData;
	/** Fallback for journals without dependency data: the prefix rule. */
	private diverged = false;
	private questionsDiverged = false;
	/** Number of agent results delivered to the script so far. */
	private settledSeq = 0;
	/** Replay decision per agent id: reused its saved result, or ran live. */
	private readonly replayDecision = new Map<number, "reused" | "live">();
	private replayNotes = 0;
	private host?: ScriptHost;
	private readonly queue: number[] = [];
	private readonly running = new Set<number>();
	private readonly attempts = new Map<number, LiveAttempt>();
	private readonly plans = new Map<number, AgentPlan>();
	private readonly pendingCalls = new Map<number, PendingCall>();
	private readonly pendingQuestions = new Map<number, { callId: number; timer?: ReturnType<typeof setTimeout> }>();
	private readonly cancelledGroups = new Set<number>();
	private readonly warming = new Map<string, { promise: Promise<void>; release: () => void }>();
	private readonly prefixStaggerMs: number;
	private readonly largeWorkflowAgents: number;
	private readonly largeWorkflowTokens: number;
	private persistTimer?: ReturnType<typeof setTimeout>;
	private endPromise: Promise<void>;
	private resolveEnd!: () => void;

	constructor(init: WorkflowRunInit) {
		this.id = init.id;
		this.prepared = init.prepared;
		this.name = init.prepared.meta.name;
		this.description = init.prepared.meta.description;
		this.source = init.source;
		this.sessionId = init.sessionId;
		this.cwd = init.cwd;
		this.runDir = init.runDir;
		this.scriptPath = init.scriptPath;
		this.transcriptDir = init.transcriptDir;
		this.args = init.args;
		this.seed = init.seed;
		this.env = init.env;
		this.limits = init.limits;
		this.executor = init.executor;
		this.replay = init.replay;
		this.resumedFrom = init.resumedFrom;
		this.foreground = init.foreground ?? false;
		this.prefixStaggerMs = init.prefixStaggerMs;
		this.largeWorkflowAgents = init.largeWorkflowAgents;
		this.largeWorkflowTokens = init.largeWorkflowTokens;
		this.targetAgents = init.targetAgents;
		for (const title of init.prepared.meta.phases ?? []) this.phases.push({ title, planned: true });
		this.endPromise = new Promise((resolve) => {
			this.resolveEnd = resolve;
		});
	}

	// -------------------------------------------------------------------------
	// Subscriptions
	// -------------------------------------------------------------------------

	subscribe(hooks: RunHooks): () => void {
		this.hooks.add(hooks);
		return () => this.hooks.delete(hooks);
	}

	private emitChange(): void {
		for (const h of this.hooks) h.onChange?.(this);
		this.schedulePersist();
	}

	/** Resolves when the run reaches a final status. */
	whenEnded(): Promise<void> {
		return this.endPromise;
	}

	get isFinal(): boolean {
		return this.status === "completed" || this.status === "failed" || this.status === "stopped";
	}

	get isPaused(): boolean {
		return this.status === "paused";
	}

	elapsedMs(now = Date.now()): number {
		return elapsedOf(this, this.pausedAt, now);
	}

	/** Milliseconds since the script last answered, while the script should be idle-able. */
	scriptBusyMs(now = Date.now()): number {
		if (!this.host?.running) return 0;
		return now - this.host.lastHeartbeat;
	}

	get pendingQuestionList(): QuestionRecord[] {
		return this.questions.filter((q) => q.status === "pending");
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	start(): void {
		mkdirSync(this.transcriptDir, { recursive: true });
		this.persistNow();
		this.host = new ScriptHost(
			{
				body: this.prepared.body,
				filename: this.scriptPath,
				args: this.args,
				env: this.env,
				seed: this.seed,
				maxItems: this.limits.maxItems,
				budget: this.budget(),
			},
			{
				onCall: (id, op, payload, scope) => this.onCall(id, op, payload, scope),
				onPost: (kind, payload, scope) => this.onPost(kind, payload, scope),
				onDone: (value) => this.onScriptDone(value),
				onError: (err) => this.onScriptError(err),
			},
		);
		this.host.start();
		this.emitChange();
	}

	pause(): void {
		if (this.status !== "running") return;
		this.status = "paused";
		this.pausedAt = Date.now();
		this.log("info", "Paused: running agents finish; no new agents start.");
		this.emitChange();
	}

	resume(): void {
		if (this.status !== "paused") return;
		this.pausedMs += Date.now() - (this.pausedAt ?? Date.now());
		this.pausedAt = undefined;
		this.status = "running";
		this.log("info", "Resumed.");
		this.pump();
		this.emitChange();
	}

	togglePause(): void {
		if (this.status === "paused") this.resume();
		else this.pause();
	}

	/** Stop the whole run. Completed agent results stay in the journal for a relaunch. */
	stop(why = "Stopped by the user."): void {
		if (this.isFinal) return;
		this.finish("stopped", { error: why });
	}

	stopAgent(id: number): boolean {
		const rec = this.agents[id];
		if (!rec || AGENT_FINAL.has(rec.status)) return false;
		if (rec.status === "queued") {
			this.removeFromQueue(id);
			rec.status = "stopped";
			rec.error = "Stopped by the user before it started.";
			rec.endedAt = Date.now();
			this.respondFailure(rec, "stopped");
			this.journalAgent(rec);
			this.emitChange();
			return true;
		}
		const live = this.attempts.get(id);
		if (!live) {
			// Held before its first attempt (prompt-cache stagger).
			this.running.delete(id);
			rec.status = "stopped";
			rec.error = "Stopped by the user before it started.";
			rec.endedAt = Date.now();
			rec.activity = undefined;
			this.respondFailure(rec, "stopped");
			this.journalAgent(rec);
			this.pump();
			this.emitChange();
			return true;
		}
		live.reason = "stopped";
		live.handle.abort("stopped");
		return true;
	}

	restartAgent(id: number): boolean {
		const rec = this.agents[id];
		if (!rec) return false;
		const live = this.attempts.get(id);
		if (!live || AGENT_FINAL.has(rec.status)) return false;
		live.reason = "restart";
		live.handle.abort("restart");
		this.log("info", `Restarting agent #${id} (${rec.label}).`);
		return true;
	}

	/** Send a correction or extra instruction to a running agent. */
	async steerAgent(id: number, text: string, by: "human" | "agent" = "human"): Promise<boolean> {
		const rec = this.agents[id];
		const live = this.attempts.get(id);
		if (!rec || !live?.handle.steer || !text.trim()) return false;
		const ok = await live.handle.steer(text.trim(), by);
		if (ok) {
			rec.steers = [...(rec.steers ?? []), { t: Date.now(), by, text: text.trim() }];
			this.log("info", `Message to agent #${id} (${rec.label}) from the ${by === "human" ? "user" : "main agent"}: ${text.trim().slice(0, 200)}`);
			this.emitChange();
		}
		return ok;
	}

	answerQuestion(qid: number, answer: string | null, by: QuestionRecord["answeredBy"] = "human"): boolean {
		const q = this.questions[qid];
		const pending = this.pendingQuestions.get(qid);
		if (!q || q.status !== "pending" || !pending) return false;
		if (pending.timer) clearTimeout(pending.timer);
		this.pendingQuestions.delete(qid);
		q.status = by === "default" ? "defaulted" : "answered";
		q.answer = answer;
		q.answeredBy = by;
		q.answeredAt = Date.now();
		this.journal({ type: "question", id: q.id, question: q.question, answer });
		this.host?.resolve(pending.callId, answer);
		for (const h of this.hooks) h.onQuestionClosed?.(this, q);
		this.emitChange();
		return true;
	}

	// -------------------------------------------------------------------------
	// Script messages
	// -------------------------------------------------------------------------

	private onCall(callId: number, op: string, payload: unknown, scope: CallScope): void {
		if (this.isFinal) return;
		if (op === "agent") this.onAgentCall(callId, payload as { prompt: string; opts: AgentCallOptions }, scope);
		else if (op === "ask") this.onAsk(callId, payload as { question: string; options?: string[]; default: string | null; timeout?: number }, scope);
		else this.host?.reject(callId, { name: "Error", message: `Unknown operation ${op}` });
	}

	private onPost(kind: string, payload: unknown, scope: CallScope): void {
		if (this.isFinal) return;
		if (kind === "log") {
			const p = payload as { level?: LogEntry["level"]; text?: string };
			this.log(p.level ?? "info", String(p.text ?? ""));
		} else if (kind === "phase") {
			const p = payload as { title?: string };
			if (p.title) this.touchPhase(p.title);
			this.emitChange();
		} else if (kind === "cancelGroups") {
			const p = payload as { groups?: number[] };
			this.cancelGroups(p.groups ?? []);
		}
		void scope;
	}

	private onAgentCall(callId: number, payload: { prompt: string; opts: AgentCallOptions }, scope: CallScope): void {
		const opts = payload.opts ?? {};
		if (this.agents.length >= this.limits.maxAgents) {
			this.host?.reject(callId, {
				name: "RangeError",
				message: `agent(): this run reached the limit of ${this.limits.maxAgents} agents.`,
			});
			return;
		}
		const phase = opts.phase?.trim() || scope.phase || DEFAULT_PHASE;
		const rec: AgentRecord = {
			callAfter: this.settledSeq,
			id: this.agents.length,
			label: opts.label?.trim() || defaultLabel(payload.prompt),
			phase,
			prompt: payload.prompt,
			opts,
			key: "",
			groups: scope.groups,
			status: "queued",
			queuedAt: Date.now(),
			attempts: 0,
			tools: [],
			usage: emptyUsage(),
			turns: 0,
			toolCalls: [],
			toolCallCount: 0,
			text: "",
		};
		let plan: AgentPlan;
		try {
			plan = this.executor.plan(this, rec);
		} catch (err) {
			this.host?.reject(callId, { name: "Error", message: `agent(): ${(err as Error).message}` });
			return;
		}
		rec.model = plan.modelId;
		rec.thinking = plan.thinking;
		rec.tools = plan.tools;
		rec.key = hashKey({
			prompt: payload.prompt,
			schema: opts.schema ?? null,
			model: plan.modelId,
			thinking: plan.thinking,
			tools: plan.tools,
			cwd: plan.cwd,
			isolation: opts.isolation ?? null,
			instructions: opts.instructions ?? null,
			context: opts.context ?? null,
		});
		this.touchPhase(phase);
		this.agents.push(rec);
		this.plans.set(rec.id, plan);
		this.pendingCalls.set(rec.id, { callId, onError: opts.onError ?? "null", isolation: opts.isolation === "worktree" });
		this.checkLarge();

		// A race() that already has a winner: skip at once.
		if (rec.groups.some((g) => this.cancelledGroups.has(g))) {
			rec.status = "skipped";
			rec.error = "Skipped: another race() task already won.";
			rec.endedAt = Date.now();
			this.respondFailure(rec, "skipped");
			this.emitChange();
			return;
		}

		// Replay. A call can use only the results the script had received before it, so a
		// saved result is reused when the inputs are unchanged and every agent that had
		// delivered its result before this call (in the earlier run) was reused too.
		if (this.replay) {
			const decision = this.replayCheck(rec, opts);
			if (decision.reuse && decision.prev) {
				const prev = decision.prev;
				rec.status = "cached";
				rec.result = prev.result;
				rec.fromRunId = this.replay.fromRunId;
				rec.worktree = prev.worktree;
				rec.startedAt = rec.queuedAt;
				rec.endedAt = rec.queuedAt;
				this.replayDecision.set(rec.id, "reused");
				this.respondValue(rec, prev.result);
				this.journalAgent(rec);
				this.pushBudget();
				this.emitChange();
				return;
			}
			this.replayDecision.set(rec.id, "live");
			if (decision.why && this.replayNotes < 12) {
				this.replayNotes++;
				this.log("info", `Replay: agent #${rec.id} (${rec.label}) runs again: ${decision.why}.`);
			}
		}

		this.queue.push(rec.id);
		this.pushBudget();
		this.pump();
		this.emitChange();
	}

	private replayCheck(
		rec: AgentRecord,
		opts: AgentCallOptions,
	): { reuse: boolean; prev?: Extract<JournalEntry, { type: "agent" }>; why?: string } {
		const replay = this.replay;
		if (!replay) return { reuse: false };
		const prev = replay.agents.get(rec.id);
		if (!prev) return { reuse: false, why: "it is new in this run" };
		if (opts.cache === false) return { reuse: false, why: "cache: false" };
		if (prev.key !== rec.key) {
			this.diverged = true;
			return { reuse: false, why: "its inputs changed" };
		}
		if (prev.status !== "done" && prev.status !== "cached") {
			this.diverged = true;
			return { reuse: false, why: `it was ${prev.status} before` };
		}
		if (prev.callAfter === undefined) {
			// Old journal: fall back to the prefix rule.
			return this.diverged ? { reuse: false, why: "an earlier agent ran again" } : { reuse: true, prev };
		}
		for (const [j, pj] of replay.agents) {
			if (j === rec.id || pj.endSeq === undefined || pj.endSeq > prev.callAfter) continue;
			const d = this.replayDecision.get(j);
			if (d !== "reused") {
				return {
					reuse: false,
					why: `its call came after the result of agent #${j}, which ${d === "live" ? "runs again" : "was not called again"}`,
				};
			}
		}
		return { reuse: true, prev };
	}

	private onAsk(callId: number, p: { question: string; options?: string[]; default: string | null; timeout?: number }, scope: CallScope): void {
		const q: QuestionRecord = {
			id: this.questions.length,
			question: p.question,
			options: p.options,
			default: p.default,
			status: "pending",
			askedAt: Date.now(),
			phase: scope.phase || DEFAULT_PHASE,
		};
		this.questions.push(q);
		this.pendingQuestions.set(q.id, { callId });
		if (this.replay && !this.questionsDiverged) {
			const prev = this.replay.questions.get(q.id);
			if (prev && prev.question === q.question) {
				this.answerQuestion(q.id, prev.answer, "replay");
				return;
			}
			this.questionsDiverged = true;
		}
		const canAsk = [...this.hooks].some((h) => h.canAsk?.());
		if (!canAsk) {
			this.log("info", `ask(): no human can answer now; used the default for "${q.question}".`);
			this.answerQuestion(q.id, q.default ?? null, "default");
			return;
		}
		if (p.timeout && p.timeout > 0) {
			const pending = this.pendingQuestions.get(q.id);
			if (pending) {
				pending.timer = setTimeout(() => this.answerQuestion(q.id, q.default ?? null, "default"), p.timeout * 1000);
			}
		}
		for (const h of this.hooks) h.onQuestion?.(this, q);
		this.emitChange();
	}

	private onScriptDone(value: unknown): void {
		if (this.isFinal) return;
		const leftovers = this.agents.filter((a) => !AGENT_FINAL.has(a.status)).length;
		if (leftovers > 0) this.log("warn", `The script ended while ${leftovers} agent(s) still ran; they were stopped.`);
		this.finish("completed", { result: value });
	}

	private onScriptError(err: SerializedError): void {
		if (this.isFinal) return;
		const where = err.line ? ` (script line ${err.line}${err.column ? `:${err.column}` : ""})` : "";
		this.finish("failed", { error: `${err.name}: ${err.message}${where}`, errorLine: err.line });
	}

	private finish(status: RunStatus, data: { result?: unknown; error?: string; errorLine?: number }): void {
		if (this.isFinal) return;
		if (this.status === "paused" && this.pausedAt) this.pausedMs += Date.now() - this.pausedAt;
		this.pausedAt = undefined;
		this.status = status;
		this.endedAt = Date.now();
		if ("result" in data) this.result = data.result;
		if (data.error) this.error = data.error;
		if (data.errorLine) this.errorLine = data.errorLine;
		void this.host?.terminate();
		// Stop everything that still runs or waits.
		for (const id of [...this.queue]) {
			const rec = this.agents[id];
			if (!rec) continue;
			rec.status = "skipped";
			rec.error = "Not started: the run ended.";
			rec.endedAt = Date.now();
		}
		this.queue.length = 0;
		for (const [, live] of this.attempts) {
			live.reason = "run-ended";
			live.handle.abort("run-ended");
		}
		for (const rec of this.agents) {
			if (AGENT_FINAL.has(rec.status)) continue;
			rec.status = "stopped";
			rec.error = "Stopped: the run ended.";
			rec.endedAt = Date.now();
			rec.activity = undefined;
			rec.waitingFor = undefined;
		}
		this.running.clear();
		for (const [qid, pending] of this.pendingQuestions) {
			if (pending.timer) clearTimeout(pending.timer);
			const q = this.questions[qid];
			if (q) {
				q.status = "cancelled";
				for (const h of this.hooks) h.onQuestionClosed?.(this, q);
			}
		}
		this.pendingQuestions.clear();
		for (const w of this.warming.values()) w.release();
		this.warming.clear();
		this.writeResult();
		this.persistNow();
		this.emitChange();
		for (const h of this.hooks) h.onEnd?.(this);
		this.resolveEnd();
	}

	// -------------------------------------------------------------------------
	// Scheduling
	// -------------------------------------------------------------------------

	private pump(): void {
		while (this.status === "running" && this.running.size < this.limits.maxConcurrency && this.queue.length > 0) {
			const id = this.queue.shift() as number;
			const rec = this.agents[id];
			if (!rec || rec.status !== "queued") continue;
			void this.startAgent(rec);
		}
	}

	private removeFromQueue(id: number): void {
		const i = this.queue.indexOf(id);
		if (i >= 0) this.queue.splice(i, 1);
	}

	private async startAgent(rec: AgentRecord): Promise<void> {
		const plan = this.plans.get(rec.id);
		if (!plan) return;
		this.running.add(rec.id);
		rec.status = "starting";
		rec.startedAt ??= Date.now();
		rec.activity = "starting";
		this.emitChange();

		// Hold agents that share a prompt prefix until the first one's response begins,
		// so they read its cache instead of each writing the same prefix.
		if (this.prefixStaggerMs > 0) {
			const warm = this.warming.get(plan.prefixKey);
			if (warm) {
				rec.activity = "waiting for the shared prompt cache";
				this.emitChange();
				await Promise.race([warm.promise, new Promise((r) => setTimeout(r, this.prefixStaggerMs))]);
				if (this.isFinal || rec.status !== "starting") return;
			} else {
				let release!: () => void;
				const promise = new Promise<void>((r) => {
					release = r;
				});
				const timer = setTimeout(() => {
					release();
				}, this.prefixStaggerMs);
				this.warming.set(plan.prefixKey, {
					promise,
					release: () => {
						clearTimeout(timer);
						release();
					},
				});
			}
		}
		this.launchAttempt(rec, plan);
	}

	private releaseWarm(prefixKey: string): void {
		const warm = this.warming.get(prefixKey);
		if (!warm) return;
		// Keep the entry (released) so later agents of this prefix start at once.
		warm.release();
	}

	private launchAttempt(rec: AgentRecord, plan: AgentPlan): void {
		if (this.isFinal) {
			this.running.delete(rec.id);
			return;
		}
		rec.attempts++;
		rec.status = "running";
		rec.activity = rec.attempts > 1 ? `attempt ${rec.attempts}` : "thinking";
		rec.error = undefined;
		const hooks: AttemptHooks = {
			onChange: () => this.emitChange(),
			onUsage: (u) => {
				addUsage(rec.usage, u);
				addUsage(this.usage, u);
				this.checkLarge();
			},
			onFirstToken: () => this.releaseWarm(plan.prefixKey),
		};
		let handle: AttemptHandle;
		try {
			handle = this.executor.start(this, rec, plan, hooks);
		} catch (err) {
			this.settleAttempt(rec, plan, { ok: false, reason: "error", message: (err as Error).message, retryable: false });
			return;
		}
		const live: LiveAttempt = { handle };
		this.attempts.set(rec.id, live);
		this.emitChange();
		handle.promise.then(
			(outcome) => this.settleAttempt(rec, plan, outcome, live.reason),
			(err) =>
				this.settleAttempt(rec, plan, { ok: false, reason: "error", message: (err as Error)?.message ?? String(err), retryable: false }, live.reason),
		);
	}

	private settleAttempt(rec: AgentRecord, plan: AgentPlan, outcome: AttemptOutcome, reason?: AbortReason): void {
		this.attempts.delete(rec.id);
		this.releaseWarm(plan.prefixKey);
		if (outcome.worktree) rec.worktree = outcome.worktree;
		if (this.isFinal) {
			// The run already ended and marked this agent; keep the journal complete.
			this.journalAgent(rec);
			this.schedulePersist();
			return;
		}
		if (reason === "restart" && !this.isFinal) {
			rec.activity = "restarting";
			this.launchAttempt(rec, plan);
			return;
		}
		this.running.delete(rec.id);
		rec.endedAt = Date.now();
		rec.waitingFor = undefined;
		if (outcome.ok) {
			rec.status = "done";
			rec.result = outcome.value;
			rec.activity = undefined;
			this.respondValue(rec, outcome.value);
			this.journalAgent(rec);
		} else if (reason === "stopped" || reason === "cancelled" || reason === "run-ended") {
			rec.status = reason === "cancelled" ? "skipped" : "stopped";
			rec.error =
				reason === "stopped" ? "Stopped by the user." : reason === "cancelled" ? "Stopped: another race() task won." : "Stopped: the run ended.";
			rec.activity = undefined;
			this.respondFailure(rec, rec.status);
			this.journalAgent(rec);
		} else {
			const retriesLeft = plan.retries - (rec.attempts - 1);
			if (outcome.retryable && retriesLeft > 0 && !this.isFinal) {
				this.log("warn", `Agent #${rec.id} (${rec.label}) failed: ${outcome.message}. Retrying (${retriesLeft} left).`);
				this.running.add(rec.id);
				this.launchAttempt(rec, plan);
				return;
			}
			rec.status = "failed";
			rec.error = outcome.message;
			rec.activity = undefined;
			this.respondFailure(rec, "failed");
			this.journalAgent(rec);
		}
		this.pushBudget();
		this.pump();
		this.emitChange();
	}

	private respondValue(rec: AgentRecord, value: unknown): void {
		const pending = this.pendingCalls.get(rec.id);
		if (!pending) return;
		rec.endSeq = ++this.settledSeq;
		this.pendingCalls.delete(rec.id);
		const out = pending.isolation ? { output: value, worktree: rec.worktree ?? null } : value;
		this.host?.resolve(pending.callId, out === undefined ? null : out);
	}

	private respondFailure(rec: AgentRecord, status: string): void {
		const pending = this.pendingCalls.get(rec.id);
		if (!pending) return;
		rec.endSeq = ++this.settledSeq;
		this.pendingCalls.delete(rec.id);
		if (pending.onError === "throw") {
			this.host?.reject(pending.callId, {
				name: "AgentError",
				message: `agent #${rec.id} (${rec.label}) ${status}: ${rec.error ?? "no result"}`,
				agentId: rec.id,
				reason: status,
			});
			return;
		}
		this.host?.resolve(pending.callId, null);
	}

	private cancelGroups(groups: number[]): void {
		if (groups.length === 0) return;
		for (const g of groups) this.cancelledGroups.add(g);
		this.host?.cancelled(groups);
		for (const rec of this.agents) {
			if (AGENT_FINAL.has(rec.status) || !rec.groups.some((g) => this.cancelledGroups.has(g))) continue;
			if (rec.status === "queued") {
				this.removeFromQueue(rec.id);
				rec.status = "skipped";
				rec.error = "Skipped: another race() task won.";
				rec.endedAt = Date.now();
				this.respondFailure(rec, "skipped");
				this.journalAgent(rec);
			} else {
				const live = this.attempts.get(rec.id);
				if (live) {
					live.reason = "cancelled";
					live.handle.abort("cancelled");
				}
			}
		}
		this.emitChange();
	}

	// -------------------------------------------------------------------------
	// State helpers
	// -------------------------------------------------------------------------

	touchPhase(title: string): void {
		const existing = this.phases.find((p) => p.title === title);
		if (existing) {
			existing.firstSeenAt ??= Date.now();
			return;
		}
		this.phases.push({ title, planned: false, firstSeenAt: Date.now() });
	}

	log(level: LogEntry["level"], text: string): void {
		this.logs.push({ t: Date.now(), level, text });
		this.logCount++;
		if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
		this.emitChange();
	}

	private readonly warningIndex = new Map<string, number>();

	/** Add a warning once per kind. Later calls of the same kind only update the text. */
	warn(kind: string, text: string): void {
		const i = this.warningIndex.get(kind);
		if (i !== undefined) {
			this.warnings[i] = text;
			return;
		}
		this.warningIndex.set(kind, this.warnings.length);
		this.warnings.push(text);
		for (const h of this.hooks) h.onWarning?.(this, text);
	}

	private checkLarge(): void {
		const threshold = this.targetAgents ?? this.largeWorkflowAgents;
		if (this.agents.length > threshold) {
			this.warn("large-agents", `Large workflow: ${this.agents.length} agents scheduled (guideline ${threshold}).`);
		}
		const finished = this.agents.filter((a) => a.status === "done" || a.status === "failed").length;
		if (finished >= 3) {
			const projected = (this.usage.totalTokens / finished) * this.agents.length;
			if (projected > this.largeWorkflowTokens) {
				this.warn("large-tokens", `Large workflow: about ${Math.round(projected / 100_000) / 10}M tokens projected.`);
			}
		}
	}

	budget(): Record<string, unknown> {
		const c = countAgents(this.agents);
		return {
			maxAgents: this.limits.maxAgents,
			agentsStarted: this.agents.length,
			agentsRemaining: Math.max(0, this.limits.maxAgents - this.agents.length),
			agentsRunning: c.active,
			agentsDone: c.done + c.cached,
			agentsFailed: c.failed,
			tokens: this.usage.totalTokens,
			cost: Math.round(this.usage.cost * 10000) / 10000,
			maxConcurrency: this.limits.maxConcurrency,
			targetAgents: this.targetAgents ?? null,
		};
	}

	private pushBudget(): void {
		this.host?.pushBudget(this.budget());
	}

	// -------------------------------------------------------------------------
	// Persistence
	// -------------------------------------------------------------------------

	snapshot(): RunSnapshot {
		return {
			version: 1,
			id: this.id,
			name: this.name,
			description: this.description,
			meta: this.prepared.meta,
			source: this.source,
			sessionId: this.sessionId,
			cwd: this.cwd,
			runDir: this.runDir,
			scriptPath: this.scriptPath,
			transcriptDir: this.transcriptDir,
			args: this.args,
			seed: this.seed,
			status: this.status,
			createdAt: this.createdAt,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			pausedMs: this.pausedMs,
			phases: this.phases,
			agents: this.agents,
			logs: this.logs,
			questions: this.questions,
			usage: this.usage,
			result: this.result,
			error: this.error,
			errorLine: this.errorLine,
			warnings: this.warnings,
			resumedFrom: this.resumedFrom,
			foreground: this.foreground,
			delivered: this.delivered,
			limits: this.limits,
			targetAgents: this.targetAgents,
		};
	}

	private schedulePersist(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			this.persistNow();
		}, 1000);
	}

	persistNow(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		try {
			mkdirSync(this.runDir, { recursive: true });
			writeFileSync(join(this.runDir, "run.json"), JSON.stringify(this.snapshot(), null, 1));
		} catch {
			// Persistence is best effort; the run goes on.
		}
	}

	private writeResult(): void {
		try {
			writeFileSync(
				join(this.runDir, "result.json"),
				JSON.stringify({ status: this.status, result: this.result ?? null, error: this.error ?? null }, null, 2),
			);
		} catch {
			// best effort
		}
	}

	private journal(entry: JournalEntry): void {
		try {
			appendFileSync(join(this.runDir, "journal.jsonl"), `${JSON.stringify(entry)}\n`);
		} catch {
			// best effort
		}
	}

	private journalAgent(rec: AgentRecord): void {
		this.journal({
			type: "agent",
			id: rec.id,
			key: rec.key,
			status: rec.status,
			result: rec.result,
			error: rec.error,
			label: rec.label,
			phase: rec.phase,
			usage: rec.usage,
			worktree: rec.worktree,
			callAfter: rec.callAfter,
			endSeq: rec.endSeq,
		});
	}
}
