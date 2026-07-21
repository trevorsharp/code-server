import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { isClaudeCliModel, startClaudeCliAgent } from "../workflow-claude-cli"

// ---------------------------------------------------------------------------
// opencode-workflows: deterministic multi-agent orchestration for OpenCode.
//
// The workflow_run tool accepts a model-authored JavaScript script (the body
// of an async function) with injected primitives (agent/parallel/pipeline/
// log/sleep/phase). The script runs in the background inside the server
// process; each agent() call becomes a child session driven via the SDK
// client. On completion the originating session is woken with
// session.promptAsync (a synthetic part — the fork UI hides the bubble).
//
// Install: drop this file into ~/.config/opencode/plugins/ (or a project's
// .opencode/plugins/) and restart opencode. Disable by renaming to
// workflow.ts.disabled or setting {"enabled": false} in the config.
//
// Config (~/.config/opencode/workflow.json; project override in
// <worktree>/.opencode/workflow.json; restart after edits):
//   models          allowlist for agent profiles: [{slug, variant, note}] —
//                   baked into the tool description; empty = session default
//   maxConcurrency  agents in flight per run (default 8)
//   maxAgentsPerRun hard cap per run (default 100)
//   agentTimeoutMs  maximum agent working duration (default 30 min)
//
// Artifacts per run: ~/.local/share/opencode/workflows/<workflow_YYYYMMDD_HHMMSS>/
// (script.js, args.json, journal.jsonl, status.json, result.json).
//
// Inline phase/agent cards require the trs fork's POST /session/:id/agent-card
// endpoint; on stock opencode the plugin feature-detects and skips them.
// ---------------------------------------------------------------------------

type ModelEntry = { slug: string; variant: string; note?: string }

type WorkflowConfig = {
  enabled: boolean
  models: ModelEntry[]
  maxConcurrency: number
  maxAgentsPerRun: number
  agentTimeoutMs: number
  dataDir: string
}

type AgentOpts = {
  label?: string
  model?: string
  variant?: string
  system?: string
  schema?: any
  phase?: string
}

type WorkflowMeta = {
  name: string
  description: string
  phases?: Array<{ title: string; detail?: string }>
}

type PhaseState = {
  title: string
  detail?: string
  started: number
  finished: number
  failed: number
  models: string[]
}

type AgentRow = {
  label: string
  model?: string
  status: "running" | "completed" | "error"
  sessionID?: string
  phase?: string
}

type AgentControl = {
  release?: () => void
  timer?: ReturnType<typeof setTimeout>
  timedOut: boolean
  abort?: () => void
}

type Run = {
  id: string
  name: string
  status: "running" | "completed" | "failed" | "cancelled"
  callerSessionID: string
  directory: string
  dir: string
  startedAt: number
  finishedAt?: number
  agentsSpawned: number
  agentsCompleted: number
  agentsFailed: number
  logs: string[]
  error?: string
  result?: any
  cancelled: boolean
  activeSessions: Set<string>
  activeAgents: Map<string, AgentControl>
  phases: PhaseState[] | null
  currentPhase: string | null
  agentRows: AgentRow[]
  card: { messageID: string; partID: string } | null
  cardQueue: Promise<void>
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const SCRIPT_PARAMS = ["agent", "parallel", "pipeline", "log", "sleep", "args", "runId", "phase"]
const META_PREFIX = "export const meta ="
const CHILD_SYSTEM =
  "Your final reply is raw workflow return data consumed by an orchestration script, not a message to a user. Your normal session tools and MCP integrations are available, except task and workflow tools."
const liveRuns = new Map<string, Run>()

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WorkflowConfig = {
  enabled: true,
  models: [],
  maxConcurrency: 8,
  maxAgentsPerRun: 100,
  agentTimeoutMs: 1_800_000,
  dataDir: path.join(os.homedir(), ".local", "share", "opencode", "workflows"),
}

function readJsonIfExists(file: string): any {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    console.error(`[workflow plugin] failed to parse ${file}: ${e}`)
    return null
  }
}

function loadConfig(worktree: string | undefined): WorkflowConfig {
  const globalCfg = readJsonIfExists(path.join(os.homedir(), ".config", "opencode", "workflow.json")) ?? {}
  const projectCfg = worktree ? (readJsonIfExists(path.join(worktree, ".opencode", "workflow.json")) ?? {}) : {}
  const merged = { ...DEFAULT_CONFIG, ...globalCfg, ...projectCfg }
  merged.models = Array.isArray(merged.models)
    ? merged.models.filter((model: any) => model && typeof model.slug === "string" && typeof model.variant === "string")
    : []
  return merged
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private limit: number) {}
  async acquire(): Promise<() => void> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active++
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

function newRunId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `workflow_${date}_${time}`
}

function unwrap(res: any, what: string): any {
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new Error(`${what} failed: ${safeStringify(res.error).slice(0, 500)}`)
  }
  return res && typeof res === "object" && "data" in res ? res.data : res
}

function safeStringify(value: any, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? "null"
  } catch {
    return String(value)
  }
}

function extractText(parts: any[]): string {
  return (parts ?? [])
    .filter((p) => p?.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim()
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function parseScript(script: string): {
  meta: WorkflowMeta
  executable: string
} {
  if (!script.startsWith(META_PREFIX)) {
    throw new Error(`script must begin exactly with ${META_PREFIX}{...}`)
  }

  let start = META_PREFIX.length
  while (/\s/.test(script[start] ?? "")) start++
  if (script[start] !== "{") throw new Error("meta must be an object literal")

  let end = -1
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let index = start; index < script.length; index++) {
    const char = script[index]!
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === "`") throw new Error("meta must not contain template literals or interpolation")
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "{") depth++
    if (char === "}" && --depth === 0) {
      end = index + 1
      break
    }
  }
  if (quote || end < 0) throw new Error("meta object literal is not balanced")

  const literal = script.slice(start, end)
  let index = 0
  const skipSpace = () => {
    while (/\s/.test(literal[index] ?? "")) index++
  }
  const fail = (message: string): never => {
    throw new Error(`${message} at meta character ${index + 1}`)
  }
  const readString = () => {
    const delimiter = literal[index++]!
    let escapedString = false
    while (index < literal.length) {
      const char = literal[index++]!
      if (escapedString) escapedString = false
      else if (char === "\\") escapedString = true
      else if (char === delimiter) return
    }
    fail("meta contains an unterminated string")
  }
  const readIdentifier = () => {
    const match = literal.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)
    const identifier = match?.[0]
    if (!identifier) throw new Error(`meta expected an identifier at meta character ${index + 1}`)
    index += identifier.length
    return identifier
  }
  const readValue = (): void => {
    skipSpace()
    const char = literal[index]
    if (literal.startsWith("...", index)) fail("meta must not contain spreads")
    if (char === "(" || char === ")") fail("meta must not contain calls or expressions")
    if (char === "{") return readObject()
    if (char === "[") return readArray()
    if (char === '"' || char === "'") return readString()
    const number = literal.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (number) {
      index += number[0].length
      return
    }
    const identifier = readIdentifier()
    skipSpace()
    if (literal[index] === "(") fail("meta must not contain calls or expressions")
    if (identifier !== "true" && identifier !== "false" && identifier !== "null") {
      fail(`meta value "${identifier}" is not a literal; variables are not allowed`)
    }
  }
  const readObject = (): void => {
    index++
    skipSpace()
    if (literal[index] === "}") {
      index++
      return
    }
    while (index < literal.length) {
      skipSpace()
      if (literal.startsWith("...", index)) fail("meta must not contain spreads")
      if (literal[index] === '"' || literal[index] === "'") readString()
      else readIdentifier()
      skipSpace()
      if (literal[index++] !== ":") fail("meta object properties require explicit values")
      readValue()
      skipSpace()
      if (literal[index] === "}") {
        index++
        return
      }
      if (literal[index++] !== ",") fail("meta object properties must be comma-separated")
      skipSpace()
      if (literal[index] === "}") {
        index++
        return
      }
    }
    fail("meta object literal is not balanced")
  }
  const readArray = (): void => {
    index++
    skipSpace()
    if (literal[index] === "]") {
      index++
      return
    }
    while (index < literal.length) {
      readValue()
      skipSpace()
      if (literal[index] === "]") {
        index++
        return
      }
      if (literal[index++] !== ",") fail("meta array values must be comma-separated")
      skipSpace()
      if (literal[index] === "]") {
        index++
        return
      }
    }
    fail("meta array literal is not balanced")
  }

  readValue()
  skipSpace()
  if (index !== literal.length) fail("meta contains a non-literal expression")

  const meta = new Function(`return (${literal})`)() as WorkflowMeta
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("meta must be an object literal")
  const keys = Object.keys(meta)
  const unknown = keys.filter((key) => !["name", "description", "phases"].includes(key))
  if (unknown.length > 0) throw new Error(`meta contains unsupported field(s): ${unknown.join(", ")}`)
  if (typeof meta.name !== "string" || !meta.name.trim()) throw new Error("meta.name is required and must be a string")
  if (typeof meta.description !== "string" || !meta.description.trim()) {
    throw new Error("meta.description is required and must be a string")
  }
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new Error("meta.phases must be an array")
    for (const [phaseIndex, phase] of meta.phases.entries()) {
      if (!phase || typeof phase !== "object" || Array.isArray(phase)) {
        throw new Error(`meta.phases[${phaseIndex}] must be an object literal`)
      }
      const phaseKeys = Object.keys(phase)
      const unsupported = phaseKeys.filter((key) => key !== "title" && key !== "detail")
      if (unsupported.length > 0) {
        throw new Error(`meta.phases[${phaseIndex}] contains unsupported field(s): ${unsupported.join(", ")}`)
      }
      if (typeof phase.title !== "string" || !phase.title.trim()) {
        throw new Error(`meta.phases[${phaseIndex}].title is required and must be a string`)
      }
      if (phase.detail !== undefined && typeof phase.detail !== "string") {
        throw new Error(`meta.phases[${phaseIndex}].detail must be a string`)
      }
    }
  }

  return { meta, executable: script.slice("export ".length) }
}

function parseModelSlug(slug: string): { providerID: string; modelID: string } {
  const idx = slug.indexOf("/")
  if (idx <= 0 || idx === slug.length - 1) {
    throw new Error(`invalid model slug "${slug}" — expected "provider/model"`)
  }
  return { providerID: slug.slice(0, idx), modelID: slug.slice(idx + 1) }
}

// ---------------------------------------------------------------------------
// Run persistence
// ---------------------------------------------------------------------------

function statusSnapshot(run: Run) {
  return {
    runId: run.id,
    name: run.name,
    status: run.status,
    callerSessionID: run.callerSessionID,
    directory: run.directory,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
    agentsSpawned: run.agentsSpawned,
    agentsCompleted: run.agentsCompleted,
    agentsFailed: run.agentsFailed,
    phases: run.phases
      ? run.phases.map((phase) => ({
          title: phase.title,
          started: phase.started,
          finished: phase.finished,
          failed: phase.failed,
        }))
      : undefined,
    agents: run.agentRows,
    scriptPath: path.join(run.dir, "script.js"),
    logs: run.logs.slice(-100),
    error: run.error ?? null,
  }
}

function writeStatus(run: Run) {
  try {
    fs.writeFileSync(path.join(run.dir, "status.json"), safeStringify(statusSnapshot(run), 2))
  } catch (e) {
    console.error(`[workflow plugin] failed to write status for ${run.id}: ${e}`)
  }
}

function journal(run: Run, entry: Record<string, any>) {
  try {
    fs.appendFileSync(
      path.join(run.dir, "journal.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    )
  } catch (e) {
    console.error(`[workflow plugin] failed to journal for ${run.id}: ${e}`)
  }
}

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

function modelSection(cfg: WorkflowConfig, variantsBySlug: Map<string, string[]>): string {
  if (cfg.models.length === 0) {
    return `MODEL PROFILES: no allowlist is configured, so omit opts.model and opts.variant (agents use the session default model). To enable per-agent model selection, add profiles to ~/.config/opencode/workflow.json and restart opencode.`
  }
  const lines = cfg.models.map((model) => {
    const knownVariants = variantsBySlug.get(model.slug)
    const unsupported = knownVariants && !knownVariants.includes(model.variant) ? " [unsupported variant]" : ""
    return `  - model: "${model.slug}", variant: "${model.variant}"${unsupported}${model.note ? ` — ${model.note}` : ""}`
  })
  return `MODEL PROFILES — every agent() call must explicitly declare an exact model and variant pair from this list (pick deliberately per the notes; never rely on a default):\n${lines.join("\n")}\n(Profiles configured in ~/.config/opencode/workflow.json; edits require an opencode restart.)`
}

function runDescription(cfg: WorkflowConfig, variantsBySlug: Map<string, string[]>): string {
  return `Run a model-neutral multi-agent orchestration script in the background. Use workflow_run whenever delegation helps, including a one-off agent. It is especially useful for parallel research, reviews with adversarial verification, migrations, audits, broad sweeps, and comparing independent attempts. No user opt-in is required.

HOW IT RUNS: workflow_run returns immediately with a run ID while the script continues in the background. Completion or failure will inject a synthetic message into this session. After starting a workflow, conclude the current turn with a brief progress update rather than continuing overlapping work. Do not wait, poll, or sleep; use workflow_status only when the user explicitly requests progress. A child's final output is raw workflow return data, not a user-facing response. You must synthesize the workflow result for the user. In-flight runs do not survive an opencode server restart.

SCRIPT SOURCE: provide exactly one of \`script\` or \`scriptPath\`. A scriptPath is read fresh and copied into the new run's artifacts; this is iteration, not a saved-workflow registry. Inline scripts are also persisted as script.js. Every script must BEGIN exactly with a pure literal:
  export const meta = { name: "review-files", description: "Review files and verify findings", phases: [{ title: "Review" }, { title: "Verify", detail: "Refute candidate findings" }] }
Then write plain JavaScript forming an async function body. Metadata admits only literal data: name and description are required; phases is optional and contains {title, detail?}. Variables, calls, spreads, template literals, interpolation, and model fields are rejected. No imports or TypeScript. Workflow scripts must not use filesystem, Node APIs, fetch, or hidden globals. Return a JSON-serializable value.

INJECTED PRIMITIVES:
- await agent(prompt, opts?) -> raw text, structured data when opts.schema is set, or null after terminal failure. Each call creates a nested child session in the current project. Children cannot see this conversation or script, so prompts must be self-contained. Children inherit available session tools and MCP integrations, except task and workflow tools are disabled to prevent recursion.
    label: short child title and journal label
${
  cfg.models.length > 0
    ? `    model: REQUIRED exact slug from MODEL PROFILES
    variant: REQUIRED exact variant paired with that slug`
    : `    model: omit when no profiles are configured
    variant: omit when no profiles are configured`
}
    system: additional child system text
    schema: JSON Schema passed through OpenCode's native structured-output format with two retries; returns AssistantMessage.structured
    phase: declared meta.phases title. Prefer opts.phase inside concurrent callbacks.
- await pipeline(items, ...stages) -> array. DEFAULT for multi-stage work. Every item advances independently through stages; item A may be verified while item B is still being discovered. Each stage receives (previousResult, originalItem, index). A failed item becomes null and skips its remaining stages.
- await parallel(thunks) -> array. Runs zero-argument functions concurrently and waits for all. Failed thunks resolve as null.
- phase(title): sets the default phase for later agent calls. Use only in sequential code; concurrent callbacks should use opts.phase.
- log(message), await sleep(ms), args (the tool's JSON args), runId.

PHASES: meta.phases is an ordered coarse progress plan, normally 2-8 entries. It controls cards only, not model routing. Attribute calls with opts.phase or phase(). Keep labels short. A workflow normally discovers its own scope rather than requiring inline scouting first. For large multi-phase work, prefer separate focused workflows and let the main agent inspect each result and decide what workflow to run next.

BARRIERS: pipeline is the default. A barrier is valid only when the next operation truly requires the complete prior set: global deduplication/ranking, synthesis across all evidence, a completeness decision, an early exit based on total count, or a main-agent decision between phases. Invalid reasons include matching phase names, visual organization, "finish research before review," or batching work that can be checked item-by-item. Smell test: can result B start its next operation before result A finishes? If yes, a barrier is unnecessary.
- Invalid: \`const reviews = await parallel(files.map(file => () => review(file))); const checks = await parallel(reviews.flatMap(review => review.findings.map(finding => () => verify(finding))))\`. Verification waits for the slowest review.
- Rewrite: \`await pipeline(files, (_, file) => review(file), review => parallel(review.findings.map(finding => () => verify(finding))))\`. Findings stream into verification.
- Valid: \`const reports = await parallel(sources.map(source => () => research(source))); return agent("Synthesize every report: " + JSON.stringify(reports), ...)\` because synthesis needs the full set.

WORKFLOW TAXONOMY:
- Understand: investigate unfamiliar code, map behavior and dependencies, then synthesize an explanation. Parallelize independent areas; avoid premature design.
- Design: produce independent designs under the same constraints, critique tradeoffs, then synthesize a chosen design. Keep implementation out unless requested.
- Review: divide by meaningful quality dimensions, report concrete evidence, and adversarially verify candidates before presenting findings.
- Research: investigate independent sources or hypotheses in parallel, preserve citations/evidence, then reconcile conflicts and gaps.
- Migrate: inventory the full scope, transform independent units, validate each as soon as it completes, then run a global completeness check.

QUALITY PATTERNS:
- Canonical review: assign dimensions such as correctness, security, concurrency, data integrity, API compatibility, and tests. Stream each dimension's candidates immediately into an adversarial verifier that tries to refute them from source evidence.
- Majority-vote refutation: use multiple independent skeptics per claim; retain it only when the required majority fails to refute it. Record dissent, not just the vote.
- Perspective-diverse verification: verify from distinct failure perspectives rather than duplicating the same prompt.
- Judge panel: create independent attempts, score every attempt in parallel against explicit criteria, then synthesize a result that uses the winner while grafting in stronger ideas from runners-up.
- Loop-until-count: continue independent discovery until the requested number of unique, supported results is reached; dedupe before counting.
- Loop-until-dry: continue until consecutive rounds produce no new findings. Dedupe against ALL previously seen candidates, including rejected ones, so rediscovery does not fake progress.
- Multi-modal sweep: combine structural search, behavioral tracing, history/docs, tests, and boundary analysis; different methods expose different misses.
- Completeness critic: give a critic the scope and all seen results, ask what is missing, then feed its uncovered dimensions into another discovery/verification round.
- Never impose a silent coverage cap. If the user asks for exhaustive or comprehensive work, continue to the semantic stop condition or return an explicit limitation.

SCALING: follow explicit wording first. "Quick" means a small proportional fan-out and minimal verification. "Thorough," "audit," "comprehensive," or "exhaustive" means broader dimensions, independent verification, and completeness checks. When wording is silent, scale by ambiguity, risk, and scope. Keep agent counts proportional; more agents without distinct work do not improve quality.

LIMITS AND RECOVERY: at most ${cfg.maxConcurrency} agents work concurrently and ${cfg.maxAgentsPerRun} may be spawned. agent(), parallel(), and pipeline() preserve terminal agent failures as null. Always inspect journal.jsonl before speculating about empty or surprising results. Every full prompt, result, failure, and transition is journaled. There is no automatic network retry. An agent request that reaches ${cfg.agentTimeoutMs}ms is aborted and settles as null; other agents continue. workflow_cancel ends a running workflow.

${modelSection(cfg, variantsBySlug)}

COMPOSED EXHAUSTIVE-REVIEW EXAMPLE: pass files, dimensions, sweep prompts, and all exact configured profiles through args. Each args.verifiers entry pairs a named perspective with a configured model and variant. Reviews stream into perspective-diverse majority refutation; independent sweeps continue until dry; a completeness critic supplies a final round.
  export const meta = { name: "exhaustive-review", description: "Exhaustive review with adversarial verification", phases: [
    { title: "Discover", detail: "Dimension and multi-modal sweeps" },
    { title: "Verify", detail: "Independent refutation" },
    { title: "Complete", detail: "Find gaps and run another round" }
  ] }
  const FINDINGS = { type: "object", required: ["findings"], properties: { findings: { type: "array", items: {
    type: "object", required: ["file", "line", "summary", "evidence"], properties: {
      file: { type: "string" }, line: { type: "integer" },
      summary: { type: "string" }, evidence: { type: "string" } } } } } }
  const VERDICT = { type: "object", required: ["refuted", "reason"], properties: {
    refuted: { type: "boolean" }, reason: { type: "string" } } }
  const GAPS = { type: "object", required: ["dimensions"], properties: {
    dimensions: { type: "array", items: { type: "string" } } } }
  const seen = new Map()
  const normalize = value => String(value ?? "").toLowerCase().replace(/\\s+/g, " ").trim()
  const findingKey = finding => JSON.stringify([
    normalize(finding.file), Number(finding.line), normalize(finding.summary), normalize(finding.evidence)
  ])
  const verify = async finding => {
    const key = findingKey(finding)
    if (seen.has(key)) return null
    seen.set(key, finding)
    const votes = await parallel(args.verifiers.map(verifier => () => agent(
      "Try to refute this candidate from repository evidence. Perspective: " + verifier.perspective + "\\nCandidate: " + JSON.stringify(finding),
      { label: "refute " + finding.file + ":" + finding.line + " " + verifier.perspective, phase: "Verify", model: verifier.model, variant: verifier.variant, schema: VERDICT }
    )))
    const valid = votes.filter(Boolean)
    const refutations = valid.filter(vote => vote.refuted).length
    return valid.length > 0 && refutations < Math.ceil(valid.length / 2) ? { ...finding, verification: valid } : null
  }
  const discover = dimensions => pipeline(
    dimensions,
    (_, dimension) => agent(
      "Review these files only for " + dimension + ". Return concrete supported candidates: " + JSON.stringify(args.files),
      { label: "review " + dimension, phase: "Discover", model: args.reviewer.model, variant: args.reviewer.variant, schema: FINDINGS }
    ),
    report => parallel((report?.findings ?? []).map(finding => () => verify(finding)))
  )
  const confirmed = (await discover(args.dimensions)).filter(Boolean).flat().filter(Boolean)
  let dryRounds = 0
  while (dryRounds < 2) {
    const before = seen.size
    const sweeps = await parallel(args.sweeps.map((sweep, index) => () => agent(
      sweep + "\\nFiles: " + JSON.stringify(args.files) + "\\nAlready seen candidates: " + JSON.stringify([...seen.values()]),
      { label: "sweep " + index, phase: "Discover", model: args.finder.model, variant: args.finder.variant, schema: FINDINGS }
    )))
    const checked = await parallel(sweeps.filter(Boolean).flatMap(report => report.findings.map(finding => () => verify(finding))))
    confirmed.push(...checked.filter(Boolean))
    dryRounds = seen.size === before ? dryRounds + 1 : 0
  }
  const gaps = await agent(
    "Critique completeness. Identify uncovered review dimensions from the scope and all seen candidates: " + JSON.stringify({ files: args.files, seen: [...seen.values()] }),
    { label: "completeness", phase: "Complete", model: args.critic.model, variant: args.critic.variant, schema: GAPS }
  )
  if (gaps?.dimensions?.length) confirmed.push(...(await discover(gaps.dimensions)).filter(Boolean).flat().filter(Boolean))
  log(confirmed.length + " confirmed unique findings")
  return { confirmed, seen: seen.size }`
}

const STATUS_DESCRIPTION = `Check background workflows. Without runId, lists recent runs. With runId, returns phases, agents, recent logs, and a finished result or error. Running disk state without a live run is "interrupted" after server restart. Do not poll; completed workflows announce themselves.`

const CANCEL_DESCRIPTION = `Cancel a running workflow. Aborts in-flight child sessions and stops new agents. Completed work remains in the journal.`

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const WorkflowPlugin: Plugin = async ({ client, worktree, directory, serverUrl }) => {
  const cfg = loadConfig(worktree || directory)
  if (!cfg.enabled) {
    console.error("[workflow plugin] disabled via workflow.json")
    return {}
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  const allowedModels = new Set(cfg.models.map((m) => m.slug))

  // Discover reasoning-effort variants for allowlisted models so the tool
  // description and opts.variant validation reflect reality. Providers are
  // not ready while plugins load, so this runs in the background with
  // retries; the tool.definition hook injects the enriched description once
  // available. Until then variants are undocumented and passed through
  // unvalidated.
  const variantsBySlug = new Map<string, string[]>()
  async function loadVariants() {
    for (let attempt = 1; attempt <= 12; attempt++) {
      try {
        const res = unwrap(
          await withTimeout(client.config.providers({}) as Promise<any>, 15_000, "config.providers"),
          "config.providers",
        )
        const providers = res?.providers ?? (Array.isArray(res) ? res : [])
        for (const provider of providers) {
          for (const [modelID, model] of Object.entries<any>(provider?.models ?? {})) {
            const slug = `${provider.id}/${modelID}`
            if (!allowedModels.has(slug)) continue
            const variants = Object.keys(model?.variants ?? {})
            if (variants.length > 0) variantsBySlug.set(slug, variants)
          }
        }
        return
      } catch (e) {
        if (attempt === 12) console.error(`[workflow plugin] could not load model variants: ${e}`)
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
  }
  void loadVariants()

  // ---------------------------------------------------------------------------
  // Inline agent cards (fork feature: POST /session/:id/agent-card).
  // Renders each workflow agent as a native subagent card in the caller's
  // conversation. Feature-detected so the plugin still works on stock opencode.
  // ---------------------------------------------------------------------------

  let agentCardsSupported: boolean | null = null

  type CardRef = { messageID: string; partID: string }

  async function upsertAgentCard(run: Run, body: Record<string, any>): Promise<CardRef | null> {
    if (agentCardsSupported === false) return null
    try {
      const url = new URL(`/session/${run.callerSessionID}/agent-card`, serverUrl)
      url.searchParams.set("directory", run.directory)
      const headers: Record<string, string> = {
        "content-type": "application/json",
      }
      if (process.env.OPENCODE_SERVER_PASSWORD) {
        headers.authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
      if (res.status === 404 || res.status === 405) {
        if (agentCardsSupported === null) journal(run, { type: "agent_card_unsupported" })
        agentCardsSupported = false
        return null
      }
      if (!res.ok) {
        journal(run, {
          type: "agent_card_error",
          status: res.status,
          body: (await res.text()).slice(0, 300),
        })
        return null
      }
      agentCardsSupported = true
      return (await res.json()) as CardRef
    } catch (e: any) {
      journal(run, {
        type: "agent_card_error",
        error: String(e?.message ?? e),
      })
      return null
    }
  }

  async function appendExternalTranscript(run: Run, sessionID: string, body: Record<string, any>): Promise<void> {
    const url = new URL(`/session/${sessionID}/external-transcript`, serverUrl)
    url.searchParams.set("directory", run.directory)
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (process.env.OPENCODE_SERVER_PASSWORD) {
      headers.authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
    }
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`external transcript failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }

  // Phase progress cards: one card per declared phase, pending upfront, running
  // while its agents are in flight, settled with aggregate counts.

  function phaseStatus(run: Run, phase: PhaseState, final: boolean): string {
    if (phase.started === 0) {
      if (!final) return "pending"
      return run.status === "completed" ? "skipped" : "pending"
    }
    const settled = phase.finished + phase.failed >= phase.started
    if (!settled) return final ? (run.status === "completed" ? "completed" : "error") : "running"
    return phase.failed > 0 && phase.finished === 0 ? "error" : "completed"
  }

  function runCardBody(run: Run, final = false) {
    // The fork's existing card payload calls phases "steps"; keep that wire key
    // while the workflow script API consistently uses phase terminology.
    const steps = run.phases?.map((phase) => {
      const status = phaseStatus(run, phase, final)
      return {
        title: phase.title,
        detail: phase.detail,
        status,
        model: phase.models.length > 0 ? phase.models.join(", ") : undefined,
        agents: run.agentRows.filter((row) => row.phase === phase.title),
      }
    })
    const status = run.status === "running" ? "running" : run.status === "completed" ? "completed" : "error"
    const summary = `${run.agentsCompleted} agent(s) completed${run.agentsFailed ? `, ${run.agentsFailed} failed` : ""}`
    return {
      tool: "workflow",
      description: run.name,
      agent: "workflow",
      prompt: run.name,
      status,
      ...(status === "completed" ? { output: summary } : {}),
      ...(status === "error" ? { error: (run.error ?? `workflow ${run.status}`).slice(0, 500) } : {}),
      metadata: {
        uiOnly: true,
        workflow: {
          runId: run.id,
          name: run.name,
          status: run.status,
          ...(steps ? { steps } : {}),
          agents: run.agentRows.filter((row) => !row.phase),
        },
      },
      ...(run.card ?? {}),
    }
  }

  function pushRunCard(run: Run, final = false) {
    run.cardQueue = run.cardQueue
      .then(async () => {
        const ref = await upsertAgentCard(run, runCardBody(run, final))
        if (ref && !run.card) run.card = ref
      })
      .catch(() => {})
    return run.cardQueue
  }

  function resolvePhase(run: Run, opts: AgentOpts): PhaseState | null {
    const name = opts.phase ?? run.currentPhase
    if (!run.phases || !name) return null
    const found = run.phases.find((phase) => phase.title.toLowerCase() === String(name).toLowerCase())
    if (!found)
      journal(run, {
        type: "unknown_phase",
        phase: name,
        known: run.phases.map((phase) => phase.title),
      })
    return found ?? null
  }

  // -------------------------------------------------------------------------
  // Script primitives
  // -------------------------------------------------------------------------

  class WorkflowCancelledError extends Error {}
  class AgentTimeoutError extends Error {}

  async function runAgent(run: Run, semaphore: Semaphore, prompt: string, opts: AgentOpts = {}): Promise<any> {
    const startedAt = Date.now()
    const label = opts.label ?? (typeof prompt === "string" ? prompt.replace(/\s+/g, " ").slice(0, 60) : "agent")
    let phase: PhaseState | null = null
    let sessionID: string | undefined
    let activeAgentID: string | undefined
    let row: AgentRow | null = null
    let control: AgentControl | undefined
    let release: (() => void) | undefined
    try {
      if (run.cancelled) throw new WorkflowCancelledError("workflow was cancelled")
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new Error("agent(prompt) requires a non-empty string prompt")
      }
      phase = resolvePhase(run, opts)
      if (cfg.models.length > 0) {
        if (!opts.model) {
          const profiles = cfg.models.map((profile) => `${profile.slug} (${profile.variant})`).join(", ")
          throw new Error(`agent("${prompt.slice(0, 40)}...") is missing opts.model; choose from: ${profiles}`)
        }
        if (!opts.variant) throw new Error(`agent("${prompt.slice(0, 40)}...") is missing opts.variant`)
        const configuredProfile = cfg.models.some(
          (profile) => profile.slug === opts.model && profile.variant === opts.variant,
        )
        if (!configuredProfile) {
          const profiles = cfg.models.map((profile) => `${profile.slug} (${profile.variant})`).join(", ")
          throw new Error(`model profile "${opts.model} (${opts.variant})" is not configured; choose from: ${profiles}`)
        }
      } else if (opts.model || opts.variant) {
        throw new Error("no model profiles are configured; omit opts.model and opts.variant to use the session default")
      }
      if (opts.variant && opts.model) {
        const known = variantsBySlug.get(opts.model)
        if (known && !known.includes(opts.variant)) {
          throw new Error(`variant "${opts.variant}" is not supported by ${opts.model}; supported: ${known.join(", ")}`)
        }
      }
      const useClaudeCli = isClaudeCliModel(opts.model)
      const model = opts.model && !useClaudeCli ? parseModelSlug(opts.model) : undefined
      const modelLabel = opts.model ? `${opts.model} (${opts.variant})` : "session default"

      if (run.agentsSpawned >= cfg.maxAgentsPerRun) {
        throw new Error(`agent cap reached (${cfg.maxAgentsPerRun} per run)`)
      }
      run.agentsSpawned++
      writeStatus(run)
      release = await semaphore.acquire()
      if (run.cancelled) {
        release()
        throw new WorkflowCancelledError("workflow was cancelled")
      }
      const session = unwrap(
        await client.session.create({
          body: {
            parentID: run.callerSessionID,
            title: `${run.id} ${label}`,
            ...(useClaudeCli
              ? {
                  agent: "claude-cli",
                  model: {
                    providerID: "claude-cli",
                    id: opts.model!.slice("claude-cli/".length),
                    variant: opts.variant,
                  },
                }
              : {}),
            metadata: {
              background: true,
              parentSessionId: run.callerSessionID,
              source: "workflow",
              ...(useClaudeCli ? { externalAgent: "claude-cli" } : {}),
            },
          } as any,
          query: { directory: run.directory },
        }),
        "session.create",
      )
      sessionID = session?.id
      if (!sessionID) throw new Error(`session.create returned no id: ${safeStringify(session).slice(0, 300)}`)
      run.activeSessions.add(sessionID)
      activeAgentID = sessionID
      row = {
        label,
        model: modelLabel,
        status: "running",
        sessionID,
        phase: phase?.title,
      }
      run.agentRows.push(row)
      if (phase) {
        phase.started++
        if (!phase.models.includes(modelLabel)) phase.models.push(modelLabel)
      }
      const agentControl: AgentControl = {
        release,
        timedOut: false,
      }
      control = agentControl
      run.activeAgents.set(activeAgentID, agentControl)
      pushRunCard(run)

      if (run.cancelled) throw new WorkflowCancelledError("workflow was cancelled")
      const timeout = new Promise<never>((_, reject) => {
        agentControl.timer = setTimeout(() => {
          agentControl.timer = undefined
          agentControl.timedOut = true
          journal(run, {
            type: "agent_timeout",
            label,
            sessionID,
            timeoutMs: cfg.agentTimeoutMs,
          })
          writeStatus(run)
          agentControl.abort?.()
          reject(new AgentTimeoutError(`agent "${label}" timed out after ${cfg.agentTimeoutMs}ms`))
        }, cfg.agentTimeoutMs)
      })

      let res: any
      try {
        const system = opts.system ? `${opts.system}\n\n${CHILD_SYSTEM}` : CHILD_SYSTEM
        let request: Promise<any>
        if (useClaudeCli) {
          const providerID = "claude-cli"
          const modelID = opts.model!.slice("claude-cli/".length)
          let claudeSessionID: string | undefined
          const tools = new Map<string, { tool: string; input: Record<string, any> }>()
          await appendExternalTranscript(run, sessionID, {
            type: "user",
            providerID,
            modelID,
            text: prompt,
          })
          const handle = startClaudeCliAgent({
            directory: run.directory,
            prompt,
            model: opts.model!,
            variant: opts.variant!,
            system,
            schema: opts.schema,
            onEvent: async (event) => {
              if (event?.type === "system" && event?.subtype === "init") {
                claudeSessionID = event.session_id
                return
              }
              if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
                for (const block of event.message.content) {
                  if (block?.type === "text" && typeof block.text === "string" && block.text) {
                    await appendExternalTranscript(run, sessionID!, {
                      type: "text",
                      providerID,
                      modelID,
                      claudeSessionID,
                      text: block.text,
                    })
                  }
                  if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                    tools.set(block.id, {
                      tool: block.name.toLowerCase(),
                      input: block.input && typeof block.input === "object" ? block.input : { value: block.input },
                    })
                  }
                }
                return
              }
              if (event?.type !== "user" || !Array.isArray(event.message?.content)) return
              for (const block of event.message.content) {
                if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue
                const tool = tools.get(block.tool_use_id)
                if (!tool) continue
                const output =
                  typeof block.content === "string" ? block.content : safeStringify(block.content ?? event.tool_use_result)
                await appendExternalTranscript(run, sessionID!, {
                  type: "tool",
                  providerID,
                  modelID,
                  claudeSessionID,
                  callID: block.tool_use_id,
                  tool: tool.tool,
                  input: tool.input,
                  output,
                  error: block.is_error === true,
                })
                tools.delete(block.tool_use_id)
              }
            },
          })
          agentControl.abort = handle.abort
          request = handle.result
        } else {
          agentControl.abort = () => {
            ;(client.session.abort({ path: { id: sessionID! } }) as Promise<any>).catch(() => {})
          }
          request = client.session.prompt({
            path: { id: sessionID },
            query: { directory: run.directory },
            body: {
              parts: [{ type: "text", text: prompt }],
              ...(model ? { model } : {}),
              ...(opts.variant ? { variant: opts.variant } : {}),
              system,
              ...(opts.schema
                ? {
                    format: {
                      type: "json_schema",
                      schema: opts.schema,
                      retryCount: 2,
                    },
                  }
                : {}),
              tools: {
                task: false,
                workflow_run: false,
                workflow_status: false,
                workflow_cancel: false,
              },
            },
          } as any) as Promise<any>
        }
        res = unwrap(await Promise.race([request, timeout]), useClaudeCli ? "claude -p" : "session.prompt")
      } catch (error) {
        if (run.cancelled) throw new WorkflowCancelledError("workflow was cancelled")
        if (agentControl.timedOut && !(error instanceof AgentTimeoutError)) {
          throw new AgentTimeoutError(`agent "${label}" timed out after ${cfg.agentTimeoutMs}ms`)
        }
        throw error
      } finally {
        clearTimeout(agentControl.timer)
        agentControl.timer = undefined
      }

      if (run.cancelled) throw new WorkflowCancelledError("workflow was cancelled")
      const responseError = useClaudeCli ? undefined : res?.info?.error
      if (responseError) throw new Error(`agent response failed: ${safeStringify(responseError).slice(0, 500)}`)
      const result = useClaudeCli ? res : opts.schema ? res?.info?.structured : extractText(res?.parts)
      if (opts.schema && result === undefined) {
        throw new Error(`agent "${label}" returned no structured output`)
      }
      run.agentsCompleted++
      journal(run, {
        type: "agent",
        label,
        sessionID,
        model: opts.model ?? null,
        variant: opts.variant ?? null,
        durationMs: Date.now() - startedAt,
        prompt,
        result,
      })
      if (phase) phase.finished++
      row.status = "completed"
      writeStatus(run)
      pushRunCard(run)
      return result
    } catch (e: any) {
      if (e instanceof WorkflowCancelledError) throw e
      run.agentsFailed++
      journal(run, {
        type: "agent_error",
        label,
        sessionID: sessionID ?? null,
        durationMs: Date.now() - startedAt,
        prompt,
        error: String(e?.message ?? e),
      })
      if (phase && row) phase.failed++
      if (row) row.status = "error"
      writeStatus(run)
      pushRunCard(run)
      return null
    } finally {
      clearTimeout(control?.timer)
      control?.release?.()
      if (!control) release?.()
      if (activeAgentID) run.activeAgents.delete(activeAgentID)
      if (sessionID) run.activeSessions.delete(sessionID)
    }
  }

  function makePrimitives(run: Run) {
    const semaphore = new Semaphore(cfg.maxConcurrency)
    const agent = (prompt: string, opts?: AgentOpts) => runAgent(run, semaphore, prompt, opts)
    const parallel = async (thunks: Array<() => Promise<any>>) => {
      if (!Array.isArray(thunks)) throw new Error("parallel(thunks) requires an array of zero-arg functions")
      return Promise.all(
        thunks.map(async (thunk, index) => {
          if (typeof thunk !== "function") {
            journal(run, {
              type: "parallel_error",
              index,
              error: "item is not a function",
            })
            return null
          }
          try {
            return await thunk()
          } catch (e: any) {
            if (e instanceof WorkflowCancelledError) throw e
            journal(run, {
              type: "parallel_error",
              index,
              error: String(e?.message ?? e),
            })
            return null
          }
        }),
      )
    }
    const pipeline = async (items: any[], ...stages: Array<(prev: any, item: any, index: number) => any>) => {
      if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) requires an array of items")
      if (stages.some((s) => typeof s !== "function")) throw new Error("pipeline stages must be functions")
      return Promise.all(
        items.map(async (item, index) => {
          let value: any = item
          for (const stage of stages) {
            try {
              value = await stage(value, item, index)
              if (value === null) return null
            } catch (e: any) {
              if (e instanceof WorkflowCancelledError) throw e
              journal(run, {
                type: "pipeline_error",
                index,
                error: String(e?.message ?? e),
              })
              return null
            }
          }
          return value
        }),
      )
    }
    const log = (message: any) => {
      const line = `[${new Date().toISOString()}] ${String(message)}`
      run.logs.push(line)
      if (run.logs.length > 500) run.logs.splice(0, run.logs.length - 500)
      journal(run, { type: "log", message: String(message) })
      writeStatus(run)
    }
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
    const phase = (title: any) => {
      run.currentPhase = title == null ? null : String(title)
    }
    return { agent, parallel, pipeline, log, sleep, phase }
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  async function wakeCaller(run: Run, message: string) {
    // synthetic: model-facing only — the UI suppresses the bubble (fork) or at
    // least the text (stock), so the notification doesn't clutter the thread.
    const body = {
      parts: [
        {
          type: "text" as const,
          text: message,
          synthetic: true,
          metadata: { workflow: { runId: run.id } },
        },
      ],
    }
    const path_ = { id: run.callerSessionID }
    const query = { directory: run.directory }
    try {
      const sessionApi: any = client.session
      if (typeof sessionApi.promptAsync === "function") {
        unwrap(await sessionApi.promptAsync({ path: path_, body, query }), "session.promptAsync")
      } else {
        // Older SDKs: fall back to fire-and-forget on the blocking endpoint.
        sessionApi.prompt({ path: path_, body, query }).catch((e: any) => {
          journal(run, { type: "wake_error", error: String(e?.message ?? e) })
        })
      }
      journal(run, { type: "wake_sent" })
    } catch (e: any) {
      journal(run, { type: "wake_error", error: String(e?.message ?? e) })
      console.error(`[workflow plugin] failed to wake session ${run.callerSessionID} for ${run.id}: ${e}`)
    }
  }

  function completionMessage(run: Run): string {
    const seconds = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)
    const header = `[workflow ${run.id} "${run.name}" ${run.status} after ${seconds}s — ${run.agentsCompleted} agents completed, ${run.agentsFailed} failed]`
    const artifacts = `Artifacts: ${run.dir} (script.js — the orchestration script, result.json, journal.jsonl with every agent's full prompt+reply, status.json)`
    if (run.status === "completed") {
      const resultJson = safeStringify(run.result ?? null, 2)
      const excerpt =
        resultJson.length > 6000
          ? resultJson.slice(0, 6000) + "\n... (truncated — full value in result.json)"
          : resultJson
      return `${header}\nResult:\n${excerpt}\n${artifacts}\nThis is an automated completion notification from the workflow plugin, not a user message. Summarize this result for the user now, relating it to what they originally asked for.`
    }
    return `${header}\nError: ${run.error ?? "unknown"}\n${artifacts}\nThis is an automated failure notification from the workflow plugin, not a user message. Inspect the journal if needed, tell the user what happened, and decide whether to retry with a corrected script.`
  }

  async function executeRun(run: Run, script: string, args: any) {
    const { agent, parallel, pipeline, log, sleep, phase } = makePrimitives(run)
    try {
      // Materialize the plan as a single workflow card (all phases pending)
      // before any work starts.
      await pushRunCard(run)
      const fn = new AsyncFunction(...SCRIPT_PARAMS, script)
      const result = await fn(agent, parallel, pipeline, log, sleep, args, run.id, phase)
      run.status = run.cancelled ? "cancelled" : "completed"
      run.result = result
      try {
        fs.writeFileSync(path.join(run.dir, "result.json"), safeStringify(result ?? null, 2))
      } catch (e) {
        console.error(`[workflow plugin] failed to write result for ${run.id}: ${e}`)
      }
    } catch (e: any) {
      run.status = run.cancelled ? "cancelled" : "failed"
      run.error = String(e?.stack ?? e).slice(0, 4000)
    } finally {
      run.finishedAt = Date.now()
      writeStatus(run)
      journal(run, {
        type: "finished",
        status: run.status,
        error: run.error ?? null,
      })
      await pushRunCard(run, true)
      if (!run.cancelled) {
        await wakeCaller(run, completionMessage(run))
      }
    }
  }

  function listRunsFromDisk(): any[] {
    let entries: string[] = []
    try {
      entries = fs
        .readdirSync(cfg.dataDir)
        .filter((name: string) => name.startsWith("workflow_") || name.startsWith("wf_"))
    } catch {
      return []
    }
    const statuses = entries
      .map((name) => readJsonIfExists(path.join(cfg.dataDir, name, "status.json")))
      .filter(Boolean)
    for (const status of statuses) {
      if (status.status === "running" && !liveRuns.has(status.runId)) {
        status.status = "interrupted"
      }
    }
    statuses.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    return statuses
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  function cancelRun(run: Run, reason: string): number {
    run.cancelled = true
    const aborting = run.activeAgents.size
    for (const control of run.activeAgents.values()) {
      clearTimeout(control.timer)
      control.timer = undefined
      control.abort?.()
      control.release?.()
      control.release = undefined
    }
    journal(run, {
      type: "cancel_requested",
      reason,
      abortedAgents: aborting,
    })
    writeStatus(run)
    return aborting
  }

  return {
    // The UI's workflow-card Cancel button flips metadata.workflow.cancelRequested
    // on the card part via the public updatePart endpoint; react to that event.
    event: async ({ event }: { event: any }) => {
      if (event?.type !== "message.part.updated") return
      const part = event.properties?.part
      const wf = part?.state?.metadata?.workflow
      if (!wf?.cancelRequested || !wf.runId) return
      const run = liveRuns.get(wf.runId)
      if (!run || run.status !== "running" || run.cancelled) return
      cancelRun(run, "ui cancel button")
    },
    config: async (opencodeConfig: any) => {
      const denyTask = (permission: any) => {
        if (typeof permission === "string") return { "*": permission, task: "deny" }
        const { task: _task, ...rest } = permission ?? {}
        return { ...rest, task: "deny" }
      }

      opencodeConfig.permission = denyTask(opencodeConfig.permission)

      for (const agent of Object.values(opencodeConfig.agent ?? {}) as any[]) {
        agent.permission = denyTask(agent.permission)
      }
    },
    "experimental.chat.system.transform": async (input: { sessionID?: string }, output: { system: string[] }) => {
      const isWorkflowChild = [...liveRuns.values()].some(
        (run) => input.sessionID && run.activeSessions.has(input.sessionID),
      )
      if (isWorkflowChild) return
      output.system.push(
        "There is no task/subagent tool. Whenever delegation or parallel work would help — including one-off explorations or single background tasks — use workflow_run, even for a single agent.",
      )
    },
    "tool.execute.before": async (input: { tool: string }) => {
      if (input.tool === "task") {
        throw new Error("The task/subagent tool is disabled. Use workflow_run instead.")
      }
    },
    // Variants load in the background after startup; rebuild the description
    // each time it is sent to the LLM so it reflects the current state.
    "tool.definition": async (input: { toolID: string }, output: { description: string }) => {
      if (input.toolID === "workflow_run") {
        output.description = runDescription(cfg, variantsBySlug)
      }
    },
    tool: {
      workflow_run: tool({
        description: runDescription(cfg, variantsBySlug),
        args: {
          script: tool.schema
            .string()
            .optional()
            .describe(
              "Inline workflow script beginning with `export const meta = {...}` and using agent/parallel/pipeline/log/sleep/args/runId/phase. Provide exactly one of script or scriptPath.",
            ),
          scriptPath: tool.schema
            .string()
            .optional()
            .describe(
              "Path to a workflow script to rerun. Relative paths resolve from the current project directory. The file is read fresh and copied into this run's artifact directory. Provide exactly one of script or scriptPath.",
            ),
          args: tool.schema
            .any()
            .optional()
            .describe(
              "Optional JSON value exposed to the script as `args`. Pass real arrays/objects, not JSON-encoded strings.",
            ),
        },
        async execute(toolArgs, context) {
          if ((toolArgs.script === undefined) === (toolArgs.scriptPath === undefined)) {
            return "Workflow was not started: provide exactly one of script or scriptPath."
          }
          let source: string
          try {
            if (toolArgs.scriptPath !== undefined) {
              const sourcePath = path.resolve(context.directory, toolArgs.scriptPath)
              source = fs.readFileSync(sourcePath, "utf8")
            } else {
              source = toolArgs.script!
            }
          } catch (e: any) {
            return `Workflow was not started: could not read scriptPath. ${String(e?.message ?? e)}`
          }

          let parsed: { meta: WorkflowMeta; executable: string }
          try {
            parsed = parseScript(source)
            new AsyncFunction(...SCRIPT_PARAMS, parsed.executable)
          } catch (e: any) {
            return `Script failed to compile - nothing was started. ${String(e?.message ?? e)}\nFix the script and call workflow_run again. It must begin with a pure literal export const meta = {...}, followed by plain JavaScript with no imports or TypeScript syntax.`
          }
          const run: Run = {
            id: newRunId(),
            name: parsed.meta.name.trim(),
            status: "running",
            callerSessionID: context.sessionID,
            directory: context.directory,
            dir: "",
            startedAt: Date.now(),
            agentsSpawned: 0,
            agentsCompleted: 0,
            agentsFailed: 0,
            logs: [],
            cancelled: false,
            activeSessions: new Set(),
            activeAgents: new Map(),
            phases: null,
            currentPhase: null,
            agentRows: [],
            card: null,
            cardQueue: Promise.resolve(),
          }
          // Timestamp ids can collide when runs start within the same second.
          for (let n = 2; fs.existsSync(path.join(cfg.dataDir, run.id)) || liveRuns.has(run.id); n++) {
            run.id = `${newRunId()}_${n}`
          }
          if (parsed.meta.phases && parsed.meta.phases.length > 0) {
            run.phases = parsed.meta.phases.map((declaredPhase) => {
              const trimmed = declaredPhase.title.trim()
              return {
                title: `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}`,
                detail: declaredPhase.detail,
                started: 0,
                finished: 0,
                failed: 0,
                models: [],
              }
            })
          }
          run.dir = path.join(cfg.dataDir, run.id)
          fs.mkdirSync(run.dir, { recursive: true })
          fs.writeFileSync(path.join(run.dir, "script.js"), source)
          if (toolArgs.args !== undefined) {
            fs.writeFileSync(path.join(run.dir, "args.json"), safeStringify(toolArgs.args, 2))
          }
          liveRuns.set(run.id, run)
          writeStatus(run)
          journal(run, {
            type: "started",
            name: run.name,
            description: parsed.meta.description,
            callerSessionID: run.callerSessionID,
          })

          void executeRun(run, parsed.executable, toolArgs.args).catch((e) => {
            console.error(`[workflow plugin] run ${run.id} crashed: ${e}`)
          })

          return [
            `Workflow ${run.id} ("${run.name}") started in the background.`,
            `A completion message with the result will be injected into this session when it finishes — do NOT wait, poll, or sleep; finish your turn normally.`,
            `Progress on demand: workflow_status({ runId: "${run.id}" }). Cancel: workflow_cancel({ runId: "${run.id}" }).`,
            `Artifacts (script.js, journal, status, result): ${run.dir}`,
          ].join("\n")
        },
      }),

      workflow_status: tool({
        description: STATUS_DESCRIPTION,
        args: {
          runId: tool.schema.string().optional().describe("Run id (workflow_...). Omit to list recent runs."),
        },
        async execute(args) {
          if (!args.runId) {
            const statuses = listRunsFromDisk().slice(0, 15)
            if (statuses.length === 0) return "No workflow runs found."
            return statuses
              .map(
                (s) =>
                  `${s.runId} "${s.name}" — ${s.status} (started ${s.startedAt}, agents ${s.agentsCompleted}/${s.agentsSpawned} completed, ${s.agentsFailed} failed)`,
              )
              .join("\n")
          }
          const live = liveRuns.get(args.runId)
          const status = live
            ? statusSnapshot(live)
            : readJsonIfExists(path.join(cfg.dataDir, args.runId, "status.json"))
          if (!status) return `No run found with id ${args.runId}.`
          if (!live && status.status === "running") {
            status.status = "interrupted"
            status.note = "The opencode server restarted while this run was in flight."
          }
          const lines = [safeStringify({ ...status, logs: undefined }, 2)]
          const logs = (status.logs ?? []).slice(-20)
          if (logs.length > 0) lines.push(`Recent progress:\n${logs.join("\n")}`)
          const resultPath = path.join(cfg.dataDir, args.runId, "result.json")
          if (status.status === "completed" && fs.existsSync(resultPath)) {
            const result = fs.readFileSync(resultPath, "utf8")
            lines.push(
              `Result:\n${result.length > 4000 ? result.slice(0, 4000) + "\n... (truncated — full value in result.json)" : result}`,
            )
          }
          return lines.join("\n\n")
        },
      }),

      workflow_cancel: tool({
        description: CANCEL_DESCRIPTION,
        args: {
          runId: tool.schema.string().describe("Run id (workflow_...) to cancel."),
        },
        async execute(args) {
          const run = liveRuns.get(args.runId)
          if (!run) {
            const status = readJsonIfExists(path.join(cfg.dataDir, args.runId, "status.json"))
            if (!status) return `No run found with id ${args.runId}.`
            return `Run ${args.runId} is not live (status on disk: ${status.status}) — nothing to cancel.`
          }
          if (run.status !== "running") return `Run ${args.runId} already ${run.status}.`
          const aborted = cancelRun(run, "workflow_cancel tool")
          return `Cancellation requested for ${args.runId}: ${aborted} in-flight agent(s) aborted, no new agents will start. The run will settle as "cancelled" shortly (check workflow_status).`
        },
      }),
    },
  }
}
