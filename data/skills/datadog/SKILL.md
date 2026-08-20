---
name: datadog
description: Use this when using the Datadog MCP
---

# Datadog

Before using Datadog data tools, follow the server's skill-discovery requirements: run a direct load for the general domain and list skills with topic keywords in parallel, then load clearly matching results and related skills.

## Exploration Workflows

- Consider a workflow for multi-surface investigations, attribute discovery, large event context, or independent evidence gathering. Handle simple known queries directly.
- The workflow's cost-efficient explorer is a good fit when the telemetry scope and attributes are known. Prefer the default model when fields must be discovered or several telemetry sources need interpretation.
- Give the workflow enough scope and privacy context to investigate independently. Allow room for bounded attribute discovery, since free-text search may not cover nested fields, and validate consequential conclusions.
