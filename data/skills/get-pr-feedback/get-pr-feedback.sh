#!/bin/bash

# get-pr-feedback.sh
# Fetches and formats PR feedback from Azure DevOps or GitHub.
#
# Azure DevOps usage: ./get-pr-feedback.sh <azure-devops-pr-url>
#   Example: ./get-pr-feedback.sh "https://carvanadev.visualstudio.com/.../_git/Repo/pullrequest/12345"
#
# GitHub usage:       ./get-pr-feedback.sh <github-pr-url>
#   Example: ./get-pr-feedback.sh "https://github.com/owner/repo/pull/42"

set -euo pipefail

# ---------------------------------------------------------------------------
# GitHub handling
# ---------------------------------------------------------------------------

run_github() {
  local pr_url="$1"

  # Parse owner/repo/number from the URL
  if [[ ! "$pr_url" =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) ]]; then
    echo "Error: Not a valid GitHub PR URL (expected .../{owner}/{repo}/pull/{number})" >&2
    exit 1
  fi
  local owner="${BASH_REMATCH[1]}"
  local repo="${BASH_REMATCH[2]}"
  local pr_id="${BASH_REMATCH[3]}"

  if ! command -v gh &> /dev/null; then
    echo "Error: GitHub CLI ('gh') is not installed." >&2
    exit 1
  fi
  if ! gh auth status &> /dev/null; then
    echo "Error: Authentication failed. Run 'gh auth login' to authenticate." >&2
    exit 1
  fi

  local api_repo="repos/$owner/$repo"

  TEMP_DIR=$(mktemp -d)
  trap "rm -rf $TEMP_DIR" EXIT

  local metadata_file="$TEMP_DIR/metadata.json"
  local review_comments_file="$TEMP_DIR/review_comments.json"
  local reviews_file="$TEMP_DIR/reviews.json"
  local issue_comments_file="$TEMP_DIR/issue_comments.json"

  echo "Fetching PR metadata..." >&2
  if ! gh api "$api_repo/pulls/$pr_id" > "$metadata_file" 2>"$TEMP_DIR/err"; then
    if grep -q "401\|403" "$TEMP_DIR/err"; then
      echo "Error: Authentication failed. Run 'gh auth login' to authenticate." >&2
    else
      echo "Error: Failed to fetch PR metadata" >&2
      cat "$TEMP_DIR/err" >&2
    fi
    exit 1
  fi

  echo "Fetching review comments..." >&2
  gh api --paginate "$api_repo/pulls/$pr_id/comments" > "$review_comments_file"

  echo "Fetching reviews..." >&2
  gh api --paginate "$api_repo/pulls/$pr_id/reviews" > "$reviews_file"

  echo "Fetching PR-level comments..." >&2
  gh api --paginate "$api_repo/issues/$pr_id/comments" > "$issue_comments_file"

  # Header
  local pr_title pr_state created_by source_branch target_branch
  pr_title=$(jq -r '.title // "N/A"' "$metadata_file")
  pr_state=$(jq -r '.state // "N/A"' "$metadata_file")
  created_by=$(jq -r '.user.login // "Unknown"' "$metadata_file")
  source_branch=$(jq -r '.head.ref // ""' "$metadata_file")
  target_branch=$(jq -r '.base.ref // ""' "$metadata_file")

  echo "# PR #$pr_id: $pr_title"
  echo ""
  echo "- Status: $pr_state"
  echo "- Author: $created_by"
  echo "- Branch: $source_branch -> $target_branch"

  # Inline review comments, grouped by file. Threading is via in_reply_to_id,
  # so we group replies under their root comment.
  jq -r '
    # Index comments by id so replies can find their root
    (reduce .[] as $c ({}; .[($c.id|tostring)] = $c)) as $byId |

    # Resolve the root (top-level) comment id for any comment
    def rootId($c):
      if ($c.in_reply_to_id // null) == null then ($c.id|tostring)
      else rootId($byId[($c.in_reply_to_id|tostring)]) end;

    [.[] | . as $c |
      select((.user.type // "") != "Bot") | {
      rootId: rootId($c),
      filePath: (.path // "PR-level"),
      line: (.line // .original_line // null),
      startLine: (.start_line // .original_start_line // null),
      author: (.user.login // "Unknown"),
      content: (.body // "" | gsub("\\n+$"; "") | gsub("\\n{3,}"; "\n\n"))
    }] |

    # Group into threads by root comment id
    group_by(.rootId) |
    map({
      filePath: .[0].filePath,
      line: .[0].line,
      startLine: .[0].startLine,
      comments: [.[] | {author, content}]
    }) |

    # Group threads by file
    group_by(.filePath) |
    to_entries[] |
    .value as $threads |
    "\n## \($threads[0].filePath)\n",
    ($threads[] | . as $t |
      (if $t.line != null then
        if $t.startLine != null and $t.startLine != $t.line then
          "Lines \($t.startLine)-\($t.line)"
        else
          "Line \($t.line)"
        end
      else "" end) as $loc |
      (if $loc != "" then "- **\($loc)**" else "- **General**" end),
      ($t.comments[] | "  - **\(.author):** \(.content)"),
      ""
    )
  ' "$review_comments_file"

  # Review summaries (state + body)
  jq -r '
    [.[] | select((.user.type // "") != "Bot") | select((.body // "") != "" or (.state // "") == "CHANGES_REQUESTED" or (.state // "") == "APPROVED")] |
    if length > 0 then
      "\n## Reviews\n",
      (.[] |
        "- **\(.user.login // "Unknown")** [\(.state // "COMMENTED")]",
        (if (.body // "") != "" then
          "  - \(.body | gsub("\\n+$"; "") | gsub("\\n{3,}"; "\n\n"))"
        else empty end)
      )
    else empty end
  ' "$reviews_file"

  # PR-level discussion comments
  jq -r '
    [.[] | select((.user.type // "") != "Bot")] |
    if length > 0 then
      "\n## PR-level Comments\n",
      (.[] |
        "- **\(.user.login // "Unknown"):** \(.body // "" | gsub("\\n+$"; "") | gsub("\\n{3,}"; "\n\n"))"
      )
    else empty end
  ' "$issue_comments_file"

  exit 0
}

# ---------------------------------------------------------------------------
# Azure DevOps handling
# ---------------------------------------------------------------------------

run_azure() {
  local pr_url="$1"

  # Parse org base URL (scheme + host) and PR ID from the URL.
  # Example: https://carvanadev.visualstudio.com/.../_git/Repo/pullrequest/12345
  if [[ ! "$pr_url" =~ ^(https?://[^/]+).*/pullrequest/([0-9]+) ]]; then
    echo "Error: Not a valid Azure DevOps PR URL (expected .../pullrequest/{number})" >&2
    exit 1
  fi
  ORG_BASE_URL="${BASH_REMATCH[1]}"
  PR_ID="${BASH_REMATCH[2]}"

  azure_main
}

# Helper function to make API calls with error handling
call_api() {
  local method="$1"
  local uri="$2"
  local output_file="$3"
  
  if ! output=$(az rest --method "$method" \
    --resource "499b84ac-1321-427f-aa17-267ca6975798" \
    --uri "$uri" \
    -o json 2>&1); then
    
    # Check if it's a 404 and we haven't tried with DefaultCollection yet
    if echo "$output" | grep -q "404" && [[ ! "$uri" =~ /DefaultCollection/ ]]; then
      # Retry with DefaultCollection
      new_uri="${uri//\/$ORG_BASE_URL/\/$ORG_BASE_URL\/DefaultCollection}"
      if ! output=$(az rest --method "$method" \
        --resource "499b84ac-1321-427f-aa17-267ca6975798" \
        --uri "$new_uri" \
        -o json 2>&1); then
        return 1
      fi
    else
      return 1
    fi
  fi
  
  echo "$output" > "$output_file"
  return 0
}

azure_main() {
# Create temp files
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

PR_METADATA_FILE="$TEMP_DIR/pr_metadata.json"
THREADS_FILE="$TEMP_DIR/threads.json"

# Step 1: Fetch PR metadata
echo "Fetching PR metadata..." >&2

if ! call_api get \
  "$ORG_BASE_URL/_apis/git/pullRequests/$PR_ID?api-version=7.0" \
  "$PR_METADATA_FILE"; then
  
  # Check if it's an auth error
  if grep -q "401\|403" "$PR_METADATA_FILE"; then
    echo "Error: Authentication failed. Run 'az login' to authenticate." >&2
  else
    echo "Error: Failed to fetch PR metadata" >&2
    cat "$PR_METADATA_FILE" >&2
  fi
  exit 1
fi

# Extract project and repository info
PROJECT=$(jq -r '.repository.project.name // empty' "$PR_METADATA_FILE")
REPOSITORY=$(jq -r '.repository.name // empty' "$PR_METADATA_FILE")

if [[ -z "$PROJECT" ]] || [[ -z "$REPOSITORY" ]]; then
  echo "Error: Could not extract project and repository from PR metadata" >&2
  exit 1
fi

# Extract PR info for display
PR_TITLE=$(jq -r '.title // "N/A"' "$PR_METADATA_FILE")
PR_STATUS=$(jq -r '.status // "N/A"' "$PR_METADATA_FILE")
CREATED_BY=$(jq -r '.createdBy.displayName // "Unknown"' "$PR_METADATA_FILE")
SOURCE_BRANCH=$(jq -r '.sourceRefName // "" | gsub("refs/heads/"; "")' "$PR_METADATA_FILE")
TARGET_BRANCH=$(jq -r '.targetRefName // "" | gsub("refs/heads/"; "")' "$PR_METADATA_FILE")

# Step 2: Fetch comment threads
echo "Fetching comment threads..." >&2

THREADS_URI="$ORG_BASE_URL/$PROJECT/_apis/git/repositories/$REPOSITORY/pullRequests/$PR_ID/threads?api-version=7.0"

if ! call_api get "$THREADS_URI" "$THREADS_FILE"; then
  echo "Error: Failed to fetch comment threads" >&2
  cat "$THREADS_FILE" >&2
  exit 1
fi

# Display PR header info
echo "# PR #$PR_ID: $PR_TITLE"
echo ""
echo "- Status: $PR_STATUS"
echo "- Author: $CREATED_BY"
echo "- Branch: $SOURCE_BRANCH -> $TARGET_BRANCH"

# Step 3: Process and filter threads

# Use jq to do all the heavy lifting: filter out system-only threads, group by file, number them
jq -r '
  # Collect threads that have at least one non-system comment
  [.value[] |
    select(.comments | map(select(.commentType != "system")) | length > 0) |
    {
      filePath: (.threadContext.filePath // "PR-level"),
      startLine: (.threadContext.rightFileStart.line // null),
      endLine: (.threadContext.rightFileEnd.line // null),
      status: (if ([.comments[] | select(.commentType != "system")] | all(.isDeleted == true)) then "deleted" else (.status // "general") end),
      comments: [.comments[] | select(.commentType != "system") | {
        author: (.author.displayName // "Unknown"),
        content: (.content // "" | gsub("\\n+$"; "") | gsub("\\n{3,}"; "\n\n"))
      }]
    }
  ] |

  # Group by file path
  group_by(.filePath) |

  # Format output
  to_entries[] |
  .value as $threads |
  $threads[0].filePath as $file |

  # File header
  "\n## \($file)\n",

  # Each thread under this file
  ($threads | to_entries[] |
    .value as $t |

    # Location line
    (if $t.startLine != null then
      if $t.endLine != null and $t.endLine != $t.startLine then
        "Lines \($t.startLine)-\($t.endLine)"
      else
        "Line \($t.startLine)"
      end
    else
      ""
    end) as $loc |

    # Thread header with status
    (if $loc != "" then
      "- **\($loc)** [\($t.status)]"
    else
      "- **General** [\($t.status)]"
    end),

    # Comments
    ($t.comments[] |
      "  - **\(.author):** \(.content)"
    ),

    # Blank line between threads
    ""
  )
' "$THREADS_FILE"

exit 0
}

# ---------------------------------------------------------------------------
# Dispatch: detect provider from the PR URL
# ---------------------------------------------------------------------------

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <pr-url>" >&2
  echo "  Supports Azure DevOps and GitHub pull request URLs." >&2
  exit 1
fi

PR_URL="$1"

case "$PR_URL" in
  *github.com*)
    run_github "$PR_URL"
    ;;
  *)
    run_azure "$PR_URL"
    ;;
esac
