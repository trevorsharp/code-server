import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";

type ScheduleConfig = {
  enabled: boolean;
  triggerModel: string;
  workModel: string;
  dataDir: string;
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
  status: "running" | "expired" | "cancelled";
  triggerSessionID?: string;
  terminalReason?: string;
};

type LiveJob = {
  job: Job;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  sessions: Set<string>;
};

type CronSpec = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
};

const DEFAULT_CONFIG: ScheduleConfig = {
  enabled: true,
  triggerModel: "openai/gpt-5.6-luna",
  workModel: "openai/gpt-5.6-sol",
  dataDir: path.join(
    os.homedir(),
    ".local",
    "share",
    "opencode",
    "scheduled-jobs",
  ),
};

const TRIGGER_TIMEOUT_MS = 5 * 60 * 1000;
const WORK_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const liveJobs = new Map<string, LiveJob>();

function readJson(file: string): any | null {
  try {
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : null;
  } catch (error) {
    console.error(`[schedule] failed to read ${file}: ${error}`);
    return null;
  }
}

function loadConfig(worktree: string | undefined): ScheduleConfig {
  const globalConfig =
    readJson(path.join(os.homedir(), ".config", "opencode", "schedule.json")) ??
    {};
  const projectConfig = worktree
    ? (readJson(path.join(worktree, ".opencode", "schedule.json")) ?? {})
    : {};
  return { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
}

function stringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? "null";
  } catch {
    return String(value);
  }
}

function unwrap(response: any, operation: string): any {
  if (response?.error) {
    throw new Error(`${operation} failed: ${stringify(response.error)}`);
  }
  return response && "data" in response ? response.data : response;
}

function parseModel(slug: string): { providerID: string; modelID: string } {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) {
    throw new Error(`invalid model "${slug}"; expected provider/model`);
  }
  return {
    providerID: slug.slice(0, separator),
    modelID: slug.slice(separator + 1),
  };
}

function parseField(
  field: string,
  min: number,
  max: number,
  name: string,
): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;

  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid ${name} step "${part}"`);
    }

    let start: number;
    let end: number;
    if (range === "*") {
      any = stepText === undefined;
      start = min;
      end = max;
    } else if (range.includes("-")) {
      [start, end] = range.split("-").map(Number);
    } else {
      start = Number(range);
      end = stepText === undefined ? start : max;
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`invalid ${name} field "${part}" (${min}-${max})`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }

  return { values, any };
}

function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      "cron must have five fields: minute hour day month weekday",
    );
  }

  const minute = parseField(fields[0], 0, 59, "minute");
  const hour = parseField(fields[1], 0, 23, "hour");
  const dayOfMonth = parseField(fields[2], 1, 31, "day-of-month");
  const month = parseField(fields[3], 1, 12, "month");
  const weekday = parseField(fields[4], 0, 7, "day-of-week");

  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: new Set(
      [...weekday.values].map((value) => (value === 7 ? 0 : value)),
    ),
    anyDayOfMonth: dayOfMonth.any,
    anyDayOfWeek: weekday.any,
  };
}

function matchesDay(spec: CronSpec, date: Date): boolean {
  if (!spec.month.has(date.getMonth() + 1)) return false;
  const monthDayMatches = spec.dayOfMonth.has(date.getDate());
  const weekDayMatches = spec.dayOfWeek.has(date.getDay());
  if (spec.anyDayOfMonth && spec.anyDayOfWeek) return true;
  if (spec.anyDayOfMonth) return weekDayMatches;
  if (spec.anyDayOfWeek) return monthDayMatches;
  return monthDayMatches || weekDayMatches;
}

function nextOccurrence(spec: CronSpec, after: Date): Date | null {
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let day = 0; day < 1461; day++) {
    if (matchesDay(spec, cursor)) {
      for (let hour = cursor.getHours(); hour < 24; hour++) {
        if (!spec.hour.has(hour)) continue;
        const firstMinute =
          hour === cursor.getHours() ? cursor.getMinutes() : 0;
        for (let minute = firstMinute; minute < 60; minute++) {
          if (!spec.minute.has(minute)) continue;
          const result = new Date(cursor);
          result.setHours(hour, minute, 0, 0);
          return result;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }

  return null;
}

function parseVerdict(text: string): {
  triggered: boolean;
  reason: string;
  context: string;
} | null {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  const candidates = [
    text,
    firstBrace >= 0 && lastBrace > firstBrace
      ? text.slice(firstBrace, lastBrace + 1)
      : "",
  ];

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (typeof value.triggered === "boolean") {
        return {
          triggered: value.triggered,
          reason: String(value.reason ?? ""),
          context: String(value.context ?? ""),
        };
      }
    } catch {}
  }
  return null;
}

function textFrom(parts: any[]): string {
  return (parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function jobID(name: string): string {
  const safeName =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "job";
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${safeName}-${timestamp}`;
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("session timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (String(error).includes("timed out")) await onTimeout().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const SchedulePlugin: Plugin = async ({
  client,
  worktree,
  directory,
}) => {
  const config = loadConfig(worktree || directory);
  if (!config.enabled) return {};
  fs.mkdirSync(config.dataDir, { recursive: true });

  const fileFor = (jobID: string) => path.join(config.dataDir, `${jobID}.json`);

  function save(job: Job): void {
    const file = fileFor(job.id);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${stringify(job, 2)}\n`);
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  function loadJobs(): Job[] {
    try {
      return fs
        .readdirSync(config.dataDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => readJson(path.join(config.dataDir, entry.name)))
        .filter((job): job is Job => Boolean(job?.id));
    } catch {
      return [];
    }
  }

  async function createSession(job: Job, title: string): Promise<string> {
    const session = unwrap(
      await client.session.create({
        query: { directory: job.directory },
        body: {
          parentID: job.creatorSessionID,
          title,
          metadata: {
            background: true,
            parentSessionId: job.creatorSessionID,
            source: "schedule",
          },
        } as any,
      }),
      "session.create",
    );
    if (!session?.id) throw new Error("session.create returned no id");
    return session.id;
  }

  async function prompt(
    job: Job,
    sessionID: string,
    text: string,
    model: string,
    timeoutMs: number,
    allowCancel = false,
  ): Promise<string> {
    const response = unwrap(
      await withTimeout(
        client.session.prompt({
          path: { id: sessionID },
          query: { directory: job.directory },
          body: {
            model: parseModel(model),
            parts: [{ type: "text", text }],
            tools: {
              schedule_create: false,
              schedule_list: false,
              schedule_logs: false,
              schedule_cancel: allowCancel,
            },
          },
        }) as Promise<any>,
        timeoutMs,
        async () => {
          await client.session.abort({ path: { id: sessionID } });
        },
      ),
      "session.prompt",
    );
    return textFrom(response?.parts);
  }

  async function trigger(live: LiveJob): Promise<{
    triggered: boolean;
    reason: string;
    context: string;
  }> {
    const job = live.job;
    let isNew = !job.triggerSessionID;
    if (job.triggerSessionID) {
      try {
        unwrap(
          await client.session.get({
            path: { id: job.triggerSessionID },
            query: { directory: job.directory },
          }),
          "session.get",
        );
      } catch {
        delete job.triggerSessionID;
        isNew = true;
      }
    }

    if (!job.triggerSessionID) {
      job.triggerSessionID = await createSession(
        job,
        `Schedule "${job.name}" trigger`,
      );
      save(job);
    }

    const sessionID = job.triggerSessionID;
    live.sessions.add(sessionID);
    const rules =
      'Keep memory only in this conversation; never write state files. Run only the trigger check. Return only {"triggered":boolean,"reason":"one sentence","context":"details for the work agent"}.';
    let message = isNew
      ? `${rules}\n\nWork from ${job.directory}.\n\n${job.triggerPrompt}`
      : `${rules}\n\nRun the check again. Report only new or materially changed conditions unless instructed otherwise.`;

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await prompt(
          job,
          sessionID,
          message,
          config.triggerModel,
          TRIGGER_TIMEOUT_MS,
        );
        const verdict = parseVerdict(response);
        if (verdict) return verdict;
        message = `Return only {"triggered":boolean,"reason":"one sentence","context":"details for the work agent"}.`;
      }
      throw new Error("trigger returned an invalid verdict twice");
    } finally {
      live.sessions.delete(sessionID);
    }
  }

  async function runWork(
    live: LiveJob,
    verdict: { reason: string; context: string },
  ): Promise<void> {
    const job = live.job;
    const sessionID = await createSession(job, `Schedule "${job.name}" work`);
    live.sessions.add(sessionID);
    try {
      await prompt(
        job,
        sessionID,
        `Perform this work once. Do not create a schedule. If the job's end condition is met, call schedule_cancel with jobId "${job.id}".\n\nTrigger: ${verdict.reason}\n${verdict.context}\n\n${job.workPrompt}`,
        config.workModel,
        WORK_TIMEOUT_MS,
        true,
      );
    } finally {
      live.sessions.delete(sessionID);
    }
  }

  function finish(job: Job, status: Job["status"], reason: string): void {
    const live = liveJobs.get(job.id);
    if (live?.timer) clearTimeout(live.timer);
    if (live) live.timer = null;
    job.status = status;
    job.terminalReason = reason;
    save(job);
    liveJobs.delete(job.id);
  }

  function arm(live: LiveJob): void {
    const job = live.job;
    if (job.status !== "running") return;

    const now = new Date();
    const expiresAt = new Date(job.expiresAt);
    if (now >= expiresAt) {
      finish(job, "expired", "expiration reached");
      return;
    }

    const next = nextOccurrence(parseCron(job.cron), now);
    if (!next || next > expiresAt) {
      finish(job, "expired", "no occurrence before expiration");
      return;
    }

    const delay = next.getTime() - Date.now();
    if (delay > MAX_TIMER_MS) {
      live.timer = setTimeout(() => arm(live), MAX_TIMER_MS);
      return;
    }
    live.timer = setTimeout(() => void tick(live), Math.max(0, delay));
  }

  async function tick(live: LiveJob): Promise<void> {
    const job = live.job;
    if (job.status !== "running" || live.running) return;
    live.running = true;

    try {
      const verdict = await trigger(live);
      if (verdict.triggered && job.status === "running") {
        await runWork(live, verdict);
      }
    } catch (error) {
      console.error(`[schedule] ${job.id} tick failed: ${error}`);
    } finally {
      live.running = false;
      arm(live);
    }
  }

  function start(job: Job): void {
    const live: LiveJob = {
      job,
      timer: null,
      running: false,
      sessions: new Set(),
    };
    liveJobs.set(job.id, live);
    arm(live);
  }

  function cancel(job: Job, requestingSessionID?: string): void {
    const live = liveJobs.get(job.id);
    if (live) {
      for (const sessionID of live.sessions) {
        if (sessionID === requestingSessionID) continue;
        void (client.session.abort({ path: { id: sessionID } }) as Promise<any>);
      }
    }
    finish(job, "cancelled", "cancelled by request");
  }

  for (const job of loadJobs()) {
    if (job.status === "running" && !liveJobs.has(job.id)) start(job);
  }

  const createDescription = `Create a job with a persistent trigger session and a fresh work session per trigger. Work sessions can cancel the job. Prompts must be self-contained. Trigger memory stays in conversation, never files. Jobs restart from ${config.dataDir}. cron has five fields; expiresAt is required; missed ticks are skipped.`;

  function describe(job: Job): string {
    const reason = job.terminalReason ? ` reason=${job.terminalReason}` : "";
    const triggerSession = job.triggerSessionID
      ? ` triggerSession=${job.triggerSessionID}`
      : "";
    return `${job.id} "${job.name}" ${job.status} cron=${job.cron} expires=${job.expiresAt}${triggerSession}${reason}`;
  }

  return {
    tool: {
      schedule_create: tool({
        description: createDescription,
        args: {
          name: tool.schema.string().describe("Short job name."),
          cron: tool.schema.string().describe("Five-field cron expression."),
          expiresAt: tool.schema
            .string()
            .describe("ISO date-time after which the job stops."),
          triggerPrompt: tool.schema
            .string()
            .describe("Self-contained read-only check and trigger condition."),
          workPrompt: tool.schema
            .string()
            .describe("Self-contained follow-up performed when triggered."),
        },
        async execute(args, context) {
          let spec: CronSpec;
          try {
            spec = parseCron(args.cron);
          } catch (error) {
            return `Invalid cron: ${error}`;
          }

          const expiresAt = new Date(args.expiresAt);
          if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
            return "expiresAt must be a future ISO date-time.";
          }
          const first = nextOccurrence(spec, new Date());
          if (!first || first > expiresAt) {
            return "The cron has no occurrence before expiresAt.";
          }

          const job: Job = {
            id: jobID(args.name),
            name: sentenceCase(args.name),
            cron: args.cron,
            expiresAt: expiresAt.toISOString(),
            triggerPrompt: args.triggerPrompt,
            workPrompt: args.workPrompt,
            directory: context.directory,
            creatorSessionID: context.sessionID,
            status: "running",
          };
          const baseID = job.id;
          let suffix = 2;
          while (fs.existsSync(fileFor(job.id))) {
            job.id = `${baseID}-${suffix}`;
            suffix++;
          }
          save(job);
          start(job);
          return `Created ${job.id}. First run: ${first.toISOString()}. State: ${fileFor(job.id)}`;
        },
      }),

      schedule_list: tool({
        description: "List scheduled jobs.",
        args: {},
        async execute() {
          const jobs = loadJobs().sort((left, right) =>
            left.name.localeCompare(right.name),
          );
          return jobs.length
            ? jobs.slice(0, 25).map(describe).join("\n")
            : "No scheduled jobs.";
        },
      }),

      schedule_logs: tool({
        description:
          "Show a scheduled job's current status and trigger session.",
        args: {
          jobId: tool.schema.string(),
        },
        async execute(args) {
          const job = loadJobs().find((candidate) => candidate.id === args.jobId);
          if (!job) return `No job ${args.jobId}.`;
          return describe(job);
        },
      }),

      schedule_cancel: tool({
        description: "Cancel a scheduled job.",
        args: { jobId: tool.schema.string() },
        async execute(args, context) {
          const job =
            liveJobs.get(args.jobId)?.job ??
            loadJobs().find((candidate) => candidate.id === args.jobId);
          if (!job) return `No job ${args.jobId}.`;
          if (job.status !== "running")
            return `${args.jobId} is ${job.status}.`;
          cancel(job, context.sessionID);
          return `Cancelled ${args.jobId}.`;
        },
      }),
    },
  };
};
