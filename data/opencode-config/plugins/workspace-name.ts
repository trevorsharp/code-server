import type { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

async function readWorkspaceName(directory: string) {
  try {
    const name = (await readFile(join(directory, ".workspace"), "utf8")).split("\n")[0].trim()
    return name || undefined
  } catch {
    return undefined
  }
}

async function applyWorkspaceName(projectID: string, name: string) {
  const { stdout } = await run("opencode", ["api", "get", "/api/project"])
  const project = (JSON.parse(stdout) as { id: string; name?: string }[]).find((candidate) => candidate.id === projectID)
  if (!project || project.name) return

  await run("opencode", ["api", "patch", `/api/project/${projectID}`, "--data", JSON.stringify({ name })])
}

export default {
  id: "Workspace Name",
  async setup(ctx) {
    const { id, canonical } = ctx.location.project
    const name = await readWorkspaceName(canonical)
    if (!name) return

    void applyWorkspaceName(id, name).catch((error) => {
      console.error("[workspace-name] Failed to apply workspace name:", String(error))
    })
  },
} satisfies Plugin.Plugin
