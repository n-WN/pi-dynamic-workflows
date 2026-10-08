export const meta = {
  name: "deep-research",
  description: "Research a question across many web sources, cross-check the key claims, and return a cited report",
  phases: [
    { title: "Plan", detail: "split the question into search angles" },
    { title: "Search", detail: "one search agent per angle" },
    { title: "Read", detail: "read the best sources, one agent per source" },
    { title: "Verify", detail: "independent agents try to refute each key claim" },
    { title: "Report", detail: "write the cited report" },
  ],
  whenToUse: "a question that needs current web sources and cross-checked claims",
  args: {
    anyOf: [
      { type: "string", minLength: 3 },
      {
        type: "object",
        required: ["question"],
        properties: {
          question: { type: "string", minLength: 3 },
          depth: { enum: ["quick", "standard", "deep"] },
        },
      },
    ],
  },
  argsHint: "<question>",
}

// Input: a question string, or { question, depth }.
const question = (typeof args === "string" ? args : args?.question ?? "").trim()
if (!question) {
  throw new Error("deep-research needs a question, for example: /deep-research What changed in the Node.js permission model between v20 and v22?")
}
const depth = (typeof args === "object" && args?.depth) || "standard"
const SIZES = {
  quick: { angles: 3, sources: 4, claims: 4, verifiers: 1 },
  standard: { angles: 4, sources: 8, claims: 6, verifiers: 2 },
  deep: { angles: 6, sources: 14, claims: 10, verifiers: 3 },
}
const size = SIZES[depth] ?? SIZES.standard

// Web tools of this session (for example an MCP server such as Parallel Search).
// MCP tool names are mcp__<server>__<tool>: classify by the tool's own name.
const own = (t) => t.split("__").pop()
const searchTools = env.tools.filter((t) => /search/i.test(own(t)) && !/^(grep|find|tool_search)$/.test(t))
const fetchTools = env.tools.filter((t) => /(fetch|extract|scrape|browse|read_?url|web_?read|crawl)/i.test(own(t)) && !searchTools.includes(t))
if (searchTools.length === 0) {
  throw new Error(
    "deep-research needs a web search tool, and this session has none. Add one, for example the Parallel Search MCP server: " +
      "`pi mcp add parallel-search --url https://search.parallel.ai/mcp`, then /reload and run /deep-research again.",
  )
}
const readTools = [...fetchTools, ...searchTools]
log(`Question: ${question}`)
log(`Depth ${depth}: ${size.angles} angles, ${size.sources} sources, ${size.claims} key claims, ${size.verifiers} verifier(s) each`)

// ---------------------------------------------------------------------------
phase("Plan")
const PLAN = {
  type: "object",
  required: ["angles"],
  properties: {
    angles: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        required: ["angle", "queries"],
        properties: {
          angle: { type: "string" },
          queries: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
        },
      },
    },
  },
}
const plan = await agent(
  `You plan web research.
Question: ${question}

Split the question into ${size.angles} distinct research angles, for example: official documentation, changelogs and release notes, issue trackers and discussions, expert analysis, and evidence that could contradict the obvious answer.
For each angle, write 1 to 4 precise web search queries.`,
  { label: "plan research angles", schema: PLAN, tools: [] },
)
if (!plan) throw new Error("The planning agent failed, so the research did not start.")
const angles = plan.angles.slice(0, size.angles)

// ---------------------------------------------------------------------------
phase("Search")
const SOURCES = {
  type: "object",
  required: ["sources"],
  properties: {
    sources: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["url", "title", "why"],
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          date: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
}
const found = await parallel(
  angles.map((a) => () =>
    agent(
      `Find the best web sources for one angle of a research question.
Question: ${question}
Angle: ${a.angle}
Start with these searches and refine them when the results are weak: ${a.queries.join(" | ")}

Return up to 8 sources. Prefer primary sources (official docs, changelogs, specifications, original reports) and recent ones. For each, say in one line why it matters.`,
      { label: a.angle, schema: SOURCES, tools: searchTools },
    ),
  ),
)
const seen = new Set()
const sources = []
for (const f of found) {
  for (const s of f?.sources ?? []) {
    const key = s.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    sources.push(s)
  }
}
log(`${sources.length} unique sources from ${angles.length} angles`)
if (sources.length === 0) throw new Error("The search agents found no sources. Check the web search tool, then try again.")
const top = sources.slice(0, size.sources)

// ---------------------------------------------------------------------------
phase("Read")
const CLAIMS = {
  type: "object",
  required: ["claims"],
  properties: {
    summary: { type: "string" },
    claims: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["claim", "quote"],
        properties: { claim: { type: "string" }, quote: { type: "string" }, date: { type: "string" } },
      },
    },
  },
}
const notes = await pipeline(top, (s) =>
  agent(
    `Read one web source and extract the facts that help answer the research question.
Question: ${question}
Source: ${s.title} - ${s.url}

Return up to 8 claims. Each claim needs a short exact quote from the source as evidence. Leave out claims that the source does not state directly.`,
    { label: s.title, schema: CLAIMS, tools: readTools },
  ).then((r) => (r ? { source: s, ...r } : null)),
)
const allClaims = notes.filter(Boolean).flatMap((n) => n.claims.map((c) => ({ ...c, url: n.source.url, title: n.source.title })))
log(`${allClaims.length} claims from ${notes.filter(Boolean).length} sources`)

// ---------------------------------------------------------------------------
phase("Verify")
const KEY = {
  type: "object",
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["claim", "urls"],
        properties: { claim: { type: "string" }, urls: { type: "array", items: { type: "string" } } },
      },
    },
  },
}
const key = await agent(
  `Merge duplicate claims and choose the ${size.claims} claims that matter most for answering the question. Keep the source URLs of each merged claim.
Question: ${question}`,
  { label: "select key claims", context: allClaims, schema: KEY, tools: [] },
)
const VOTE = {
  type: "object",
  required: ["verdict", "reason"],
  properties: {
    verdict: { enum: ["supported", "refuted", "unclear"] },
    reason: { type: "string" },
    evidenceUrl: { type: "string" },
  },
}
const checked = await pipeline((key?.claims ?? []).slice(0, size.claims), (c) =>
  parallel(
    Array.from({ length: size.verifiers }, (_, i) => () =>
      agent(
        `Check one claim independently. Search for evidence that confirms it and evidence that contradicts it; do not rely only on the cited sources.
Claim: ${c.claim}
Cited sources: ${c.urls.join(", ")}

Answer supported, refuted, or unclear, give the reason, and give the best evidence URL.`,
        { label: `check ${i + 1}: ${c.claim.slice(0, 50)}`, schema: VOTE, tools: readTools },
      ),
    ),
  ).then((votes) => ({ ...c, votes })),
)
// A verifier that failed (rate limit, API error) gives null: such a claim is unverified, not refuted.
function verdict(c) {
  const votes = c.votes.filter(Boolean)
  if (votes.length === 0) return "unverified"
  const yes = votes.filter((v) => v.verdict === "supported").length
  const no = votes.filter((v) => v.verdict === "refuted").length
  if (no > yes) return "refuted"
  if (yes > 0 && yes >= no && yes * 2 >= votes.length) return "supported"
  return "unclear"
}
const groups = { supported: [], unclear: [], unverified: [], refuted: [] }
for (const c of checked.filter(Boolean)) groups[verdict(c)].push({ claim: c.claim, urls: c.urls, votes: c.votes.filter(Boolean) })
log(`Verified: ${groups.supported.length} supported, ${groups.unclear.length} unclear, ${groups.unverified.length} unverified, ${groups.refuted.length} refuted`)

// ---------------------------------------------------------------------------
phase("Report")
const report = await agent(
  `Write a research report in Markdown that answers the question.
Question: ${question}

Rules:
- Start with a short direct answer.
- State only "supported" claims as facts, and cite each one inline as [title](url).
- Put "unclear" and "unverified" claims in a section "Open points", and say why each is open.
- Put "refuted" claims in a short section "Claims that did not survive cross-checking".
- End with a "Sources" list of the URLs you cite.
- Use the extracted notes for detail, but do not add facts that are not in the context.`,
  { label: "write report", context: { question, ...groups, notes: notes.filter(Boolean).map((n) => ({ source: n.source, summary: n.summary })) }, tools: [] },
)
return report ?? "The report agent failed. The verified claims are in the run log and in /workflows."
