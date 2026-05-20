---
name: get-pr-feedback
description: Fetch and display PR review comments from an Azure DevOps pull request URL
---

# Get PR Feedback

## Input

If you already have an Azure DevOps PR URL in context, use that. Otherwise, the user should provide an Azure DevOps PR URL. If you don't have one, ask them to provide it.

## Steps

Follow these steps in order. If any step fails, stop and report the error to the user.

### Step 1: Parse the PR URL

Extract the following from the URL:

| Component | How to extract |
|-----------|---------------|
| **Org base URL** | The scheme + host, e.g. `https://carvanadev.visualstudio.com` |
| **PR ID** | The numeric value after `/pullrequest/` in the path |

The path segments between the host and `/_git/` may vary (e.g. `/DefaultCollection/Carvana.Transaction` or just `/Carvana.Transaction`). You do not need to parse the project or repo from the URL.

If the URL does not contain `/pullrequest/{number}`, tell the user the URL doesn't appear to be a valid PR link and ask them to provide a correct one.

### Step 2: Run the Helper Script

Use the bundled `get-pr-feedback.sh` script to fetch and filter PR feedback. This script:
- Fetches PR metadata (title, status, branches)
- Fetches all comment threads from the API
- Filters out system comments
- Outputs structured markdown grouped by file with line ranges, authors, and content

Run the script with:

```bash
/path/to/get-pr-feedback.sh "{orgBaseUrl}" {prId}
```

**Example:**
```bash
/path/to/get-pr-feedback.sh "https://carvanadev.visualstudio.com" 12345
```

The script outputs structured markdown:
- A `# PR #ID: Title` header with metadata (status, author, branches)
- Feedback grouped by file under `## /path/to/file` headers
- Each thread as a bullet with line location and status, e.g. `- **Line 42** [active]`
- Comments nested under each thread as `- **Author:** content`

## Error Handling

The script handles most errors automatically. If the script fails, check:

- **`az` not found**: Tell the user to install Azure CLI with the `azure-devops` extension
- **Authentication failure (401/403)**: Tell the user to run `az login` to authenticate
- **404 errors**: The script automatically retries with `/DefaultCollection` if the first attempt fails
- **Invalid arguments**: Check that the org URL starts with `http://` or `https://` and the PR ID is numeric
- **Other API errors**: The script will display the error response for debugging

If the script runs successfully but produces no `##` file sections, it means the PR has no review comments.
