import { tool, type Plugin } from "@opencode-ai/plugin"

const QUESTION_WAIT_NOTIFICATIONS_ENABLED = true
const QUESTION_WAIT_TIMEOUT_MS = 5 * 60 * 1000

type QuestionEvent =
  | {
      type: "question.asked"
      properties: {
        id: string
        sessionID: string
        questions: Array<{ question: string }>
      }
    }
  | {
      type: "question.replied" | "question.rejected"
      properties: { requestID: string }
    }

async function sendNotification(message: string, sessionID: string, directory: string) {
  const webhookUrl = process.env.NOTIFY_SLACK_WEBHOOK_URL
  if (!webhookUrl) {
    throw new Error("NOTIFY_SLACK_WEBHOOK_URL is not configured")
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      sessionId: sessionID,
      projectId: Buffer.from(directory).toString("base64url"),
    }),
  })

  if (!response.ok) {
    throw new Error(`Slack notification failed (${response.status} ${response.statusText})`)
  }
}

export const NotifyPlugin: Plugin = async ({ client, directory }) => {
  const questionTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function cancelQuestionTimer(requestID: string) {
    const timer = questionTimers.get(requestID)
    if (timer) clearTimeout(timer)
    questionTimers.delete(requestID)
  }

  return {
    event: async ({ event }) => {
      if (!QUESTION_WAIT_NOTIFICATIONS_ENABLED) return

      const questionEvent = event as unknown as QuestionEvent
      if (questionEvent.type === "question.asked") {
        const question = questionEvent.properties.questions[0]?.question
        if (!question) return

        cancelQuestionTimer(questionEvent.properties.id)
        const timer = setTimeout(async () => {
          questionTimers.delete(questionEvent.properties.id)
          try {
            await sendNotification(
              `Question for you:\n${question}`,
              questionEvent.properties.sessionID,
              directory,
            )
          } catch (error) {
            await client.app.log({
              body: {
                service: "notify",
                level: "error",
                message: "Failed to send delayed question notification",
                extra: { error: String(error) },
              },
              query: { directory },
            })
          }
        }, QUESTION_WAIT_TIMEOUT_MS)
        questionTimers.set(questionEvent.properties.id, timer)
        return
      }

      if (questionEvent.type === "question.replied" || questionEvent.type === "question.rejected") {
        cancelQuestionTimer(questionEvent.properties.requestID)
      }
    },
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
          await sendNotification(message, context.sessionID, context.directory)

          return "Slack notification sent to Trevor."
        },
      }),
    },
  }
}
