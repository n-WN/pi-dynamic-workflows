/**
 * Launch flow of one workflow run:
 * source -> persisted script -> checks -> resume data -> approval -> executor -> run.
 */

import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
	ModelRuntime,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { BUILTIN_TOOLS, PiAgentExecutor } from "./agent-runner.ts";
import { createChildUi } from "./child-ui.ts";
import { SIZE_TARGETS, type WorkflowConfig } from "./config.ts";
import { CONTROL_TOOL, WORKFLOW_TOOL } from "./prompts.ts";
import { addRun, changed, getRegistry, serializeApproval } from "./registry.ts";
import { type ReplayData, WorkflowRun } from "./run.ts";
import { validate } from "./schema.ts";
import { type PreparedScript, prepareScript, ScriptError } from "./script.ts";
import { consentKey, discoverWorkflows, findWorkflow, loadConsent, repoRoot, runsRoot, type SavedWorkflow, saveConsent } from "./store.ts";
import type { JournalEntry, RunSnapshot, ThinkingLevel, WorkflowSource } from "./types.ts";
import { type ApprovalChoice, ApprovalDialog, type ApprovalInfo } from "./ui/approval.ts";

export interface LaunchParams {
	script?: string;
	name?: string;
	scriptPath?: string;
	args?: unknown;
	resumeFromRunId?: string;
	wait?: boolean;
}

export type LaunchOutcome =
	| { kind: "started"; run: WorkflowRun; notes: string[] }
	| { kind: "error"; message: string; scriptPath?: string; name?: string }
	| { kind: "declined"; name: string; feedback?: string; scriptPath: string };

export interface LaunchDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	toolCtx?: ExtensionToolContext;
	cfg: WorkflowConfig;
	agentDir: string;
	sessionId: string;
	bundledDir: string;
	selfDirs: string[];
	hostUi: () => ExtensionUIContext | undefined;
}

function expandHome(p: string): string {
	return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function newRunId(): string {
	const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
	const bytes = randomBytes(6);
	let id = "";
	for (const b of bytes) id += alphabet[b % alphabet.length];
	return `wf-${id}`;
}

export function runDirOf(agentDir: string, sessionId: string, runId: string): string {
	return join(runsRoot(agentDir), sessionId, runId);
}

interface PreviousRun {
	snapshot: RunSnapshot;
	scriptPath: string;
	replay: ReplayData;
}

function loadPrevious(deps: LaunchDeps, runId: string): PreviousRun | { error: string } {
	const live = getRegistry().runs.get(runId);
	if (live && live.sessionId !== deps.sessionId) return { error: `Run ${runId} belongs to another session. Resume works only in the session that started the run.` };
	if (live && !live.isFinal) {
		return { error: `Run ${runId} is still ${live.status}. Stop it first (workflow_control stop) or wait for its result.` };
	}
	const dir = runDirOf(deps.agentDir, deps.sessionId, runId);
	const runFile = join(dir, "run.json");
	if (!existsSync(runFile)) {
		return { error: `Nothing to resume: run ${runId} was not found in this session. Start the workflow as a new run instead.` };
	}
	let snapshot: RunSnapshot;
	try {
		snapshot = JSON.parse(readFileSync(runFile, "utf8")) as RunSnapshot;
	} catch (err) {
		return { error: `Run ${runId} has an unreadable run.json: ${(err as Error).message}` };
	}
	const replay: ReplayData = { fromRunId: runId, agents: new Map(), questions: new Map() };
	try {
		const text = readFileSync(join(dir, "journal.jsonl"), "utf8");
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const e = JSON.parse(line) as JournalEntry;
			if (e.type === "agent") replay.agents.set(e.id, e);
			else if (e.type === "question") replay.questions.set(e.id, e);
		}
	} catch {
		// No journal: nothing completed, so nothing is reused.
	}
	return { snapshot, scriptPath: snapshot.scriptPath || join(dir, "script.js"), replay };
}

function formatScriptError(err: unknown, scriptPath: string): string {
	const detail = err instanceof ScriptError ? err.format(scriptPath) : String((err as Error)?.message ?? err);
	return `The workflow script has a problem, so the run did not start.\n${detail}\nFix it: edit ${scriptPath} and call workflow({ scriptPath: "${scriptPath}" }) again, or pass a corrected script.`;
}

function modelFinder(ctx: ExtensionContext) {
	const registry = ctx.modelRegistry;
	const scoped = ctx.scopedModels.map((s) => s.model);
	const same = (a: Model<any>, b: Model<any>) => a.provider === b.provider && a.id === b.id;
	const available = (): Model<any>[] => {
		const all = registry.getAvailable();
		return [...scoped.filter((m) => all.some((x) => same(x, m))), ...all.filter((m) => !scoped.some((s) => same(s, m)))];
	};
	const find = (spec: string): Model<any> | undefined => {
		const s = spec.trim();
		const slash = s.indexOf("/");
		if (slash > 0) {
			const m = registry.find(s.slice(0, slash), s.slice(slash + 1));
			if (m) return m;
		}
		const list = available();
		const lower = s.toLowerCase();
		return (
			list.find((m) => m.id === s) ??
			list.find((m) => m.id.toLowerCase() === lower) ??
			list.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(lower) || (m.name ?? "").toLowerCase().includes(lower))
		);
	};
	return { find, list: () => available().map((m) => `${m.provider}/${m.id}`) };
}

function realOr(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

const NOT_FOR_AGENTS = new Set([WORKFLOW_TOOL, CONTROL_TOOL, "codemode", "tool_search"]);

export function agentToolNames(pi: ExtensionAPI): { parentTools: Map<string, ToolInfo>; available: string[] } {
	const parentTools = new Map<string, ToolInfo>();
	for (const t of pi.getAllTools()) {
		// codemode and tool_search work on the main session's own tool set; agents cannot use them.
		if (t.exposure === "hidden" || NOT_FOR_AGENTS.has(t.name)) continue;
		parentTools.set(t.name, t);
	}
	const builtins = [...BUILTIN_TOOLS].filter((n) => n !== "powershell" || process.platform === "win32");
	return { parentTools, available: [...new Set([...builtins, ...parentTools.keys()])] };
}

/**
 * Extension paths from the pi command line (-e / --extension), resolved against the
 * start directory, and whether --no-extensions was given. Built-in extensions
 * (builtin:...) are left out: an agent does not need its own MCP connections.
 */
export function cliExtensionArgs(): { paths: string[]; noExtensions: boolean } {
	const argv = process.argv.slice(2);
	const paths: string[] = [];
	let noExtensions = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-ne" || a === "--no-extensions") noExtensions = true;
		else if ((a === "-e" || a === "--extension") && argv[i + 1]) paths.push(argv[++i]);
		else if (a.startsWith("--extension=")) paths.push(a.slice("--extension=".length));
	}
	return {
		paths: paths.filter((p) => !p.startsWith("builtin:") && !/^(npm|git):/.test(p)).map((p) => resolve(process.cwd(), expandHome(p))),
		noExtensions,
	};
}

export function defaultAgentTools(pi: ExtensionAPI, cfg: WorkflowConfig): string[] {
	if (cfg.agentTools) return cfg.agentTools;
	const active = pi.getActiveTools().filter((t) => BUILTIN_TOOLS.has(t));
	return active.length ? active : ["read", "bash", "edit", "write"];
}

async function approve(deps: LaunchDeps, info: ApprovalInfo, source: { text: string; prepared: PreparedScript }, scriptPath: string): Promise<{ ok: true } | { ok: false; feedback?: string }> {
	const { ctx, cfg, agentDir, sessionId } = deps;
	const reg = getRegistry();
	if (!ctx.hasUI || cfg.approval === "never" || reg.autoApprove.has(sessionId)) return { ok: true };
	const consent = loadConsent(agentDir);
	const key = consentKey(ctx.cwd, info.name);
	if (info.named && consent.skip[key]) return { ok: true };
	if (cfg.approval === "first" && consent.firstLaunchApproved) return { ok: true };

	const record = (choice: ApprovalChoice) => {
		const c = loadConsent(agentDir);
		c.firstLaunchApproved = true;
		if (choice.action === "run-always") c.skip[key] = true;
		saveConsent(agentDir, c);
		if (choice.action === "run-session") reg.autoApprove.add(sessionId);
	};

	return serializeApproval(async () => {
		if (ctx.mode !== "tui") {
			const options = ["Yes, run it", "Yes, and approve all workflows in this session", "No"];
			const pick = await ctx.ui.select(`Run workflow ${info.name}? ${info.description} (${info.phases.join(" → ") || "no phases listed"})`, options);
			if (pick === options[0]) {
				record({ action: "run" });
				return { ok: true };
			}
			if (pick === options[1]) {
				record({ action: "run-session" });
				return { ok: true };
			}
			return { ok: false };
		}
		for (;;) {
			const choice = await ctx.ui.custom<ApprovalChoice>((tui, theme, _kb, done) => new ApprovalDialog(tui, theme, info, done), {
				overlay: true,
				overlayOptions: { width: "86%", maxHeight: "88%", anchor: "center" },
			});
			if (!choice || choice.action === "decline") return { ok: false, feedback: choice?.feedback };
			if (choice.action === "edit") {
				const edited = await ctx.ui.editor(`Edit workflow ${info.name} — the run starts from your version`, source.text);
				if (edited !== undefined && edited.trim() && edited !== source.text) {
					try {
						const prepared = prepareScript(edited, scriptPath);
						source.text = edited;
						source.prepared = prepared;
						writeFileSync(scriptPath, edited);
						Object.assign(info, {
							name: prepared.meta.name,
							description: prepared.meta.description,
							phases: prepared.meta.phases ?? [],
							script: edited,
							lineCount: prepared.lineCount,
							edited: true,
						});
					} catch (err) {
						ctx.ui.notify(`The edited script was not applied:\n${err instanceof ScriptError ? err.format(scriptPath) : (err as Error).message}`, "error");
					}
				}
				continue;
			}
			record(choice);
			return { ok: true };
		}
	});
}

export async function launchWorkflow(params: LaunchParams, deps: LaunchDeps): Promise<LaunchOutcome> {
	const { pi, ctx, cfg, agentDir, sessionId } = deps;
	if (!cfg.enabled) return { kind: "error", message: "Dynamic workflows are turned off (workflows.enabled is false or PI_DISABLE_WORKFLOWS is set)." };

	// 1. Source.
	let prev: PreviousRun | undefined;
	if (params.resumeFromRunId) {
		const p = loadPrevious(deps, params.resumeFromRunId.trim());
		if ("error" in p) return { kind: "error", message: p.error };
		prev = p;
	}
	let text: string;
	let source: WorkflowSource;
	if (params.scriptPath) {
		const path = resolve(ctx.cwd, expandHome(params.scriptPath));
		if (!existsSync(path)) return { kind: "error", message: `scriptPath ${path} does not exist.` };
		text = readFileSync(path, "utf8");
		source = { kind: "file", path };
	} else if (params.name) {
		const list = discoverWorkflows({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted(), bundledDir: deps.bundledDir });
		const w: SavedWorkflow | undefined = findWorkflow(list, params.name.trim());
		if (!w) {
			const names = list.filter((x) => !x.error).map((x) => x.name);
			return { kind: "error", message: `No saved workflow named "${params.name}". Available: ${names.join(", ") || "none"}.` };
		}
		text = readFileSync(w.path, "utf8");
		source = { kind: w.scope === "bundled" ? "bundled" : "saved", name: w.name, path: w.path, scope: w.scope };
	} else if (params.script) {
		text = params.script;
		source = { kind: "inline" };
	} else if (prev) {
		try {
			text = readFileSync(prev.scriptPath, "utf8");
		} catch {
			return { kind: "error", message: `The script of run ${prev.snapshot.id} (${prev.scriptPath}) is missing. Pass script or scriptPath.` };
		}
		source = prev.snapshot.source ?? { kind: "file", path: prev.scriptPath };
	} else {
		return { kind: "error", message: "Pass one of: script (inline source), scriptPath, name (saved workflow), or resumeFromRunId." };
	}

	// 2. Persist the script first, so the agent can edit the file even when a check fails.
	const runId = newRunId();
	const runDir = runDirOf(agentDir, sessionId, runId);
	const scriptPath = join(runDir, "script.js");
	const transcriptDir = join(runDir, "agents");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(scriptPath, text);

	// 3. Checks.
	let prepared: PreparedScript;
	try {
		prepared = prepareScript(text, scriptPath);
	} catch (err) {
		return { kind: "error", message: formatScriptError(err, scriptPath), scriptPath };
	}
	let args = params.args !== undefined ? params.args : prev?.snapshot.args;
	const notes: string[] = [];
	// Some models send objects as JSON strings. Parse them unless meta.args takes that string.
	if (typeof args === "string") {
		const t = args.trim();
		const looksJson = (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
		if (looksJson) {
			try {
				const parsed = JSON.parse(t) as unknown;
				// Use the parsed value when it fits meta.args (or when there is no schema).
				if (!prepared.meta.args || validate(prepared.meta.args, parsed).ok) {
					args = parsed;
					notes.push("args arrived as a JSON string; it was parsed into a JSON value. Next time pass objects and arrays as JSON values.");
				}
			} catch {
				// keep the string
			}
		}
	}
	if (args !== undefined && prepared.meta.args) {
		const check = validate(prepared.meta.args, args);
		if (!check.ok) {
			return {
				kind: "error",
				message: `args do not match meta.args of ${prepared.meta.name}: ${check.errors.join("; ")}. Schema: ${JSON.stringify(prepared.meta.args)}`,
				scriptPath,
			};
		}
	}

	// 4. Executor context.
	const modelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
	if (!modelRuntime) return { kind: "error", message: "This pi version does not expose its model runtime to extensions; workflows cannot start agents." };
	const defaultModel = ctx.model;
	if (!defaultModel) return { kind: "error", message: "No model is selected in this session. Select one with /model first." };
	const finder = modelFinder(ctx);
	const thinking = pi.getThinkingLevel() as ThinkingLevel;
	const { parentTools, available } = agentToolNames(pi);
	const defaultTools = defaultAgentTools(pi, cfg);
	const reg = getRegistry();
	const selfDirs = deps.selfDirs.flatMap((d) => [d, realOr(d)]);
	const exclude = (path: string) => {
		const real = realOr(path);
		return selfDirs.some((d) => path.startsWith(d) || real.startsWith(d)) || cfg.agentExtensionsExclude.some((p) => path.includes(p));
	};
	const toolCtx = deps.toolCtx;
	const cli = cliExtensionArgs();
	const executor = new PiAgentExecutor({
		agentDir,
		modelRuntime,
		findModel: finder.find,
		listModels: finder.list,
		defaultModel,
		defaultThinking: thinking,
		configModel: cfg.agentModel,
		configThinking: cfg.agentThinking,
		parentTools,
		defaultTools,
		projectTrusted: ctx.isProjectTrusted(),
		loadExtensions: cfg.agentExtensions && !cli.noExtensions,
		cliExtensions: cfg.agentExtensions ? cli.paths.filter((p) => !exclude(p)) : [],
		loadSkills: cfg.agentSkills,
		loadContextFiles: cfg.agentContextFiles,
		excludeExtension: exclude,
		structuredRetries: cfg.structuredOutputRetries,
		childUi: ctx.hasUI
			? (run, rec, signal) =>
					createChildUi({
						signal,
						parentUi: deps.hostUi,
						dialogs: reg.dialogs,
						source: `${run.name} #${rec.id} ${rec.label}`,
						runId: run.id,
						agentId: rec.id,
						onWaiting: (what) => {
							rec.waitingFor = what;
							if (what && rec.status === "running") rec.status = "waiting";
							else if (!what && rec.status === "waiting") rec.status = "running";
							changed();
						},
					})
			: undefined,
		bridgeExec: toolCtx
			? async (_run, name, toolArgs, signal) => {
					const outcome = await toolCtx.executeTool(name, toolArgs, { signal });
					return { content: outcome.result.content as Array<{ type: string; text?: string }>, isError: outcome.isError };
				}
			: undefined,
		onExtensionError: (run, rec, error) => run.log("warn", `Agent #${rec.id} (${rec.label}): extension error: ${error}`),
	});

	// 5. Approval.
	const srcLabel =
		source.kind === "inline" ? "written for this task" : source.kind === "file" ? "file" : `${source.kind} workflow ${source.name ?? ""}`.trim();
	const target = SIZE_TARGETS[cfg.sizeGuideline];
	const info: ApprovalInfo = {
		name: prepared.meta.name,
		description: prepared.meta.description,
		phases: prepared.meta.phases ?? [],
		source: srcLabel,
		lineCount: prepared.lineCount,
		scriptPath,
		script: text,
		args,
		limits: `up to ${cfg.maxConcurrency} at once · at most ${cfg.maxAgents} per run${target ? ` · guideline: fewer than ${target}` : ""}`,
		model: `${defaultModel.provider}/${defaultModel.id} · thinking ${thinking} (the script can choose other models)`,
		named: source.kind !== "inline",
		edited: false,
		resumeFrom: prev?.snapshot.id,
		notes: [],
	};
	const src = { text, prepared };
	const decision = await approve(deps, info, src, scriptPath);
	if (!decision.ok) return { kind: "declined", name: info.name, feedback: decision.feedback, scriptPath };
	prepared = src.prepared;

	// 6. Run.
	const env = {
		cwd: ctx.cwd,
		runId,
		name: prepared.meta.name,
		sessionId,
		model: `${defaultModel.provider}/${defaultModel.id}`,
		thinking,
		tools: available,
		defaultTools,
		gitRepo: !!repoRoot(ctx.cwd),
		platform: process.platform,
	};
	const run = new WorkflowRun({
		id: runId,
		prepared,
		source,
		sessionId,
		cwd: ctx.cwd,
		runDir,
		scriptPath,
		transcriptDir,
		args,
		seed: prev?.snapshot.seed ?? randomInt(1, 2 ** 31 - 1),
		env,
		limits: { maxConcurrency: cfg.maxConcurrency, maxAgents: cfg.maxAgents, maxItems: cfg.maxItems },
		prefixStaggerMs: cfg.prefixStaggerMs,
		largeWorkflowAgents: cfg.largeWorkflowAgents,
		largeWorkflowTokens: cfg.largeWorkflowTokens,
		targetAgents: target,
		executor,
		replay: prev?.replay,
		resumedFrom: prev?.snapshot.id,
		foreground: !!params.wait,
	});
	addRun(run);
	run.start();
	if (prev) run.log("info", `Relaunch of ${prev.snapshot.id}: unchanged completed agents reuse their saved results.`);
	for (const n of notes) run.log("warn", n);
	return { kind: "started", run, notes };
}

/** Run snapshots of this session on disk that are not in memory (after a restart). */
export function loadPastRuns(agentDir: string, sessionId: string, exclude: Set<string>): RunSnapshot[] {
	const dir = join(runsRoot(agentDir), sessionId);
	const out: RunSnapshot[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		if (exclude.has(name)) continue;
		try {
			const snap = JSON.parse(readFileSync(join(dir, name, "run.json"), "utf8")) as RunSnapshot;
			// A run that was "running" when pi exited did not finish.
			if (snap.status === "running" || snap.status === "paused") {
				snap.status = "stopped";
				snap.error ??= "Interrupted: pi exited while the run was going on.";
				snap.endedAt ??= snap.startedAt;
			}
			out.push(snap);
		} catch {
			// skip broken runs
		}
	}
	return out;
}
