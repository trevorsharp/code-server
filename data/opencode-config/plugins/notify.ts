import { tool, type Plugin } from "@opencode-ai/plugin"

export const NotifyPlugin: Plugin = async () => ({
  tool: {
    notify: tool({
      description:
        "Send Trevor a Slack notification. Use only when the user explicitly asks to be notified, pinged, or alerted.",
      args: {
        message: tool.schema
          .string()
          .describe('Brief plain-text message (markdown is unsupported). Newlines are supported using "\\n".'),
      },
      async execute({ message }, context) {
        const webhookUrl = process.env.NOTIFY_SLACK_WEBHOOK_URL
        if (!webhookUrl) {
          throw new Error("NOTIFY_SLACK_WEBHOOK_URL is not configured")
        }

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            sessionId: context.sessionID,
            projectId: Buffer.from(context.directory).toString("base64url"),
          }),
        })

        if (!response.ok) {
          throw new Error(`Slack notification failed (${response.status} ${response.statusText})`)
        }

        return "Slack notification sent to Trevor."
      },
    }),
  },
})
