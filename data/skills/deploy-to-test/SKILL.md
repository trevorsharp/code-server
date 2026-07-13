---
name: deploy-to-test
description: Deploy a service to the TEST environment by running its Azure DevOps test pipeline with the correct source and test branches
---

# Deploy to Test

This skill deploys a service to the TEST environment by triggering its Azure DevOps test pipeline via the REST API. It auto-detects the service and source branch from the current repo, helps the user pick the correct test branch, and runs the pipeline.

## Prerequisites

- Azure CLI must be installed with the `azure-devops` extension
- User must be authenticated via `az login`
- Must be run from within a service repository that has a `Deployments/` directory

## Constants

- **Azure DevOps Org**: `https://carvanadev.visualstudio.com`
- **Pipelines Project**: `Carvana.Platform.Pipelines`
- **Test Repo Project**: `Carvana.Transaction`
- **Test Repo Name**: `carvana.payments.testing`
- **Azure DevOps Resource ID** (for `az rest --resource`): `499b84ac-1321-427f-aa17-267ca6975798`

## Steps

Follow these steps in order. If any step fails, stop and report the error to the user.

### Step 1: Detect the Service

Look for a `Deployments/` directory in the current repo root. List its contents to find the deployment folder name.

```bash
ls Deployments/
```

The deployment folder name (e.g. `carvana-oec-stripeapi`) is used to derive:
- The **pipeline name**: `{deployment-folder}-test` (e.g. `carvana-oec-stripeapi-test`)

If the `Deployments/` directory does not exist or is empty, tell the user this repo does not appear to have a deployment configuration and ask them to confirm the pipeline name manually.

### Step 2: Detect the Source Branch

Get the current git branch:

```bash
git branch --show-current
```

This is the **source branch** that will be deployed. Tell the user which branch was detected.

If the branch is `master` or `main`, warn the user that this will deploy the default branch (which may already be deployed) and ask if they want to continue.

### Step 3: Find the Pipeline ID

Query the Azure DevOps Pipelines API to find the pipeline by name:

```bash
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/Carvana.Platform.Pipelines/_apis/pipelines?api-version=7.1"
```

From the response, find the pipeline whose `name` matches `{deployment-folder}-test`. Extract its `id`.

If no matching pipeline is found, report this to the user and stop. Suggest they verify the pipeline exists in Azure DevOps under the `Carvana.Platform.Pipelines` project.

### Step 4: Find the Tests Branch

Query the remote branches on the `carvana.payments.testing` repo:

```bash
az rest --method get \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/Carvana.Transaction/_apis/git/repositories/carvana.payments.testing/refs?filter=heads/&api-version=7.1"
```

From the response, extract branch names (strip the `refs/heads/` prefix from each `name` field).

Filter out `master` and `main` from the candidate list. Look for a single branch that is clearly related to the source branch or the service being deployed. Consider:
- Branches containing similar keywords to the source branch name
- Branches containing the service name (e.g. `stripe`, `cashiering`, etc.)
- Branches containing the same JIRA ticket (e.g. `pmt-1234`)

If you find exactly one branch that is a strong match, suggest it to the user. If there is no clear match, or if multiple branches seem equally plausible, do not guess -- just ask the user which branch to use (or whether to use `master`).

### Step 5: Run the Pipeline

Build and execute the `az rest` POST call to trigger the pipeline:

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
  }'
```

Replace `{pipelineId}`, `{source-branch}`, and `{tests-branch}` with the values gathered in previous steps.

If the user chose `master` for the tests branch, you may omit the `tests` resource entirely from the body since `master` is the default:

```bash
az rest --method post \
  --resource "499b84ac-1321-427f-aa17-267ca6975798" \
  --uri "https://carvanadev.visualstudio.com/Carvana.Platform.Pipelines/_apis/pipelines/{pipelineId}/runs?api-version=7.1" \
  --body '{
    "resources": {
      "repositories": {
        "source": {
          "refName": "refs/heads/{source-branch}"
        }
      }
    }
  }'
```

### Step 6: Report Results

**Note:** The API response only includes a `self` entry under `resources.repositories` (pointing to the pipeline YAML repo). It does **not** echo back the `source` or `tests` repository overrides. This is expected behavior -- the overrides are applied even though they are not reflected in the response.

From the API response, extract:
- `id`: the pipeline run ID
- `url`: the API URL for the run
- `_links.web.href`: the web UI URL for the run (if present)

Construct the web URL if not directly available:
```
https://carvanadev.visualstudio.com/Carvana.Platform.Pipelines/_build/results?buildId={run-id}
```

Tell the user:
- The pipeline has been triggered
- A clickable link to monitor the pipeline run
- Which source and tests branches were used

### Step 7: Report to Slack (Optional)

If and only if the user asks to post to Slack, send a message to the dev channel simply saying "Taking over XYZ in TEST" where XYZ is the service name.

## Error Handling

- **`az` not found**: Tell the user to install Azure CLI
- **Authentication failure (401/403)**: Tell the user to run `az login`
- **Pipeline not found**: The pipeline name may not follow the expected convention. Suggest the user check Azure DevOps for the correct pipeline name and provide it manually
- **API errors**: Show the full error response to the user for debugging
