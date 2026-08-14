---
name: splunk
description: Use this when using the Splunk MCP
---

# Splunk

Payments team services live under `index=cvna_oec_prod` (or `index=cvna_oec_test`) and will have `Properties.Track=Payments`. Our services log both the start of an API call with `Properties.BeginRequest=true` and the end of an API call with `Properties.EndRequest=true`.

Your goal should always be to run performant queries. Start with small queries to understand data shape and expand time windows and filters only after you understand the data.