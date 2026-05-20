#!/bin/bash

# get-pr-feedback.sh
# Fetches and formats PR feedback from Azure DevOps
# Usage: ./get-pr-feedback.sh <org-base-url> <pr-id>
# Example: ./get-pr-feedback.sh "https://carvanadev.visualstudio.com" 12345

set -euo pipefail

# Parse arguments
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <org-base-url> <pr-id>" >&2
  exit 1
fi

ORG_BASE_URL="$1"
PR_ID="$2"

# Validate org URL
if [[ ! "$ORG_BASE_URL" =~ ^https?:// ]]; then
  echo "Error: Org URL must start with http:// or https://" >&2
  exit 1
fi

# Validate PR ID is numeric
if ! [[ "$PR_ID" =~ ^[0-9]+$ ]]; then
  echo "Error: PR ID must be numeric" >&2
  exit 1
fi

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
      status: (.status // "general"),
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
