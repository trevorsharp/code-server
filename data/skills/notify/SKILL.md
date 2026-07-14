---
name: notify
description: Send a Slack notification to Trevor. Use ONLY when the user explicitly asks to be notified, pinged, or alerted about something (e.g., "notify me when the build finishes", "let me know when it's done").
---

# Notify

Send a notification to Trevor via Slack webhook.

## Usage

```bash
curl -s -X POST https://hooks.slack.com/triggers/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 \
  -H "Content-Type: application/json" \
  -d '{"message": "Example text"}'
```

- Use plain text only as markdown formatting is not supported via this method.
