# Design

This document explains how the extension works and why. It also lists where it
differs from Claude Code's dynamic workflows.

## 1. Goals

1. The agent writes the orchestration for each task (it is not a fixed pipeline):
   loops, branches, fan-out sized by discovered data, retries, and checks are plain
   JavaScript.
2. Orchestration state lives in the script, not in the conversation. The
   conversation gets one result.
3. The human and the agent can both see and steer a run while it goes on.
4. A run can stop and relaunch cheaply: completed work is reused when that is safe.
5. It uses pi's own building blocks (sessions, extensions, tools, models, TUI) and
   behaves like pi in print, JSON, RPC, and interactive mode.

## 2. Architecture

```
main pi session
 ├─ workflow tool ──► launcher ──► approval ──► WorkflowRun ──► registry (globalThis)
 │                                               │      ▲
 │                                   postMessage │      │ results
 │                                               ▼      │
 │                                     worker thread: vm context
 │                                       prelude (agent, parallel, ...)
 │                                       the script
 │                                               │ agent() calls
 │                                               ▼
 │                                      scheduler (concurrency, pause,
 │                                      prompt-cache stagger, replay)
 │                                               │
 │                                               ▼
 │                                   PiAgentExecutor: one in-process
 │                                   AgentSession per attempt
 │                                     ├─ your extensions (except this one)
 │                                     ├─ tool allowlist + submit_result
 │                                     ├─ bridged main-session tools (MCP, ...)
 │                                     └─ UI proxy for dialogs
 ├─ workflow_control tool
 ├─ /workflows monitor, task line widget, result card, approval dialog
 └─ ultracode: keyword editor, opt-in message, /ultracode mode
```

### 2.1 Script sandbox

- The script runs in a `worker_threads` worker, inside a fresh `vm` context. A busy
  loop in the script cannot freeze the TUI, and a stop terminates the thread.
- The DSL is defined by a prelude *inside* the context, so every object the
  script sees belongs to its own realm (`instanceof Array` works, errors are real
  `Error`s). The prelude talks to the worker through one closure-held bridge.
- `phase()` scoping uses `AsyncLocalStorage`. `parallel`/`pipeline`/`race` run
  each task in its own async frame, so `phase()` inside one branch does not leak
  into siblings or into the code after the fan-out.
- `race()` gives each task a cancellation group. When a task wins, the runtime
  stops the agents of the other groups and answers their later calls with `null`.
- Before a run: a small tokenizer reads `meta` as data (no eval), finds forbidden
  constructs outside strings and comments (`import()`, `require()`, `Date.now()`,
  `new Date()`, `Math.random()`, other `export`s), and `vm.Script` checks the
  syntax. The script body keeps its line numbers (`export` becomes spaces, the
  wrapper uses `lineOffset: -1`), so every error shows the real line with a caret.
- During a run: `Date.now()`, `new Date()`, and `Math.random()` throw (also when
  reached through aliases). `random()` is seeded per run and the seed is kept on
  relaunch. A script that waits on a promise that can never settle fails after
  three idle seconds instead of hanging. A script that stops answering shows a
  "script busy" warning.

### 2.2 Agents

Each `agent()` attempt is an in-process `AgentSession` (pi SDK):

- It shares the main session's `ModelRuntime` (credentials, providers, OAuth
  refresh) and gets a fresh context, an allowlist of tools, and a transcript file
  in the run's `agents/` directory.
- It loads your extensions, the extensions given with `-e`, and trusted project
  resources, except this extension (no nested workflows). Provider hooks and
  permission gates therefore apply to agents too. `session_shutdown` is emitted
  before `dispose()`, as `AgentSessionRuntime` does, so extensions release their
  timers.
- The system prompt adds a short, run-wide preamble. Agent-specific text goes into
  the first user message, so agents of one run share a cacheable prefix. The
  scheduler holds agents with the same prefix until the first one's response
  starts (up to `prefixStaggerMs`), so they read its cache.
- `schema` adds a `submit_result` tool whose parameters are the schema (wrapped
  under `value` when it is not an object schema). pi validates the arguments; the
  tool validates again and ends the agent loop (`terminate: true`). Without a valid
  call, the runtime reminds the agent up to `structuredOutputRetries` times. A
  schema that no value can match fails before the agent starts.
- Tools that an agent session cannot load itself (MCP tools of the main session,
  for example) are bridged: a proxy tool calls `ctx.executeTool()` of the workflow
  tool call that started the run, so the main session's validation and hooks apply.
- Dialogs of extensions inside an agent go through a UI proxy. It serializes them,
  adds `[run #id label]` to the title, marks the agent as waiting, and routes the
  dialog to the open monitor when there is one.
- `isolation: "worktree"` creates `git worktree add` from HEAD, runs the agent
  there, commits its changes to a branch, and removes the worktree when nothing
  changed.

### 2.3 Replay (resume)

Every agent outcome goes to `journal.jsonl` with its input key (hash of prompt,
schema, model, thinking, tools, cwd, isolation, instructions, context), its call
position, and two counters: `callAfter` (results the script had received when it
made the call) and `endSeq` (when its own result reached the script).

On relaunch, agents are matched by call position. A saved result is reused when:

1. the key is the same, and
2. it completed, and
3. every agent whose result had reached the script before this call (in the earlier
   run) was reused in this run too.

Rule 3 is the happens-before relation of the script: a call can only depend on
results that existed when it was made. It is a safe over-approximation of the data
flow. A sequential chain therefore reruns from the first change (like Claude
Code's prefix rule), but the parallel siblings of a failed agent keep their
results, which the prefix rule would discard. Journals without the counters fall
back to the prefix rule. `ask()` answers are replayed by position and text.

### 2.4 Lifecycle

- Runs live in a registry on `globalThis`. `/reload` loads a new copy of the
  extension; runs go on, and the new copy receives their results.
- Leaving the session (`/new`, `/resume`, `/fork`) asks first when runs are
  active; leaving stops them. Quitting stops them. Their journals stay, so a
  later relaunch in the same session reuses the completed work.
- Interactive and RPC mode: the result arrives as a `workflow-result` custom
  message with `triggerTurn` (`followUp` while the agent streams).
- Print and JSON mode: pi exits when the agent settles. The extension waits in
  `agent_before_settle` for the session's runs and appends their results as
  entries with one continuation, so the agent always sees them.

## 3. Interaction design

### 3.1 For the human

| Moment | Design |
|---|---|
| Typing | The keyword is highlighted while you type; the editor border says what it does and how to dismiss it (`alt+w`). In the transcript the keyword shows as **⚡ultracode**, and a badge confirms the opt-in. A mention does not trigger: quotes, code spans and blocks, and `/ultracode` in a text. The highlight, the trigger, and the transcript mark use the same rule, so what is highlighted is what triggers. |
| Before a run | Approval overlay: name, description, planned phases, and facts from the script text (agent() call sites, fan-out helpers, default and named tools, read-only calls, worktree isolation, named models, ask() calls), size limits, model, args, resume source. Choices: run, run and stop asking (named workflows), run and approve the session, read the script, edit it (`ctrl+g`), decline with a note for the agent (`tab`), decline. |
| During a run | One task line per run below the editor: spinner, current phase with its count, colored progress bar (done, failed, running, queued), counters, tokens, time. Each part has a priority; on a narrow terminal the key hint, the bar, and the tokens go first. It turns into a warning when the run waits for you, is paused, is large, or the script is busy. The tool row in the transcript also redraws live. |
| Steering | `m` on a running agent sends it a message (pi steering: the agent reads it after its current step). The agent detail lists the messages. |
| Inspecting | `/workflows` overlay with four levels, a timeline, and a script view. Keys follow Claude Code where possible (`p`, `x`, `r`, `s`, `f`, `j`/`k`). Every level shows its key hints; when they do not fit, `?` lists all keys. Long text wraps; long paths shorten in the middle. The box fits its content and does not shrink while one view shows (no jumping). Columns that carry no information leave (the model column when all agents of a phase use one model). |
| Seeing time | The run view puts an activity track next to each phase, on one time axis for the run: the height is the number of agents that ran at that moment against the concurrency limit. One look shows barriers, pipeline overlap, slow tails, idle slots, and failures (red). A live slots gauge shows the scheduler state. The timeline (`t`) draws one bar per agent: dots while it waited for a free slot, a bar while it ran, `↺` for a reused result; `o` sorts by duration. |
| Status vocabulary | One set of glyphs everywhere (task line, tool row, monitor, timeline): `✓` done, `⚠` a finished phase with failed agents, `✗` failed, `↺` reused, `·` queued, `○` planned, spinner for running. Color is never the only signal. The status words use the colors of the progress bar, so they are also its legend. |
| Questions | `ask()` questions and agent permission prompts show in the task line, as a notification, and as a banner in the monitor. `a` answers inline: options with numbers, or a text field. |
| Ending | A result card (status, time, agents, failures, reused agents, tokens, cost, the phases with their agent counts, the result, the path of the full result). A text result renders as Markdown; an object result shows one block per field, long text fields as Markdown. The agent detail renders results the same way. The task line shows the final state for a few seconds. |
| Reuse | `s` saves the run's script as `/name`; it is in autocomplete at once. |

### 3.2 For the agent

| Moment | Design |
|---|---|
| Choosing | Tool description and guidelines say when to use a workflow (asked for, keyword, ultracode) and when not (small tasks, cost). A system prompt section lists the size guideline, the concurrency, and the saved workflows with their args hints. |
| Writing | The description has the complete short API; the `workflow-authoring` skill has the full reference and six patterns with code. |
| Mistakes | Every check fails before tokens are spent, with file, line, column, a caret snippet, and the fix. The script is saved first, so the agent can edit `scriptPath` instead of resending it. Unknown options, tools, and models list the valid ones. JSON-string `args` are parsed and the agent is told. |
| Launch | The result says: run ID, phases, script path, transcripts, "do not poll", and how to inspect. |
| Result | `<workflow-result>` with status, counts, agents and tokens per phase, the result, agents without a result and why (with transcript paths), worktree branches to merge, answered questions, warnings, the last log lines, and exact resume instructions. A result that is too long stays valid JSON: it keeps whole array items or object fields, and a note says what it cut and where the full file is. |
| Control | `workflow_control`: `list`, `status`, `wait` (with timeout; marks the result as delivered so it does not arrive twice), `stop` (run or agent), `pause`, `resume`, `answer`, `steer` (message to one running agent). |
| Declined | The decline text includes the human's note, or says not to retry. |

## 4. Differences from Claude Code

| Area | Claude Code | This extension |
|---|---|---|
| Resume rule | Prefix: the first changed or failed agent and every later agent rerun. | Happens-before: unchanged agents that did not depend on a rerun agent keep their results. |
| Human input during a run | None (only permission prompts). | `ask()` plus permission prompts, answered inline in the monitor; messages to running agents (`m`); the main agent can answer and steer with `workflow_control`. |
| Extra primitives | `agent`, `parallel`, `pipeline`, `phase`, `log`. | Also `race` (with cancellation), multi-stage `pipeline`, scoped `phase(title, fn)`, `env`, `budget`, `sleep`, seeded `random`/`shuffle`, `parallel` over objects. |
| Agent options | Schema, model, isolation. | Also `tools`, `readOnly`, `cwd`, `thinking`, `instructions`, `context`, `timeout`, `maxTurns`, `retries`, `onError`, `cache`. |
| Tool for the agent | `Workflow`; results arrive as task notifications. | `workflow` plus `workflow_control`; `wait: true` for a result in the same call. |
| Effort | `/effort ultracode` sets xhigh effort. | `/ultracode` changes only the planning; pi's thinking level stays yours. |
| Usage limits | Waits for a subscription limit reset. | Not available in pi; a failed agent can be relaunched. |
| Where things live | `~/.claude/workflows/`, `.claude/workflows/`. | `~/.pi/agent/workflows/`, `.pi/workflows/` (trusted projects). |

## 5. Known limits

- The `vm` context is not a security boundary. Agents already have shell access;
  the sandbox is for determinism and for clear errors.
- Bridged tools need the tool call that started the run. A run started by a slash
  command goes through the agent for this reason.
- `alt+w` needs a terminal that sends Option as Alt on macOS (set `shortcut` for
  another key).
- An agent's own todo list is not shown (pi has no built-in todo tool).
