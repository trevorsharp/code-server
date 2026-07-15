---
name: notify
description: Send a Slack notification to Trevor. Use only when the user explicitly asks to be notified, pinged, or alerted about something.
---

# Notify

Send a notification to Trevor via Slack webhook. Use plain text only as markdown formatting is not supported via this method.

## Usage

```bash
curl -s -X POST https://hooks.slack.com/triggers/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 \
  -H "Content-Type: application/json" \
  -d '{"message": "Example text"}'
```
