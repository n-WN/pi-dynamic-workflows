/** Model-facing text: tool descriptions, prompt sections, and agent instructions. */

import { SIZE_TARGETS, type WorkflowConfig } from "./config.ts";

export const WORKFLOW_TOOL = "workflow";
export const CONTROL_TOOL = "workflow_control";
export const SUBMIT_TOOL = "submit_result";

export function sizeAdvice(cfg: WorkflowConfig): string {
	const target = SIZE_TARGETS[cfg.sizeGuideline];
	return target
		? `aim for fewer than ${target} agents per workflow (size guideline "${cfg.sizeGuideline}") unless the user asks for a different scale`
		: "size the workflow to the task (no size guideline)";
}

export function workflowToolDescription(cfg: WorkflowConfig): string {
	return `Run a dynamic workflow: a JavaScript orchestration script that runs many subagents in the background and returns one consolidated result. The script holds the loop, the branching, and the intermediate results, so only the final result reaches this conversation.

Use it only when the user asks for a workflow (in their words, or with the keyword "${cfg.keyword}"), when ${cfg.keyword} mode is on, or when the user runs a saved workflow. It fits tasks with many independent parts: codebase-wide audits, large migrations, research that needs cross-checked sources, plans drafted from several angles. Do not use it for small tasks: a workflow uses many more tokens than normal work.

The call returns at once with a run ID (unless wait is true). The final result arrives later as a <workflow-result> message. Do not poll. Continue other work or end your turn.

SCRIPT (pass "script" inline, or "scriptPath", or the "name" of a saved or bundled workflow):
export const meta = { name: "kebab-name", description: "One line", phases: ["Find", "Fix", "Verify"] }
...then plain JavaScript with top-level await. The return value is the workflow result: keep it compact (JSON data or a markdown report).
meta must be the first statement and contain literal values only.

GLOBALS
- agent(prompt, opts?) -> Promise<string | object | null>. Starts one subagent with a fresh context. Resolves to its final text, or to parsed JSON when opts.schema is set. Resolves to null when the agent fails or is stopped (opts.onError: "throw" throws instead).
  opts: label (short display name), phase, schema (JSON Schema of the result), model ("provider/id" or a model id), thinking (off|minimal|low|medium|high|xhigh|max), tools (tool names; default: the session's built-in tools), readOnly (read/grep/find/ls only), cwd, isolation: "worktree" (own git worktree; resolves to { output, worktree }), instructions (extra text), context (data added to the prompt), timeout (seconds), maxTurns, retries, cache (false: never reuse a saved result).
- parallel(tasks, { concurrency }?) -> Promise<any[]>. Runs functions at the same time and waits for all: parallel(files.map(f => () => agent(...))). An object of functions gives an object of results.
- pipeline(items, stage1, stage2?, ...) -> Promise<any[]>. Sends each item through the stages on its own, with no barrier between stages. Stage 1 gets (item, index); later stages get (previousValue, item, index). A null result stops that item.
- race(tasks, predicate?) -> Promise<{ index, value } | null>. The first result that passes the predicate (default: not null) wins; the other tasks' agents stop.
- phase(title, fn?). Groups the agents that follow (or only those started inside fn) under a title in the progress view.
- log(...values) and console.log: progress notes for the human.
- ask(question, { options?, default?, timeout? }) -> Promise<string | null>. Asks the human and waits. Returns the default when no human can answer.
- args (the input value), env ({ cwd, runId, model, tools, defaultTools, gitRepo }), budget (live: agentsStarted, agentsRemaining, agentsRunning, tokens, maxConcurrency, targetAgents), sleep(ms), random() (seeded), shuffle(list).

RULES
- Agents do not see this conversation. Each prompt must be self-contained: give paths, criteria, and the output format.
- Use schema whenever later code reads fields of a result. Keep results small: return findings, not file contents.
- The script cannot read files, run commands, or import modules (no import/require). Agents do that work.
- Date.now(), new Date() without arguments, and Math.random() throw (they would break replay). Pass time in args; use random().
- Limits: ${cfg.maxConcurrency} agents at once, ${cfg.maxAgents} agents per run, ${cfg.maxItems} items per parallel/pipeline/race call. Size: ${sizeAdvice(cfg)}.
- Good shapes: fan-out then synthesize; adversarial verification (independent agents try to refute each finding); generate then filter; tournament; loop until a check passes or makes no progress; classify then act. Read the workflow-authoring skill for patterns and examples.

ITERATE
Every run saves its script and returns scriptPath. To fix a script, edit that file and call again with scriptPath. Pass resumeFromRunId to relaunch a stopped or failed run (add scriptPath to relaunch an edited script): completed agents with unchanged inputs return their saved results; agents that changed or had no result run again, and so do agents the script called after one of those results.`;
}

export const WORKFLOW_TOOL_SNIPPET = "Run a dynamic workflow script that orchestrates many subagents in the background";

export function workflowToolGuidelines(cfg: WorkflowConfig): string[] {
	return [
		`Start a ${WORKFLOW_TOOL} only when the user asks for one, uses the keyword "${cfg.keyword}", or ${cfg.keyword} mode is on; workflows cost many more tokens than normal work.`,
		`After you start a ${WORKFLOW_TOOL}, do not poll: its result arrives as a <workflow-result> message. Then present the result to the user.`,
	];
}

export const CONTROL_TOOL_DESCRIPTION = `Inspect and control dynamic workflow runs of this session.
Actions:
- list: all runs with status.
- status (runId?): phases, running and failed agents, pending questions, recent log. Without runId: every active run.
- wait (runId?, timeout?): block until the run ends (or the timeout in seconds passes) and return its result. Use it only when you need the result in this turn.
- stop (runId, agent?): stop a whole run, or one agent by its number.
- pause / resume (runId): hold or release new agent starts.
- answer (runId, question, answer): answer an ask() question when the user told you the answer.
- steer (runId, agent, message): send a correction or extra instruction to one running agent.
Do not use status in a loop to wait; the result arrives as a <workflow-result> message.`;

export function workflowsSection(cfg: WorkflowConfig, saved: Array<{ name: string; description: string; argsHint?: string }>): string {
	const lines = [
		`Dynamic workflows: ${sizeAdvice(cfg)}. Up to ${cfg.maxConcurrency} agents run at once.`,
	];
	if (saved.length) {
		lines.push("Saved workflows (run with workflow({ name, args })):");
		for (const w of saved.slice(0, 40)) {
			lines.push(`- ${w.name}${w.argsHint ? ` ${w.argsHint.slice(0, 40)}` : ""}: ${w.description.replace(/\s+/g, " ").slice(0, 160)}`);
		}
	}
	return lines.join("\n");
}

export function ultracodeSection(cfg: WorkflowConfig): string {
	return `${cfg.keyword} mode is ON for this session. For each substantive task, plan the work as one or more dynamic workflows and run them with the ${WORKFLOW_TOOL} tool instead of doing the work turn by turn. A request can become several workflows in a row: one to understand the code, one to make the change, one to verify it. For trivial requests (a question you can answer at once, a one-line change), answer directly. Size: ${sizeAdvice(cfg)}.`;
}

export function keywordOptInText(cfg: WorkflowConfig): string {
	return `The user typed the keyword "${cfg.keyword}": they opted in to a dynamic workflow for this request. Write a workflow script for the task and run it with the ${WORKFLOW_TOOL} tool instead of working through the task turn by turn. Read the workflow-authoring skill first if you need the patterns. Size: ${sizeAdvice(cfg)}.`;
}

export function agentPreamble(runName: string): string {
	return `# Workflow agent
You are a worker agent in the pi dynamic workflow "${runName}". An orchestration script started you for one focused task, and the script reads your final answer. No human watches this conversation and nobody can answer questions: make reasonable assumptions, state them in your answer, and complete the task. Do only your task. Do not start workflows or other subagents.`;
}

export function agentPromptFooter(structured: boolean, schemaSummary?: string): string {
	return structured
		? `When the task is complete, call the ${SUBMIT_TOOL} tool once with your final result${schemaSummary ? ` (shape: ${schemaSummary})` : ""}. Do not write the final result as plain text.`
		: "When the task is complete, reply with your final answer only. The orchestration script reads it, so leave out greetings and meta comments.";
}

export function structuredReminder(lastError?: string): string {
	return lastError
		? `Your last ${SUBMIT_TOOL} call was rejected: ${lastError}. Call ${SUBMIT_TOOL} again with a result that matches the schema.`
		: `You did not call ${SUBMIT_TOOL}. Call it now with your final result. Do not answer in plain text.`;
}

export function worktreeNote(path: string, branch: string): string {
	return `You work in an isolated git worktree at ${path} (branch ${branch}). Make all edits there. When you finish, your changes are committed to that branch.`;
}
