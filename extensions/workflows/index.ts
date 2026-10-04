/**
 * pi dynamic workflows.
 *
 * The agent writes a JavaScript orchestration script; a runtime executes it in
 * the background and runs many subagents; the final result comes back to the
 * conversation. See README.md and DESIGN.md.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	type ExtensionUIContext,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, type KeyId, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { configFilePath, loadConfig, readGlobalPiSettings, saveConfigValue, type WorkflowConfig } from "./config.ts";
import { countAgents, formatDuration, formatTokens, oneLine } from "./format.ts";
import { type LaunchParams, launchWorkflow, loadPastRuns } from "./launcher.ts";
import {
	CONTROL_TOOL,
	CONTROL_TOOL_DESCRIPTION,
	keywordOptInText,
	ultracodeSection,
	WORKFLOW_TOOL,
	WORKFLOW_TOOL_SNIPPET,
	workflowToolDescription,
	workflowToolGuidelines,
	workflowsSection,
} from "./prompts.ts";
import { activeRuns, getRegistry, type RegistryHost, runsOfSession } from "./registry.ts";
import { resultDetails, resultText, statusText } from "./results.ts";
import type { WorkflowRun } from "./run.ts";
import { acceptsString, validate } from "./schema.ts";
import { renameScript } from "./script.ts";
import { discoverWorkflows, findWorkflow, personalWorkflowDir, projectSaveDir, runsRoot, type SavedWorkflow, saveWorkflowFile } from "./store.ts";
import type { RunSnapshot } from "./types.ts";
import { KeywordEditor, keywordRegex } from "./ui/editor.ts";
import { WorkflowMonitor } from "./ui/monitor.ts";
import {
	renderOptInMessage,
	renderResultMessage,
	renderWorkflowCall,
	renderWorkflowResult,
	type WorkflowToolArgs,
	type WorkflowToolDetails,
} from "./ui/renderers.ts";
import { WorkflowWidget } from "./ui/widget.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, "..", "..");
const BUNDLED_DIR = join(PACKAGE_DIR, "workflows");
const SKILLS_DIR = join(PACKAGE_DIR, "skills");
const RESULT_TYPE = "workflow-result";
const OPTIN_TYPE = "workflow-optin";
const ULTRACODE_ENTRY = "workflows-ultracode";

export default function workflowsExtension(pi: ExtensionAPI): void {
	const reg = getRegistry();
	const agentDir = getAgentDir();
	// Settings that exist before a session starts (descriptions are fixed at registration).
	let cfg: WorkflowConfig = loadConfig(readGlobalPiSettings(agentDir), agentDir);
	const OPEN_KEY = cfg.shortcut;

	let ctxRef: ExtensionContext | undefined;
	let sessionId = "";
	let ultracode = false;
	let keywordPending = false;
	let keywordDismissed = false;
	let saved: SavedWorkflow[] = [];
	const commandNames = new Set<string>();
	/** Open dialogs of ask() questions, so an answer from elsewhere can close them. */
	const questionDialogs = new Map<string, AbortController>();

	const ui = (): ExtensionUIContext | undefined => {
		try {
			return ctxRef?.hasUI ? ctxRef.ui : undefined;
		} catch {
			return undefined; // stale context after a reload
		}
	};
	const interactive = () => ctxRef?.mode === "tui" || ctxRef?.mode === "rpc";

	// ---------------------------------------------------------------------------
	// Result delivery
	// ---------------------------------------------------------------------------

	const deliver = (run: WorkflowRun) => {
		if (run.foreground || run.delivered || run.sessionId !== sessionId) return;
		// Print and JSON mode: agent_before_settle waits for runs and appends the results.
		if (!interactive()) return;
		run.delivered = true;
		run.persistNow();
		try {
			pi.sendMessage(
				{ customType: RESULT_TYPE, content: resultText(run, cfg.resultMaxChars), display: true, details: resultDetails(run) },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			run.delivered = false;
			return;
		}
		const level = run.status === "completed" ? "info" : run.status === "failed" ? "error" : "warning";
		ui()?.notify(`Workflow ${run.name} ${run.status} after ${formatDuration(run.elapsedMs())}. The result went to the agent.`, level);
	};

	const host: RegistryHost = {
		onRunEnd: (run) => deliver(run),
		onQuestion: (run, q) => {
			// Ask at once (inline when the monitor is open). Esc means "later": the
			// question stays open in /workflows.
			const target = ui();
			if (!target) return;
			const controller = new AbortController();
			questionDialogs.set(`${run.id}:${q.id}`, controller);
			const options = q.options?.length ? [...q.options] : undefined;
			if (options && q.default && !options.includes(q.default)) options.push(q.default);
			const title = `[${run.name}] ${q.question}`;
			void reg.dialogs
				.run(
					{ kind: options ? "select" : "input", title: q.question, options, prefill: q.default ?? undefined, source: run.name, runId: run.id, questionId: q.id },
					(u) => (options ? u.select(title, options, { signal: controller.signal }) : u.input(title, q.default ?? "", { signal: controller.signal })),
					ui,
				)
				.then((answer) => {
					questionDialogs.delete(`${run.id}:${q.id}`);
					if (typeof answer === "string" && q.status === "pending") run.answerQuestion(q.id, answer, "human");
					else if (q.status === "pending" && !reg.monitorOpen) ui()?.notify(`${run.name} still waits for your answer. ${OPEN_KEY} opens /workflows; a answers.`, "warning");
				});
		},
		onQuestionClosed: (run, q) => {
			questionDialogs.get(`${run.id}:${q.id}`)?.abort();
			questionDialogs.delete(`${run.id}:${q.id}`);
		},
		onWarning: (run, text) => {
			ui()?.notify(`${run.name}: ${text} See /workflows to stop it.`, "warning");
		},
		canAsk: () => !!ui(),
		ui,
	};

	// ---------------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------------

	const launchedText = (run: WorkflowRun, notes: string[] = []): string =>
		[
			`Workflow "${run.name}" started in the background (run ${run.id}).`,
			...notes.map((n) => `Note: ${n}`),
			run.phases.length ? `Phases: ${run.phases.map((p) => p.title).join(" → ")}` : "",
			`Script: ${run.scriptPath}`,
			`Agent transcripts: ${run.transcriptDir}`,
			`The result arrives as a <workflow-result run="${run.id}"> message when the run ends. Do not poll: continue with other work or end your turn. Use ${CONTROL_TOOL} to inspect, answer questions, or stop it.`,
		]
			.filter(Boolean)
			.join("\n");

	const launchedDetails = (run: WorkflowRun, status: WorkflowToolDetails["status"]): WorkflowToolDetails => ({
		status,
		runId: run.id,
		name: run.name,
		description: run.description,
		phases: run.phases.map((p) => p.title),
		scriptPath: run.scriptPath,
		transcriptDir: run.transcriptDir,
		final: run.isFinal
			? {
					status: run.status,
					durationMs: run.elapsedMs(),
					agents: run.agents.length,
					failed: countAgents(run.agents).failed,
					tokens: run.usage.totalTokens,
				}
			: undefined,
	});

	const launch = (params: LaunchParams, ctx: ExtensionContext, toolCtx?: ExtensionToolContext) =>
		launchWorkflow(params, {
			pi,
			ctx,
			toolCtx,
			cfg,
			agentDir,
			sessionId: ctx.sessionManager.getSessionId(),
			bundledDir: BUNDLED_DIR,
			selfDirs: [PACKAGE_DIR, HERE],
			hostUi: ui,
		});

	pi.registerTool({
		name: WORKFLOW_TOOL,
		label: "Workflow",
		description: workflowToolDescription(cfg),
		promptSnippet: WORKFLOW_TOOL_SNIPPET,
		promptGuidelines: workflowToolGuidelines(cfg),
		parameters: Type.Object({
			script: Type.Optional(
				Type.String({ description: "Inline workflow script. It must begin with export const meta = { name, description, phases? }." }),
			),
			name: Type.Optional(Type.String({ description: "Name of a saved or bundled workflow (see the saved list in the system prompt)." })),
			scriptPath: Type.Optional(
				Type.String({ description: "Path of a workflow script file, for example the scriptPath of an earlier run after you edited it. Takes precedence over script and name." }),
			),
			args: Type.Optional(Type.Any({ description: "Input value for the script's args global. Pass arrays and objects as JSON values, not as JSON strings." })),
			resumeFromRunId: Type.Optional(
				Type.String({ description: "Run ID of an earlier run in this session to relaunch. Completed agents with unchanged inputs return their saved results." }),
			),
			wait: Type.Optional(Type.Boolean({ description: "Wait for the run to end and return its result in this call. Default: false (the run goes on in the background)." })),
		}),
		renderCall: (args, theme, context) => renderWorkflowCall(args as WorkflowToolArgs, theme, context),
		renderResult: (result, options, theme, context) =>
			renderWorkflowResult(result as never, options, theme, context as never),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const outcome = await launch(params as LaunchParams, ctx, ctx);
			if (outcome.kind === "error") {
				return {
					content: [{ type: "text", text: outcome.message }],
					details: { status: "error", error: outcome.message, scriptPath: outcome.scriptPath } satisfies WorkflowToolDetails,
					isError: true,
				};
			}
			if (outcome.kind === "declined") {
				const text = outcome.feedback
					? `The user declined to run the workflow "${outcome.name}" and wrote: ${outcome.feedback}\nRevise the plan or the script (${outcome.scriptPath}) and ask again, or continue without a workflow.`
					: `The user declined to run the workflow "${outcome.name}". Do not start it again unless the user asks; continue without a workflow or ask what to change.`;
				return {
					content: [{ type: "text", text }],
					details: { status: "declined", name: outcome.name, feedback: outcome.feedback, scriptPath: outcome.scriptPath } satisfies WorkflowToolDetails,
					isError: true,
				};
			}
			const run = outcome.run;
			if (!params.wait) {
				return { content: [{ type: "text", text: launchedText(run, outcome.notes) }], details: launchedDetails(run, "launched") };
			}
			// Foreground: report progress until the run ends.
			let lastUpdate = 0;
			const off = run.subscribe({
				onChange: () => {
					const now = Date.now();
					if (now - lastUpdate < 500) return;
					lastUpdate = now;
					const c = countAgents(run.agents);
					onUpdate?.({
						content: [{ type: "text", text: `${run.name}: ${c.done + c.cached}/${c.total} agents done · ${formatTokens(run.usage.totalTokens)} tokens` }],
						details: launchedDetails(run, "launched"),
					});
				},
			});
			const aborted = new Promise<void>((r) => {
				if (signal?.aborted) r();
				signal?.addEventListener("abort", () => r(), { once: true });
			});
			await Promise.race([run.whenEnded(), aborted]);
			off();
			if (!run.isFinal) {
				run.foreground = false;
				return {
					content: [
						{
							type: "text",
							text: `Stopped waiting (the turn was aborted). Run ${run.id} goes on in the background; its result arrives as a <workflow-result> message.`,
						},
					],
					details: launchedDetails(run, "launched"),
				};
			}
			run.delivered = true;
			run.persistNow();
			return {
				content: [{ type: "text", text: resultText(run, cfg.resultMaxChars) }],
				details: launchedDetails(run, "done"),
				isError: run.status !== "completed",
			};
		},
	});

	pi.registerTool({
		name: CONTROL_TOOL,
		label: "Workflow control",
		description: CONTROL_TOOL_DESCRIPTION,
		promptSnippet: "Inspect, wait for, answer, pause, or stop dynamic workflow runs",
		parameters: Type.Object({
			action: Type.Union(
				["list", "status", "wait", "stop", "pause", "resume", "answer", "steer"].map((a) => Type.Literal(a)),
				{ description: "What to do." },
			),
			runId: Type.Optional(Type.String({ description: "Run ID, such as wf-k3x9ab." })),
			agent: Type.Optional(Type.Number({ description: "Agent number (#n) for stop." })),
			question: Type.Optional(Type.Number({ description: "Question number for answer." })),
			answer: Type.Optional(Type.String({ description: "Answer text for answer." })),
			message: Type.Optional(Type.String({ description: "For steer: a message to a running agent (correction or extra instruction)." })),
			timeout: Type.Optional(Type.Number({ description: "For wait: give up after this many seconds (default 600)." })),
		}),
		renderCall: (args, theme) => {
			const a = args as { action?: string; runId?: string; agent?: number };
			return new Text(
				`${theme.fg("toolTitle", theme.bold("workflow_control "))}${theme.fg("accent", a.action ?? "")}${a.runId ? theme.fg("muted", ` ${a.runId}`) : ""}${a.agent !== undefined ? theme.fg("muted", ` #${a.agent}`) : ""}`,
				0,
				0,
			);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sid = ctx.sessionManager.getSessionId();
			const runs = runsOfSession(sid);
			const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, isError });
			const pick = (): WorkflowRun | string => {
				const wanted = params.runId?.trim();
				if (!wanted) return "Pass runId.";
				const r = runs.find((x) => x.id === wanted || x.name === wanted);
				return r ?? `No run ${params.runId} in this session. Runs: ${runs.map((x) => x.id).join(", ") || "none"}.`;
			};
			switch (params.action) {
				case "list": {
					if (!runs.length) return text("No workflow runs in this session.");
					return text(
						runs
							.map((r) => {
								const c = countAgents(r.agents);
								return `${r.id} ${r.name}: ${r.status} · ${formatDuration(r.elapsedMs())} · ${c.total} agents (${c.done + c.cached} done, ${c.active} running, ${c.failed} failed) · ${formatTokens(r.usage.totalTokens)} tokens${r.delivered ? " · result delivered" : ""}`;
							})
							.join("\n"),
					);
				}
				case "status": {
					if (params.runId) {
						const r = pick();
						return typeof r === "string" ? text(r, true) : text(statusText(r));
					}
					const act = runs.filter((r) => !r.isFinal);
					if (!act.length) return text(runs.length ? "No active runs. Use action list to see finished runs." : "No workflow runs in this session.");
					return text(act.map(statusText).join("\n\n"));
				}
				case "wait": {
					const targets = params.runId ? [pick()] : runs.filter((r) => !r.isFinal);
					const bad = targets.find((t) => typeof t === "string");
					if (bad) return text(bad as string, true);
					const list = targets as WorkflowRun[];
					if (!list.length) return text("No active runs to wait for.");
					const timeoutMs = Math.max(1, params.timeout ?? 600) * 1000;
					let timer: ReturnType<typeof setTimeout> | undefined;
					const timeout = new Promise<void>((r) => {
						timer = setTimeout(r, timeoutMs);
					});
					const aborted = new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true }));
					await Promise.race([Promise.all(list.map((r) => r.whenEnded())), timeout, aborted]);
					if (timer) clearTimeout(timer);
					const out: string[] = [];
					for (const r of list) {
						if (r.isFinal) {
							r.delivered = true;
							r.persistNow();
							out.push(resultText(r, cfg.resultMaxChars));
						} else out.push(`Run ${r.id} is still ${r.status} after the wait.\n${statusText(r)}`);
					}
					return text(out.join("\n\n"));
				}
				case "stop": {
					const r = pick();
					if (typeof r === "string") return text(r, true);
					if (params.agent !== undefined) {
						return r.stopAgent(params.agent)
							? text(`Stopping agent #${params.agent} of ${r.id}. The script gets null for it.`)
							: text(`Agent #${params.agent} of ${r.id} is not running or queued.`, true);
					}
					if (r.isFinal) return text(`Run ${r.id} already ended (${r.status}).`);
					r.stop("Stopped by the agent.");
					return text(`Stopped run ${r.id}. Completed agent results are saved; relaunch with workflow({ resumeFromRunId: "${r.id}" }).`);
				}
				case "pause":
				case "resume": {
					const r = pick();
					if (typeof r === "string") return text(r, true);
					if (params.action === "pause") r.pause();
					else r.resume();
					return text(`Run ${r.id} is ${r.status}.`);
				}
				case "answer": {
					const r = pick();
					if (typeof r === "string") return text(r, true);
					if (params.question === undefined || params.answer === undefined) return text("Pass question (number) and answer (text).", true);
					return r.answerQuestion(params.question, params.answer, "agent")
						? text(`Answered question ${params.question} of ${r.id}.`)
						: text(`Question ${params.question} of ${r.id} does not wait for an answer.`, true);
				}
				case "steer": {
					const r = pick();
					if (typeof r === "string") return text(r, true);
					if (params.agent === undefined || !params.message?.trim()) return text("Pass agent (number) and message (text).", true);
					return (await r.steerAgent(params.agent, params.message, "agent"))
						? text(`Sent the message to agent #${params.agent} of ${r.id}. It reads it after its current step.`)
						: text(`Agent #${params.agent} of ${r.id} is not running, so it cannot take a message.`, true);
				}
				default:
					return text(`Unknown action ${String(params.action)}.`, true);
			}
		},
	});

	// ---------------------------------------------------------------------------
	// Renderers
	// ---------------------------------------------------------------------------

	pi.registerMessageRenderer(RESULT_TYPE, (message, options, theme) => renderResultMessage(message, options, theme));
	pi.registerMessageRenderer(OPTIN_TYPE, (message, options, theme) => renderOptInMessage(message, options, theme));
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "user" || !cfg.keywordTrigger) return markdown;
		return markdown.replace(keywordRegex(cfg.keyword, "gi"), (m) => `**⚡${m}**`);
	});

	// ---------------------------------------------------------------------------
	// Monitor and commands
	// ---------------------------------------------------------------------------

	const pastRuns = (): RunSnapshot[] => loadPastRuns(agentDir, sessionId, new Set(runsOfSession(sessionId).map((r) => r.id)));

	const openMonitor = async (ctx: ExtensionContext, runId?: string) => {
		if (ctx.mode !== "tui") {
			const runs = runsOfSession(sessionId);
			ctx.ui.notify(
				runs.length
					? runs.map((r) => `${r.id} ${r.name}: ${r.status} · ${formatDuration(r.elapsedMs())} · ${r.agents.length} agents`).join("\n")
					: "No workflow runs in this session.",
				"info",
			);
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) =>
				new WorkflowMonitor(
					tui,
					theme,
					() => done(),
					{
						sessionId: () => sessionId,
						pastRuns,
						openKey: OPEN_KEY,
						saveLocations: () => ({
							project: shortPath(join(projectSaveDir(ctx.cwd), "<name>.js")),
							personal: shortPath(join(personalWorkflowDir(agentDir), "<name>.js")),
						}),
						save: (run, name, scope) => {
							const source = "prepared" in run ? (run as WorkflowRun).prepared : undefined;
							let text = source?.source;
							if (!text) text = readFileSync(run.scriptPath, "utf8");
							const renamed = source && source.meta.name !== name ? renameScript(source, name) : text;
							const path = saveWorkflowFile({ source: renamed, name, scope, cwd: ctx.cwd, agentDir });
							refreshSaved(ctx);
							registerSavedCommands();
							// Rebuild autocomplete so /<name> shows now.
							ctx.ui.addAutocompleteProvider((current) => current);
							return path;
						},
					},
					runId,
				),
			{ overlay: true, overlayOptions: { width: "96%", maxHeight: "94%", anchor: "center" } },
		);
	};

	pi.registerCommand("workflows", {
		description: "Watch and control dynamic workflow runs (/workflows [run-id] | settings)",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "settings", label: "settings", description: "Approval, size guideline, concurrency, keyword" },
				...runsOfSession(sessionId).map((r) => ({ value: r.id, label: r.id, description: `${r.name} · ${r.status}` })),
			];
			const filtered = items.filter((i) => i.value.startsWith(prefix.trim()));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const a = args.trim();
			if (a === "settings") return openSettings(ctx);
			const runs = runsOfSession(sessionId);
			const target = a ? (runs.find((r) => r.id === a || r.name === a)?.id ?? pastRuns().find((r) => r.id === a || r.name === a)?.id) : undefined;
			if (a && !target) ctx.ui.notify(`No run "${a}" in this session.`, "warning");
			await openMonitor(ctx, target);
		},
	});

	const setUltracode = (on: boolean, ctx: ExtensionContext, persist = true) => {
		ultracode = on;
		if (persist) pi.appendEntry(ULTRACODE_ENTRY, { on });
		if (ctx.hasUI) {
			ctx.ui.setStatus("ultracode", on ? ctx.ui.theme.fg("accent", `⚡ ${cfg.keyword}`) : undefined);
		}
	};

	pi.registerCommand("ultracode", {
		description: "Let the agent plan every substantive task as dynamic workflows (/ultracode [on|off])",
		getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const a = args.trim().toLowerCase();
			if (!cfg.enabled) {
				ctx.ui.notify("Dynamic workflows are turned off.", "warning");
				return;
			}
			if (a === "status") {
				ctx.ui.notify(`${cfg.keyword} is ${ultracode ? "on" : "off"}.`, "info");
				return;
			}
			const next = a === "on" ? true : a === "off" ? false : !ultracode;
			setUltracode(next, ctx);
			ctx.ui.notify(
				next
					? `${cfg.keyword} is on: the agent plans substantive tasks as dynamic workflows. This uses many more tokens. /ultracode off returns to normal work.`
					: `${cfg.keyword} is off.`,
				next ? "warning" : "info",
			);
		},
	});

	pi.registerShortcut(OPEN_KEY as KeyId, {
		description: "Dismiss the ultracode keyword in the prompt, or open /workflows",
		handler: async (ctx) => {
			const text = ctx.hasUI ? ctx.ui.getEditorText() : "";
			if (cfg.keywordTrigger && keywordRegex(cfg.keyword).test(text)) {
				keywordDismissed = !keywordDismissed;
				// Redraw the editor with the new state.
				ctx.ui.setEditorText(text);
				ctx.ui.notify(keywordDismissed ? `${cfg.keyword} dismissed for this prompt.` : `${cfg.keyword} active again.`, "info");
				return;
			}
			await openMonitor(ctx);
		},
	});

	pi.registerFlag("ultracode", {
		type: "boolean",
		description: "Start with ultracode on: the agent plans substantive tasks as dynamic workflows",
	});

	const openSettings = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`Workflow settings: ${JSON.stringify(cfg)}\nEdit ${configFilePath(agentDir)} or the "workflows" key in settings.json.`, "info");
			return;
		}
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "approval",
					label: "Approval before a run",
					description: "ask: every run · first: only the first launch · never: no prompt",
					currentValue: cfg.approval,
					values: ["ask", "first", "never"],
				},
				{
					id: "sizeGuideline",
					label: "Size guideline",
					description: "How many agents the agent aims for (advice, not a cap): small <5, medium <10, large <50",
					currentValue: cfg.sizeGuideline,
					values: ["small", "medium", "large", "unrestricted"],
				},
				{
					id: "maxConcurrency",
					label: "Agents at once",
					description: "Concurrent agents per run",
					currentValue: String(cfg.maxConcurrency),
					values: [...new Set([2, 4, 8, cfg.maxConcurrency, 12, 16, 24, 32])].sort((a, b) => a - b).map(String),
				},
				{
					id: "keywordTrigger",
					label: `Keyword trigger (${cfg.keyword})`,
					description: `A prompt with "${cfg.keyword}" runs as a workflow`,
					currentValue: cfg.keywordTrigger ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "agentExtensions",
					label: "Agents load your extensions",
					description: "Provider hooks and permission gates apply to agents (recommended)",
					currentValue: cfg.agentExtensions ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "agentSkills",
					label: "Agents see your skills",
					description: "Off: smaller agent prompts (fewer tokens per agent in large fan-outs)",
					currentValue: cfg.agentSkills ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "ultracode",
					label: `${cfg.keyword} in new sessions`,
					description: "Start every session with ultracode on",
					currentValue: cfg.ultracode ? "on" : "off",
					values: ["on", "off"],
				},
			];
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Dynamic workflow settings")), 0, 0));
			container.addChild(new Text(theme.fg("dim", `Saved to ${shortPath(configFilePath(agentDir))}`), 0, 0));
			const list = new SettingsList(
				items,
				10,
				getSettingsListTheme(),
				(id, value) => {
					const v: unknown = value === "on" ? true : value === "off" ? false : /^\d+$/.test(value) ? Number(value) : value;
					saveConfigValue(agentDir, id as keyof WorkflowConfig, v);
					cfg = loadConfig(pi.getSettings() as unknown as Record<string, unknown>, agentDir);
				},
				() => done(),
			);
			container.addChild(list);
			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	};

	// ---------------------------------------------------------------------------
	// Saved workflows as commands
	// ---------------------------------------------------------------------------

	const refreshSaved = (ctx: ExtensionContext) => {
		saved = discoverWorkflows({ cwd: ctx.cwd, agentDir, projectTrusted: ctx.isProjectTrusted(), bundledDir: BUNDLED_DIR });
	};

	const registerSavedCommands = () => {
		const taken = new Set(pi.getCommands().map((c) => c.name));
		for (const w of saved) {
			if (w.error || commandNames.has(w.name)) continue;
			if (taken.has(w.name)) continue;
			commandNames.add(w.name);
			const name = w.name;
			pi.registerCommand(name, {
				description: `${w.description}${w.argsHint ? ` ${w.argsHint}` : ""} (workflow)`,
				handler: async (text, ctx) => runSavedCommand(name, text, ctx),
			});
		}
	};

	const runSavedCommand = async (name: string, text: string, ctx: ExtensionContext) => {
		const w = findWorkflow(saved, name);
		if (!w) {
			ctx.ui.notify(`The workflow ${name} is no longer available. Run /reload.`, "error");
			return;
		}
		const input = text.trim();
		const schema = w.argsSchema;
		let argsJson: string | undefined;
		if (input) {
			// JSON input that matches the schema is used as JSON; else plain text, if the schema takes a string.
			if (/^[[{]/.test(input)) {
				try {
					const parsed = JSON.parse(input) as unknown;
					if (!schema || validate(schema, parsed).ok) argsJson = JSON.stringify(parsed);
				} catch {
					argsJson = undefined;
				}
			}
			if (argsJson === undefined && acceptsString(schema)) argsJson = JSON.stringify(input);
		}
		const call = argsJson !== undefined ? `workflow({ name: "${name}", args: ${argsJson} })` : `workflow({ name: "${name}" })`;
		const lines = [`Run the saved workflow /${name} now: call ${call}.`];
		if (input && argsJson === undefined) {
			lines[0] = `Run the saved workflow /${name} now with the workflow tool.`;
			lines.push(`The user's input: ${input}`);
			lines.push(`Convert it to an args value that matches this JSON Schema: ${JSON.stringify(schema)}`);
		}
		lines.push("When its result arrives, present it to the user.");
		pi.sendUserMessage(lines.join("\n"), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	};

	// ---------------------------------------------------------------------------
	// Events
	// ---------------------------------------------------------------------------

	pi.on("resources_discover", () => (passive ? undefined : { skillPaths: [SKILLS_DIR] }));

	// A workflow agent session (its file is under the runs directory) must stay passive:
	// it must never bind as the registry host or stop runs. Agents normally do not load
	// this extension at all; this guard covers path mismatches such as symlinks.
	let passive = false;
	const isAgentSession = (ctx: ExtensionContext): boolean => {
		try {
			const file = ctx.sessionManager.getSessionFile() ?? "";
			const root = runsRoot(agentDir);
			return !!file && (file.startsWith(root) || file.startsWith(realpathOr(root)));
		} catch {
			return false;
		}
	};

	pi.on("session_start", async (event, ctx) => {
		passive = isAgentSession(ctx);
		if (passive) {
			pi.setActiveTools(pi.getActiveTools().filter((t) => t !== WORKFLOW_TOOL && t !== CONTROL_TOOL));
			return;
		}
		ctxRef = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		cfg = loadConfig(pi.getSettings() as unknown as Record<string, unknown>, agentDir);
		reg.host = host;

		if (!cfg.enabled) {
			pi.setActiveTools(pi.getActiveTools().filter((t) => t !== WORKFLOW_TOOL && t !== CONTROL_TOOL));
			return;
		}

		// ultracode: saved session state first, then the flag, then the setting.
		let restored: boolean | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === ULTRACODE_ENTRY) restored = !!(entry.data as { on?: boolean } | undefined)?.on;
		}
		const initial = restored ?? (pi.getFlag("ultracode") === true || cfg.ultracode);
		setUltracode(initial, ctx, false);

		refreshSaved(ctx);
		registerSavedCommands();

		if (ctx.mode === "tui") {
			ctx.ui.setWidget("workflows", (tui, theme) => new WorkflowWidget(tui, theme, () => sessionId, OPEN_KEY), { placement: "belowEditor" });
			if (cfg.keywordTrigger && !ctx.ui.getEditorComponent()) {
				ctx.ui.setEditorComponent(
					(tui, theme, keybindings) =>
						new KeywordEditor(tui, theme, keybindings, {
							keyword: () => cfg.keyword,
							enabled: () => cfg.keywordTrigger && cfg.enabled,
							dismissed: () => keywordDismissed,
							theme: () => ctx.ui.theme,
							dismissKey: OPEN_KEY,
						}),
				);
			}
		}

		// After a /reload: results of runs that ended in between.
		if (event.reason === "reload") {
			for (const run of runsOfSession(sessionId)) if (run.isFinal) deliver(run);
		}
	});

	const stopSessionRuns = (why: string) => {
		for (const run of activeRuns(sessionId)) run.stop(why);
	};

	pi.on("session_shutdown", async (event) => {
		if (passive) return;
		if (event.reason === "reload") return; // Runs go on; the new copy of the extension adopts them.
		stopSessionRuns(event.reason === "quit" ? "Stopped: pi exited." : "Stopped: the session changed.");
		if (reg.host === host) reg.host = undefined;
	});

	const confirmLeave = async (ctx: ExtensionContext) => {
		const act = activeRuns(sessionId);
		if (!act.length || !ctx.hasUI) return undefined;
		const ok = await ctx.ui.confirm(
			"Workflows are running",
			`${act.map((r) => r.name).join(", ")} ${act.length === 1 ? "runs" : "run"} in this session. If you leave, ${act.length === 1 ? "it stops" : "they stop"} (completed agent results stay saved for a relaunch). Leave anyway?`,
		);
		return ok ? undefined : { cancel: true };
	};
	pi.on("session_before_switch", async (_e, ctx) => (passive ? undefined : confirmLeave(ctx)));
	pi.on("session_before_fork", async (_e, ctx) => (passive ? undefined : confirmLeave(ctx)));

	pi.on("input", async (event, ctx) => {
		if (passive || !cfg.enabled || !cfg.keywordTrigger) return { action: "continue" };
		const human = (ctx.mode === "tui" && event.source === "interactive") || (ctx.mode === "rpc" && event.source === "rpc");
		const has = keywordRegex(cfg.keyword).test(event.text);
		if (!has) {
			keywordDismissed = false;
			return { action: "continue" };
		}
		if (!human || keywordDismissed) {
			keywordDismissed = false;
			return { action: "continue" };
		}
		if (!pi.getActiveTools().includes(WORKFLOW_TOOL)) {
			ctx.ui.notify(`${cfg.keyword}: the ${WORKFLOW_TOOL} tool is not active in this session, so the keyword has no effect.`, "warning");
			return { action: "continue" };
		}
		keywordPending = true;
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (passive || !cfg.enabled) return undefined;
		const sections = event.systemPromptOptions.sections;
		if (pi.getActiveTools().includes(WORKFLOW_TOOL)) {
			sections.workflows = workflowsSection(cfg, saved.filter((w) => !w.error));
			if (ultracode) sections.ultracode = ultracodeSection(cfg);
			else delete sections.ultracode;
		}
		if (keywordPending) {
			keywordPending = false;
			return {
				message: { customType: OPTIN_TYPE, content: keywordOptInText(cfg), display: true, details: { keyword: cfg.keyword } },
			};
		}
		return undefined;
	});

	// Print and JSON mode: pi exits when the agent settles, so wait for the runs here
	// and hand their results to the agent before it settles.
	pi.on("agent_before_settle", async (_event, ctx) => {
		if (passive || ctx.mode === "tui" || ctx.mode === "rpc") return undefined;
		const mine = () => runsOfSession(sessionId).filter((r) => !r.foreground && !r.delivered);
		const pending = mine();
		if (!pending.length) return undefined;
		const progress = cfg.printProgress && process.stderr.isTTY ? setInterval(() => printProgress(pending), 1000) : undefined;
		await Promise.all(pending.map((r) => r.whenEnded()));
		if (progress) {
			clearInterval(progress);
			process.stderr.write("\r\x1b[2K");
		}
		const finished = mine().filter((r) => r.isFinal);
		for (const r of finished) {
			r.delivered = true;
			r.persistNow();
		}
		if (!finished.length) return undefined;
		return {
			entries: finished.map((r) => ({
				type: "custom_message" as const,
				customType: RESULT_TYPE,
				content: resultText(r, cfg.resultMaxChars),
				display: true,
				details: resultDetails(r),
			})),
			continue: true,
		};
	});
}

function printProgress(runs: WorkflowRun[]): void {
	const text = runs
		.map((r) => {
			const c = countAgents(r.agents);
			return `${r.name} ${r.status}: ${c.done + c.cached}/${c.total} agents, ${formatTokens(r.usage.totalTokens)} tokens, ${formatDuration(r.elapsedMs())}`;
		})
		.join(" | ");
	process.stderr.write(`\r\x1b[2K[workflow] ${oneLine(text, (process.stderr.columns ?? 100) - 12)}`);
}

function realpathOr(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

function shortPath(p: string): string {
	const home = process.env.HOME;
	return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
