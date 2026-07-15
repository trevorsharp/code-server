---
name: deploy-to-test
description: Deploy a service to the TEST environment
---

# Deploy to Test

Deploy a service to the TEST environment by triggering its Azure DevOps test pipeline. Identify the correct testing branch or ask the user which branch to use. Report back to the user with a link to the pipeline run and optionally post a message to the payments dev channel in Slack when the user requests that.

## Steps

Follow these steps. If anything seems off, ask the user for clarification instead of guessing.

### Detect the service

Look for a `Deployments/` directory in the current repo root. List its contents to find the deployment folder name.

```bash
ls Deployments/
```

The deployment folder name (e.g. `carvana-oec-stripeapi`) is used to derive:
- The **pipeline name**: `{deployment-folder}-test` (e.g. `carvana-oec-stripeapi-test`)

### Detect the source branch

Get the current git branch name and determine if it has been pushed to the remote. If not, inform the user and ask if they would like to push it before proceeding.

### Find the pipeline ID

Query to find the Azure DevOps pipeline id by substituting in the deployment folder name.

```bash
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/Carvana.Platform.Pipelines/_apis/build/definitions?api-version=7.1&name={deployment-folder}-test" \
  --query "value[0].id"
```

### Detect the tests branch to use

Query to find the remote branches for the `carvana.payments.testing` repo.

```bash
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/Carvana.Transaction/_apis/git/repositories/carvana.payments.testing/refs?filter=heads/&api-version=7.1" \
  | jq -r '.value[].name | sub("^refs/heads/"; "")'
```

Look for a single branch name that is clearly related to the source branch or the service being deployed. If you find exactly one branch that is identical to the source branch, use it without asking. If there is no identical match, only a similar match, or if multiple branches seem equally plausible, ask the user which branch to use (and provide `master` as an option).

### Run the pipeline

Trigger the test pipeline using the pipeline ID, source branch, and tests branch. This will return the link to the pipeline run.

```bash
az rest --method post \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/Carvana.Platform.Pipelines/_apis/pipelines/{pipelineId}/runs?api-version=7.1" \
  --body '{
    "resources": {
      "repositories": {
        "source": {
          "refName": "refs/heads/{source-branch}"
        },
        "tests": {
          "refName": "refs/heads/{tests-branch}"
        }
      }
    }
  }' \
  | jq -r '._links.web.href'
```

### Update the user

Tell the user the pipeline has been triggered and provide a clickable link to the pipeline run along with which source and tests branches were used.

### Report to Slack (optional)

If and only if the user asks to post to Slack, send a message to the dev channel simply saying "Taking over XYZ in TEST" where XYZ is the service name.