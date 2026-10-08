export const meta = {
  name: "audit-routes",
  description: "Audit every route handler for missing authentication checks",
  phases: [
    { title: "Discover", detail: "list the route files" },
    { title: "Audit", detail: "one agent per file" },
    { title: "Verify", detail: "two independent checks per finding" },
    { title: "Report", detail: "write the summary" },
  ],
}

const FILES = { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } }
const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: { type: "object", required: ["handler", "line", "issue"], properties: { handler: { type: "string" }, line: { type: "number" }, issue: { type: "string" } } },
    },
  },
}
const VERDICT = { type: "object", required: ["verdict", "reason"], properties: { verdict: { enum: ["confirmed", "refuted"] }, reason: { type: "string" } } }

phase("Discover")
const found = await agent("List every .ts file under src/routes. Return paths relative to the project root.", { label: "list route files", schema: FILES, readOnly: true, thinking: "low" })

phase("Audit")
const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file}. Find route handlers that read or change private data without the requireAuth middleware. Handlers that are public by design (a comment says so) are fine. Report each finding with the handler's route and line.`, {
    label: file.replace("src/routes/", ""),
    schema: FINDINGS,
    readOnly: true,
    thinking: "low",
  }),
)
const findings = audits.flatMap((a, i) => (a?.findings ?? []).map((f) => ({ ...f, file: found.files[i] })))
log(`${findings.length} findings in ${found.files.length} files`)

phase("Verify")
const checked = await pipeline(findings, (f) =>
  parallel([1, 2].map((n) => () =>
    agent(`Check this finding. Read the code yourself. Can a request reach the handler without authentication? Finding: ${JSON.stringify(f)}`, {
      label: `${f.file.split("/").pop()}:${f.line} check ${n}`,
      schema: VERDICT,
      readOnly: true,
      thinking: "low",
    }),
  )).then((votes) => ({ ...f, votes })),
)
const confirmed = checked.filter((c) => c && c.votes.filter((v) => v?.verdict === "confirmed").length === 2)

phase("Report")
return await agent(`Write a short markdown report of these confirmed findings: a one-line summary, then a table with file, route, line, and issue. Findings: ${JSON.stringify(confirmed)}`, { label: "write report", tools: [], thinking: "low" })
