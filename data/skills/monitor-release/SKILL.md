---
name: monitor-release
description: Monitor a backend service production release for a provided Azure DevOps build URL. Use only when the user explicitly instructs and not from within an existing scheduled job for monitoring release.
---

# Monitor Release

Prepare and create a scheduled job to monitor a provided backend service production release.

## Steps

### Extract service and version

Extract the project and build ID from the provided Azure DevOps build URL.

Get the service and version:

```bash
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/{project}/_apis/build/builds/{buildId}?api-version=7.1" \
  --query "buildNumber" \
  --output tsv
```

Derive the version from the semantic-version suffix of `buildNumber`. The remaining prefix is the service name.

### Check release status

Get the current production-release status:

```bash
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/{project}/_apis/build/builds/{buildId}/timeline?api-version=7.1" \
  --query "sort_by(records[?name=='Deployment: PRODUCTION'], &lastModified)[-1].{name:name,state:state,result:result,startTime:startTime,finishTime:finishTime}" \
  --output json
```

Treat the production release as successful only when its state is `completed` and its result is `succeeded`.

### Telemetry discovery

Splunk and Datadog will be required for this release monitor. If either MCP is missing, ask the user to enable them before proceeding.

Derive the candidate Splunk source by removing the `carvana-oec-` prefix from the service name from the build. Verify it with a small Splunk query over the last 15 minutes:

```spl
index=cvna_oec_prod Properties.Track=Payments source={splunk-source}
| stats latest(source) as source count latest(Properties.AppVersion) as version latest(Properties.dd_service) as datadog_service latest(Properties.dd_version) as datadog_version
```

If the candidate source returns no data then expand to the past 4 hours. If still no results, then run the same query with source omitted over the last 15 minutes to query all Payments services and match the service name. If still no source is found, then ask the user to provide the Splunk source.

Verify the Datadog mapping with `aggregate_spans` over the last 15 minutes using this query and a `COUNT` computation:

```text
service:{datadog_service} env:prod version:{datadog_version}
```

If the count is zero, retry once over the last 4 hours. If still no data is found, then ask the user to provide the Datadog info.

### Create the scheduled job with the prompts

- Default to every 3 minutes for 2 hours; honor any user instructions otherwise.
- Use a sentence-case name containing the service and target version.
- Call `schedule_create` exactly once.
- Do not schedule if any of the setup steps were not completed.

## Trigger prompt

Replace every placeholder and use this complete prompt. Include the pending-release block if and only if the production deployment has not already succeeded during setup. Set `{production-deployment-time}` to the deployment `finishTime` when known; otherwise set it to `pending (capture finishTime when deployment succeeds)`.

````text
Monitor the production release of {service} (version {version}).

Release build URL: {build-url}
Production deployment completed at: {production-deployment-time}

{Pending release block
  
Before starting to query release telemetry, run the following command to check the release status. If the production deployment is not completed, do not query telemetry or escalate. If it completes with a result other than `succeeded`, immediately trigger an investigation for rollout failure. Once it succeeds, retain its `finishTime`, stop running the status command, and start the telemetry queries.

```bash
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/{project}/_apis/build/builds/{buildId}/timeline?api-version=7.1" \
  --query "sort_by(records[?name=='Deployment: PRODUCTION'], &lastModified)[-1].{name:name,state:state,result:result,startTime:startTime,finishTime:finishTime}" \
  --output json
```
}

Telemetry:
- Splunk index: cvna_oec_prod
- Splunk source: {splunk-source}
- Splunk version field: Properties.AppVersion
- Datadog service: {datadog-service}
- Datadog environment: prod
- Datadog version tag: version

On the first run after production deployment:
- Identify the previous production version.
- Choose a completed 30-minute baseline window for the previous version prior to the release of this version.
- Query Splunk and Datadog to establish baseline metrics for the previous version

```spl
index=cvna_oec_prod source={splunk-source} Properties.Track=Payments Properties.EndRequest=true Properties.AppVersion={previous-version}
| stats count by Properties.CallDetails.StatusCode
```

```spl
index=cvna_oec_prod source={splunk-source} Properties.Track=Payments Properties.AppVersion={previous-version} (Level=Warning OR Level=Error)
| stats count by Level MessageTemplate
| sort - count
```

```text
sum:trace.aspnet_core.request.hits{service:{datadog-service},env:prod,!resource_name:*health*,!resource_name:*swagger*,!resource_name:*openapi*} by {version}.as_count()
```

```text
p95:trace.aspnet_core.request{service:{datadog-service},env:prod,version:{previous-version},!http.status_code:404,!resource_name:*health*,!resource_name:*swagger*,!resource_name:*openapi*}
```

```text
sum:trace.aspnet_core.request.hits.by_http_status{service:{datadog-service},env:prod,version:{previous-version},!resource_name:*health*,!resource_name:*swagger*,!resource_name:*openapi*} by {resource_name,http.status_code}.as_count()
```

On all runs after production deployment:
- Query the latest completed 5-minute window for the new version ({version}), allowing for telemetry ingestion delay.
- Run the equivalent Splunk request-outcome and warning/error-pattern queries for the current window.
- Run the Datadog version-traffic query, the p95 query scoped to {version}, and the complete HTTP status breakdown scoped to {version}.
- Allow a 15-minute deployment grace period. Afterward, escalate if the target receives fewer than 10 requests in a completed 5-minute window, or if old-version traffic remains above 10% of total traffic for two consecutive windows.
- Derive the target's 5xx rate from the status breakdown only when its sum matches target request hits. A missing or incomplete series is unknown, not zero.
- Treat the 5xx rate as materially increased only when there are at least 5 target-version 5xx responses and the rate is at least 1 percentage point and twice the baseline rate.
- Compare rates rather than raw counts when the baseline and current windows differ in duration. Treat a warning or error pattern as materially worse only when it has at least 5 occurrences and at least twice the baseline rate per request.
- Compare target p95 with the retained baseline only when both windows contain at least 100 requests. Treat p95 as materially regressed only when it is at least 50% and 100 ms above baseline for two consecutive windows.
- Escalate only for a new or materially worse signal attributable to the release: rollout failure, meaningful 5xx increase, new or sharply increased Splunk error pattern, or sustained material p95 regression.
- Do not repeatedly escalate the same unchanged signal. Escalate again only if impact materially worsens or distinct evidence appears.
- Treat unavailable telemetry as unknown. Do not treat missing data as healthy or escalate solely because a source is unavailable.

Trigger the work prompt only when an escalation criterion is met. Include the symptom, current and baseline values and UTC windows, thresholds crossed, affected endpoints, unavailable sources, production deployment time, build link, and relevant Splunk or Datadog links.
````

## Work prompt

Replace every placeholder and use this complete prompt.

```text
Investigate an escalated production-release signal for {service} (version {version}). Treat the escalation reason and context provided above as a hypothesis, not a conclusion.

Release:
- Build URL: {build-url}

Safety:
- Never mutate production, approve or reject anything, redeploy, restart services, change configuration, or perform a rollback.
- Recommend actions only.
- Do not ask the user questions. Complete the investigation from available evidence.
- Notify only Trevor through the `notify` tool.
- Do not create another scheduled job.
- Keep your investigation focused yet thorough. If high-confidence evidence is found early, limit the remaining investigation to evidence needed to refute or scope it before notifying.

Telemetry:
- Splunk index: cvna_oec_prod
- Splunk source: {splunk-source}
- Splunk version field: Properties.AppVersion
- Datadog service: {datadog-service}
- Datadog environment: prod
- Datadog version tag: version
- Payments dashboard: https://app.datadoghq.com/dashboard/yxz-6s5-yi8/payments-dashboard

```spl
index=cvna_oec_prod source={splunk-source} Properties.Track=Payments Properties.EndRequest=true Properties.AppVersion={version}
| stats count by Properties.CallDetails.StatusCode
```

```spl
index=cvna_oec_prod source={splunk-source} Properties.Track=Payments Properties.AppVersion={version} (Level=Warning OR Level=Error)
| stats count by Level MessageTemplate
| sort - count
```

```text
sum:trace.aspnet_core.request.hits{service:{datadog-service},env:prod,!resource_name:*health*,!resource_name:*swagger*,!resource_name:*openapi*} by {version}.as_count()
```

```text
p95:trace.aspnet_core.request{service:{datadog-service},env:prod,version:{version},!http.status_code:404,!resource_name:*health*,!resource_name:*swagger*,!resource_name:*openapi*}
```

```text
sum:trace.aspnet_core.request.hits.by_http_status{service:{datadog-service},env:prod,version:{version},!resource_name:*health*,!resource_name:*swagger*,!resource_name:*openapi*} by {resource_name,http.status_code}.as_count()
```

Investigation:
Assume no knowledge from the trigger agent beyond the escalation reason and context supplied. Reconstruct the signal by identifying or deriving its query, UTC window, values, threshold, and links, then re-run it to confirm it still exists. Independently identify the previous production version and build a comparable pre-release baseline, and compare the signal with that baseline and at least one adjacent completed window while normalizing counts by request volume and accounting for endpoint and status mix. Try to refute release attribution using deployment timing, target-version traffic, old-version overlap, expected status codes, known warning patterns, and unrelated concurrent changes. Inspect Splunk warning and error patterns for {version}, compare new or increased MessageTemplate values with the previous version, and open representative events when needed. In Datadog, investigate the signal type directly: for rollout or traffic, verify target-version adoption, persistent old-version traffic, deployment changes, and sustained unavailable replicas; for HTTP errors, verify denominator completeness, status distribution, affected endpoints, traces, and matching Splunk patterns, treating missing error series as unknown rather than zero; for latency, verify request volume, endpoint mix, consecutive-window p95, and whether a small number of routes explains the change; for resource pressure, inspect service-level CPU throttling, memory, unavailable replicas, and per-pod details while treating transient startup and rollout effects as expected unless sustained. If the primary signal persists, use Datadog service dependencies to identify likely upstream callers and downstream dependencies, inspect exact routes rather than all service traffic, and use sampled spans only as supporting examples. Inspect Payments dashboard or RUM journeys only when there is a defensible mapping to an affected endpoint, adequate volume, and corroborating backend evidence. 

Classify the result as false alarm, real concern, or inconclusive. For a real concern, determine observed impact, likely cause, affected endpoints or callers, confidence, whether the issue is ongoing, and whether rollback consideration is justified.

Final notification:
- Notify Trevor exactly once after the investigation if it is not a false alarm.
- Include the verdict, confidence, concise evidence with current and baseline values and UTC windows, impact, likely cause, build link, relevant telemetry links, unavailable evidence, and rollback relevance.
- For inconclusive, explain the evidence gap and what should be watched next.
```
