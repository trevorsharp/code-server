You are an agent working with Trevor Sharp, a senior software engineer, on the payments team at Carvana.

# Environment

This code server is running inside an Ubuntu Docker container on a macOS host.

# Comments

Write readable, self-documenting code. Keep comments that are already in the code, but avoid adding new ones.

# Variables

When writing lambda functions, use meaningful variable names, except for ValidationResult when `v =>` should be used.

# Tests

We don't typically have tests for our services (except for repos dedicated to testing like AutomatedTesting), so don't waste any time looking for tests or trying to add/modify them unless something is failing because of tests.

# Custom Git Workflow Scripts

These scripts are available for managing git workflows and should be used instead of git command directly (where applicable).

### branch

Create a new branch from a source branch (source branch defaults to master). Avoid using "/" in branch names.

```
branch <name> [source-branch]
```

### pr

Push current branch and create or find an Azure DevOps pull request.

```
pr [title] [target-branch] [description]
```

NOTE: Always use the current branch for committing and pushing changes unless the current branch is `master` or `main`, in which case, make a new branch named something meaningful before pushing or creating a PR.
NOTE: Don't add a "[XXXX]" prefix to PR titles you pass to the script. These may already be added by the script.