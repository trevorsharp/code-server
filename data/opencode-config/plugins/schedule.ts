import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { tool, type Plugin } from "@opencode-ai/plugin";

// ---------------------------------------------------------------------------
// opencode-schedule: cron-driven two-tier scheduled jobs for OpenCode.
//
// Each job fires on a cron schedule until it expires. On every tick a cheap
// "trigger" model evaluates a trigger prompt in a persistent session and
// replies with a JSON verdict; when it reports triggered=true, a stronger
// "work" model is spawned in a fresh session to carry out the work prompt.
//
// Jobs are persisted to disk and re-armed when the opencode server restarts.
// Ticks missed while the server was down are skipped (no backfill); the job
// resumes at its next cron occurrence.
//
// Install: drop this file into ~/.config/opencode/plugins/ and restart.
// Config: ~/.config/opencode/schedule.json (project override in
// <worktree>/.opencode/schedule.json; restart after edits).
//   triggerModel     model slug for trigger evaluations (cheap/fast)
//   workModel        model slug for work sessions (capable)
//   triggerTimeoutMs per-trigger timeout (default 5 min)
//   workTimeoutMs    per-work-session timeout (default 30 min)
//   maxTicksPerJob   safety cap on total ticks for one job (default 500)
//   triggerFailureLimit  consecutive trigger failures before auto-pause
//   childSessions    "nested" (default) or "toplevel"
//
// Artifacts per job: <dataDir>/<job-id>/ (job.json, ticks.jsonl).
// ---------------------------------------------------------------------------

type ScheduleConfig = {
  enabled: boolean;
  triggerModel: string;
  workModel: string;
  triggerTimeoutMs: number;
  workTimeoutMs: number;
  maxTicksPerJob: number;
  triggerFailureLimit: number;
  dataDir: string;
  childSessions: "nested" | "toplevel";
};

const DEFAULT_CONFIG: ScheduleConfig = {
  enabled: true,
  triggerModel: "openai/gpt-5.6-luna",
  workModel: "openai/gpt-5.6-sol",
  triggerTimeoutMs: 300_000,
  workTimeoutMs: 1_800_000,
  maxTicksPerJob: 500,
  triggerFailureLimit: 3,
  dataDir: path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "scheduled-jobs",
  ),
  childSessions: "nested",
};

type JobStatus = "running" | "completed" | "expired" | "cancelled" | "paused";

type CardRef = {
  messageID: string;
  partID: string;
};

type SessionRow = {
  sessionID: string;
  kind: "trigger" | "work";
  tick?: number;
  label: string;
  model?: string;
  status: "running" | "completed" | "error";
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

type TickRecord = {
  ts: string;
  tick: number;
  triggered?: boolean;
  reason?: string;
  skipped?: string;
  error?: string;
  workSessionID?: string;
  workError?: string;
};

type Job = {
  id: string;
  name: string;
  cron: string;
  expiresAt: string;
  triggerPrompt: string;
  workPrompt: string;
  directory: string;
  creatorSessionID: string;
  wakeOnCompletion: boolean;
  status: JobStatus;
  createdAt: string;
  ticksRun: number;
  triggersFired: number;
  consecutiveTriggerFailures: number;
  triggerSessionID: string | null;
  lastTick: TickRecord | null;
  nextFireAt: string | null;
  finishedAt: string | null;
  finishReason: string | null;
  card?: CardRef | null;
  triggerRow?: SessionRow | null;
  workRows?: SessionRow[];
};

type LiveJob = {
  job: Job;
  timer: ReturnType<typeof setTimeout> | null;
  ticking: boolean;
  workInFlight: boolean;
  activeSessions: Set<string>;
  currentTick: TickRecord | null;
  cardQueue: Promise<void>;
  cardCreateAttempted: boolean;
  cancelling: boolean;
};

const liveJobs = new Map<string, LiveJob>();
const MAX_WORK_ROWS = 25;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// ---------------------------------------------------------------------------
// Cron: standard 5-field (minute hour day-of-month month day-of-week).
// Supports *, lists, ranges, steps (e.g. "*/5", "0 9-17 * * 1-5", "30 8 1,15 * *").
// Day-of-month and day-of-week are OR'd when both are restricted (vixie cron).
// ---------------------------------------------------------------------------

type CronSpec = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
};

function parseCronField(
  field: string,
  min: number,
  max: number,
  what: string,
): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1)
      throw new Error(`invalid cron step in ${what}: "${part}"`);
    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "") {
      if (stepPart === undefined) any = true;
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (
      !Number.isInteger(lo) ||
      !Number.isInteger(hi) ||
      lo < min ||
      hi > max ||
      lo > hi
    ) {
      throw new Error(
        `invalid cron ${what} field: "${part}" (allowed ${min}-${max})`,
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any };
}

function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new Error(
      `cron expression must have 5 fields (minute hour dom month dow), got ${fields.length}: "${expr}"`,
    );
  const minute = parseCronField(fields[0], 0, 59, "minute");
  const hour = parseCronField(fields[1], 0, 23, "hour");
  const dom = parseCronField(fields[2], 1, 31, "day-of-month");
  const month = parseCronField(fields[3], 1, 12, "month");
  const dowField = parseCronField(fields[4], 0, 7, "day-of-week");
  const dow = new Set(
    [...dowField.values].map((value) => (value === 7 ? 0 : value)),
  );
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow,
    domAny: dom.any,
    dowAny: dowField.any,
  };
}

function cronMatchesDay(spec: CronSpec, date: Date): boolean {
  if (!spec.month.has(date.getMonth() + 1)) return false;
  const domMatch = spec.dom.has(date.getDate());
  const dowMatch = spec.dow.has(date.getDay());
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dowMatch;
  if (spec.dowAny) return domMatch;
  return domMatch || dowMatch;
}

function nextCronOccurrence(spec: CronSpec, after: Date): Date | null {
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  // Bounded scan: up to 4 years of days is plenty for any valid expression.
  for (let day = 0; day < 1461; day++) {
    if (cronMatchesDay(spec, cursor)) {
      for (let hour = cursor.getHours(); hour <= 23; hour++) {
        if (!spec.hour.has(hour)) continue;
        const firstMinute =
          hour === cursor.getHours() ? cursor.getMinutes() : 0;
        for (let minute = firstMinute; minute <= 59; minute++) {
          if (spec.minute.has(minute)) {
            const result = new Date(cursor.getTime());
            result.setHours(hour, minute, 0, 0);
            return result;
          }
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small utilities (shared shapes with the workflow plugin)
// ---------------------------------------------------------------------------

function readJsonIfExists(file: string): any {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`[schedule plugin] failed to parse ${file}: ${e}`);
    return null;
  }
}

function loadConfig(worktree: string | undefined): ScheduleConfig {
  const globalCfg =
    readJsonIfExists(
      path.join(os.homedir(), ".config", "opencode", "schedule.json"),
    ) ?? {};
  const projectCfg = worktree
    ? (readJsonIfExists(path.join(worktree, ".opencode", "schedule.json")) ??
      {})
    : {};
  return { ...DEFAULT_CONFIG, ...globalCfg, ...projectCfg };
}

function unwrap(res: any, what: string): any {
  if (res && typeof res === "object" && "error" in res && res.error) {
    throw new Error(
      `${what} failed: ${safeStringify(res.error).slice(0, 500)}`,
    );
  }
  return res && typeof res === "object" && "data" in res ? res.data : res;
}

function safeStringify(value: any, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? "null";
  } catch {
    return String(value);
  }
}

function extractText(parts: any[]): string {
  return (parts ?? [])
    .filter(
      (p) => p?.type === "text" && !p.synthetic && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (e: any) {
    if (String(e?.message ?? e).includes("timed out")) {
      await onTimeout().catch(() => {});
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonReply(
  text: string,
): { ok: true; value: any } | { ok: false; error: string } {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace)
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate.trim()) };
    } catch {}
  }
  return { ok: false, error: "reply was not parseable as JSON" };
}

function parseModelSlug(slug: string): { providerID: string; modelID: string } {
  const idx = slug.indexOf("/");
  if (idx <= 0 || idx === slug.length - 1) {
    throw new Error(`invalid model slug "${slug}" — expected "provider/model"`);
  }
  return { providerID: slug.slice(0, idx), modelID: slug.slice(idx + 1) };
}

function sanitizeName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return safe || "job";
}

function sentenceCase(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

function newJobId(name: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sanitizeName(name)}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const SchedulePlugin: Plugin = async ({
  client,
  worktree,
  directory,
  serverUrl,
}) => {
  const cfg = loadConfig(worktree || directory);
  if (!cfg.enabled) {
    console.error("[schedule plugin] disabled via schedule.json");
    return {};
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  function jobDir(jobId: string): string {
    return path.join(cfg.dataDir, jobId);
  }

  function saveJob(job: Job) {
    try {
      fs.mkdirSync(jobDir(job.id), { recursive: true });
      const file = path.join(jobDir(job.id), "job.json");
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, safeStringify(job, 2));
      fs.renameSync(temporary, file);
    } catch (e) {
      console.error(`[schedule plugin] failed to save job ${job.id}: ${e}`);
    }
  }

  function journal(job: Job, entry: TickRecord | Record<string, any>) {
    try {
      fs.appendFileSync(
        path.join(jobDir(job.id), "ticks.jsonl"),
        JSON.stringify(
          "ts" in entry ? entry : { ts: new Date().toISOString(), ...entry },
        ) + "\n",
      );
    } catch (e) {
      console.error(`[schedule plugin] failed to journal for ${job.id}: ${e}`);
    }
  }

  function loadJobsFromDisk(): Job[] {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(cfg.dataDir);
    } catch {
      return [];
    }
    return entries
      .map((name) => readJsonIfExists(path.join(cfg.dataDir, name, "job.json")))
      .filter((j): j is Job => j && typeof j.id === "string")
      .map(normalizeJob);
  }

  function normalizeJob(job: Job): Job {
    job.card =
      job.card &&
      typeof job.card.messageID === "string" &&
      typeof job.card.partID === "string"
        ? job.card
        : null;
    job.triggerRow = normalizeSessionRow(job.triggerRow, "trigger");
    job.workRows = Array.isArray(job.workRows)
      ? job.workRows
          .map((row) => normalizeSessionRow(row, "work"))
          .filter((row): row is SessionRow => row !== null)
          .slice(-MAX_WORK_ROWS)
      : [];
    return job;
  }

  function normalizeSessionRow(
    value: any,
    kind: SessionRow["kind"],
  ): SessionRow | null {
    if (!value || typeof value.sessionID !== "string") return null;
    const status =
      value.status === "completed" || value.status === "error"
        ? value.status
        : "running";
    return {
      sessionID: value.sessionID,
      kind,
      ...(typeof value.tick === "number" ? { tick: value.tick } : {}),
      label:
        typeof value.label === "string" && value.label ? value.label : kind,
      ...(typeof value.model === "string" ? { model: value.model } : {}),
      status,
      startedAt:
        typeof value.startedAt === "string"
          ? value.startedAt
          : new Date().toISOString(),
      ...(typeof value.finishedAt === "string"
        ? { finishedAt: value.finishedAt }
        : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Inline schedule cards
  // -------------------------------------------------------------------------

  let agentCardsSupported: boolean | null = null;

  async function upsertAgentCard(
    live: LiveJob,
    body: Record<string, any>,
  ): Promise<CardRef | null> {
    if (agentCardsSupported === false) return null;
    try {
      const url = new URL(
        `/session/${live.job.creatorSessionID}/agent-card`,
        serverUrl,
      );
      url.searchParams.set("directory", live.job.directory);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (process.env.OPENCODE_SERVER_PASSWORD) {
        headers.authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
      }
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (response.status === 404 || response.status === 405) {
        if (agentCardsSupported === null)
          journal(live.job, { type: "agent_card_unsupported" });
        agentCardsSupported = false;
        return null;
      }
      if (!response.ok) {
        journal(live.job, {
          type: "agent_card_error",
          status: response.status,
          body: (await response.text()).slice(0, 300),
        });
        return null;
      }
      agentCardsSupported = true;
      return (await response.json()) as CardRef;
    } catch (error: any) {
      journal(live.job, {
        type: "agent_card_error",
        error: String(error?.message ?? error),
      });
      return null;
    }
  }

  function modelLabel(slug: string): string {
    const separator = slug.indexOf("/");
    return separator >= 0 ? slug.slice(separator + 1) : slug;
  }

  function stepStatus(
    rows: SessionRow[],
  ): "pending" | "running" | "completed" | "error" {
    if (rows.length === 0) return "pending";
    if (rows.some((row) => row.status === "running")) return "running";
    return rows.at(-1)?.status === "error" ? "error" : "completed";
  }

  function jobCardBody(live: LiveJob) {
    const job = live.job;
    const triggerRows = job.triggerRow ? [job.triggerRow] : [];
    const workRows = (job.workRows ?? []).map((row) => ({
      ...row,
      label: row.label.replace(/^Work tick /i, "Work run "),
    }));
    const status = job.status === "running" ? "running" : "completed";
    const summary = `Scheduled job ${job.status}`;
    return {
      tool: "schedule",
      description: job.name,
      agent: "schedule",
      prompt: job.name,
      status,
      ...(status === "completed" ? { output: summary } : {}),
      metadata: {
        uiOnly: true,
        schedule: {
          jobId: job.id,
          name: job.name,
          status: job.status,
          cron: job.cron,
          expiresAt: job.expiresAt,
          nextFireAt: job.nextFireAt,
          steps: [
            {
              title: "Trigger",
              status: stepStatus(triggerRows),
              agents: triggerRows,
            },
            { title: "Work", status: stepStatus(workRows), agents: workRows },
          ],
        },
      },
    };
  }

  function pushJobCard(live: LiveJob) {
    const body = jobCardBody(live);
    live.cardQueue = live.cardQueue
      .then(async () => {
        if (!live.job.card && live.cardCreateAttempted) return;
        if (!live.job.card) live.cardCreateAttempted = true;
        const reference = await upsertAgentCard(live, {
          ...body,
          ...live.job.card,
        });
        if (reference && !live.job.card) {
          live.job.card = reference;
          saveJob(live.job);
        }
      })
      .catch(() => {});
    return live.cardQueue;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async function promptSession(
    live: LiveJob,
    sessionID: string,
    text: string,
    modelSlug: string,
    timeoutMs: number,
    what: string,
    allowCancel = false,
  ): Promise<string> {
    const model = parseModelSlug(modelSlug);
    const res = unwrap(
      await withTimeout(
        client.session.prompt({
          path: { id: sessionID },
          query: { directory: live.job.directory },
          body: {
            parts: [{ type: "text", text }],
            model,
            tools: {
              schedule_create: false,
              schedule_list: false,
              schedule_logs: false,
              schedule_cancel: allowCancel,
            },
          },
        }) as Promise<any>,
        timeoutMs,
        what,
        async () => {
          await client.session.abort({ path: { id: sessionID } });
        },
      ),
      "session.prompt",
    );
    return extractText(res?.parts);
  }

  async function createChildSession(
    live: LiveJob,
    title: string,
  ): Promise<string> {
    const session = unwrap(
      await client.session.create({
        body: {
          ...(cfg.childSessions === "nested"
            ? { parentID: live.job.creatorSessionID }
            : {}),
          title,
          metadata: {
            background: true,
            parentSessionId: live.job.creatorSessionID,
            source: "schedule",
          },
        } as any,
        query: { directory: live.job.directory },
      }),
      "session.create",
    );
    if (!session?.id)
      throw new Error(
        `session.create returned no id: ${safeStringify(session).slice(0, 300)}`,
      );
    return session.id;
  }

  // -------------------------------------------------------------------------
  // Trigger evaluation
  // -------------------------------------------------------------------------

  const VERDICT_INSTRUCTIONS = `\n\nOUTPUT FORMAT (mandatory): after performing the check, reply with ONLY a single JSON object — no prose, no markdown fences:\n{"triggered": <true|false>, "reason": "<one sentence: why it did or did not trigger>", "context": "<everything a follow-up agent needs to act: ids, urls, values observed, exact findings — empty string if not triggered>"}`;

  async function evaluateTrigger(
    live: LiveJob,
    tickNumber: number,
  ): Promise<{ triggered: boolean; reason: string; context: string }> {
    const job = live.job;
    // Reuse the persisted trigger session when it still exists (it survives
    // server restarts on disk); otherwise start fresh with the full brief.
    if (job.triggerSessionID) {
      try {
        const existing = unwrap(
          await client.session.get({
            path: { id: job.triggerSessionID },
            query: { directory: job.directory },
          }),
          "session.get",
        );
        if (
          existing?.metadata?.background !== true ||
          existing.metadata.parentSessionId !== job.creatorSessionID
        ) {
          try {
            unwrap(
              await client.session.update({
                path: { id: job.triggerSessionID },
                query: { directory: job.directory },
                body: {
                  metadata: {
                    ...(existing?.metadata ?? {}),
                    background: true,
                    parentSessionId: job.creatorSessionID,
                    source: "schedule",
                  },
                } as any,
              }),
              "session.update",
            );
          } catch (error: any) {
            journal(job, {
              type: "trigger_session_metadata_error",
              error: String(error?.message ?? error),
            });
          }
        }
      } catch {
        journal(job, {
          type: "trigger_session_lost",
          sessionID: job.triggerSessionID,
        });
        if (job.triggerRow?.sessionID === job.triggerSessionID) {
          job.triggerRow.status = "error";
          job.triggerRow.finishedAt = new Date().toISOString();
          job.triggerRow.error = "Trigger session was lost";
        }
        job.triggerSessionID = null;
        saveJob(job);
        pushJobCard(live);
      }
    }
    const isNewSession = !job.triggerSessionID;
    let sessionID = job.triggerSessionID;
    if (!sessionID) {
      sessionID = await createChildSession(
        live,
        `Schedule "${job.name}" — trigger`,
      );
      job.triggerSessionID = sessionID;
      job.triggerRow = {
        sessionID,
        kind: "trigger",
        tick: tickNumber,
        label: "Trigger evaluator",
        model: modelLabel(cfg.triggerModel),
        status: "running",
        startedAt: new Date().toISOString(),
      };
      saveJob(job);
      pushJobCard(live);
    } else {
      job.triggerRow = {
        ...(job.triggerRow ?? {
          sessionID,
          kind: "trigger" as const,
          label: "Trigger evaluator",
          model: modelLabel(cfg.triggerModel),
          startedAt: new Date().toISOString(),
        }),
        tick: tickNumber,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: undefined,
        error: undefined,
      };
      saveJob(job);
      pushJobCard(live);
    }
    live.activeSessions.add(sessionID);
    try {
      let text = isNewSession
        ? `You are the trigger evaluator for a scheduled job named "${job.name}". You will be re-prompted on a schedule; each prompt is one evaluation${tickNumber > 1 ? ` (this is evaluation #${tickNumber}; earlier evaluations happened in a previous session whose findings you cannot see, so treat currently-observable conditions as reportable)` : ""}. Work from ${job.directory}. Do exactly the check described below, nothing more — do NOT perform follow-up work, do NOT schedule anything, do NOT ask questions.\n\nCHECK: ${job.triggerPrompt}${VERDICT_INSTRUCTIONS}`
        : `Scheduled evaluation #${tickNumber}. Re-run your check per the original instructions. Remember what you already reported in earlier evaluations — only report triggered=true for NEW conditions unless your instructions say otherwise.${VERDICT_INSTRUCTIONS}`;

      for (let attempt = 0; attempt < 3; attempt++) {
        const reply = await promptSession(
          live,
          sessionID,
          text,
          cfg.triggerModel,
          cfg.triggerTimeoutMs,
          `trigger "${job.name}" tick ${tickNumber}`,
        );
        const parsed = parseJsonReply(reply);
        if (parsed.ok && typeof parsed.value?.triggered === "boolean") {
          job.triggerRow!.status = "completed";
          job.triggerRow!.finishedAt = new Date().toISOString();
          saveJob(job);
          pushJobCard(live);
          return {
            triggered: parsed.value.triggered,
            reason: String(parsed.value.reason ?? ""),
            context: String(parsed.value.context ?? ""),
          };
        }
        text = `Your previous reply was not a valid verdict. Reply again with ONLY the JSON object {"triggered": bool, "reason": string, "context": string} — no prose, no fences.`;
      }
      throw new Error(
        "trigger reply failed verdict validation after 3 attempts",
      );
    } catch (error: any) {
      job.triggerRow!.status = "error";
      job.triggerRow!.finishedAt = new Date().toISOString();
      job.triggerRow!.error = String(error?.message ?? error).slice(0, 500);
      saveJob(job);
      pushJobCard(live);
      throw error;
    } finally {
      live.activeSessions.delete(sessionID);
    }
  }

  // -------------------------------------------------------------------------
  // Work execution
  // -------------------------------------------------------------------------

  async function runWork(
    live: LiveJob,
    tick: TickRecord,
    verdict: { reason: string; context: string },
  ) {
    const job = live.job;
    if (job.status !== "running" || live.cancelling) return;
    live.workInFlight = true;
    let sessionID: string | undefined;
    let row: SessionRow | undefined;
    try {
      sessionID = await createChildSession(
        live,
        `Schedule "${job.name}" — work (tick ${tick.tick})`,
      );
      live.activeSessions.add(sessionID);
      if (job.status !== "running" || live.cancelling) {
        await (
          client.session.abort({ path: { id: sessionID } }) as Promise<any>
        ).catch(() => {});
        return;
      }
      tick.workSessionID = sessionID;
      row = {
        sessionID,
        kind: "work",
        tick: tick.tick,
        label: `Work run ${tick.tick}`,
        model: modelLabel(cfg.workModel),
        status: "running",
        startedAt: new Date().toISOString(),
      };
      job.workRows!.push(row);
      if (job.workRows!.length > MAX_WORK_ROWS)
        job.workRows!.splice(0, job.workRows!.length - MAX_WORK_ROWS);
      saveJob(job);
      pushJobCard(live);
      const prompt = `You are the work agent for a scheduled job named "${job.name}" (job id: ${job.id}). A cheaper trigger agent just determined there is work to do. Work from ${job.directory}. Perform the instructions below right now, this one time. Do NOT schedule anything, do NOT ask questions — act autonomously and finish.\n\nTRIGGER REASON: ${verdict.reason}\n\nTRIGGER CONTEXT: ${verdict.context || "(none provided)"}\n\nINSTRUCTIONS: ${job.workPrompt}\n\nIf completing these instructions fulfills the job's overall purpose and no future scheduled checks are needed (e.g. the thing being watched for has happened and been handled), cancel the job by calling schedule_cancel({ jobId: "${job.id}" }) before finishing. If future checks are still useful, do NOT cancel.`;
      await promptSession(
        live,
        sessionID,
        prompt,
        cfg.workModel,
        cfg.workTimeoutMs,
        `work "${job.name}" tick ${tick.tick}`,
        true,
      );
      row.status = "completed";
      row.finishedAt = new Date().toISOString();
    } catch (e: any) {
      tick.workError = String(e?.message ?? e).slice(0, 500);
      if (row) {
        row.status = "error";
        row.finishedAt = new Date().toISOString();
        row.error = tick.workError;
      }
    } finally {
      if (sessionID) live.activeSessions.delete(sessionID);
      live.workInFlight = false;
      saveJob(job);
      pushJobCard(live);
    }
  }

  // -------------------------------------------------------------------------
  // Job lifecycle
  // -------------------------------------------------------------------------

  async function wakeCreator(job: Job, message: string) {
    const body = {
      parts: [
        {
          type: "text" as const,
          text: message,
          synthetic: true,
          metadata: { schedule: { jobId: job.id } },
        },
      ],
    };
    try {
      const sessionApi: any = client.session;
      if (typeof sessionApi.promptAsync === "function") {
        unwrap(
          await sessionApi.promptAsync({
            path: { id: job.creatorSessionID },
            body,
            query: { directory: job.directory },
          }),
          "session.promptAsync",
        );
      } else {
        sessionApi
          .prompt({
            path: { id: job.creatorSessionID },
            body,
            query: { directory: job.directory },
          })
          .catch(() => {});
      }
    } catch (e) {
      console.error(
        `[schedule plugin] failed to wake session for ${job.id}: ${e}`,
      );
    }
  }

  function finishJob(live: LiveJob, status: JobStatus, reason: string) {
    const job = live.job;
    if (job.status !== "running") return;
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    job.status = status;
    job.nextFireAt = null;
    job.finishedAt = new Date().toISOString();
    job.finishReason = reason;
    saveJob(job);
    journal(job, { type: "finished", status, reason });
    pushJobCard(live);
    liveJobs.delete(job.id);
    const selfCancelled =
      status === "cancelled" && reason.includes("own work agent");
    if (job.wakeOnCompletion && (status !== "cancelled" || selfCancelled)) {
      void wakeCreator(
        job,
        `[scheduled job ${job.id} "${job.name}" ${status}: ${reason} — ${job.ticksRun} tick(s) run, ${job.triggersFired} trigger(s) fired. Logs: ${jobDir(job.id)}/ticks.jsonl]\nThis is an automated notification from the schedule plugin, not a user message. Briefly inform the user.`,
      );
    }
  }

  function armJob(live: LiveJob) {
    const job = live.job;
    if (job.status !== "running") return;
    const expires = new Date(job.expiresAt);
    const next = nextCronOccurrence(parseCron(job.cron), new Date());
    if (!next || next.getTime() > expires.getTime()) {
      finishJob(
        live,
        job.ticksRun > 0 ? "completed" : "expired",
        next
          ? "expiration reached before next occurrence"
          : "no future cron occurrence",
      );
      return;
    }
    job.nextFireAt = next.toISOString();
    saveJob(job);
    pushJobCard(live);
    if (live.timer) clearTimeout(live.timer);
    live.timer = setTimeout(
      () => {
        if (Date.now() < next.getTime()) {
          armJob(live);
          return;
        }
        void tickJob(live).catch((e) =>
          console.error(`[schedule plugin] tick crashed for ${job.id}: ${e}`),
        );
      },
      Math.max(0, Math.min(next.getTime() - Date.now(), MAX_TIMER_DELAY_MS)),
    );
  }

  async function tickJob(live: LiveJob) {
    const job = live.job;
    if (job.status !== "running") return;
    if (live.ticking) return;
    live.ticking = true;
    const tick: TickRecord = {
      ts: new Date().toISOString(),
      tick: job.ticksRun + 1,
    };
    live.currentTick = tick;
    try {
      job.ticksRun++;
      job.nextFireAt = null;
      saveJob(job);
      pushJobCard(live);
      if (job.ticksRun > cfg.maxTicksPerJob) {
        tick.error = `safety cap of ${cfg.maxTicksPerJob} ticks reached`;
        finishJob(
          live,
          "paused",
          `safety cap of ${cfg.maxTicksPerJob} ticks reached`,
        );
        return;
      }
      if (live.workInFlight) {
        tick.skipped = "previous work session still running";
        return;
      }
      let verdict: { triggered: boolean; reason: string; context: string };
      try {
        verdict = await evaluateTrigger(live, tick.tick);
        job.consecutiveTriggerFailures = 0;
      } catch (e: any) {
        tick.error = String(e?.message ?? e).slice(0, 500);
        job.consecutiveTriggerFailures++;
        job.triggerSessionID = null;
        if (job.consecutiveTriggerFailures >= cfg.triggerFailureLimit) {
          finishJob(
            live,
            "paused",
            `${job.consecutiveTriggerFailures} consecutive trigger failures (last: ${tick.error})`,
          );
          return;
        }
        return;
      }
      tick.triggered = verdict.triggered;
      tick.reason = verdict.reason;
      if (job.status !== "running" || live.cancelling) return;
      if (verdict.triggered) {
        job.triggersFired++;
        await runWork(live, tick, verdict);
      }
    } finally {
      live.ticking = false;
      live.currentTick = null;
      job.lastTick = tick;
      journal(job, tick);
      saveJob(job);
      if (job.status === "running") {
        armJob(live);
      } else {
        pushJobCard(live);
      }
    }
  }

  function startJob(job: Job, restarted = false): LiveJob {
    const existing = liveJobs.get(job.id);
    if (existing) return existing;
    normalizeJob(job);
    if (restarted) {
      const interruptedAt = new Date().toISOString();
      if (job.triggerRow?.status === "running") {
        job.triggerRow.status = "error";
        job.triggerRow.finishedAt = interruptedAt;
        job.triggerRow.error = "Interrupted by server restart";
      }
      for (const row of job.workRows!) {
        if (row.status !== "running") continue;
        row.status = "error";
        row.finishedAt = interruptedAt;
        row.error = "Interrupted by server restart";
      }
      saveJob(job);
    }
    const live: LiveJob = {
      job,
      timer: null,
      ticking: false,
      workInFlight: false,
      activeSessions: new Set(),
      currentTick: null,
      cardQueue: Promise.resolve(),
      cardCreateAttempted: false,
      cancelling: false,
    };
    liveJobs.set(job.id, live);
    armJob(live);
    return live;
  }

  // Re-arm persisted jobs after a server restart. Missed ticks are skipped by
  // design: armJob schedules from "now", so the job resumes at the next
  // occurrence (or finishes if it expired while the server was down). The
  // persisted trigger session is reused — evaluateTrigger verifies it still
  // exists and falls back to a fresh session if not.
  for (const job of loadJobsFromDisk()) {
    if (job.status !== "running") continue;
    if (liveJobs.has(job.id)) continue;
    journal(job, { type: "rearmed_after_restart" });
    startJob(job, true);
  }

  // -------------------------------------------------------------------------
  // Tool descriptions
  // -------------------------------------------------------------------------

  const CREATE_DESCRIPTION = `Create a scheduled background job: "monitor X", "check on this deployment every N minutes", "remind me at 5pm", "watch this PR for feedback". The job fires on a cron schedule until it expires. Each firing runs a cheap trigger model (${cfg.triggerModel}) in a persistent session to evaluate the trigger prompt; when it reports there is work to do, a capable work model (${cfg.workModel}) is spawned in a fresh session to carry out the work prompt with the trigger's findings inlined.

PROMPT RULES — the job runs in isolated sessions that CANNOT see this conversation:
- triggerPrompt must be fully self-contained: absolute paths, exact targets/urls/ids, exactly what to check, and what counts as "triggered". It should be a cheap read-only check (a curl, a status lookup, a grep) — put the real work in workPrompt. For unconditional jobs like reminders, use a trigger like "Always trigger." so every tick fires.
- workPrompt must also be self-contained: exactly what to do when triggered (e.g. "Use the notify skill to alert Trevor that <X>", "post a summary to Slack channel eng-payments-dev"). The trigger's reason/context is appended automatically.
- The trigger session persists across ticks and is told to only report NEW conditions, so repeated firings for the same finding are suppressed by default; say otherwise in triggerPrompt if you want re-fires.

SCHEDULING:
- cron: standard 5-field expression evaluated in server local time (e.g. "*/5 * * * *" every 5 min, "0 9 * * 1-5" weekdays 9am, "30 14 * * *" daily 2:30pm).
- expiresAt: ISO datetime when the job stops. Required — never create unbounded jobs. For "for the next hour" compute now+1h; for one-shot reminders set a cron matching the target minute and expiresAt a couple minutes after it.
- Jobs survive opencode server restarts; ticks missed while the server was down are skipped (no backfill).
- If a work session is still running when the next tick fires, that tick is skipped.
- The work agent is allowed to cancel its own job via schedule_cancel when its instructions fulfill the job's overall purpose (e.g. a one-time reminder delivered, a watched event handled) — write workPrompt with that in mind.

After creating, report the job id to the user. Do NOT create a job when you are already running inside a scheduled job session.`;

  const LIST_DESCRIPTION = `List scheduled jobs created with schedule_create: id, name, status, cron, next fire time, ticks run, triggers fired, and last tick outcome. Jobs marked "paused" hit their failure limit and need attention.`;

  const LOGS_DESCRIPTION = `Show the tick history for a scheduled job: each evaluation's verdict (triggered or not, reason) and any work sessions spawned. Use to debug why a job did or didn't fire.`;

  const CANCEL_DESCRIPTION = `Cancel a scheduled job created with schedule_create. Stops future ticks and aborts any in-flight trigger/work sessions. Tick history is retained on disk.`;

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  function describeJob(job: Job): string {
    const parts = [
      `${job.id} "${job.name}" — ${job.status}`,
      `  cron: ${job.cron}  expires: ${job.expiresAt}${job.nextFireAt ? `  next: ${job.nextFireAt}` : ""}`,
      `  ticks: ${job.ticksRun}, triggers fired: ${job.triggersFired}${job.finishReason ? `, finished: ${job.finishReason}` : ""}`,
    ];
    if (job.lastTick) {
      const t = job.lastTick;
      parts.push(
        `  last tick (${t.ts}): ${t.error ? `error: ${t.error}` : t.skipped ? `skipped: ${t.skipped}` : `triggered=${t.triggered}${t.reason ? ` — ${t.reason}` : ""}${t.workError ? ` (work failed: ${t.workError})` : ""}`}`,
      );
    }
    return parts.join("\n");
  }

  function cancelJob(
    live: LiveJob,
    reason: string,
    requestingSessionID?: string,
  ): number {
    if (live.job.status !== "running" || live.cancelling) return 0;
    live.cancelling = true;
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    const aborting = [...live.activeSessions].filter(
      (sessionID) => sessionID !== requestingSessionID,
    );
    const finishedAt = new Date().toISOString();
    if (live.job.triggerRow?.status === "running") {
      live.job.triggerRow.status = "error";
      live.job.triggerRow.finishedAt = finishedAt;
      live.job.triggerRow.error = "Cancelled";
    }
    for (const row of live.job.workRows ?? []) {
      if (row.status !== "running" || row.sessionID === requestingSessionID)
        continue;
      row.status = "error";
      row.finishedAt = finishedAt;
      row.error = "Cancelled";
    }
    for (const sessionID of aborting) {
      (client.session.abort({ path: { id: sessionID } }) as Promise<any>).catch(
        () => {},
      );
    }
    journal(live.job, {
      type: "cancel_requested",
      reason,
      abortedSessions: aborting.length,
    });
    finishJob(live, "cancelled", reason);
    return aborting.length;
  }

  return {
    event: async ({ event }: { event: any }) => {
      if (event?.type !== "message.part.updated") return;
      const schedule = event.properties?.part?.state?.metadata?.schedule;
      if (!schedule?.cancelRequested || !schedule.jobId) return;
      const live = liveJobs.get(schedule.jobId);
      if (!live || live.job.status !== "running" || live.cancelling) return;
      cancelJob(live, "ui cancel button");
    },
    tool: {
      schedule_create: tool({
        description: CREATE_DESCRIPTION,
        args: {
          name: tool.schema
            .string()
            .describe(
              "Short human-friendly name in sentence case, e.g. 'PR 420088 feedback monitor'.",
            ),
          cron: tool.schema
            .string()
            .describe(
              '5-field cron expression in server local time, e.g. "*/5 * * * *".',
            ),
          expiresAt: tool.schema
            .string()
            .describe(
              "ISO datetime when the job stops firing, e.g. '2026-07-14T17:00:00'. Required — compute it from the user's requested duration.",
            ),
          triggerPrompt: tool.schema
            .string()
            .describe(
              "Self-contained cheap check evaluated every tick; must state exactly what to check and what counts as triggered.",
            ),
          workPrompt: tool.schema
            .string()
            .describe(
              "Self-contained instructions executed by the work model when the trigger fires.",
            ),
          wakeOnCompletion: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, inject a summary message into this session when the job finishes or is auto-paused. Default false.",
            ),
        },
        async execute(args, context) {
          let spec: CronSpec;
          try {
            spec = parseCron(args.cron);
          } catch (e: any) {
            return `Invalid cron expression — nothing was scheduled. ${String(e?.message ?? e)}`;
          }
          const expires = new Date(args.expiresAt);
          if (Number.isNaN(expires.getTime()))
            return `Invalid expiresAt "${args.expiresAt}" — nothing was scheduled. Provide an ISO datetime.`;
          if (expires.getTime() <= Date.now())
            return `expiresAt ${expires.toISOString()} is in the past — nothing was scheduled.`;
          const first = nextCronOccurrence(spec, new Date());
          if (!first)
            return `Cron "${args.cron}" has no future occurrence — nothing was scheduled.`;
          if (first.getTime() > expires.getTime()) {
            return `Cron "${args.cron}" first fires at ${first.toISOString()}, after expiresAt ${expires.toISOString()} — the job would never run. Nothing was scheduled.`;
          }
          const job: Job = {
            id: newJobId(args.name),
            name: sentenceCase(args.name),
            cron: args.cron,
            expiresAt: expires.toISOString(),
            triggerPrompt: args.triggerPrompt,
            workPrompt: args.workPrompt,
            directory: context.directory,
            creatorSessionID: context.sessionID,
            wakeOnCompletion: args.wakeOnCompletion ?? false,
            status: "running",
            createdAt: new Date().toISOString(),
            ticksRun: 0,
            triggersFired: 0,
            consecutiveTriggerFailures: 0,
            triggerSessionID: null,
            lastTick: null,
            nextFireAt: null,
            finishedAt: null,
            finishReason: null,
            card: null,
            triggerRow: null,
            workRows: [],
          };
          for (
            let n = 2;
            fs.existsSync(jobDir(job.id)) || liveJobs.has(job.id);
            n++
          ) {
            job.id = `${newJobId(args.name)}-${n}`;
          }
          saveJob(job);
          journal(job, {
            type: "created",
            creatorSessionID: job.creatorSessionID,
          });
          const live = startJob(job);
          await live.cardQueue;
          return [
            `Scheduled job ${job.id} ("${job.name}") created.`,
            `First fire: ${job.nextFireAt ?? first.toISOString()} (cron "${job.cron}", expires ${job.expiresAt}).`,
            `Manage with schedule_list / schedule_logs({ jobId: "${job.id}" }) / schedule_cancel({ jobId: "${job.id}" }).`,
          ].join("\n");
        },
      }),

      schedule_list: tool({
        description: LIST_DESCRIPTION,
        args: {},
        async execute() {
          const onDisk = loadJobsFromDisk();
          if (onDisk.length === 0) return "No scheduled jobs found.";
          const jobs = onDisk
            .map((j) => liveJobs.get(j.id)?.job ?? j)
            .sort((a, b) =>
              String(b.createdAt).localeCompare(String(a.createdAt)),
            );
          for (const job of jobs) {
            if (job.status === "running" && !liveJobs.has(job.id)) {
              job.status =
                new Date(job.expiresAt).getTime() < Date.now()
                  ? "expired"
                  : "paused";
              job.finishReason = "not re-armed after server restart";
            }
          }
          return jobs.slice(0, 25).map(describeJob).join("\n\n");
        },
      }),

      schedule_logs: tool({
        description: LOGS_DESCRIPTION,
        args: {
          jobId: tool.schema
            .string()
            .describe("Job id from schedule_create or schedule_list."),
          limit: tool.schema
            .number()
            .optional()
            .describe(
              "Max tick entries to show (default 20, most recent last).",
            ),
        },
        async execute(args) {
          const job =
            liveJobs.get(args.jobId)?.job ??
            readJsonIfExists(path.join(jobDir(args.jobId), "job.json"));
          if (!job) return `No job found with id ${args.jobId}.`;
          const limit = Math.max(1, Math.min(100, args.limit ?? 20));
          let lines: string[] = [];
          try {
            lines = fs
              .readFileSync(
                path.join(jobDir(args.jobId), "ticks.jsonl"),
                "utf8",
              )
              .trim()
              .split("\n")
              .filter(Boolean);
          } catch {}
          return [
            describeJob(job),
            "",
            `Tick history (last ${Math.min(limit, lines.length)} of ${lines.length}):`,
            ...lines.slice(-limit),
          ].join("\n");
        },
      }),

      schedule_cancel: tool({
        description: CANCEL_DESCRIPTION,
        args: {
          jobId: tool.schema.string().describe("Job id to cancel."),
        },
        async execute(args, context) {
          const live = liveJobs.get(args.jobId);
          if (!live) {
            const loaded = readJsonIfExists(
              path.join(jobDir(args.jobId), "job.json"),
            );
            const job = loaded ? normalizeJob(loaded) : null;
            if (!job) return `No job found with id ${args.jobId}.`;
            if (job.status === "running") {
              const orphan: LiveJob = {
                job,
                timer: null,
                ticking: false,
                workInFlight: false,
                activeSessions: new Set(),
                currentTick: null,
                cardQueue: Promise.resolve(),
                cardCreateAttempted: false,
                cancelling: false,
              };
              cancelJob(
                orphan,
                "cancelled while not live (was orphaned by a restart)",
              );
              return `Job ${args.jobId} was orphaned by a restart; marked cancelled.`;
            }
            return `Job ${args.jobId} is already ${job.status} — nothing to cancel.`;
          }
          cancelJob(
            live,
            context.sessionID === live.job.triggerSessionID ||
              live.activeSessions.has(context.sessionID)
              ? "cancelled by the job's own work agent (purpose fulfilled)"
              : "schedule_cancel tool",
            context.sessionID,
          );
          return `Job ${args.jobId} cancelled. Tick history retained at ${jobDir(args.jobId)}/ticks.jsonl.`;
        },
      }),
    },
  };
};
