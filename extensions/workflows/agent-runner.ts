/**
 * PiAgentExecutor: runs each workflow agent as an in-process pi AgentSession.
 *
 * Each agent gets a clean context, its own transcript file in the run's agents/
 * directory, the session's model registry and credentials, your pi extensions
 * (except this one), and a tool allowlist. Tools that only the main session has
 * (MCP tools, for example) are bridged to it when the run started from a tool call.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { oneLine, previewJson, slug, summarizeToolArgs } from "./format.ts";
import { agentPreamble, agentPromptFooter, CONTROL_TOOL, SUBMIT_TOOL, structuredReminder, WORKFLOW_TOOL, worktreeNote } from "./prompts.ts";
import type { AbortReason, AgentExecutor, AgentPlan, AttemptHandle, AttemptHooks, AttemptOutcome, WorkflowRun } from "./run.ts";
import { describeSchema, findSchemaContradiction, toToolParameters, validate } from "./schema.ts";
import type { AgentRecord, ThinkingLevel, ToolCallView, WorktreeInfo } from "./types.ts";

const execFileAsync = promisify(execFile);

export const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const ORCHESTRATION_TOOLS = new Set([WORKFLOW_TOOL, CONTROL_TOOL]);
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_TOOL_VIEWS = 40;
const TEXT_TAIL = 2000;

export interface ToolOutcomeLike {
	content: Array<{ type: string; text?: string; [k: string]: unknown }>;
	isError: boolean;
}

export interface ExecutorContext {
	agentDir: string;
	modelRuntime: ModelRuntime;
	/** Resolve a model spec ("provider/id", "id", or a fuzzy name). */
	findModel(spec: string): Model<any> | undefined;
	listModels(): string[];
	defaultModel: Model<any>;
	defaultThinking: ThinkingLevel;
	configModel?: string;
	configThinking?: string;
	/** Every tool of the main session. */
	parentTools: Map<string, ToolInfo>;
	/** Default tools of agents. */
	defaultTools: string[];
	projectTrusted: boolean;
	loadExtensions: boolean;
	/** Extension paths given on the pi command line (-e), without this extension. */
	cliExtensions: string[];
	loadSkills: boolean;
	loadContextFiles: boolean;
	excludeExtension(path: string): boolean;
	structuredRetries: number;
	/** UI proxy for extension dialogs in the agent. Undefined: no UI. */
	childUi?(run: WorkflowRun, rec: AgentRecord, signal: AbortSignal): ExtensionUIContext | undefined;
	/** Run a main-session tool (for tools an agent session cannot load itself). */
	bridgeExec?(run: WorkflowRun, name: string, args: unknown, signal: AbortSignal | undefined): Promise<ToolOutcomeLike>;
	onExtensionError?(run: WorkflowRun, rec: AgentRecord, error: string): void;
}

interface PlanData {
	model: Model<any>;
	thinking: ThinkingLevel;
	prompt: string;
	schema?: Record<string, unknown>;
	timeoutMs?: number;
	maxTurns?: number;
	isolation: boolean;
	gitRoot?: string;
}

const gitRootCache = new Map<string, string | null>();

function gitRoot(cwd: string): string | undefined {
	if (gitRootCache.has(cwd)) return gitRootCache.get(cwd) ?? undefined;
	let root: string | null = null;
	try {
		root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
	} catch {
		root = null;
	}
	gitRootCache.set(cwd, root);
	return root ?? undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
	return stdout;
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
	return (content ?? [])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

export class PiAgentExecutor implements AgentExecutor {
	private readonly ctx: ExecutorContext;

	constructor(ctx: ExecutorContext) {
		this.ctx = ctx;
	}

	plan(run: WorkflowRun, rec: AgentRecord): AgentPlan {
		const o = rec.opts;
		const ctx = this.ctx;

		const spec = o.model ?? ctx.configModel;
		const model = spec && spec !== "inherit" ? ctx.findModel(spec) : ctx.defaultModel;
		if (!model) {
			throw new Error(`model "${spec}" was not found. Models you can use: ${ctx.listModels().slice(0, 16).join(", ")}`);
		}
		const thinkingRaw = o.thinking ?? ctx.configThinking ?? ctx.defaultThinking;
		const thinking = (THINKING_LEVELS.includes(thinkingRaw as ThinkingLevel) ? thinkingRaw : ctx.defaultThinking) as ThinkingLevel;

		let tools = o.tools ? [...new Set(o.tools)] : o.readOnly ? [...READ_ONLY_TOOLS] : [...ctx.defaultTools];
		for (const t of tools) {
			if (ORCHESTRATION_TOOLS.has(t)) throw new Error(`workflow agents cannot use the ${t} tool (no nested workflows)`);
			if (t === SUBMIT_TOOL) throw new Error(`${SUBMIT_TOOL} is added automatically when you set schema`);
			if (!BUILTIN_TOOLS.has(t) && !ctx.parentTools.has(t)) {
				const known = [...new Set([...BUILTIN_TOOLS, ...ctx.parentTools.keys()])].filter((n) => !ORCHESTRATION_TOOLS.has(n));
				throw new Error(`unknown tool "${t}". Tools agents can use: ${known.join(", ")}`);
			}
		}
		tools = tools.filter((t) => !ORCHESTRATION_TOOLS.has(t));

		let schema: Record<string, unknown> | undefined;
		if (o.schema !== undefined) {
			const problem = findSchemaContradiction(o.schema);
			if (problem) throw new Error(`schema contradiction: ${problem}. No result could match it, so the agent did not start.`);
			schema = o.schema;
		}

		const cwd = o.cwd ? resolve(run.cwd, o.cwd) : run.cwd;
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd "${o.cwd}" is not a directory (resolved: ${cwd})`);

		let root: string | undefined;
		if (o.isolation === "worktree") {
			root = gitRoot(cwd);
			if (!root) throw new Error(`isolation "worktree" needs a git repository, but ${cwd} is not in one`);
		}

		const parts = [rec.prompt.trim()];
		if (o.context !== undefined) {
			const body = typeof o.context === "string" ? o.context : JSON.stringify(o.context, null, 2);
			parts.push(`<context>\n${body}\n</context>`);
		}
		if (o.instructions?.trim()) parts.push(o.instructions.trim());
		parts.push(agentPromptFooter(!!schema, schema ? describeSchema(schema) : undefined));

		const modelId = `${model.provider}/${model.id}`;
		const schemaHash = schema ? createHash("sha1").update(JSON.stringify(schema)).digest("hex").slice(0, 10) : "";
		const data: PlanData = {
			model,
			thinking,
			prompt: parts.join("\n\n"),
			schema,
			timeoutMs: o.timeout ? Math.round(o.timeout * 1000) : undefined,
			maxTurns: o.maxTurns,
			isolation: o.isolation === "worktree",
			gitRoot: root,
		};
		return {
			modelId,
			thinking,
			tools,
			cwd,
			retries: o.retries ?? 0,
			prefixKey: [modelId, thinking, tools.join(","), schemaHash, cwd, data.isolation ? rec.id : ""].join("|"),
			data,
		};
	}

	start(run: WorkflowRun, rec: AgentRecord, plan: AgentPlan, hooks: AttemptHooks): AttemptHandle {
		const data = plan.data as PlanData;
		const ctx = this.ctx;
		let session: AgentSession | undefined;
		let abortReason: AbortReason | "max_turns" | "validation" | undefined;
		const controller = new AbortController();
		/** Aborts when this attempt ends for any reason: its open dialogs close. */
		const attemptDone = new AbortController();
		const abort = (reason: AbortReason | "max_turns" | "validation") => {
			abortReason ??= reason;
			controller.abort();
			void session?.abort().catch(() => {});
		};

		const promise = (async (): Promise<AttemptOutcome> => {
			let worktree: WorktreeInfo | undefined;
			let agentCwd = plan.cwd;
			let unsubscribe: (() => void) | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let submitted: { value: unknown } | undefined;
			let submitFailures = 0;
			let lastValidationError: string | undefined;
			const aborted = (): AttemptOutcome => {
				if (abortReason === "timeout") {
					return { ok: false, reason: "timeout", message: `timed out after ${Math.round((data.timeoutMs ?? 0) / 1000)}s`, retryable: true, worktree };
				}
				if (abortReason === "max_turns") {
					return { ok: false, reason: "max_turns", message: `stopped after ${data.maxTurns} turns (maxTurns)`, retryable: false, worktree };
				}
				if (abortReason === "validation") {
					return {
						ok: false,
						reason: "validation",
						message: `the result failed schema validation ${submitFailures} times: ${lastValidationError ?? "unknown error"}`,
						retryable: false,
						worktree,
					};
				}
				return { ok: false, reason: "aborted", message: `aborted (${abortReason ?? "unknown"})`, retryable: false, worktree };
			};
			try {
				// Isolation: a fresh git worktree from HEAD.
				if (data.isolation && data.gitRoot) {
					rec.activity = "creating git worktree";
					hooks.onChange();
					worktree = await createWorktree(run, rec, data.gitRoot);
					agentCwd = join(worktree.path, relative(data.gitRoot, plan.cwd));
				}
				if (abortReason) return aborted();

				rec.activity = "loading";
				hooks.onChange();
				const settingsManager = SettingsManager.create(agentCwd, ctx.agentDir, { projectTrusted: ctx.projectTrusted });
				const loader = new DefaultResourceLoader({
					cwd: agentCwd,
					agentDir: ctx.agentDir,
					settingsManager,
					noExtensions: !ctx.loadExtensions,
					additionalExtensionPaths: ctx.cliExtensions,
					noPromptTemplates: true,
					noThemes: true,
					noSkills: !ctx.loadSkills,
					noContextFiles: !ctx.loadContextFiles,
					appendSystemPrompt: [agentPreamble(run.name)],
					extensionsOverride: (base) => ({
						...base,
						extensions: base.extensions.filter((e) => !ctx.excludeExtension(e.resolvedPath || e.path)),
					}),
				});
				await loader.reload();
				if (abortReason) return aborted();

				// Tools the agent session has itself; bridge the others to the main session.
				const native = new Set<string>(BUILTIN_TOOLS);
				for (const ext of loader.getExtensions().extensions) for (const name of ext.tools.keys()) native.add(name);
				const customTools: ToolDefinition[] = [];
				const toolNames = [...plan.tools];
				for (const name of plan.tools) {
					if (native.has(name)) continue;
					const info = ctx.parentTools.get(name);
					if (!info || !ctx.bridgeExec) {
						return {
							ok: false,
							reason: "error",
							message: `tool "${name}" exists only in the main session, and this run cannot reach it (start the workflow from the agent's workflow tool, not from a command)`,
							retryable: false,
							worktree,
						};
					}
					customTools.push(bridgedTool(run, info, ctx.bridgeExec.bind(ctx)));
				}
				if (data.schema) {
					const schema = data.schema;
					const params = toToolParameters(schema);
					customTools.push({
						name: SUBMIT_TOOL,
						label: "Submit result",
						description: "Submit your final result for the orchestration script. Call it once, when the task is complete. The arguments must match the result schema.",
						parameters: params.parameters as never,
						async execute(_id, args) {
							const value = params.wrapped ? (args as { value: unknown }).value : args;
							const check = validate(schema, value);
							if (!check.ok) {
								lastValidationError = check.errors.join("; ");
								throw new Error(`The result does not match the schema: ${lastValidationError}`);
							}
							submitted = { value };
							return {
								content: [{ type: "text", text: "Result recorded. Your task is complete: stop now." }],
								details: undefined,
								terminate: true,
							};
						},
					});
					toolNames.push(SUBMIT_TOOL);
				}

				const sessionManager = SessionManager.create(agentCwd, run.transcriptDir);
				const created = await createAgentSession({
					cwd: agentCwd,
					agentDir: ctx.agentDir,
					modelRuntime: ctx.modelRuntime,
					model: data.model,
					thinkingLevel: data.thinking,
					tools: toolNames,
					customTools,
					resourceLoader: loader,
					sessionManager,
					settingsManager,
				});
				session = created.session;
				rec.transcriptPath = session.sessionFile;
				const ui = ctx.childUi?.(run, rec, attemptDone.signal);
				await session.bindExtensions({
					...(ui ? { uiContext: ui, mode: "rpc" as const } : {}),
					onError: (e) => ctx.onExtensionError?.(run, rec, `${e.extensionPath}: ${e.error}`),
				});
				if (abortReason) return aborted();

				unsubscribe = session.subscribe((ev) => {
					onEvent(rec, ev, hooks, {
						onTurn: () => {
							if (data.maxTurns && rec.turns >= data.maxTurns && !submitted) abort("max_turns");
						},
						onSubmitError: (text) => {
							submitFailures++;
							lastValidationError ??= text;
							if (submitFailures >= ctx.structuredRetries) abort("validation");
						},
					});
				});
				if (data.timeoutMs) timer = setTimeout(() => abort("timeout"), data.timeoutMs);

				rec.activity = "thinking";
				hooks.onChange();
				await session.prompt(
					worktree ? `${data.prompt}\n\n${worktreeNote(agentCwd, worktree.branch)}` : data.prompt,
					{ expandPromptTemplates: false, source: "extension" },
				);

				if (data.schema) {
					let reminders = 0;
					while (!submitted && !abortReason && reminders < ctx.structuredRetries && !lastStopIsError(session)) {
						reminders++;
						rec.activity = `asking for ${SUBMIT_TOOL} (${reminders}/${ctx.structuredRetries})`;
						hooks.onChange();
						await session.prompt(structuredReminder(lastValidationError), { expandPromptTemplates: false, source: "extension" });
					}
				}

				if (data.schema && submitted) return { ok: true, value: submitted.value, worktree: await settleWorktree() };
				if (abortReason) return aborted();
				const last = lastAssistant(session);
				if (last?.stopReason === "error") {
					return { ok: false, reason: "error", message: oneLine(last.errorMessage ?? "provider error", 300), retryable: true, worktree: await settleWorktree() };
				}
				if (last?.stopReason === "aborted") return aborted();
				if (data.schema) {
					return {
						ok: false,
						reason: "validation",
						message: lastValidationError
							? `no valid ${SUBMIT_TOOL} call: ${lastValidationError}`
							: `the agent did not call ${SUBMIT_TOOL} after ${ctx.structuredRetries} reminders`,
						retryable: false,
						worktree: await settleWorktree(),
					};
				}
				return { ok: true, value: session.getLastAssistantText() ?? "", worktree: await settleWorktree() };
			} catch (err) {
				if (abortReason) return aborted();
				return { ok: false, reason: "error", message: oneLine((err as Error)?.message ?? String(err), 300), retryable: false, worktree };
			} finally {
				attemptDone.abort();
				if (timer) clearTimeout(timer);
				unsubscribe?.();
				if (session) {
					// Like AgentSessionRuntime.dispose(): extensions release timers and watchers
					// they started in session_start.
					try {
						const runner = session.extensionRunner;
						if (runner.hasHandlers("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "quit" });
					} catch {
						// ignore extension errors at shutdown
					}
					try {
						session.dispose();
					} catch {
						// ignore
					}
				}
			}

			async function settleWorktree(): Promise<WorktreeInfo | undefined> {
				if (!worktree || !data.gitRoot) return worktree;
				try {
					worktree = await finishWorktree(run, rec, worktree, data.gitRoot);
				} catch (err) {
					worktree = { ...worktree, diffStat: `worktree check failed: ${(err as Error).message}` };
				}
				return worktree;
			}
		})();

		const steer = async (text: string, by: "human" | "agent"): Promise<boolean> => {
			if (!session || abortReason) return false;
			try {
				const who = by === "human" ? "the user who watches this workflow run" : "the main agent that started this workflow";
				const note = `Message from ${who}. Take it into account for the rest of your task:\n${text}`;
				if (session.isStreaming) {
					await session.steer(note, undefined, { source: "extension" });
				} else {
					await session.followUp(note, undefined, { source: "extension" });
				}
				return true;
			} catch {
				return false;
			}
		};
		return { promise, abort: (reason) => abort(reason), steer };
	}
}

function lastAssistant(session: AgentSession): { stopReason?: string; errorMessage?: string } | undefined {
	const messages = session.messages as Array<{ role: string; stopReason?: string; errorMessage?: string }>;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i];
	return undefined;
}

function lastStopIsError(session: AgentSession): boolean {
	const s = lastAssistant(session)?.stopReason;
	return s === "error" || s === "aborted";
}

function bridgedTool(
	run: WorkflowRun,
	info: ToolInfo,
	exec: (run: WorkflowRun, name: string, args: unknown, signal: AbortSignal | undefined) => Promise<ToolOutcomeLike>,
): ToolDefinition {
	return {
		name: info.name,
		label: info.name,
		description: info.description,
		parameters: info.parameters,
		async execute(_id, args, signal) {
			const out = await exec(run, info.name, args, signal);
			if (out.isError) throw new Error(textOf(out.content) || `${info.name} failed`);
			return { content: out.content as never, details: undefined };
		},
	};
}

interface EventCallbacks {
	onTurn(): void;
	onSubmitError(text: string): void;
}

function onEvent(rec: AgentRecord, ev: AgentSessionEvent, hooks: AttemptHooks, cb: EventCallbacks): void {
	const e = ev as AgentSessionEvent & Record<string, any>;
	switch (e.type) {
		case "message_start":
			if (e.message?.role === "assistant") {
				rec.text = "";
				rec.activity = "thinking";
				hooks.onChange();
			}
			return;
		case "message_update": {
			const a = e.assistantMessageEvent as { type: string; delta?: string; toolName?: string } | undefined;
			if (!a) return;
			if (a.type === "text_delta" && a.delta) {
				hooks.onFirstToken();
				rec.text = (rec.text + a.delta).slice(-TEXT_TAIL);
				if (rec.activity !== "writing") {
					rec.activity = "writing";
				}
				hooks.onChange();
			} else if (a.type === "thinking_delta") {
				hooks.onFirstToken();
				if (rec.activity !== "thinking") {
					rec.activity = "thinking";
					hooks.onChange();
				}
			} else if (a.type === "toolcall_start") {
				hooks.onFirstToken();
				const partial = (e.assistantMessageEvent as { partial?: { content?: Array<{ type: string; name?: string }> } }).partial;
				const name = a.toolName ?? partial?.content?.filter((c) => c.type === "toolCall").pop()?.name;
				rec.activity = name ? `calling ${name}` : "calling a tool";
				hooks.onChange();
			}
			return;
		}
		case "message_end": {
			const m = e.message as { role?: string; usage?: Record<string, any>; stopReason?: string; errorMessage?: string } | undefined;
			if (m?.role !== "assistant") return;
			hooks.onFirstToken();
			const u = m.usage;
			if (u) {
				hooks.onUsage({
					input: u.input ?? 0,
					output: u.output ?? 0,
					cacheRead: u.cacheRead ?? 0,
					cacheWrite: u.cacheWrite ?? 0,
					totalTokens: u.totalTokens ?? 0,
					cost: u.cost?.total ?? 0,
				});
			}
			if (m.stopReason === "error" && m.errorMessage) rec.activity = `error: ${oneLine(m.errorMessage, 80)}`;
			hooks.onChange();
			return;
		}
		case "tool_execution_start": {
			if (e.parentToolCallId) return;
			const view: ToolCallView = {
				id: e.toolCallId,
				name: e.toolName,
				summary: summarizeToolArgs(e.toolName, e.args),
				status: "running",
				startedAt: Date.now(),
				argsPreview: previewJson(e.args, 600),
			};
			rec.toolCalls.push(view);
			if (rec.toolCalls.length > MAX_TOOL_VIEWS) rec.toolCalls.splice(0, rec.toolCalls.length - MAX_TOOL_VIEWS);
			rec.toolCallCount++;
			rec.activity = `${e.toolName}${view.summary ? `: ${view.summary}` : ""}`;
			hooks.onChange();
			return;
		}
		case "tool_execution_end": {
			if (e.parentToolCallId) return;
			const view = rec.toolCalls.find((t) => t.id === e.toolCallId);
			const text = textOf(e.result?.content);
			if (view) {
				view.status = e.isError ? "error" : "done";
				view.endedAt = Date.now();
				view.resultPreview = text.slice(0, 600);
			}
			if (e.toolName === SUBMIT_TOOL && e.isError) cb.onSubmitError(oneLine(text, 300));
			rec.activity = "thinking";
			hooks.onChange();
			return;
		}
		case "turn_end":
			rec.turns++;
			cb.onTurn();
			hooks.onChange();
			return;
		case "auto_retry_start":
			rec.activity = `retrying after error (${e.attempt}/${e.maxAttempts}): ${oneLine(String(e.errorMessage ?? ""), 60)}`;
			hooks.onChange();
			return;
		case "compaction_start":
			rec.activity = "compacting its context";
			hooks.onChange();
			return;
		default:
			return;
	}
}

async function createWorktree(run: WorkflowRun, rec: AgentRecord, root: string): Promise<WorktreeInfo> {
	const base = (await git(root, ["rev-parse", "HEAD"])).trim();
	const name = `${rec.id}-${slug(rec.label, 24)}`;
	const path = join(run.runDir, "worktrees", name);
	const branch = `workflow/${run.id}/${name}`;
	await git(root, ["worktree", "add", "-q", "-b", branch, path, base]);
	return { path, branch, base, changed: false };
}

async function finishWorktree(run: WorkflowRun, rec: AgentRecord, info: WorktreeInfo, root: string): Promise<WorktreeInfo> {
	const dirty = (await git(info.path, ["status", "--porcelain"])).trim().length > 0;
	if (dirty) {
		await git(info.path, ["add", "-A"]);
		await git(info.path, [
			"-c",
			"user.name=pi workflow",
			"-c",
			"user.email=workflow@pi.invalid",
			"commit",
			"-q",
			"--no-verify",
			"-m",
			`workflow ${run.name} (${run.id}) agent #${rec.id}: ${rec.label}`,
		]);
	}
	const head = (await git(info.path, ["rev-parse", "HEAD"])).trim();
	if (head === info.base) {
		await git(root, ["worktree", "remove", "--force", info.path]).catch(() => "");
		await git(root, ["branch", "-D", info.branch]).catch(() => "");
		return { ...info, changed: false };
	}
	const stat = (await git(info.path, ["diff", "--shortstat", `${info.base}..HEAD`])).trim();
	return { ...info, changed: true, diffStat: stat };
}
