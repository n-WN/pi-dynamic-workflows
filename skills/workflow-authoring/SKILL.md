---
name: workflow-authoring
description: Reference for writing pi dynamic workflow scripts (the workflow tool) - the agent(), parallel(), pipeline(), race(), phase(), ask() API, structured output with schemas, resume, and proven orchestration patterns. Read it before you write or edit a workflow script, or when the user says "ultracode" or asks for a workflow.
---

# Writing dynamic workflow scripts

A workflow is a JavaScript script. The `workflow` tool runs it in the background. The
script starts subagents with `agent()`, holds the loops, branches, and intermediate
results in variables, and returns one final result. Only that result reaches the
conversation, as a `<workflow-result>` message.

Use a workflow when a task has many independent parts, or needs cross-checking:
codebase-wide audits, migrations of many files, research across many sources, plans
drafted from several angles. Do not use a workflow for one small task.

## Script shape

```js
export const meta = {
  name: "audit-routes",                      // kebab-case, required
  description: "Audit route handlers for missing auth checks", // one line, required
  phases: ["Discover", "Audit", "Verify"],   // optional plan, shown before the run
  args: { type: "string" },                  // optional JSON Schema of args (saved workflows)
  argsHint: "<dir>",                         // optional hint for the /name command
}

phase("Discover")
const found = await agent(`List every .ts file under ${args ?? "src/routes"}. Return paths relative to the repo root.`, {
  label: "list route files",
  schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
  readOnly: true,
})
if (!found) throw new Error("Could not list the route files")

phase("Audit")
const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file} for route handlers without an authentication check. Report each handler with line numbers.`, {
    label: file,
    schema: FINDINGS,
    readOnly: true,
  }),
)

return { files: found.files.length, findings: audits.filter(Boolean).flatMap((a) => a.findings) }
```

Rules for `meta`: it is the first statement, and it holds only literal values (strings,
numbers, booleans, null, arrays, objects). No variables, calls, spreads, or template
substitutions. The body is plain JavaScript with top-level `await` and `return`.

## API

### agent(prompt, opts?) → Promise<string | object | null>

Starts one subagent. It is a pi agent session with a fresh context: it does not see the
conversation, other agents, or the script. Resolves to the agent's final text, or to
parsed JSON when `opts.schema` is set. Resolves to `null` when the agent fails (provider
error, timeout, validation failure after retries) or is stopped. With `onError: "throw"`
it throws an `AgentError` (`err.agentId`, `err.reason`) instead.

| option | type | meaning |
|---|---|---|
| `label` | string | Short name in the progress view. Default: the first line of the prompt. |
| `phase` | string | Phase for this agent (overrides `phase()`). |
| `schema` | JSON Schema | Structured result. The agent must call `submit_result` with matching JSON; it gets up to 5 tries. Contradictory schemas (a required key that `additionalProperties: false` forbids, an empty `enum`, `minItems > maxItems`) fail at once. |
| `model` | string | `"provider/id"`, a model id, or part of a name. Default: the session model. Use a smaller model for simple stages. |
| `thinking` | string | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Default: the session level. |
| `tools` | string[] | Tool allowlist. Default: the session's built-in tools (`env.defaultTools`). `[]` gives a pure reasoning agent. `env.tools` lists what exists, including MCP tools (`mcp__server__tool`). |
| `readOnly` | boolean | Shortcut for `tools: ["read", "grep", "find", "ls"]`. |
| `cwd` | string | Working directory, relative to the session directory. |
| `isolation` | `"worktree"` | The agent works in its own git worktree from HEAD. The call then resolves to `{ output, worktree: { path, branch, changed, diffStat } }`. Changes are committed to `branch`; merge them in a later step. Uncommitted changes of the main tree are not in the worktree. |
| `instructions` | string | Extra text appended to the prompt. |
| `context` | any | Data added to the prompt in a `<context>` block (strings as is, other values as JSON). Use it to pass results of earlier stages. |
| `timeout` | number | Seconds. The attempt fails when it passes. |
| `maxTurns` | number | Stop the agent after this many turns. |
| `retries` | number | Extra attempts after a provider error or timeout. Default 0 (pi already retries transient API errors). |
| `onError` | `"null"` or `"throw"` | Default `"null"`. |
| `cache` | boolean | `false`: never reuse a saved result on resume. |

### parallel(tasks, { concurrency }?) → Promise<any[]>

Runs tasks at the same time and waits for all. A task is a function (usually
`() => agent(...)`) or a value. An object of tasks gives an object of results:
`const { a, b } = await parallel({ a: () => agent(...), b: () => agent(...) })`.
If a task function throws, `parallel` rejects. Failed agents give `null` entries.

### pipeline(items, stage1, stage2?, ..., { concurrency }?) → Promise<any[]>

Sends each item through the stages on its own: item 3 can be in stage 2 while item 7 is
still in stage 1. There is no barrier between stages. Stage 1 gets `(item, index)`; later
stages get `(previousValue, item, index)`. A stage result of `null` or `undefined` stops
that item; its entry is `null`. Results keep the item order.

### race(tasks, predicate?) → Promise<{ index, value } | null>

Starts all tasks. The first value that passes `predicate` (default: not null) wins, and
the agents of the other tasks stop. Resolves `null` when no task wins.

### phase(title, fn?)

Without `fn`: the agents that the current code path starts next belong to `title`. Inside a
`parallel`/`pipeline` task, `phase()` changes only that task. With `fn`:
`await phase("Verify", () => parallel(...))` scopes the phase to the agents started in `fn`.
Titles in `meta.phases` show up as planned before they start.

### log(...values), console.log/info/warn/error

Notes for the human in the progress view. The last lines are also in the final result
message. Do not log large data.

### ask(question, { options?, default?, timeout? }) → Promise<string | null>

Asks the human and waits. The run shows "waits for your answer"; the human answers in
`/workflows` (or the main agent with `workflow_control answer` when the user told it the
answer). Without a human (print mode) or after `timeout` seconds it resolves to `default`.
Use it for real decisions only, such as "Apply 14 fixes now?".

### Other globals

- `args`: the input value (frozen), or `undefined`.
- `env`: `{ cwd, runId, name, sessionId, model, thinking, tools, defaultTools, gitRepo, platform }`.
- `budget`: live counts: `agentsStarted`, `agentsRemaining`, `agentsRunning`, `agentsDone`, `agentsFailed`, `tokens`, `cost`, `maxConcurrency`, `targetAgents`.
- `sleep(ms)`, `random()` (seeded per run, so a relaunch repeats it), `shuffle(list)`.

### Not available

`import`, `require`, file system, shell, network, timers other than `sleep`. Agents do
that work. `Date.now()`, `new Date()` without arguments, and `Math.random()` throw, so
that a relaunched run repeats the same `agent()` calls. Pass a timestamp in `args`.

### Limits

Concurrent agents per run (default 16), 1000 agents per run, 4096 items per
`parallel`/`pipeline`/`race` call. A size guideline (default: fewer than 10 agents) is
advice: follow it unless the user asks for a bigger or smaller run.

## Writing good agent prompts

- Make every prompt self-contained: paths, the goal, the criteria, and what to return.
  Agents do not see the conversation or each other.
- Ask for small results. Return findings, decisions, and paths, not file contents.
- Use `schema` whenever the script reads fields of a result. Keep schemas simple: objects
  with required keys, arrays of objects, enums for verdicts.
- Give each agent one focused job. Split large jobs into stages.
- Use `readOnly: true` for agents that only read. Give edit tools only to agents that edit.
- Use `context` to pass earlier results instead of pasting large text into the prompt.
- Ask independent agents to check claims that matter (adversarial verification).

## Patterns

### Fan-out and synthesize

```js
const parts = await parallel(dirs.map((d) => () => agent(`Summarize the purpose and public API of ${d}.`, { label: d, readOnly: true })))
return await agent("Write one architecture overview from these module summaries.", { context: parts.filter(Boolean), tools: [] })
```

### Adversarial verification

```js
const VERDICT = { type: "object", required: ["verdict", "reason"], properties: { verdict: { enum: ["confirmed", "refuted", "unsure"] }, reason: { type: "string" } } }
phase("Verify")
const checked = await pipeline(findings, (f) =>
  parallel([1, 2].map((n) => () =>
    agent(`Try to refute this finding. Read the code yourself. Finding: ${JSON.stringify(f)}`, { label: `${f.file} check ${n}`, schema: VERDICT, readOnly: true }),
  )).then((votes) => ({ ...f, votes })),
)
const confirmed = checked.filter((c) => c && c.votes.filter((v) => v?.verdict === "confirmed").length >= 2)
const unverified = checked.filter((c) => c && c.votes.some((v) => v === null))
```

A vote of `null` means the verifier failed (for example a rate limit): report the claim
as unverified, not as refuted.

### Generate and filter

```js
const ideas = await parallel([1, 2, 3, 4].map((i) => () => agent(`Propose a design for X. Angle ${i}: ...`, { label: `idea ${i}`, schema: IDEA })))
const ranked = await agent("Score each design against the rubric and keep the best two.", { context: ideas.filter(Boolean), schema: RANKING, tools: [] })
```

### Tournament

```js
let pool = candidates
while (pool.length > 1) {
  const pairs = []
  for (let i = 0; i < pool.length; i += 2) pairs.push(pool.slice(i, i + 2))
  pool = await parallel(pairs.map((p) => () => p.length === 1 ? p[0] :
    agent("Which of the two is better for the goal? Return the winner.", { context: p, schema: WINNER, tools: [] }).then((w) => w?.winner ?? p[0])))
}
return pool[0]
```

### Loop until done

```js
let lastErrors = Infinity
for (let round = 1; round <= 6; round++) {
  phase(`Round ${round}`)
  const check = await agent("Run `npx tsc --noEmit`. Return the error count and the list of errors.", { schema: TSC, label: "type check" })
  if (!check || check.count === 0) break
  if (check.count >= lastErrors) { log(`Round ${round}: no progress, stopping`); break }
  lastErrors = check.count
  const byFile = groupBy(check.errors, (e) => e.file)
  await parallel(Object.entries(byFile).map(([file, errs]) => () =>
    agent(`Fix these TypeScript errors in ${file}. Change only that file.`, { label: file, context: errs })))
}
```

### Classify and act

```js
const kind = await agent(`Classify this issue: ${args.title}`, { schema: { type: "object", required: ["kind"], properties: { kind: { enum: ["bug", "feature", "question"] } } }, tools: [] })
if (kind?.kind === "bug") return await agent("Reproduce and fix the bug ...")
```

### First success (race)

```js
const win = await race(strategies.map((s) => () => agent(`Make the failing test pass with this strategy: ${s}. Report "ok" only if the test passes.`, { label: s, isolation: "worktree" })),
  (r) => r?.output?.includes("ok"))
return win ? { strategy: strategies[win.index], branch: win.value.worktree.branch } : "no strategy worked"
```

### Human checkpoint

```js
const plan = await agent("Plan the migration ...", { schema: PLAN })
const go = await ask(`Apply the migration to ${plan.files.length} files?`, { options: ["yes", "no"], default: "no" })
if (go !== "yes") return { plan, applied: false }
```

## Iterate and resume

- Every run saves its script; the launch result gives `scriptPath`. To fix a script, edit
  that file and call `workflow({ scriptPath })`.
- `workflow({ resumeFromRunId })` relaunches a stopped or failed run in the same session.
  Agents are matched by call order. A completed agent with unchanged inputs returns its
  saved result. An agent runs again when its inputs changed, when it had no result, or when
  the script called it after the result of an agent that runs again (the script could have
  used that result). So parallel siblings of a failed agent keep their results, and a
  sequential chain runs again from the first change. Combine with `scriptPath` to resume an
  edited script.
- For determinism, keep the order of `agent()` calls stable: do not branch on `budget`
  or on timing.

## Errors you may see

- `meta must be a plain object literal ...`: remove variables or calls from `meta`.
- `import() is not allowed ...`: move that work into an agent.
- `agent(): unknown option "x"`: check the option table above.
- `agent(): unknown tool "x"`: use a name from `env.tools`.
- `schema contradiction: ...`: fix the schema; the agent did not start.
- `The script waits on a promise that can never settle`: an awaited promise has nothing
  that can resolve it.
- A run result with `Agents without a result`: these agents returned `null`. Check their
  errors, then resume or adjust prompts.

## Watching a run

The human watches runs in `/workflows` (also `alt+w`): runs → phases → agents → one
agent's prompt, tool calls, output, and result. They can pause, stop a run or one agent,
restart an agent, answer questions, and save the script as a `/command`. The main agent
can use `workflow_control` (`list`, `status`, `wait`, `stop`, `pause`, `resume`, `answer`).
