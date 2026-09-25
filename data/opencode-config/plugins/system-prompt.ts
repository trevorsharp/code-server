function omitMcpToolSamples(text: string, namespaces: Set<string>) {
  const catalogStart = text.indexOf("## Available tools\n\n")
  const catalogEnd = text.indexOf("Instructions from: ", catalogStart)
  if (catalogStart < 0 || catalogEnd < 0) return text

  const catalog = text.slice(catalogStart, catalogEnd)
  const headers = [...catalog.matchAll(/^- ([A-Za-z_][\w-]*) \((\d+) tools?, \d+ shown\)[^\n]*$/gm)]
  if (!headers.length) return text

  const reminder = "MCP namespaces only. Use search to find tools for a namespace."
  let trimmed = catalog.slice(0, headers[0].index)
  if (!trimmed.includes(reminder)) trimmed += `${reminder}\n\n`

  for (const [index, header] of headers.entries()) {
    const end = headers[index + 1]?.index ?? catalog.length
    if (header[1] === "browser") continue
    trimmed += header[1] === "opencode"
      ? `${header[0].replace(/, \d+ shown/, "")}\n\n`
      : namespaces.has(header[1])
        ? `- ${header[1]} (${header[2]} tools)\n`
        : catalog.slice(header.index, end)
  }

  return text.slice(0, catalogStart) + trimmed + text.slice(catalogEnd)
}

export default {
  id: "System Prompt",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (tool.id.startsWith("browser_")) editor.remove(tool.id)
      }
    })

    await ctx.session.hook("context", async (event) => {
      if (event.agent !== "build") return

      let namespaces = new Set<string>()
      try {
        const { data: servers } = await ctx.mcp.list()
        namespaces = new Set(servers.map((server) => server.name.replace(/[^A-Za-z0-9_-]/g, "_")))
      } catch (error) {
        console.error("Failed to list MCP servers; leaving tool samples unchanged:", error)
      }

      for (let index = event.system.length - 1; index >= 0; index--) {
        const part = event.system[index]
        if (part.type !== "text") continue

        let text = part.text
        if (text.includes("<mcp_instructions>")) text = text.replace(/<mcp_instructions>[\s\S]*?<\/mcp_instructions>/g, "").trim()
        if (namespaces.size) text = omitMcpToolSamples(text, namespaces)
        if (text === part.text) continue
        if (text) event.system[index] = { ...part, text }
        else event.system.splice(index, 1)
      }
    })
  },
}
