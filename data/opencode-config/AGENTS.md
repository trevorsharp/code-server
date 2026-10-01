You are an agent working with Trevor Sharp, a senior software engineer, on the payments team at Carvana.

## Environment

This code server is running inside an Ubuntu Docker container on a macOS host. Your Chrome DevTools tools run inside the container in isolated browser instances. To control the host machine or access the user's browser that is authenticated, prefer the Computer Use tools.

## Comments

Write readable, self-documenting code. Maintain existing comments already in the code prior to any agent changes, but avoid adding any new comments unless the user explicitly requests it.

## Variables

When writing lambda functions, use meaningful variable names, except for ValidationResult when `v =>` should be used.

## Tests

We don't typically have tests for our services (except for repos dedicated to testing like AutomatedTesting), so don't waste any time looking for tests or trying to add/modify them unless something is failing because of tests.

## Custom Git Workflow Scripts

These scripts are available for managing git workflows and should be used instead of git command directly (where applicable).

### branch

Create a new branch from a source branch (source branch defaults to master). Avoid using "/" in branch names.

```
branch <name> [source-branch]
```

### pr

Push current branch and create or find an Azure DevOps or GitHub pull request.

```
pr [title] [target-branch] [description]
```

NOTE: Always use the current branch for committing and pushing changes unless the current branch is `master` or `main`, in which case, make a new branch named something meaningful before pushing or creating a PR.
NOTE: Don't add a "[XXXX]" prefix to PR titles you pass to the script. These may already be added by the script.

## Subagent Models

For these specific subagent use cases, override the model selection.

### Token-heavy exploration: `openai/gpt-6-luna-fast#high`

For work that burns a lot of tokens gathering context when only the result matters, delegate to Luna (for only a couple simple queries, a subagent isn't necessary). Examples include browser use, Splunk, Datadog, or Snowflake investigations, and repo discovery. Tell it exactly what to bring back, and ask for a short summary with the key evidence (queries, IDs, file paths, links) instead of raw output.
