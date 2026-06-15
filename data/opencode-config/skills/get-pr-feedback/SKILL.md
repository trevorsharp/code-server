---
name: get-pr-feedback
description: Fetch and display PR review comments from an Azure DevOps or GitHub pull request URL
---

# Get PR Feedback

## Input

You need a pull request URL. Both Azure DevOps and GitHub PR URLs are supported.

If you already have a PR URL in context, use it.

If you don't have a URL, try to find it before asking the user. From inside the
relevant git repo, run the `pr` script with `--existing` to print the URL of the
existing PR for the current branch:

```bash
pr --existing
```

If it prints a URL, use it. Otherwise, ask the user for the PR URL.

## Run the Helper Script

Pass the PR URL directly to the bundled `get-pr-feedback.sh` script. It detects the
provider from the URL, fetches the feedback, and prints structured markdown:

```bash
./get-pr-feedback.sh "<pr-url>"
```

## Error Handling

If the script fails, check:

- **CLI not found**: Tell the user to install the relevant CLI (`az` for Azure DevOps,
  `gh` for GitHub).
- **Authentication failure (401/403)**: Tell the user to authenticate (`az login` for
  Azure DevOps, `gh auth login` for GitHub).
- **Invalid URL**: The script reports if the URL isn't a recognizable PR link; ask the
  user for a correct one.
- **Other API errors**: The script displays the error response for debugging.

If the script runs successfully but produces no `##` sections, the PR has no review comments.
