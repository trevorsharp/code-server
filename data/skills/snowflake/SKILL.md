---
name: snowflake
description: Use this when using the Snowflake MCP
---

# Snowflake

Use the Snowflake business intelligence (BI) corpus to discover and understand candidate sources, then use live Snowflake to verify them.

## Route By Intent

- Use `Snowflake_bi_retrieve` for focused business-language discovery questions such as "what table contains payment selections?" Include the desired grain and use case, and retrieve evidence for competing interpretations, consumer objects, key fields, and lineage. It is also the default for understanding how a column is populated, inspecting DDL or application code, or resolving a specific definition.
- Avoid `Snowflake_bi_ask` unless the user explicitly requests it. The command commonly exceeds Cloudflare's timeout, so do not use it as the default discovery path or retry it after a timeout.
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

## Payment Data

For payment-domain questions, read `references/payment-sources.md` before corpus discovery. Treat it as a dated candidate-source index, not an authority: verify object existence, columns, freshness, grain, and semantics using the normal workflow above.

Before searching, identify the journey and direction of money, the state being measured, and the required grain. Common journeys include retail collection, STC negative-equity authorization, seller payout, refund, and transfer. Common states include selection, consent, initiation, authorization, collection, ledger posting, and processor movement.

Do not treat adjacent states as interchangeable. Selection or consent does not prove initiation; payment success does not prove ledger posting or settlement; order-accounting entries do not prove payment movement.

- Prefer curated `VW_` objects to raw tables unless raw document history is required.
- Apply selective date predicates before querying high-volume event, clickstream, Plaid transaction, or audit tables.
- Do not return or persist unnecessary PII such as email, phone, account number, or routing number.

For experiment analyses:

- Match assignments using the experiment's identifier type; customer, user, visitor, and browser-cookie identifiers are not interchangeable.
- Require assignment time at or before the measured event and select the latest eligible assignment.
- Validate assignment cardinality before aggregation.
- Report allocation and eligible population before extrapolating treatment volume.
- Use assignment-day or maturity-aligned cohorts when ramping or unequal observation windows make pooled conversion misleading.

An event funnel measures only emitted events. Absence of a terminal event is not automatically failure, and failures before the first lifecycle event are invisible to lifecycle-only analysis. Reconcile pre-initiation failures with logs or APM when the question includes rejected requests, conflicts, or missing payment creation.

For event-to-next-event analyses, first materialize candidate entities and their minimum relevant timestamps. Join high-volume outcome sources only to those entities and bounded observation windows, then select the next eligible event. Preserve the requested follow-up window so performance bounds do not exclude delayed outcomes.

Keep live queries read-only and bounded.
