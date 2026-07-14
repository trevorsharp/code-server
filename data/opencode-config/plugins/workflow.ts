import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { tool, type Plugin } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// opencode-workflows: deterministic multi-agent orchestration for OpenCode.
//
// The workflow_run tool accepts a model-authored JavaScript script (the body
// of an async function) with injected primitives (agent/parallel/pipeline/
// log/sleep/step). The script runs in the background inside the server
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
//   models          allowlist for opts.model: [{slug, note}] — baked into the
//                   tool description; empty = session default only
//   maxConcurrency  agents in flight per run (default 8)
//   maxAgentsPerRun hard cap per run (default 200)
//   agentTimeoutMs  per-agent timeout (default 15 min)
//   childSessions   "nested" (default) or "toplevel" sidebar visibility
//   disableAgents   built-in agent names to disable (e.g. ["general", "plan"])
//
// Artifacts per run: ~/.local/share/opencode/workflows/<workflow_YYYYMMDD_HHMMSS>/
// (script.js, input.json, journal.jsonl, status.json, result.json).
//
// Inline stage/agent cards require the trs fork's POST /session/:id/agent-card
// endpoint; on stock opencode the plugin feature-detects and skips them.
// ---------------------------------------------------------------------------

type ModelEntry = { slug: string; note?: string }

type WorkflowConfig = {
  enabled: boolean
  models: ModelEntry[]
  maxConcurrency: number
  maxAgentsPerRun: number
  agentTimeoutMs: number
  dataDir: string
  childSessions: "nested" | "toplevel"
  disableAgents: string[]
}

type AgentOpts = {
  label?: string
  model?: string
  variant?: string
  agent?: string
  system?: string
  schema?: any
  retries?: number
  timeoutMs?: number
  step?: string
}

type StepState = {
  title: string
  detail?: string
  started: number
  finished: number
  failed: number
  declaredModel?: string
  models: string[]
}

type AgentRow = {
  label: string
  model?: string
  status: "running" | "completed" | "error"
  sessionID?: string
  step?: string
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
  steps: StepState[] | null
  currentStep: string | null
  agentRows: AgentRow[]
  card: { messageID: string; partID: string } | null
  cardQueue: Promise<void>
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const SCRIPT_PARAMS = ["agent", "parallel", "pipeline", "log", "sleep", "input", "runId", "step"]
const liveRuns = new Map<string, Run>()

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: WorkflowConfig = {
  enabled: true,
  models: [],
  maxConcurrency: 8,
  maxAgentsPerRun: 200,
  agentTimeoutMs: 900_000,
  dataDir: path.join(os.homedir(), ".local", "share", "opencode", "workflows"),
  childSessions: "nested",
  disableAgents: [],
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
    ? merged.models
        .map((m: any) => (typeof m === "string" ? { slug: m } : m))
        .filter((m: any) => m && typeof m.slug === "string")
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

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (e: any) {
    if (String(e?.message ?? e).includes("timed out")) {
      await onTimeout().catch(() => {})
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// Minimal JSON Schema check: type, required, properties, items, enum, const.
function schemaErrors(value: any, schema: any, at = "$"): string[] {
  if (!schema || typeof schema !== "object") return []
  const errs: string[] = []
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null
  if (types) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value
    const ok = types.some(
      (t: string) => t === actual || (t === "integer" && actual === "number" && Number.isInteger(value)),
    )
    if (!ok) return [`${at}: expected ${types.join("|")}, got ${actual}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e: any) => safeStringify(e) === safeStringify(value))) {
    errs.push(`${at}: value not in enum ${safeStringify(schema.enum).slice(0, 200)}`)
  }
  if (schema.const !== undefined && safeStringify(schema.const) !== safeStringify(value)) {
    errs.push(`${at}: expected const ${safeStringify(schema.const)}`)
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errs.push(`${at}.${req}: missing required property`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errs.push(...schemaErrors(value[key], sub, `${at}.${key}`))
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errs.push(...schemaErrors(v, schema.items, `${at}[${i}]`)))
  }
  return errs
}

function parseJsonReply(text: string): { ok: true; value: any } | { ok: false; error: string } {
  const candidates: string[] = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1])
  candidates.push(text)
  const firstBrace = Math.min(...[text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0))
  const lastBrace = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"))
  if (Number.isFinite(firstBrace) && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1))
  }
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate.trim()) }
    } catch {}
  }
  return { ok: false, error: "reply was not parseable as JSON" }
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
    steps: run.steps
      ? run.steps.map((s) => ({
          title: s.title,
          started: s.started,
          finished: s.finished,
          failed: s.failed,
        }))
      : undefined,
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
    return `MODELS: no allowlist is configured, so omit opts.model (agents use the session default model). To enable per-agent model selection, add slugs to ~/.config/opencode/workflow.json and restart opencode.`
  }
  const lines = cfg.models.map((m) => {
    const variants = variantsBySlug.get(m.slug)
    const variantNote = variants?.length ? ` [variants: ${variants.join(", ")}]` : ""
    return `  - "${m.slug}"${variantNote}${m.note ? ` — ${m.note}` : ""}`
  })
  return `MODELS — opts.model is REQUIRED on every agent() call and must be one of these slugs (pick deliberately per the notes; never rely on a default):\n${lines.join("\n")}\nopts.variant sets the reasoning effort for the agent, chosen from that model's [variants] list (omit for the model's default). Spend effort where it pays: high/xhigh/max for verification, judging, and design stages; low for mechanical scans, extraction, and formatting.\n(Models configured in ~/.config/opencode/workflow.json; edits require an opencode restart.)`
}

function runDescription(cfg: WorkflowConfig, variantsBySlug: Map<string, string[]>): string {
  return `Run a multi-agent orchestration script in the background. Use when a task benefits from fanning out across many subagents with deterministic control flow: parallel research, code review with adversarial verification, migrations, audits, broad sweeps.

HOW IT RUNS: this tool returns IMMEDIATELY with a run id. The workflow executes in the background; when it finishes (or fails), a completion message containing the result is automatically injected into this session as a new message. After starting a workflow, finish your turn normally — do NOT wait, poll in a loop, or sleep. Use workflow_status only if the user asks for progress. The result message will wake you.

SCRIPT FORMAT: plain JavaScript forming the BODY of an async function. No imports, no TypeScript syntax, no filesystem access, no fetch. Use await directly. \`return\` a JSON-serializable value — it becomes the workflow result delivered back to you. Runs die if the opencode server restarts (they do not survive quitting the TUI).

INJECTED PRIMITIVES (these exact names are in scope; nothing else is):
- await agent(prompt, opts?) -> string, or a validated object when opts.schema is set. Spawns one subagent in a fresh child session in the current project directory. The child has the normal coding tools (read/edit/bash) but CANNOT see this conversation or the script — every prompt must be fully self-contained (absolute paths, all needed context inline). Throws on failure/timeout/cancellation. opts:
    label: short display label used in child session titles and the journal
    model: REQUIRED — model slug from the MODELS list below; every agent must explicitly declare its model (calls without opts.model throw)
    variant: reasoning effort for this agent (e.g. "low", "high", "xhigh") — must be one of the chosen model's [variants] listed below; omit for the model's default
    agent: a named opencode agent (e.g. "plan") to run the child as; omit for default
    system: extra system prompt text for the child
    schema: JSON Schema the reply must satisfy. The child is instructed to reply with only matching JSON; the reply is parsed and validated, and on mismatch the child is asked to correct itself up to \`retries\` times before the call throws. Supported keywords: type, properties, required, items, enum, const.
    retries: schema-correction attempts (default 2)
    timeoutMs: per-agent timeout (default ${cfg.agentTimeoutMs}ms); on timeout the child session is aborted and the call throws
    step: title of the declared step this agent belongs to (see STEPS below); most reliable way to attribute agents inside pipeline stages and parallel thunks
- await parallel(thunks) -> array. Runs an array of zero-arg functions concurrently and waits for ALL of them (a barrier). A thunk that throws resolves to null instead of rejecting — .filter(Boolean) the results. Example: await parallel(files.map(f => () => agent(\`Review \${f}\`)))
- await pipeline(items, ...stages) -> array. Each item flows through the stages independently with NO barrier between stages — item A can be in stage 3 while item B is still in stage 1, so wall-clock is the slowest single chain, not the sum of slowest-per-stage. Each stage receives (previousResult, originalItem, index). A stage that throws drops that item's result to null and skips its remaining stages. PREFER pipeline for multi-stage work; use parallel only when a step genuinely needs ALL prior results at once (dedup across findings, early exit on zero results).
- log(message): appends a progress line (visible via workflow_status, recorded in the journal). Use it at meaningful checkpoints.
- await sleep(ms)
- step(title): sets the current step for subsequent agent() calls (an alternative to opts.step for strictly sequential scripts; under concurrency prefer opts.step)
- input: the JSON value passed as this tool's \`input\` argument (undefined if omitted)
- runId: this run's id string

STEPS — ALWAYS declare the plan upfront via the \`steps\` argument (an ordered array of {title, detail?, model?, variant?}). Each step renders in the user's conversation as a stage card: grayed out while pending, active once its first agent starts, settled when its agents finish — this is how the user gauges overall progress, so pick 2-8 coarse steps that mirror the script's stages (e.g. "Survey", "Review", "Verify", "Synthesize"). Declare each step's planned model/variant so the user sees the model lineup before anything runs. Attribute every agent() call to a step via opts.step (title must match a declared step exactly) or a preceding step("Title") call. Each agent renders as a row nested under its stage (with its model and a link to its session), so keep agent labels short and meaningful; agents without a step render at the bottom of the widget.

LIMITS & FAILURE SEMANTICS: at most ${cfg.maxConcurrency} agents run concurrently (excess queue automatically) and at most ${cfg.maxAgentsPerRun} agents per run (exceeding this throws). agent() THROWS on failure — inside parallel/pipeline that becomes a null result; a bare await agent() at top level will fail the whole workflow unless you try/catch. Every agent's full prompt and reply are recorded in the run's journal.jsonl. Subagents cannot start workflows (no recursion).

${modelSection(cfg, variantsBySlug)}

CANONICAL EXAMPLE — review three files, verify each finding as soon as its review completes.
Tool call: { name: "review-files", steps: [{ title: "Review", detail: "one reviewer per file", model: "openai/gpt-5.6-sol" }, { title: "Verify", detail: "adversarial check per finding", model: "github-copilot/claude-fable-5", variant: "high" }], input: { files: [...] }, script: ... }
  const FINDINGS = { type: "object", required: ["findings"], properties: { findings: { type: "array", items: {
    type: "object", required: ["file", "line", "summary"], properties: {
      file: { type: "string" }, line: { type: "integer" }, summary: { type: "string" } } } } } }
  const VERDICT = { type: "object", required: ["isReal", "reasoning"], properties: {
    isReal: { type: "boolean" }, reasoning: { type: "string" } } }
  const reviewed = await pipeline(
    input.files,
    (_, file) => agent(\`Review \${file} for correctness bugs. Report each with file, line, summary.\`, { label: \`review \${file}\`, step: "Review", schema: FINDINGS }),
    (review, file) => parallel((review?.findings ?? []).map(f => () =>
      agent(\`Adversarially verify this bug report — try to REFUTE it by reading the code: \${JSON.stringify(f)}\`, { label: \`verify \${f.file}:\${f.line}\`, step: "Verify", schema: VERDICT })
        .then(v => ({ ...f, ...v })))),
  )
  const confirmed = reviewed.filter(Boolean).flat().filter(Boolean).filter(f => f.isReal)
  log(\`\${confirmed.length} confirmed findings\`)
  return { confirmed }

OTHER USEFUL SHAPES:
- Adversarial majority vote: spawn 3 skeptics per claim, keep the claim only if >=2 fail to refute it.
- Loop-until-dry for unknown-size discovery: keep spawning finder agents until 2 consecutive rounds surface nothing new (dedupe against everything seen, not just confirmed).
- Judge panel: N independent attempts from different angles, then one judge agent scores them and you return the winner.

Scale agent counts to what the user asked for: a quick check warrants a few agents; "thorough"/"audit"/"comprehensive" warrants wide fan-out plus verification stages.`
}

const STATUS_DESCRIPTION = `Check on background workflows started with workflow_run. Without runId: lists recent runs (id, name, status, agent counts). With runId: full status, recent progress logs, and the result (or error) if finished. Runs marked "interrupted" were killed by an opencode server restart and will never complete — tell the user instead of waiting. Do NOT call this in a polling loop; completed workflows announce themselves with an injected message.`

const CANCEL_DESCRIPTION = `Cancel a running background workflow started with workflow_run. Aborts all in-flight child agent sessions and stops the script from spawning more. Already-completed agent work remains recorded in the run's journal.`

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
          await withTimeout(client.config.providers({}) as Promise<any>, 15_000, "config.providers", async () => {}),
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

  // Step progress cards: one card per declared step, pending upfront, running
  // while its agents are in flight, settled with aggregate counts.

  function stepStatus(run: Run, step: StepState, final: boolean): string {
    if (step.started === 0) {
      if (!final) return "pending"
      return run.status === "completed" ? "skipped" : "pending"
    }
    const settled = step.finished + step.failed >= step.started
    if (!settled) return final ? (run.status === "completed" ? "completed" : "error") : "running"
    return step.failed > 0 && step.finished === 0 ? "error" : "completed"
  }

  function runCardBody(run: Run, final = false) {
    const steps = run.steps?.map((step) => ({
      title: step.title,
      detail: step.detail,
      status: stepStatus(run, step, final),
      model: step.models.length > 0 ? step.models.join(", ") : step.declaredModel,
      agents: run.agentRows.filter((row) => row.step === step.title),
    }))
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
          agents: run.agentRows.filter((row) => !row.step),
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

  function resolveStep(run: Run, opts: AgentOpts): StepState | null {
    const name = opts.step ?? run.currentStep
    if (!run.steps || !name) return null
    const found = run.steps.find((s) => s.title.toLowerCase() === String(name).toLowerCase())
    if (!found)
      journal(run, {
        type: "unknown_step",
        step: name,
        known: run.steps.map((s) => s.title),
      })
    return found ?? null
  }

  // -------------------------------------------------------------------------
  // Script primitives
  // -------------------------------------------------------------------------

  async function runAgent(run: Run, semaphore: Semaphore, prompt: string, opts: AgentOpts = {}): Promise<any> {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new Error("agent(prompt) requires a non-empty string prompt")
    }
    const step = resolveStep(run, opts)
    if (run.cancelled) throw new Error("workflow was cancelled")
    if (run.agentsSpawned >= cfg.maxAgentsPerRun) {
      throw new Error(`agent cap reached (${cfg.maxAgentsPerRun} per run)`)
    }
    if (!opts.model) {
      throw new Error(
        `agent("${prompt.slice(0, 40)}...") is missing opts.model — every agent must explicitly pick a model${allowedModels.size > 0 ? ` from: ${[...allowedModels].join(", ")}` : ""}`,
      )
    }
    if (allowedModels.size > 0 && !allowedModels.has(opts.model)) {
      throw new Error(`model "${opts.model}" is not in the configured allowlist: ${[...allowedModels].join(", ")}`)
    }
    if (opts.variant && opts.model) {
      const known = variantsBySlug.get(opts.model)
      if (known && !known.includes(opts.variant)) {
        throw new Error(`variant "${opts.variant}" is not supported by ${opts.model}; supported: ${known.join(", ")}`)
      }
    }
    const model = opts.model ? parseModelSlug(opts.model) : undefined
    const label = opts.label ?? prompt.replace(/\s+/g, " ").slice(0, 60)
    const timeoutMs = opts.timeoutMs ?? cfg.agentTimeoutMs
    const retries = opts.retries ?? 2
    run.agentsSpawned++
    writeStatus(run)

    const release = await semaphore.acquire()
    const startedAt = Date.now()
    let sessionID: string | undefined
    let row: AgentRow | null = null
    const modelLabel = `${parseModelSlug(opts.model!).modelID}${opts.variant ? ` (${opts.variant})` : ""}`
    try {
      if (run.cancelled) throw new Error("workflow was cancelled")
      // "toplevel" makes children visible in UIs that hide parented sessions.
      const session = unwrap(
        await client.session.create({
          body: {
            ...(cfg.childSessions === "nested" ? { parentID: run.callerSessionID } : {}),
            title: `${run.id} ${label}`,
            metadata: {
              background: true,
              parentSessionId: run.callerSessionID,
              source: "workflow",
            },
          } as any,
          query: { directory: run.directory },
        }),
        "session.create",
      )
      sessionID = session?.id
      if (!sessionID) throw new Error(`session.create returned no id: ${safeStringify(session).slice(0, 300)}`)
      run.activeSessions.add(sessionID)
      row = {
        label,
        model: modelLabel,
        status: "running",
        sessionID,
        step: step?.title,
      }
      run.agentRows.push(row)
      if (step) {
        step.started++
        if (modelLabel && !step.models.includes(modelLabel)) step.models.push(modelLabel)
      }
      pushRunCard(run)

      let text = opts.schema
        ? `${prompt}\n\nOUTPUT FORMAT (mandatory): reply with ONLY a single JSON value that validates against this JSON Schema — no prose, no markdown fences, no explanation:\n${safeStringify(opts.schema, 2)}`
        : prompt

      for (let attempt = 0; ; attempt++) {
        const abortChild = async () => {
          await client.session.abort({ path: { id: sessionID! } })
        }
        const res = unwrap(
          await withTimeout(
            client.session.prompt({
              path: { id: sessionID },
              query: { directory: run.directory },
              body: {
                parts: [{ type: "text", text }],
                ...(model ? { model } : {}),
                ...(opts.variant ? { variant: opts.variant } : {}),
                ...(opts.agent ? { agent: opts.agent } : {}),
                ...(opts.system ? { system: opts.system } : {}),
                tools: {
                  workflow_run: false,
                  workflow_status: false,
                  workflow_cancel: false,
                },
              },
            }) as Promise<any>,
            timeoutMs,
            `agent "${label}"`,
            abortChild,
          ),
          "session.prompt",
        )
        if (run.cancelled) throw new Error("workflow was cancelled")
        const reply = extractText(res?.parts)

        if (!opts.schema) {
          run.agentsCompleted++
          journal(run, {
            type: "agent",
            label,
            sessionID,
            model: opts.model ?? null,
            variant: opts.variant ?? null,
            durationMs: Date.now() - startedAt,
            prompt,
            result: reply,
          })
          writeStatus(run)
          if (step) step.finished++
          if (row) row.status = "completed"
          pushRunCard(run)
          return reply
        }

        const parsed = parseJsonReply(reply)
        const errors = parsed.ok ? schemaErrors(parsed.value, opts.schema) : [parsed.error]
        if (parsed.ok && errors.length === 0) {
          run.agentsCompleted++
          journal(run, {
            type: "agent",
            label,
            sessionID,
            model: opts.model ?? null,
            variant: opts.variant ?? null,
            durationMs: Date.now() - startedAt,
            prompt,
            result: parsed.value,
          })
          writeStatus(run)
          if (step) step.finished++
          if (row) row.status = "completed"
          pushRunCard(run)
          return parsed.value
        }
        if (attempt >= retries) {
          throw new Error(
            `agent "${label}" reply failed schema validation after ${attempt + 1} attempts: ${errors.join("; ").slice(0, 500)}. Last reply: ${reply.slice(0, 500)}`,
          )
        }
        journal(run, {
          type: "schema_retry",
          label,
          sessionID,
          attempt: attempt + 1,
          errors,
        })
        text = `Your previous reply did not satisfy the required JSON Schema. Problems: ${errors.join("; ")}. Reply again with ONLY the corrected JSON value — no prose, no fences.`
      }
    } catch (e: any) {
      run.agentsFailed++
      journal(run, {
        type: "agent_error",
        label,
        sessionID: sessionID ?? null,
        durationMs: Date.now() - startedAt,
        prompt,
        error: String(e?.message ?? e),
      })
      writeStatus(run)
      if (step && sessionID) step.failed++
      if (row) row.status = "error"
      pushRunCard(run)
      throw e
    } finally {
      if (sessionID) run.activeSessions.delete(sessionID)
      release()
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
            } catch (e: any) {
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
    const step = (title: any) => {
      run.currentStep = title == null ? null : String(title)
    }
    return { agent, parallel, pipeline, log, sleep, step }
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

  async function executeRun(run: Run, script: string, input: any) {
    const { agent, parallel, pipeline, log, sleep, step } = makePrimitives(run)
    try {
      // Materialize the plan as a single workflow card (all steps pending)
      // before any work starts.
      await pushRunCard(run)
      const fn = new AsyncFunction(...SCRIPT_PARAMS, script)
      const result = await fn(agent, parallel, pipeline, log, sleep, input, run.id, step)
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
      entries = fs.readdirSync(cfg.dataDir).filter((name) => name.startsWith("workflow_") || name.startsWith("wf_"))
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
    const aborting = [...run.activeSessions]
    for (const id of aborting) {
      ;(client.session.abort({ path: { id } }) as Promise<any>).catch(() => {})
    }
    journal(run, {
      type: "cancel_requested",
      reason,
      abortedSessions: aborting.length,
    })
    writeStatus(run)
    return aborting.length
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
    // Disable built-in subagents listed in workflow.json (disableAgents) so
    // workflows are the only fan-out mechanism — no need to also maintain
    // agent.disable blocks in opencode.json.
    config: async (opencodeConfig: any) => {
      if (cfg.disableAgents.length === 0) return
      opencodeConfig.agent = opencodeConfig.agent ?? {}
      for (const name of cfg.disableAgents) {
        opencodeConfig.agent[name] = {
          ...opencodeConfig.agent[name],
          disable: true,
        }
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
            .describe(
              "The workflow script: plain JavaScript forming the body of an async function, using the injected primitives (agent/parallel/pipeline/log/sleep/input/runId). Return the final result.",
            ),
          name: tool.schema
            .string()
            .optional()
            .describe("Short kebab-case name for this run, e.g. 'review-auth-changes'."),
          input: tool.schema
            .any()
            .optional()
            .describe(
              "Optional JSON value exposed to the script as `input`. Pass real arrays/objects, not JSON-encoded strings.",
            ),
          steps: tool.schema
            .array(
              tool.schema.union([
                tool.schema.string(),
                tool.schema.object({
                  title: tool.schema.string().describe("Step title; agents reference it via opts.step / step()"),
                  detail: tool.schema.string().optional().describe("One-line description of what the step does"),
                  model: tool.schema
                    .string()
                    .optional()
                    .describe("Model slug the step's agents will use — shown on the step card before it runs"),
                  variant: tool.schema.string().optional().describe("Reasoning-effort variant planned for the step"),
                }),
              ]),
            )
            .optional()
            .describe(
              "Ordered plan of 2-8 coarse steps, shown to the user as progress cards (pending → running → done). Always declare these; attribute agents with opts.step or step(). See STEPS in the main description.",
            ),
        },
        async execute(args, context) {
          try {
            new AsyncFunction(...SCRIPT_PARAMS, args.script)
          } catch (e: any) {
            return `Script failed to compile — nothing was started. ${String(e?.message ?? e)}\nFix the script and call workflow_run again. Remember: plain JavaScript function body, no imports, no TypeScript syntax, no 'export'.`
          }
          const run: Run = {
            id: newRunId(),
            name: args.name ?? "workflow",
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
            steps: null,
            currentStep: null,
            agentRows: [],
            card: null,
            cardQueue: Promise.resolve(),
          }
          // Timestamp ids can collide when runs start within the same second.
          for (let n = 2; fs.existsSync(path.join(cfg.dataDir, run.id)) || liveRuns.has(run.id); n++) {
            run.id = `${newRunId()}_${n}`
          }
          const declaredSteps = (args.steps ?? [])
            .map((s: any) => (typeof s === "string" ? { title: s } : s))
            .filter((s: any) => s && typeof s.title === "string" && s.title.trim() !== "")
          if (declaredSteps.length > 0) {
            run.steps = declaredSteps.map((s: any) => {
              const trimmed = s.title.trim()
              const declaredModel =
                typeof s.model === "string" && s.model
                  ? `${s.model.includes("/") ? s.model.slice(s.model.indexOf("/") + 1) : s.model}${typeof s.variant === "string" && s.variant ? ` (${s.variant})` : ""}`
                  : undefined
              return {
                title: `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}`,
                detail: typeof s.detail === "string" ? s.detail : undefined,
                started: 0,
                finished: 0,
                failed: 0,
                declaredModel,
                models: [],
              }
            })
          }
          run.dir = path.join(cfg.dataDir, run.id)
          fs.mkdirSync(run.dir, { recursive: true })
          fs.writeFileSync(path.join(run.dir, "script.js"), args.script)
          if (args.input !== undefined) {
            fs.writeFileSync(path.join(run.dir, "input.json"), safeStringify(args.input, 2))
          }
          liveRuns.set(run.id, run)
          writeStatus(run)
          journal(run, {
            type: "started",
            name: run.name,
            callerSessionID: run.callerSessionID,
          })

          void executeRun(run, args.script, args.input).catch((e) => {
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
            status.note = "The opencode server restarted while this run was in flight; it will never complete."
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
