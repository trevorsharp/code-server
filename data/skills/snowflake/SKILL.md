---
name: snowflake
description: Use this when using the Snowflake MCP
---

# Snowflake

Use the Snowflake business intelligence (BI) corpus to discover and understand candidate sources, then use live Snowflake to verify them.

## Route By Intent

- Use `Snowflake_bi_ask` for business-language discovery questions such as "what table contains payment selections?" Ask it to identify competing interpretations, recommend a consumer object, and provide grain, key fields, and lineage. If it times out, use `Snowflake_bi_retrieve` with the same focused question; do not fall back to broad literal searches.
- Use `Snowflake_bi_retrieve` when the task requires raw source material: understanding how a column is populated, tracing lineage, inspecting DDL or application code, or resolving a specific definition.
- Use `Snowflake_bi_lookup` only when you already have a technical identifier such as an object, event, column, workbook, or repository name. It is literal manifest matching, not semantic search.
- Use `Snowflake_bi_expand` to open a known URI returned by another corpus tool.
- Use live Snowflake tools only after discovery identifies a candidate. `describe_object` verifies its current schema; `execute_query` verifies freshness, values, grain, and coverage.

## Find The Right Source

1. Describe the business concept, desired grain, and intended use in the corpus question. Include known distinctions or exclusions, but do not invent technical names.
2. Ask for alternatives that represent adjacent meanings. Similar business phrases often map to different events or models.
3. Choose authority based on the use case:
   - Prefer curated analytics tables or views for established reporting concepts.
   - Prefer backend domain events or transactional state for event detail, operational behavior, or lower latency.
   - Use client telemetry only when measuring client behavior.
4. Verify the chosen object sequentially: describe it first, then run a bounded profile for freshness, representative values, key uniqueness, and relevant join coverage.
5. If live behavior contradicts the corpus description, trust the live evidence and investigate lineage with `Snowflake_bi_retrieve`.

Do not select a source from its name alone. Confirm that its grain, semantics, lineage, and live data match the question.

Keep live queries read-only and bounded.
