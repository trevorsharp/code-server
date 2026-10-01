import type { Plugin } from "@opencode/plugin"
import { request } from "node:http"
import type { IncomingMessage } from "node:http"
import { setTimeout } from "node:timers/promises"

interface ComputerUseInput {
  title: string
  task: string
  continueFrom?: string
}

type TerminalStatus = "completed" | "rejected" | "cancelled" | "failed" | "disabled"
type ActiveStatus = "awaitingApproval" | "starting" | "running" | "cancelling"

interface TerminalEvent {
  event: "result" | "rejected" | "cancelled"
  requestId: string
  status: TerminalStatus
  result: string
  elapsedSeconds: number
  errorCode?: string
}

type TaskEvent = { event: "created" | "approved"; requestId: string } | TerminalEvent
type TaskSnapshot = { requestId: string; status: ActiveStatus } | TerminalEvent

async function sendRequest(method: string, path: string, signal: AbortSignal, body?: ComputerUseInput) {
  const token = process.env.COMPUTER_USE_TOKEN
  if (!token) throw new Error("COMPUTER_USE_TOKEN is not configured")
  const url = new URL(path, process.env.COMPUTER_USE_BASE_URL ?? "http://host.docker.internal:8766")
  if (url.protocol !== "http:") throw new Error("Computer Use requires an HTTP base URL")

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(url, {
      method,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: method === "POST" ? "application/x-ndjson" : "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    }, resolve)
    outgoing.on("error", reject)
    outgoing.setTimeout(0)
    outgoing.end(body ? JSON.stringify(body) : undefined)
  })

  if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) return response
  throw new Error(`Computer Use HTTP ${response.statusCode}: ${await readBody(response)}`)
}

function parseEvent(value: unknown): TaskEvent {
  if (typeof value !== "object" || value === null || !("requestId" in value) || typeof value.requestId !== "string") {
    throw new Error("Invalid Computer Use event: missing requestId")
  }
  if (!("event" in value)) throw new Error("Invalid Computer Use event: missing event")
  if (value.event === "created" || value.event === "approved") {
    return { event: value.event, requestId: value.requestId }
  }
  if (
    (value.event !== "result" && value.event !== "rejected" && value.event !== "cancelled") ||
    !("status" in value) ||
    (value.status !== "completed" && value.status !== "rejected" && value.status !== "cancelled" && value.status !== "failed" && value.status !== "disabled") ||
    !("result" in value) || typeof value.result !== "string" ||
    !("elapsedSeconds" in value) || typeof value.elapsedSeconds !== "number" ||
    !Number.isFinite(value.elapsedSeconds) || value.elapsedSeconds < 0 ||
    ("errorCode" in value && typeof value.errorCode !== "string")
  ) {
    throw new Error("Invalid Computer Use terminal event")
  }
  return {
    event: value.event,
    requestId: value.requestId,
    status: value.status,
    result: value.result,
    elapsedSeconds: value.elapsedSeconds,
    ...("errorCode" in value ? { errorCode: value.errorCode as string } : {}),
  }
}

async function readBody(response: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

async function readSnapshot(response: IncomingMessage, requestId: string): Promise<TaskSnapshot> {
  const value: unknown = JSON.parse(await readBody(response))
  if (typeof value !== "object" || value === null || !("requestId" in value) || value.requestId !== requestId) {
    throw new Error("Computer Use returned a different or missing requestId")
  }
  if ("status" in value && (value.status === "awaitingApproval" || value.status === "starting" || value.status === "running" || value.status === "cancelling")) {
    return { requestId, status: value.status }
  }
  const event = parseEvent(value)
  if (!("status" in event)) throw new Error("Computer Use returned a nonterminal status event")
  return event
}

async function* readEvents(response: IncomingMessage): AsyncGenerator<TaskEvent> {
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for await (const chunk of response) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield parseEvent(JSON.parse(line))
        newline = buffer.indexOf("\n")
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield parseEvent(JSON.parse(buffer))
  } finally {
    response.destroy()
  }
}

async function awaitResult(events: AsyncGenerator<TaskEvent>, requestId: string, signal: AbortSignal): Promise<TerminalEvent> {
  try {
    for await (const event of events) {
      if (event.requestId !== requestId) throw new Error("Computer Use stream returned a different requestId")
      if ("status" in event) return event
    }
  } catch (error) {
    if (signal.aborted) throw error
  }

  while (!signal.aborted) {
    const snapshot = await readSnapshot(await sendRequest("GET", `/tasks/${requestId}`, signal), requestId)
    if ("event" in snapshot) return snapshot
    await setTimeout(5_000, undefined, { signal })
  }
  throw new Error("Computer Use monitoring stopped")
}

export default {
  id: "Computer Use",
  async setup(ctx) {
    const controller = new AbortController()
    const tasks = new Map<string, Promise<void>>()

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "ComputerUse",
        description:
          "Delegate a desktop or authenticated browser task to the host machine. Only run one computer use task at a time. Each task requires the user to allow it via a notification on the host machine. Do not automatically retry interrupted, rejected, or cancelled tasks. The tool call will immediately return a requestId and run the task in the background you will be notified async once the task is completed.",
        input: {
          type: "object",
          properties: {
            continueFrom: {
              description: "Optional requestId from a previously completed computer use task. Use for follow-up requests when continuing a related task.",
              format: "uuid",
              type: "string",
            },
            task: {
              description: "Full prompt / instructions for the computer use agent.",
              maxLength: 16384,
              minLength: 1,
              type: "string",
            },
            title: {
              description: "A concise title describing the computer use task.",
              maxLength: 200,
              minLength: 1,
              type: "string",
            },
          },
          required: ["title", "task"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          const toolArguments = input as ComputerUseInput
          if (Buffer.byteLength(toolArguments.task, "utf8") > 16384) {
            throw new Error("Computer Use task must be at most 16 KiB in UTF-8")
          }
          context.signal.throwIfAborted()
          const response = await sendRequest("POST", "/tasks", controller.signal, {
            title: toolArguments.title,
            task: toolArguments.task,
            ...(toolArguments.continueFrom ? { continueFrom: toolArguments.continueFrom } : {}),
          }).catch((error) => {
            throw new Error(`Computer Use submission failed: ${String(error)}. Do not automatically repeat POST; the task may have been received.`)
          })
          const events = readEvents(response)
          const created = await events.next().catch(async (error) => {
            await events.return(undefined)
            throw new Error(`Computer Use creation stream failed (requestId: ${response.headers["x-request-id"] ?? "unknown"}): ${String(error)}. Do not automatically repeat POST.`)
          })
          if (created.done || created.value.event !== "created") {
            await events.return(undefined)
            throw new Error(`Computer Use did not send created (requestId: ${response.headers["x-request-id"] ?? "unknown"}). Do not automatically repeat POST.`)
          }
          const requestId = created.value.requestId

          const task = (async () => {
            let result: TerminalEvent | { requestId: string; status: "unknown"; error: string }
            try {
              result = await awaitResult(events, requestId, controller.signal)
            } catch (error) {
              if (controller.signal.aborted) return
              result = {
                requestId,
                status: "unknown",
                error: `Could not recover the task result: ${String(error)}. The host task may still be active. Do not automatically retry it; use Cancel Computer Use if cancellation is needed.`,
              }
            }

            if (controller.signal.aborted) return
            await ctx.session.synthetic({
              sessionID: context.sessionID,
              description: toolArguments.title,
              text: `Computer-use background task update:\n${JSON.stringify(result)}`,
              metadata: { requestId, status: result.status },
              resume: true,
            })
          })().catch((error) => {
            if (!controller.signal.aborted) {
              console.error("[computer-use] Failed to deliver background completion:", String(error))
            }
          }).finally(() => tasks.delete(requestId))

          tasks.set(requestId, task)
          return {
            content: JSON.stringify({
              requestId,
              status: "awaitingApproval",
              message: "Computer-use task received and awaiting user approval. It will run in the background after approval, and you will be notified automatically when it finishes. Do not poll or automatically retry this task.",
            }),
            metadata: { requestId, status: "awaitingApproval" },
          }
        },
      })
      editor.add({
        name: "CancelComputerUse",
        description:
          "Request cancellation of a computer-use task by its requestId. Use when the task is no longer needed or the user asks to stop it. Cancellation does not undo completed actions. A finished task retains its existing result; an active task may remain cancelling until it stops. The original background task will report its final status when monitoring is still active.",
        input: {
          type: "object",
          properties: {
            requestId: {
              type: "string",
              format: "uuid",
              description: "The requestId returned when the computer-use task was created.",
            },
          },
          required: ["requestId"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          const { requestId } = input as { requestId: string }
          const response = await sendRequest(
            "DELETE",
            `/tasks/${encodeURIComponent(requestId)}`,
            AbortSignal.any([controller.signal, context.signal]),
          )
          const result = await readSnapshot(response, requestId)
          return {
            content: JSON.stringify(result),
            metadata: { requestId, status: result.status },
          }
        },
      })
    })

    return async () => {
      controller.abort()
      await Promise.allSettled(tasks.values())
      tasks.clear()
    }
  },
} satisfies Plugin.Plugin
