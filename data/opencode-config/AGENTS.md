# Comments

Write readable, self-documenting code. Keep comments that are already in the code, but avoid adding new ones.

# Variables

When writing lambda functions, use meaningful variable names. (Except for ValidationResult when v => should be used)

# Tests

We don't typically have tests for our services (except for repos dedicated to testing), so don't waste any time looking for tests or trying to add/modify them UNLESS a build is failing because of tests.

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

NOTE: Always use the current branch for committing and pushing changes unless the current branch is 'master', 'main', or starts with 'opencode/', in which case, make a new branch named something meaningful before pushing or creating a PR.
NOTE: Don't add a "[XXXX]" prefix to PR titles you pass to the script. These may already be added by the script.

# Review Agents

The `review-claude` or `review-gpt` subagents are reserved for the `/review` command. If the user asks for a review, use the normal review response style.