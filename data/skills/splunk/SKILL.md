---
name: splunk
description: Use this when using the Splunk MCP
---

# Splunk

Payments team services live under `index=cvna_oec_prod` (or `index=cvna_oec_test`) and will have `Properties.Track=Payments`. Our services log both the start of an API call with `Properties.BeginRequest=true` and the end of an API call with `Properties.EndRequest=true`.

Your goal should always be to run performant queries. Start with small queries to understand data shape and expand time windows and filters only after you understand the data.

## Exploration Workflows

- Consider a workflow for multi-step field discovery, pattern analysis, correlation, or investigations that would add substantial log context. Handle simple known SPL queries directly.
- The workflow's cost-efficient explorer is a good fit when the scope and query shape are well bounded. Prefer the default model when SPL design or correlation requires more judgment.
- Splunk may enforce shared query limits, so favor focused, serial exploration over parallel agents and ask workflows to return aggregate evidence and limitations.
