# pi dynamic workflows

Dynamic workflows for [pi](https://pi.dev): the agent writes a JavaScript
orchestration script, a runtime executes it in the background, and the script
runs many subagents. The script holds the loops, the branches, and the
intermediate results. Only the final result comes back to the conversation.

This is a pi implementation of the "dynamic workflows" feature of Claude Code,
written from scratch for the pi extension API. See [DESIGN.md](DESIGN.md) for the
architecture and the differences.

## Install

```bash
pi install /path/to/pi-dynamic-workflows     # or add the path to "packages" in ~/.pi/agent/settings.json
```

To try it for one session only:

```bash
pi -e /path/to/pi-dynamic-workflows/extensions/workflows/index.ts
```

Requirements: pi 1.0 or later, Node.js 22.19 or later.

## Start a workflow

| How | What happens |
|---|---|
| Ask for it: "use a workflow to audit every route handler under src/routes/" | The agent writes a script and starts it. |
| Put the keyword `ultracode` in your prompt | Same, as an explicit opt-in. The editor highlights the keyword; `alt+w` dismisses it for this prompt. A mention does not count: the keyword in quotes (`"ultracode"`), in code (`` `ultracode` ``, code blocks), or as `/ultracode` in a text. |
| `/ultracode` | Ultracode mode for this session: the agent plans every substantive task as workflows. `/ultracode off` ends it. |
| `/deep-research <question>` | Bundled workflow: plan, search, read, cross-check claims, write a cited report. It needs a web search tool (for example an MCP server). |
| `/<name>` | A workflow that you saved from an earlier run. |

Before a run starts, an approval dialog shows the plan:

```
╭─ Run workflow? ──────────────────────────────────────────── uses many tokens ╮
│ ◆ deep-research                                                              │
│   Research a question across many web sources, cross-check the key claims,   │
│   and return a cited report                                                  │
│                                                                              │
│ Phases    1 Scope  →  2 Search  →  3 Fetch  →  4 Verify  →  5 Synthesize     │
│ Plan      5 agent() calls in the script · parallel, pipeline: the number of  │
│           agents is known only at run time                                   │
│ Agents    up to 4 at once · at most 1000 per run · guideline: fewer than 10  │
│ Tools     by default read, bash, edit, write · read-only at 1 call           │
│ Isolation 1 call in its own git worktree: changes go to new branches, not to │
│           your working tree                                                  │
│ Model     provider/model · thinking medium · the script also names           │
│           provider/bigger-model                                              │
│ Script    written for this task · 24 lines                                   │
│           ~/.pi/agent/workflows/runs/01a1…/wf-res001/script.js               │
│                                                                              │
│ ❯ 1. Yes, run it                                                             │
│   2. Yes, and approve all workflows in this session                          │
│   3. View the script                                                         │
│   4. No, and tell the agent what to change                                   │
│   5. No                                                                      │
╰─ ↑↓ select · enter confirm · v script · ctrl+g edit · tab feedback · esc no ─╯
```

The Plan, Tools, Isolation, Model, and Questions rows come from the script text:
`agent()` call sites, `parallel`/`pipeline`/`race`, `readOnly: true`,
`isolation: "worktree"`, `model: "..."`, `tools: [...]`, and `ask()` calls.

- `v` shows the script with line numbers. `ctrl+g` opens it in an editor; the run
  starts from your version.
- `tab` declines with a note. The agent gets the note and can revise the script.
- Saved and bundled workflows also offer "don't ask again for <name> in this project".

## Watch and control

While a run goes on, a line below the editor shows it. On a narrow terminal the
parts with less value go first (the key hint, the bar, the tokens):

```
 ⠹ audit-routes  Audit 12/40  ━━━━━━━━━━━──────  3⟳ 1✗  418k tok  2m13s           alt+w /workflows
```

`/workflows` (or `alt+w` with an empty prompt) opens the monitor:

```
runs  →  run (phases, activity, log)  →  phase (agents + preview)  →  agent (prompt, tool calls, output, result)
          └→ timeline (one bar per agent on a time axis)
```

The run view shows the progress and, per phase, an activity track on the run's
time axis: how many agents of the phase ran at each moment (full height = all
slots busy). It shows the shape of the run at a glance: barriers between phases,
overlap in a `pipeline()`, the slow tail of a phase, and failures (red).

```
╭─ Workflows › deep-research ────────────────────────────────── ✓ completed 6m ╮
│ wf-res001 · written for this task                                            │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100% 23/23 │
│ 21 done · 2 failed                                               155k tokens │
│                                                                              │
│ PHASES            done            tokens time 0:00                      6:12 │
│ ❯ ✓ Scope          1/1              8.2k  12s ▂▂▂                            │
│   ⚠ Search         5/5 1✗          45.2k 1:10   ▃████▆▃▂▁                    │
│   ✓ Fetch          8/8               52k 1:31           ▇████▅▄▂▂▂           │
│   ⚠ Verify         8/8 1✗            36k 1:20                    ▄███▇▃▂     │
│   ✓ Synthesize     1/1             13.1k  41s                          ▁▂▂▂▂ │
│     all agents   23/23 peak 4/4     155k 6:12 ▂▂▄████▆▃▂▇████▅▄▂▂▅███▇▃▂▂▂▂▂ │
╰─ ↑↓ phase · enter agents · t timeline · v script · ? keys · esc back ────────╯
```

`t` opens the timeline: one bar per agent, grouped by phase. Dots show the time an
agent waited for a free slot; `o` sorts by duration to find the slow agents.

```
│ by start               0:00           2:00           4:00                    │
│                        ┬──────────────┬──────────────┬──────────────┬        │
│ ⚠ SEARCH 5 agents          ██████▇▆▄▂▂▂                                      │
│   ✓ #1 search: market…     ━━━━━━━━                                     58s  │
│   ✗ #4 search: pricing     ━━━━━━                                       41s  │
│   ✓ #5 search: risks       ·····━━━━━━━                                 52s  │
```

Glyphs: `✓` done, `⚠` a finished phase where some agents failed, `✗` failed, `↺`
a result reused from an earlier run, `·` queued, `○` a planned phase that has not
started, a spinner for work that runs. The status words (`21 done · 2 failed`) use
the colors of the progress bar, so they are also its legend.

| Key | Action |
|---|---|
| `↑` `↓` (`k` `j`) | Select, or scroll the agent detail |
| `t` | Timeline of the run (from the run list or the run view) |
| `o` | In the timeline: order by start or by duration |
| `?` | All keys of the current view |
| `enter` `→` | Open. In the agent detail: expand or collapse |
| `esc` `←` | Back. At the top: close |
| `p` | Pause or resume the run (running agents finish; no new agents start) |
| `x` | Stop the selected agent (the script gets `null`), or the run. Both ask first |
| `r` | Restart the selected running agent |
| `m` | Send a message to the selected running agent (a correction or an extra instruction; it reads it after its current step) |
| `f` | Filter the agents of a phase: all, active, failed, done, queued |
| `s` | Save the run's script as a command (project `.pi/workflows/` or personal `~/.pi/agent/workflows/`) |
| `v` | Show the run's script |
| `a` | Answer a question that waits (see below) |

Questions reach you in two ways, and both show in the task line and as a banner
in the monitor:

- A script can ask with `ask("Apply 14 fixes now?", { options: ["yes", "no"] })`.
- Your extensions run in the agents too. When one of them asks (a permission gate,
  for example), the dialog shows with the run and the agent in its title. When the
  monitor is open, you answer it there.

When a run ends, a result card appears in the conversation and the agent continues
with the result.

## For the agent

The `workflow` tool takes `script` (inline), `scriptPath`, or `name` (saved), plus
`args`, `resumeFromRunId`, and `wait`. It returns at once with a run ID. The
result arrives later as a `<workflow-result>` message. `workflow_control` lists,
inspects, waits for, pauses, stops, answers, and steers runs (`steer` sends a
message to one running agent).

The script API in short (the full reference is the `workflow-authoring` skill):

```js
export const meta = { name: "audit-routes", description: "Audit route handlers", phases: ["Find", "Audit"] }

phase("Find")
const found = await agent("List every .ts file under src/routes/.", {
  schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
  readOnly: true,
})
phase("Audit")
const audits = await pipeline(found.files, (file) => agent(`Audit ${file} for missing auth checks.`, { label: file, readOnly: true }))
return audits.filter(Boolean)
```

| Global | Purpose |
|---|---|
| `agent(prompt, opts)` | One subagent with a fresh context. Options: `label`, `phase`, `schema`, `model`, `thinking`, `tools`, `readOnly`, `cwd`, `isolation: "worktree"`, `instructions`, `context`, `timeout`, `maxTurns`, `retries`, `onError`, `cache`. |
| `parallel(tasks, { concurrency })` | Run at the same time, wait for all. |
| `pipeline(items, ...stages)` | Each item goes through the stages on its own. |
| `race(tasks, predicate)` | First acceptable result wins; the other agents stop. |
| `phase(title, fn?)` | Group agents in the progress view (scoped per branch). |
| `log()`, `console.*` | Notes for the human. |
| `ask(question, opts)` | Ask the human; default when nobody can answer. |
| `args`, `env`, `budget` | Input, environment (tools, model, cwd), live counts. |
| `sleep(ms)`, `random()`, `shuffle()` | Helpers; `random()` is seeded per run. |

Scripts have no `import`/`require`, file system, or shell. `Date.now()`,
`new Date()`, and `Math.random()` throw, so that a relaunched run repeats the same
calls.

## Resume and iterate

Every run saves its script. The agent can edit `scriptPath` and run it again, or
pass `resumeFromRunId` to relaunch a stopped or failed run. A completed agent with
unchanged inputs returns its saved result. An agent runs again when its inputs
changed, when it had no result, or when the script called it after the result of
an agent that runs again. So parallel siblings of a failed agent keep their
results, and a sequential chain runs again from the first change.

## Settings

`/workflows settings` changes the common ones. All keys can go in
`~/.pi/agent/workflows/config.json`, or under `"workflows"` in pi's `settings.json`:

| Key | Default | Meaning |
|---|---|---|
| `approval` | `"ask"` | `ask`: every run · `first`: only the first launch · `never`: no dialog |
| `sizeGuideline` | `"medium"` | Advice for the agent: `small` (<5 agents), `medium` (<10), `large` (<50), `unrestricted` |
| `maxConcurrency` | CPUs, at most 16 | Agents at once per run |
| `maxAgents` | 1000 | Agents per run |
| `maxItems` | 4096 | Items per `parallel`/`pipeline`/`race` call |
| `keywordTrigger`, `keyword` | `true`, `"ultracode"` | The prompt keyword |
| `ultracode` | `false` | Start every session with ultracode on (also `pi --ultracode`) |
| `shortcut` | `"alt+w"` | Opens the monitor. On macOS the terminal must send Option as Alt |
| `agentModel`, `agentThinking` | session model | Default model and thinking level of agents |
| `agentTools` | session built-ins | Default tool list of agents |
| `agentExtensions` | `true` | Agents load your extensions (provider hooks, permission gates, tools) |
| `agentExtensionsExclude` | `[]` | Extension paths (substring) that agents do not load |
| `agentSkills`, `agentContextFiles` | `true` | Skills list and AGENTS.md in agent prompts (off: fewer tokens per agent) |
| `prefixStaggerMs` | 5000 | Hold agents with the same prompt prefix until the first one's response starts (prompt cache) |
| `structuredOutputRetries` | 5 | Tries for a valid schema result |
| `largeWorkflowAgents`, `largeWorkflowTokens` | 25, 1.5M | "Large workflow" warning thresholds |
| `resultMaxChars` | 30000 | Result size in the message; the full result is in `result.json` |
| `enabled` | `true` | `false` turns workflows off (also `PI_DISABLE_WORKFLOWS=1`) |

Environment variables: `PI_WORKFLOW_MAX_CONCURRENT_AGENTS`, `PI_WORKFLOW_MAX_AGENTS`,
`PI_WORKFLOW_PREFIX_STAGGER_MS`, `PI_WORKFLOW_MAX_STRUCTURED_OUTPUT_RETRIES`,
`PI_DISABLE_WORKFLOWS`.

## Files

```
~/.pi/agent/workflows/
  <name>.js                         personal saved workflows
  config.json                       settings written by /workflows settings
  consent.json                      "don't ask again" choices
  runs/<session-id>/<run-id>/
    script.js                       the script of this run (edit it and pass scriptPath)
    run.json                        live state (phases, agents, logs, usage)
    journal.jsonl                   agent outcomes, used to resume
    result.json                     the final result
    agents/*.jsonl                  one pi session file per agent (open with pi --session <file>)
    worktrees/                      git worktrees of isolated agents
.pi/workflows/<name>.js             project saved workflows (loaded in trusted projects)
```

## Print and JSON mode

`pi -p "use a workflow to ..."` works: pi waits for the runs before it exits, and
the agent gets the results first. Progress goes to stderr when stderr is a
terminal. There is no approval dialog without a UI.

## Cost

A workflow can use many more tokens than normal work: each agent has its own
system prompt and context. Start with a small slice of the task, use
`sizeGuideline`, give simple stages a smaller model (`model` option or
`agentModel`), and stop a run in `/workflows` when it grows. The monitor shows the
tokens of every agent.

## Tests

```bash
npm install --no-save typescript @types/node
npm run check   # type check against the installed pi
npm test        # engine, script, and UI helper tests (no model calls)
node dev/preview.ts /tmp/wf-preview [--light]   # render every UI view with fake agents
```

`dev/preview.ts` runs a fake five-phase workflow and drives the real widget,
monitor, approval dialog, tool row, and result card. It writes each view as plain
text and as HTML with colors, at several widths.
