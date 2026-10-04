/** Shared types of the workflow runtime. All run state is plain JSON data. */

export interface WorkflowMeta {
	name: string;
	description: string;
	/** Planned phase titles, in order. */
	phases?: string[];
	/** JSON Schema of the args value. */
	args?: Record<string, unknown>;
	/** Short hint for the slash command, such as "<question>". */
	argsHint?: string;
	[key: string]: unknown;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Options of one agent() call, as the script passes them. */
export interface AgentCallOptions {
	label?: string;
	phase?: string;
	schema?: Record<string, unknown>;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	readOnly?: boolean;
	cwd?: string;
	isolation?: "worktree";
	instructions?: string;
	context?: unknown;
	timeout?: number;
	maxTurns?: number;
	retries?: number;
	onError?: "null" | "throw";
	cache?: boolean;
}

export type AgentStatus =
	| "queued"
	| "starting"
	| "running"
	| "waiting"
	| "done"
	| "cached"
	| "failed"
	| "stopped"
	| "skipped";

export const AGENT_FINAL: ReadonlySet<AgentStatus> = new Set(["done", "cached", "failed", "stopped", "skipped"]);
export const AGENT_ACTIVE: ReadonlySet<AgentStatus> = new Set(["starting", "running", "waiting"]);

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export function emptyUsage(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function addUsage(into: UsageTotals, u: Partial<UsageTotals> | undefined): void {
	if (!u) return;
	into.input += u.input ?? 0;
	into.output += u.output ?? 0;
	into.cacheRead += u.cacheRead ?? 0;
	into.cacheWrite += u.cacheWrite ?? 0;
	into.totalTokens += u.totalTokens ?? 0;
	into.cost += u.cost ?? 0;
}

export interface ToolCallView {
	id: string;
	name: string;
	/** One-line summary of the arguments, such as the bash command. */
	summary: string;
	status: "running" | "done" | "error";
	startedAt: number;
	endedAt?: number;
	/** Start of the arguments as JSON (for the expanded view). */
	argsPreview?: string;
	/** Start of the result text. */
	resultPreview?: string;
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	base: string;
	changed: boolean;
	diffStat?: string;
}

export interface AgentRecord {
	/** Index in start order. Replay matches agents by this index. */
	id: number;
	label: string;
	phase: string;
	prompt: string;
	opts: AgentCallOptions;
	/** Hash of everything that changes what the agent does. */
	key: string;
	/** Cancellation groups (race scopes) the call belongs to. */
	groups: number[];
	status: AgentStatus;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	attempts: number;
	model?: string;
	thinking?: string;
	tools: string[];
	usage: UsageTotals;
	turns: number;
	toolCalls: ToolCallView[];
	toolCallCount: number;
	/** What the agent does now, such as "bash: npm test". */
	activity?: string;
	/** Tail of the streamed assistant text. */
	text: string;
	result?: unknown;
	error?: string;
	transcriptPath?: string;
	/** Why the agent waits, such as a permission prompt. */
	waitingFor?: string;
	worktree?: WorktreeInfo;
	/** Restored from a previous run instead of running again. */
	fromRunId?: string;
	/** How many agent results the script had received when it made this call (replay dependencies). */
	callAfter?: number;
	/** Position of this agent in the order in which results reached the script. */
	endSeq?: number;
}

export type RunStatus = "running" | "paused" | "completed" | "failed" | "stopped";
export const RUN_FINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "stopped"]);

export interface PhaseRecord {
	title: string;
	/** Declared in meta.phases. */
	planned: boolean;
	firstSeenAt?: number;
}

export interface LogEntry {
	t: number;
	level: "info" | "warn" | "error" | "debug";
	text: string;
}

export interface QuestionRecord {
	id: number;
	question: string;
	options?: string[];
	default?: string | null;
	status: "pending" | "answered" | "defaulted" | "cancelled";
	answer?: string | null;
	askedAt: number;
	answeredAt?: number;
	phase: string;
	/** Who answered: the human in the UI, the main agent, or the default. */
	answeredBy?: "human" | "agent" | "default" | "replay";
}

export type WorkflowSourceKind = "inline" | "file" | "saved" | "bundled";

export interface WorkflowSource {
	kind: WorkflowSourceKind;
	/** Saved or bundled workflow name. */
	name?: string;
	/** Path of the script the run started from. */
	path?: string;
	scope?: "project" | "personal" | "bundled";
}

export interface RunSnapshot {
	version: 1;
	id: string;
	name: string;
	description: string;
	meta: WorkflowMeta;
	source: WorkflowSource;
	sessionId: string;
	cwd: string;
	runDir: string;
	scriptPath: string;
	transcriptDir: string;
	args: unknown;
	seed: number;
	status: RunStatus;
	createdAt: number;
	startedAt: number;
	endedAt?: number;
	/** Milliseconds spent paused, for the elapsed time. */
	pausedMs: number;
	phases: PhaseRecord[];
	agents: AgentRecord[];
	logs: LogEntry[];
	questions: QuestionRecord[];
	usage: UsageTotals;
	result?: unknown;
	error?: string;
	errorLine?: number;
	warnings: string[];
	resumedFrom?: string;
	/** True when a tool call waited for the run and got the result directly. */
	foreground: boolean;
	delivered: boolean;
	limits: { maxConcurrency: number; maxAgents: number; maxItems: number };
	/** Agents the size guideline aims for (advice, not a cap). */
	targetAgents?: number;
}

/** One line of journal.jsonl: the outcome of an agent call or a question, for replay. */
export type JournalEntry =
	| {
			type: "agent";
			id: number;
			key: string;
			status: AgentStatus;
			result?: unknown;
			error?: string;
			label: string;
			phase: string;
			usage: UsageTotals;
			worktree?: WorktreeInfo;
			callAfter?: number;
			endSeq?: number;
	  }
	| { type: "question"; id: number; question: string; answer: string | null };
