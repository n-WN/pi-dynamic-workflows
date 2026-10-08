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
import { countAgents, defaultLabel, elapsedOf, formatDuration, formatTokens, parseTokens } from "./format.ts";
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

export type AbortReason = "stopped" | "restart" | "timeout" | "cancelled" | "run-ended" | "stalled";

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
	/** Any sign of life (a streamed token, a tool update). The stall watchdog uses it. */
	onActivity?(): void;
}

export interface AttemptHandle {
	promise: Promise<AttemptOutcome>;
	abort(reason: AbortReason): void;
	/** Send a message to the running agent. Resolves false when it cannot take one now. */
	steer?(text: string, by: "human" | "agent"): Promise<boolean>;
	/**
	 * Stop the agent's current step (a model response or a tool call) and let it go on
	 * in the same conversation with `note`. Resolves false when no step runs now.
	 */
	interrupt?(note: string): Promise<boolean>;
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

type AgentEntry = Extract<JournalEntry, { type: "agent" }>;

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
	/** Hard token limit for the run (all agents). 0 or undefined: none. */
	tokenBudget?: number;
	/** Abort an attempt that shows no activity for this long, and start it again once. 0: off. */
	stallMs?: number;
	/** Time a stopped attempt gets to end before the run gives up on it. Default 10 s. */
	abandonMs?: number;
}

interface PendingCall {
	callId: number;
	onError: "null" | "throw";
	isolation: boolean;
}

interface LiveAttempt {
	handle: AttemptHandle;
	reason?: AbortReason;
	/** Last sign of life of the attempt (stall watchdog). */
	lastActivity: number;
	/** The attempt did not end after a stop; the run went on without it. */
	abandoned?: boolean;
	abandonTimer?: ReturnType<typeof setTimeout>;
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
	/** Hard token limit; the human can raise it when the run reaches it. */
	tokenLimit?: number;
	/** Arbitrary data the extension keeps per run (for example a parent tool context). */
	attachments = new Map<string, unknown>();

	private readonly executor: AgentExecutor;
	private readonly hooks = new Set<RunHooks>();
	private readonly replay?: ReplayData;
	/** Saved agent results by input key, in call order. Replay matches calls by their inputs. */
	private readonly replayByKey = new Map<string, AgentEntry[]>();
	/** Saved entries that a call of this run took (to reuse, or to run again). */
	private readonly replayClaimed = new Set<number>();
	/** Saved entries whose result this run reused. */
	private readonly replayReused = new Set<number>();
	/** A journal without dependency data (older runs): match by position with the prefix rule. */
	private readonly replayLegacy: boolean;
	/** Fallback for journals without dependency data: the prefix rule. */
	private diverged = false;
	private questionsDiverged = false;
	/** Number of ask() calls of the script (budget questions do not count). */
	private scriptQuestions = 0;
	/** Default model per phase, from meta.phases objects. */
	private readonly phaseModels = new Map<string, string>();
	private pausedBy?: "user" | "budget";
	/** The open budget question, if any. */
	private budgetQid?: number;
	private readonly stallMs: number;
	private readonly abandonMs: number;
	private watchdog?: ReturnType<typeof setInterval>;
	private watchdogMs = 0;
	/** Number of agent results delivered to the script so far. */
	private settledSeq = 0;
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
		this.tokenLimit = init.tokenBudget && init.tokenBudget > 0 ? Math.round(init.tokenBudget) : undefined;
		this.stallMs = init.stallMs && init.stallMs > 0 ? init.stallMs : 0;
		this.abandonMs = init.abandonMs && init.abandonMs > 0 ? init.abandonMs : 10_000;
		for (const title of init.prepared.meta.phases ?? []) this.phases.push({ title, planned: true });
		for (const p of init.prepared.meta.phaseInfo ?? []) if (p.model) this.phaseModels.set(p.title, p.model);
		let legacy = false;
		if (this.replay) {
			const entries = [...this.replay.agents.values()].sort((a, b) => a.id - b.id);
			legacy = entries.some((e) => e.callAfter === undefined);
			for (const e of entries) {
				const list = this.replayByKey.get(e.key);
				if (list) list.push(e);
				else this.replayByKey.set(e.key, [e]);
			}
		}
		this.replayLegacy = legacy;
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

	pause(by: "user" | "budget" = "user"): void {
		if (this.status !== "running") return;
		this.status = "paused";
		this.pausedAt = Date.now();
		this.pausedBy = by;
		if (by === "user") this.log("info", "Paused: running agents finish; no new agents start.");
		this.emitChange();
	}

	resume(): void {
		if (this.status !== "paused") return;
		if (this.budgetQid !== undefined) {
			this.log("warn", "The run waits for a decision about its token budget. Answer that question to go on.");
			return;
		}
		this.pausedMs += Date.now() - (this.pausedAt ?? Date.now());
		this.pausedAt = undefined;
		this.pausedBy = undefined;
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
		this.abortAttempt(rec, live, "stopped");
		return true;
	}

	/** Milliseconds since the agent's last sign of life (0 when it does not run, or waits for the human). */
	quietMs(id: number, now = Date.now()): number {
		const rec = this.agents[id];
		const live = this.attempts.get(id);
		if (!rec || !live || rec.status === "waiting" || live.reason) return 0;
		return Math.max(0, now - live.lastActivity);
	}

	/** Start the agent again from the beginning (a new conversation). */
	restartAgent(id: number): boolean {
		const rec = this.agents[id];
		if (!rec) return false;
		const live = this.attempts.get(id);
		if (!live || AGENT_FINAL.has(rec.status)) return false;
		this.abortAttempt(rec, live, "restart");
		this.log("info", `Restarting agent #${id} (${rec.label}).`);
		return true;
	}

	/**
	 * Stop the agent's current step and let it go on with its context: for a step that
	 * hangs (a command that waits for input, a tool that does not return). `text` is an
	 * optional message for the agent.
	 */
	async interruptAgent(id: number, text = "", by: "human" | "agent" = "human"): Promise<boolean> {
		const rec = this.agents[id];
		const live = this.attempts.get(id);
		if (!rec || !live?.handle.interrupt || live.reason || AGENT_FINAL.has(rec.status)) return false;
		const who = by === "human" ? "The user who watches this workflow" : "The main agent that started this workflow";
		const message = text.trim();
		const note = `${who} stopped your last step before it finished (it may hang).${message ? ` Message: ${message}` : " Do not repeat it in the same way."} Continue your task.`;
		const ok = await live.handle.interrupt(note);
		if (!ok) return false;
		live.lastActivity = Date.now();
		rec.interrupts = (rec.interrupts ?? 0) + 1;
		if (message) rec.steers = [...(rec.steers ?? []), { t: Date.now(), by, text: message }];
		this.log("info", `Agent #${id} (${rec.label}): the ${by === "human" ? "user" : "main agent"} interrupted its current step; it goes on with its context.`);
		this.emitChange();
		return true;
	}

	/**
	 * Abort an attempt. A step that ignores the stop signal must not hold the run: when
	 * the attempt has not ended after abandonMs, the run gives up on it and goes on.
	 */
	private abortAttempt(rec: AgentRecord, live: LiveAttempt, reason: AbortReason): void {
		live.reason = reason;
		live.handle.abort(reason);
		if (live.abandonTimer) return;
		live.abandonTimer = setTimeout(() => {
			if (this.attempts.get(rec.id) !== live || this.isFinal) return;
			live.abandoned = true;
			this.log(
				"warn",
				`Agent #${rec.id} (${rec.label}) did not stop within ${formatDuration(this.abandonMs)}: one of its steps ignores the stop signal. The run goes on without that attempt.`,
			);
			const plan = this.plans.get(rec.id);
			if (plan) this.settleAttempt(rec, plan, { ok: false, reason: "aborted", message: "the attempt did not stop and was abandoned", retryable: false }, live.reason);
		}, this.abandonMs);
		live.abandonTimer.unref?.();
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
		// The token budget protects the human's money: only the human raises it.
		if (q.kind === "budget" && by === "agent") return false;
		if (pending.timer) clearTimeout(pending.timer);
		this.pendingQuestions.delete(qid);
		q.status = by === "default" ? "defaulted" : "answered";
		q.answer = answer;
		q.answeredBy = by;
		q.answeredAt = Date.now();
		if (q.kind === "budget") {
			this.onBudgetAnswer(q, answer, by);
			for (const h of this.hooks) h.onQuestionClosed?.(this, q);
			this.emitChange();
			return true;
		}
		this.journal({ type: "question", id: q.seq ?? q.id, question: q.question, answer });
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
		let opts = payload.opts ?? {};
		if (this.agents.length >= this.limits.maxAgents) {
			this.host?.reject(callId, {
				name: "RangeError",
				message: `agent(): this run reached the limit of ${this.limits.maxAgents} agents.`,
			});
			return;
		}
		const phase = opts.phase?.trim() || scope.phase || DEFAULT_PHASE;
		// meta.phases can give a phase a default model.
		const phaseModel = this.phaseModels.get(phase);
		if (opts.model === undefined && phaseModel) opts = { ...opts, model: phaseModel };
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
				this.respondValue(rec, prev.result);
				this.journalAgent(rec);
				this.pushBudget();
				this.emitChange();
				return;
			}
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

	/**
	 * Replay decision for one call. A call takes the first saved entry with the same
	 * inputs (prompt and options) that no earlier call took, so a changed call order
	 * (pipeline stages, for example) still finds its results. The saved result is
	 * reused only when every agent whose result had reached the script before this
	 * call (in the earlier run) was reused too: the agent could depend on what they did.
	 */
	private replayCheck(rec: AgentRecord, opts: AgentCallOptions): { reuse: boolean; prev?: AgentEntry; why?: string } {
		const replay = this.replay;
		if (!replay) return { reuse: false };
		if (this.replayLegacy) return this.replayCheckByPosition(rec, opts);
		const candidates = this.replayByKey.get(rec.key) ?? [];
		const open = candidates.filter((e) => !this.replayClaimed.has(e.id));
		const prev = open.find((e) => e.status === "done" || e.status === "cached") ?? open[0];
		if (!prev) return { reuse: false, why: candidates.length ? "an identical call already took its saved result" : "no saved result has the same inputs" };
		this.replayClaimed.add(prev.id);
		if (opts.cache === false) return { reuse: false, why: "cache: false" };
		if (prev.status !== "done" && prev.status !== "cached") return { reuse: false, why: `it was ${prev.status} before` };
		for (const pj of replay.agents.values()) {
			if (pj.id === prev.id || pj.endSeq === undefined || prev.callAfter === undefined || pj.endSeq > prev.callAfter) continue;
			if (!this.replayReused.has(pj.id)) {
				return {
					reuse: false,
					why: `before, it started after the result of agent #${pj.id} (${pj.label}), which ${this.replayClaimed.has(pj.id) ? "runs again" : "this run did not call again"}`,
				};
			}
		}
		this.replayReused.add(prev.id);
		return { reuse: true, prev };
	}

	/** Journals without dependency data: match by position; the first change or failure invalidates the rest. */
	private replayCheckByPosition(rec: AgentRecord, opts: AgentCallOptions): { reuse: boolean; prev?: AgentEntry; why?: string } {
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
		return this.diverged ? { reuse: false, why: "an earlier agent ran again" } : { reuse: true, prev };
	}

	private onAsk(callId: number, p: { question: string; options?: string[]; default: string | null; timeout?: number }, scope: CallScope): void {
		const q: QuestionRecord = {
			id: this.questions.length,
			seq: this.scriptQuestions++,
			kind: "script",
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
			const prev = this.replay.questions.get(q.seq ?? q.id);
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
		this.budgetQid = undefined;
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = undefined;
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
			// The budget decides only when a new agent would start: a script that ends
			// without another agent never sees a budget question.
			if (this.tokenLimit && this.usage.totalTokens >= this.tokenLimit) {
				this.onBudgetReached();
				return;
			}
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
		let live: LiveAttempt | undefined;
		const alive = () => {
			if (live) live.lastActivity = Date.now();
		};
		const hooks: AttemptHooks = {
			onChange: () => {
				alive();
				this.emitChange();
			},
			onUsage: (u) => {
				alive();
				addUsage(rec.usage, u);
				addUsage(this.usage, u);
				this.checkLarge();
			},
			onFirstToken: () => {
				alive();
				this.releaseWarm(plan.prefixKey);
			},
			onActivity: alive,
		};
		let handle: AttemptHandle;
		try {
			handle = this.executor.start(this, rec, plan, hooks);
		} catch (err) {
			this.settleAttempt(rec, plan, { ok: false, reason: "error", message: (err as Error).message, retryable: false });
			return;
		}
		live = { handle, lastActivity: Date.now() };
		this.ensureWatchdog(rec.opts.stallMs ?? this.stallMs);
		const current = live;
		this.attempts.set(rec.id, current);
		this.emitChange();
		const settle = (outcome: AttemptOutcome) => {
			if (current.abandonTimer) clearTimeout(current.abandonTimer);
			// The run already gave up on this attempt and went on.
			if (current.abandoned) return;
			this.settleAttempt(rec, plan, outcome, current.reason);
		};
		handle.promise.then(settle, (err) => settle({ ok: false, reason: "error", message: (err as Error)?.message ?? String(err), retryable: false }));
	}

	/** Check live attempts for stalls at a rate that fits the smallest stall limit. */
	private ensureWatchdog(limit: number): void {
		if (!(limit > 0)) return;
		const every = Math.max(50, Math.min(15_000, Math.floor(limit / 4)));
		if (this.watchdog && this.watchdogMs <= every) return;
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdogMs = every;
		this.watchdog = setInterval(() => this.checkStalls(), every);
		this.watchdog.unref?.();
	}

	private checkStalls(): void {
		const now = Date.now();
		for (const [id, live] of this.attempts) {
			const rec = this.agents[id];
			if (!rec || live.reason) continue;
			const limit = rec.opts.stallMs ?? this.stallMs;
			if (!(limit > 0)) continue;
			// Time spent waiting for the human is not a stall.
			if (rec.status === "waiting") {
				live.lastActivity = now;
				continue;
			}
			if (now - live.lastActivity <= limit) continue;
			rec.stalls = (rec.stalls ?? 0) + 1;
			// First stall: stop only the hanging step; the agent keeps its context.
			if (rec.stalls === 1 && live.handle.interrupt) {
				live.lastActivity = now;
				const note = `Your last step showed no activity for ${formatDuration(limit)}, so the workflow stopped it. It may hang (for example a command that waits for input). Do not run it the same way again. Continue your task.`;
				this.log("warn", `Agent #${id} (${rec.label}) showed no activity for ${formatDuration(limit)}. Its current step was stopped; it goes on with its context.`);
				void live.handle.interrupt(note).then((ok) => {
					if (ok) {
						rec.interrupts = (rec.interrupts ?? 0) + 1;
						this.emitChange();
					} else if (this.attempts.get(id) === live && !live.reason) this.abortAttempt(rec, live, "stalled");
				});
				continue;
			}
			this.abortAttempt(rec, live, "stalled");
		}
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
			const stalled = reason === "stalled";
			const limit = rec.opts.stallMs ?? this.stallMs;
			const message = stalled
				? `no activity for ${formatDuration(limit)} (stalled). An agent that runs long silent commands needs a larger stallMs.`
				: outcome.message;
			// One restart after a stall is free: it does not count against retries.
			const freeRetry = stalled && !rec.stallRestarts;
			if (freeRetry) rec.stallRestarts = 1;
			const retriesLeft = plan.retries - (rec.attempts - 1 - (rec.stallRestarts ?? 0));
			if ((freeRetry || ((outcome.retryable || stalled) && retriesLeft > 0)) && !this.isFinal) {
				this.log(
					"warn",
					`Agent #${rec.id} (${rec.label}) ${stalled ? "showed no activity" : "failed"}: ${message} ${freeRetry ? "It starts again once." : `Retrying (${retriesLeft} left).`}`,
				);
				this.running.add(rec.id);
				this.launchAttempt(rec, plan);
				return;
			}
			rec.status = "failed";
			rec.error = message;
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
		// Counts first: the script may read budget right after the result arrives.
		this.pushBudget();
		this.host?.resolve(pending.callId, out === undefined ? null : out);
	}

	private respondFailure(rec: AgentRecord, status: string): void {
		const pending = this.pendingCalls.get(rec.id);
		if (!pending) return;
		rec.endSeq = ++this.settledSeq;
		this.pendingCalls.delete(rec.id);
		this.pushBudget();
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
				if (live) this.abortAttempt(rec, live, "cancelled");
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
			tokenLimit: this.tokenLimit ?? null,
			tokensRemaining: this.tokenLimit ? Math.max(0, this.tokenLimit - this.usage.totalTokens) : null,
			cost: Math.round(this.usage.cost * 10000) / 10000,
			maxConcurrency: this.limits.maxConcurrency,
			targetAgents: this.targetAgents ?? null,
		};
	}

	/** A new agent would start at the token limit: the human decides (or the run stops without one). */
	private onBudgetReached(): void {
		const limit = this.tokenLimit;
		if (!limit || this.isFinal || this.budgetQid !== undefined || this.usage.totalTokens < limit) return;
		const used = this.usage.totalTokens;
		this.log("warn", `Token budget reached: ${formatTokens(used)} of ${formatTokens(limit)} tokens. No new agents start.`);
		const canAsk = [...this.hooks].some((h) => h.canAsk?.());
		if (!canAsk) {
			this.stop(`Stopped: the run used its token budget of ${formatTokens(limit)} tokens. Completed agents keep their results; relaunch with a larger budget to go on.`);
			return;
		}
		if (this.status === "running") this.pause("budget");
		const more = Math.max(1000, Math.round(limit / 2));
		const q: QuestionRecord = {
			id: this.questions.length,
			kind: "budget",
			question: `${this.name} used its token budget: ${formatTokens(used)} of ${formatTokens(limit)} tokens. No new agents start until you decide. Raise the budget, or stop the run?`,
			options: [`Add ${formatTokens(more)} (budget ${formatTokens(limit + more)})`, `Double it (budget ${formatTokens(limit * 2)})`, "Stop the run"],
			default: null,
			status: "pending",
			askedAt: Date.now(),
			phase: "Budget",
		};
		this.questions.push(q);
		this.budgetQid = q.id;
		this.pendingQuestions.set(q.id, { callId: -1 });
		for (const h of this.hooks) h.onQuestion?.(this, q);
		this.emitChange();
	}

	private onBudgetAnswer(q: QuestionRecord, answer: string | null, by: QuestionRecord["answeredBy"]): void {
		this.budgetQid = undefined;
		const limit = this.tokenLimit ?? 0;
		const pick = q.options?.indexOf(answer ?? "") ?? -1;
		// A typed amount ("3M") sets the new budget directly.
		const typed = pick < 0 && answer ? parseTokens(answer) : undefined;
		let next: number | undefined;
		if (pick === 0) next = limit + Math.max(1000, Math.round(limit / 2));
		else if (pick === 1) next = limit * 2;
		else if (typed && typed > this.usage.totalTokens) next = typed;
		if (next === undefined) {
			this.stop(`Stopped: the run used its token budget of ${formatTokens(limit)} tokens.`);
			return;
		}
		this.tokenLimit = next;
		this.log("info", `Token budget raised to ${formatTokens(next)} tokens by the ${by === "human" ? "user" : by}.`);
		this.pushBudget();
		// resume() starts queued agents; at the limit still, pump() asks again.
		if (this.pausedBy === "budget") this.resume();
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
			tokenLimit: this.tokenLimit,
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
