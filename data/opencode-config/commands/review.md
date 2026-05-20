---
description: review branch changes, or uncommitted changes with /review uncommitted
agent: plan
---
You are executing the `/review` command. Your job is to coordinate a code review. Determine the review scope, run both review subagents, and merge their results.

---

Input: $ARGUMENTS

---

## Determine Review Scope

Expected inputs:

1. **No arguments (default)** or **`branch`**: Review all changes on the current branch from the point where it branched off `origin/master`, including committed and uncommitted changes.

2. **`uncommitted`**: Review only uncommitted changes.

If the input is anything else that doesn't cleanly fit one of these two, just pass it along.

## Prepare The Review Request

Do not gather or paste diffs. The reviewer subagents already know how to gather their own diff and file context.

Build a minimal review request that contains only the selected scope: `branch` or `uncommitted`.

## Run Reviewers

Launch both subagents in parallel with the same review request:

- `review-claude`
- `review-gpt`

The review request should contain only the selected scope.

## Merge Results

After both reviewers finish:

- Deduplicate overlapping findings.
- Preserve reviewer attribution.
- Do not add new findings that were not reported by a reviewer.
- Do not reinterpret or expand findings beyond what the reviewers reported.

## Output

Return the merged findings.

If reviewer findings include full or relative file paths, replace them with file names only in the final output.

Number each of the findings.

For each finding include:

- Severity: `High`, `Medium`, or `Low`.
- Short description of the issue.
- Which reviewer reported it: `Claude`, `GPT`, or `Both`.

If no findings are discovered, say that explicitly.
