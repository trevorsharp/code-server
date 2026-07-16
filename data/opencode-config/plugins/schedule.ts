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
  finishedAt?: string;
  terminalReason?: string;
  card?: { messageID: string; partID: string };
  nextFireAt?: string;
  workRunCount?: number;
  workSessions?: Array<{
    sessionID: string;
    label: string;
    model: string;
    status: "running" | "completed" | "error";
  }>;
};

type LiveJob = {
  job: Job;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  sessions: Set<string>;
  cardQueue: Promise<void>;
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
  shouldEscalate: boolean;
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
      if (typeof value.shouldEscalate === "boolean") {
        return {
          shouldEscalate: value.shouldEscalate,
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
  serverUrl,
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

  let cardsSupported: boolean | null = null;

  function cardBody(live: LiveJob) {
    const job = live.job;
    const triggerRunning =
      live.running &&
      Boolean(job.triggerSessionID && live.sessions.has(job.triggerSessionID));
    const triggerAgents = job.triggerSessionID
      ? [
          {
            sessionID: job.triggerSessionID,
            label: "Trigger",
            model: config.triggerModel,
            status: triggerRunning ? "running" : "completed",
          },
        ]
      : [];
    const workSessions = job.workSessions ?? [];
    return {
      tool: "schedule",
      description: job.name,
      agent: "schedule",
      prompt: job.name,
      status: job.status === "running" ? "running" : "completed",
      metadata: {
        uiOnly: true,
        schedule: {
          jobId: job.id,
          name: job.name,
          expiresAt: job.expiresAt,
          nextFireAt: job.nextFireAt,
          steps: [
            {
              title: "Trigger",
              status: triggerRunning
                ? "running"
                : triggerAgents.length
                  ? "completed"
                  : "pending",
              agents: triggerAgents,
            },
            {
              title: "Work",
              status: workSessions.some((row) => row.status === "running")
                ? "running"
                : workSessions.length
                  ? "completed"
                  : "pending",
              agents: workSessions,
            },
          ],
        },
      },
      ...(job.card ?? {}),
    };
  }

  async function updateCard(live: LiveJob): Promise<void> {
    if (cardsSupported === false) return;
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
        body: JSON.stringify(cardBody(live)),
      });
      if (response.status === 404 || response.status === 405) {
        cardsSupported = false;
        return;
      }
      if (!response.ok) {
        console.error(
          `[schedule] card update failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
        );
        return;
      }
      cardsSupported = true;
      const card = (await response.json()) as Job["card"];
      if (!card?.messageID || !card.partID) return;
      live.job.card = card;
      save(live.job);
    } catch (error) {
      console.error(`[schedule] card update failed: ${error}`);
    }
  }

  function pushCard(live: LiveJob): void {
    live.cardQueue = live.cardQueue.then(() => updateCard(live));
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
              schedule_status: false,
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
    shouldEscalate: boolean;
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
      const sessionID = await createSession(
        job,
        `Schedule "${job.name}" trigger`,
      );
      if (job.status !== "running") {
        await client.session.abort({ path: { id: sessionID } }).catch(() => {});
        throw new Error(`job is ${job.status}`);
      }
      job.triggerSessionID = sessionID;
      save(job);
    }

    const sessionID = job.triggerSessionID;
    live.sessions.add(sessionID);
    pushCard(live);
    const rules =
      'You are running as part of a scheduled job. Your task has been defined below or in a previous message. You should not track context in files (unless explicitly asked). Run or re-run any required checks and reply with only {"shouldEscalate":boolean,"reason":"One sentence of why or why not to escalate","context":"Context relevant to the escalation or empty string if not escalating"}.';
    let message = isNew ? `${rules}\n\n${job.triggerPrompt}` : rules;

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
        message = `Reply only with {"shouldEscalate":boolean,"reason":"One sentence of why or why not to escalate","context":"Context relevant to the escalation or empty string if not escalating"}.`;
      }
      throw new Error("trigger returned an invalid verdict twice");
    } finally {
      live.sessions.delete(sessionID);
      pushCard(live);
    }
  }

  async function runWork(
    live: LiveJob,
    verdict: { reason: string; context: string },
  ): Promise<void> {
    const job = live.job;
    const sessionID = await createSession(job, `Schedule "${job.name}" work`);
    if (job.status !== "running") {
      await client.session.abort({ path: { id: sessionID } }).catch(() => {});
      return;
    }
    job.workRunCount = (job.workRunCount ?? 0) + 1;
    const row = {
      sessionID,
      label: `Work run ${job.workRunCount}`,
      model: config.workModel,
      status: "running" as "running" | "completed" | "error",
    };
    job.workSessions = [...(job.workSessions ?? []), row].slice(-5);
    live.sessions.add(sessionID);
    save(job);
    pushCard(live);
    try {
      await prompt(
        job,
        sessionID,
        `You are running as part of a scheduled job. Another agent has decided to escalate to you to perform a one-off task described below. You should not track context in files (unless explicitly asked). Run any required checks and re-validate any conclusions provided as context below. Do not ask the user questions as this is running in a background session. If you determine the job's end condition has been met, call \`schedule_cancel\` with jobId \`${job.id}\`.\n\nEscalation reason: "${verdict.reason}"\nContext: "${verdict.context}"\n\nYour task:\n${job.workPrompt}`,
        config.workModel,
        WORK_TIMEOUT_MS,
        true,
      );
      row.status = "completed";
    } catch (error) {
      row.status = "error";
      throw error;
    } finally {
      live.sessions.delete(sessionID);
      save(job);
      pushCard(live);
    }
  }

  function finish(job: Job, status: Job["status"], reason: string): void {
    const live = liveJobs.get(job.id);
    if (live?.timer) clearTimeout(live.timer);
    if (live) live.timer = null;
    job.status = status;
    job.finishedAt = new Date().toISOString();
    job.terminalReason = reason;
    delete job.nextFireAt;
    save(job);
    if (live) pushCard(live);
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
    job.nextFireAt = next.toISOString();
    save(job);
    pushCard(live);
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
      if (verdict.shouldEscalate && job.status === "running") {
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
      cardQueue: Promise.resolve(),
    };
    liveJobs.set(job.id, live);
    arm(live);
  }

  function cancel(job: Job, requestingSessionID?: string): void {
    const live = liveJobs.get(job.id);
    if (live) {
      for (const sessionID of live.sessions) {
        if (sessionID === requestingSessionID) continue;
        void (client.session.abort({
          path: { id: sessionID },
        }) as Promise<any>);
      }
    }
    finish(job, "cancelled", "cancelled by request");
  }

  for (const job of loadJobs()) {
    if (job.status === "running" && !liveJobs.has(job.id)) start(job);
  }

  const createDescription =
    "Create a scheduled job to perform ongoing or repetitive tasks or monitoring.";

  function describe(job: Job): string {
    const reason = job.terminalReason
      ? ` terminalReason=${job.terminalReason}`
      : "";
    const triggerSession = job.triggerSessionID
      ? ` triggerSession=${job.triggerSessionID}`
      : "";
    return `${job.id} "${job.name}" ${job.status} cron=${job.cron} expires=${job.expiresAt}${triggerSession}${reason}`;
  }

  return {
    event: async ({ event }: { event: any }) => {
      if (event?.type !== "message.part.updated") return;
      const schedule = event.properties?.part?.state?.metadata?.schedule;
      if (!schedule?.cancelRequested || !schedule.jobId) return;
      const job = liveJobs.get(schedule.jobId)?.job;
      if (!job || job.status !== "running") return;
      cancel(job);
    },
    tool: {
      schedule_create: tool({
        description: createDescription,
        args: {
          name: tool.schema
            .string()
            .describe("Short name for the scheduled job in sentence case."),
          cron: tool.schema.string().describe("Five-field cron expression."),
          expiresAt: tool.schema
            .string()
            .describe(
              "ISO date-time after which the scheduled job stops running.",
            ),
          triggerPrompt: tool.schema
            .string()
            .describe(
              "Prompt for the trigger agent that runs on every cron occurrence. It performs quick checks and determines whether the work agent should run. Its context persists across intervals.",
            ),
          workPrompt: tool.schema
            .string()
            .describe(
              "Prompt for the work agent that runs when the trigger agent escalates to it. It performs deeper analysis or investigation and may take action. It receives a fresh context each time.",
            ),
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
            return "The cron never fires before the expiresAt date-time.";
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
          const firstRun = new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "long",
          }).format(first);
          return `Created scheduled job with id: ${job.id}. The first run will be at ${firstRun}.`;
        },
      }),

      schedule_list: tool({
        description:
          "List all running scheduled jobs and any jobs that expired or were cancelled within the past 24 hours.",
        args: {},
        async execute() {
          const cutoff = Date.now() - 24 * 60 * 60 * 1000;
          const jobs = loadJobs()
            .filter(
              (job) =>
                job.status === "running" ||
                (job.finishedAt !== undefined &&
                  new Date(job.finishedAt).getTime() >= cutoff),
            )
            .sort((left, right) => left.name.localeCompare(right.name));
          return jobs.length
            ? jobs.map(describe).join("\n")
            : "No scheduled jobs.";
        },
      }),

      schedule_status: tool({
        description:
          "Show a scheduled job's status, schedule, expiration, trigger session, and terminal reason.",
        args: {
          jobId: tool.schema.string(),
        },
        async execute(args) {
          const job = loadJobs().find(
            (candidate) => candidate.id === args.jobId,
          );
          if (!job) return `No scheduled job found for id: ${args.jobId}.`;
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
          if (!job) return `No scheduled job found for id: ${args.jobId}.`;
          if (job.status !== "running")
            return `${args.jobId} is ${job.status}.`;
          cancel(job, context.sessionID);
          return `Cancelled ${args.jobId}.`;
        },
      }),
    },
  };
};
