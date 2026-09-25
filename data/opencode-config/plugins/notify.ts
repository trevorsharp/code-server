import type { Plugin } from "@opencode/plugin"

const QUESTION_WAIT_TIMEOUT_MS = 5 * 60 * 1000

async function sendNotification(message: string, sessionID: string, signal: AbortSignal) {
  const webhookUrl = process.env.NOTIFY_SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    throw new Error("NOTIFY_SLACK_WEBHOOK_URL is not configured")
  }

  const serverUrl = "https://work.trs.dev"
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    body: JSON.stringify({
      message,
      sessionId: sessionID,
      projectId: `server/${Buffer.from(serverUrl).toString("base64url")}`,
    }),
  })

  if (!response.ok) {
    throw new Error(`Slack notification failed (${response.status} ${response.statusText})`)
  }
}

export default {
  id: "Notify",
  async setup(ctx) {
    const controller = new AbortController()
    const questionTimers = new Map<string, ReturnType<typeof setTimeout>>()

    function cancelQuestionTimer(formID: string) {
      const timer = questionTimers.get(formID)
      if (timer) clearTimeout(timer)
      questionTimers.delete(formID)
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "Notify",
        description:
          "Send Trevor a Slack notification. Use only when explicitly instructed to notify, ping, or alert Trevor.",
        input: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: 'Brief plain-text message (markdown is unsupported). Newlines are supported using "\\n".',
            },
          },
          required: ["message"],
          additionalProperties: false,
        },
        options: { codemode: false },
        async execute(input, context) {
          const { message } = input as { message: string }
          await sendNotification(
            message,
            context.sessionID,
            AbortSignal.any([controller.signal, context.signal]),
          )
          return { content: "Slack notification sent to Trevor." }
        },
      })
    })

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break
        if (event.location?.directory !== ctx.location.directory) continue

        if (event.type === "form.created") {
          const { form } = event.data
          if (!form.sessionID.startsWith("ses")) continue

          const field = form.fields.find((field) => !("hidden" in field && field.hidden))
          const question = field?.description || field?.title || form.title
          if (!question) continue

          cancelQuestionTimer(form.id)
          const timer = setTimeout(async () => {
            questionTimers.delete(form.id)
            try {
              await sendNotification(`A question is waiting for an answer:\n\n${question}`, form.sessionID, controller.signal)
            } catch (error) {
              if (!controller.signal.aborted) {
                console.error("[notify] Failed to send delayed question notification:", String(error))
              }
            }
          }, QUESTION_WAIT_TIMEOUT_MS)
          questionTimers.set(form.id, timer)
          continue
        }

        if (event.type === "form.replied" || event.type === "form.cancelled") {
          cancelQuestionTimer(event.data.id)
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) {
        console.error("[notify] Question notification event stream failed:", String(error))
      }
    })

    return () => {
      controller.abort()
      for (const timer of questionTimers.values()) clearTimeout(timer)
      questionTimers.clear()
    }
  },
} satisfies Plugin.Plugin
