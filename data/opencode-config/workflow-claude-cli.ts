import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

const MODEL_PREFIX = "claude-cli/"
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"])

export type ClaudeCliAgentOptions = {
  directory: string
  prompt: string
  model: string
  variant: string
  system: string
  schema?: unknown
  onEvent?: (event: any) => void | Promise<void>
}

export type ClaudeCliAgentHandle = {
  result: Promise<unknown>
  abort: () => void
}

export function isClaudeCliModel(model: string | undefined): model is string {
  return model?.startsWith(MODEL_PREFIX) === true
}

export function startClaudeCliAgent(options: ClaudeCliAgentOptions): ClaudeCliAgentHandle {
  const model = options.model.slice(MODEL_PREFIX.length)
  if (!model) throw new Error(`Claude CLI model must follow ${MODEL_PREFIX}<model>`)
  if (!EFFORT_LEVELS.has(options.variant)) {
    throw new Error(`Claude CLI effort "${options.variant}" is not supported`)
  }

  const args = [
    "-p",
    "--model",
    model,
    "--effort",
    options.variant,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--dangerously-skip-permissions",
    "--tools",
    "Read,Glob,Grep,Bash,WebFetch,WebSearch,StructuredOutput",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-chrome",
    "--append-system-prompt",
    options.system,
  ]
  if (options.schema) args.push("--json-schema", JSON.stringify(options.schema))

  const child = spawn("claude", args, {
    cwd: options.directory,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const result = collectResult(child, options.schema !== undefined, options.onEvent)
  child.stdin.on("error", () => {})
  child.stdin.end(options.prompt)

  return {
    result,
    abort: () => child.kill("SIGTERM"),
  }
}

function collectResult(
  child: ChildProcessWithoutNullStreams,
  structured: boolean,
  onEvent?: (event: any) => void | Promise<void>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const stderr: Buffer[] = []
    let settled = false
    let response: any
    let eventError: unknown
    let events = Promise.resolve()

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line)
        if (event.type === "result") response = event
        if (onEvent) events = events.then(() => onEvent(event)).catch((error) => void (eventError = error))
      } catch (error) {
        eventError = new Error(`invalid Claude CLI stream event: ${error}; output: ${line.slice(0, 500)}`)
      }
    })
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.on("error", (error) => {
      settled = true
      reject(error)
    })
    child.on("close", async (code, signal) => {
      if (settled) return
      await events
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim()
      if (code !== 0) {
        reject(new Error(`claude exited with ${signal ?? `code ${code}`}${errorOutput ? `: ${errorOutput}` : ""}`))
        return
      }
      if (eventError) {
        reject(eventError)
        return
      }

      try {
        if (!response) throw new Error("Claude CLI returned no result event")
        if (response.is_error) throw new Error(response.result || "Claude CLI returned an error")
        const value = structured ? response.structured_output : response.result
        if (value === undefined) {
          throw new Error(structured ? "Claude CLI returned no structured output" : "Claude CLI returned no result")
        }
        resolve(value)
      } catch (error: any) {
        reject(new Error(`invalid Claude CLI response: ${error?.message ?? error}`))
      }
    })
  })
}
