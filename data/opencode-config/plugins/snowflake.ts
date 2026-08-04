import type { Plugin } from "@opencode-ai/plugin"

type QueryResponse = {
  sfid?: string
  metadata?: {
    row_count?: number
  }
  data?: {
    headers?: unknown[]
    rows?: unknown[][]
  }
  is_sample?: boolean
  saved_results?: unknown
}

export const SnowflakePlugin: Plugin = async () => ({
  "tool.execute.after": async ({ tool }, output) => {
    if (!tool.toLowerCase().endsWith("snowflake_execute_query")) return

    try {
      const response = JSON.parse(output.output) as QueryResponse
      if (!response.data) return

      output.output = JSON.stringify({
        sfid: response.sfid,
        row_count: response.metadata?.row_count,
        data: response.data,
        is_sample: response.is_sample,
        saved_results: response.saved_results,
      })
    } catch { }
  },
})
