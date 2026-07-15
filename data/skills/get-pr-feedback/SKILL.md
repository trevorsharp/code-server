---
name: get-pr-feedback
description: Fetch PR review comments from an Azure DevOps or GitHub pull request URL
---

# Get PR Feedback

## Steps

### Get the pull request URL

You need a pull request URL. Both Azure DevOps and GitHub PR URLs are supported.
If you already have a PR URL provided or in context, use it.
If you don't have a URL, try to find it before asking the user. From inside the relevant git repo, run `pr --existing` to print the URL of the existing PR for the current branch.
If it prints a URL, use it. If not, ask the user for the PR URL.

### Run the helper script

Pass the PR URL directly to the bundled `get-pr-feedback.sh` script. It detects the provider from the URL, fetches the feedback, and prints structured markdown.

```bash
./get-pr-feedback.sh "<pr-url>"
```

If the script fails, report back to the user. If the script runs successfully but produces no `##` sections, then the PR has no review comments.
