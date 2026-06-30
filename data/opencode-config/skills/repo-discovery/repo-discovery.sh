#!/usr/bin/env bash
set -euo pipefail

AZURE_ORG_URL="https://dev.azure.com/CarvanaDev"
AZURE_ORG_NAME="CarvanaDev"
AZURE_PROJECT=""
GITHUB_ORG=""
LIST_AZURE_PROJECTS=0
LIST_GITHUB_ORGS=0

usage() {
  cat >&2 <<'USAGE'
Usage: repo-discovery.sh <search-term> (--azure-project <project> | --github-org <org>) [options]
       repo-discovery.sh --azure-projects [options]
       repo-discovery.sh --github-orgs

Options:
  --azure-project <name>  Azure DevOps project scope and provider. Alias: --project
  --azure-projects        List Azure DevOps projects.
  --github-org <name>     GitHub organization scope. Searches GitHub instead of Azure DevOps.
  --github-orgs           List accessible GitHub organizations.
  -h, --help              Show this help.

Examples:
  repo-discovery.sh --azure-projects
  repo-discovery.sh --github-orgs
  repo-discovery.sh underwriting --azure-project Carvana.Transaction
  repo-discovery.sh underwriting --github-org CVNA-Verifications
USAGE
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --azure-projects)
      LIST_AZURE_PROJECTS=1
      shift
      ;;
    --github-orgs)
      LIST_GITHUB_ORGS=1
      shift
      ;;
    --azure-project|--project)
      AZURE_PROJECT="${2:-}"
      shift 2
      ;;
    --github-org)
      GITHUB_ORG="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "ERROR: Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ "$LIST_AZURE_PROJECTS" -eq 1 || "$LIST_GITHUB_ORGS" -eq 1 ]]; then
  if [[ "$LIST_AZURE_PROJECTS" -eq 1 && "$LIST_GITHUB_ORGS" -eq 1 ]]; then
    echo "ERROR: Use either --azure-projects or --github-orgs, not both." >&2
    usage
    exit 1
  fi

  if [[ "${#POSITIONAL[@]}" -ne 0 || -n "$AZURE_PROJECT" || -n "$GITHUB_ORG" ]]; then
    echo "ERROR: project/org listing cannot be combined with a search term, --azure-project, or --github-org." >&2
    usage
    exit 1
  fi
elif [[ "${#POSITIONAL[@]}" -ne 1 ]]; then
  echo "ERROR: Provide exactly one search term." >&2
  usage
  exit 1
fi

if [[ -n "$AZURE_PROJECT" && -n "$GITHUB_ORG" ]]; then
  echo "ERROR: Use either --azure-project or --github-org, not both." >&2
  usage
  exit 1
fi

if [[ "$LIST_AZURE_PROJECTS" -eq 0 && "$LIST_GITHUB_ORGS" -eq 0 && -z "$AZURE_PROJECT" && -z "$GITHUB_ORG" ]]; then
  echo "ERROR: Choose a provider with --azure-project <project> or --github-org <org>." >&2
  usage
  exit 1
fi

SEARCH_TERM="${POSITIONAL[0]:-}"

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is not installed." >&2
    exit 1
  fi
}

search_azure() {
  require_jq

  if ! command -v az >/dev/null 2>&1; then
    echo "ERROR: Azure CLI ('az') is not installed." >&2
    exit 1
  fi

  if ! az extension show --name azure-devops >/dev/null 2>&1; then
    echo "ERROR: Azure DevOps CLI extension is not installed. Run: az extension add --name azure-devops" >&2
    exit 1
  fi

  local results="[]"
  while IFS= read -r repo; do
    if [[ "${repo,,}" == *"${SEARCH_TERM,,}"* ]]; then
      local clone_url result
      clone_url="$AZURE_ORG_URL/$AZURE_PROJECT/_git/$repo"
      result=$(jq -n \
        --arg provider "azure" \
        --arg scope "$AZURE_PROJECT" \
        --arg repo "$repo" \
        --arg cloneUrl "$clone_url" \
        '{provider: $provider, scope: $scope, repo: $repo, cloneUrl: $cloneUrl}')
      results=$(jq -s '.[0] + [.[1]]' <(printf '%s\n' "$results") <(printf '%s\n' "$result"))
    fi
  done < <(az repos list --organization "$AZURE_ORG_URL" --project "$AZURE_PROJECT" --query '[].name' -o tsv 2>/dev/null)

  printf '%s\n' "$results"
}

list_azure_projects() {
  if ! command -v az >/dev/null 2>&1; then
    echo "ERROR: Azure CLI ('az') is not installed." >&2
    exit 1
  fi

  az devops project list --organization "$AZURE_ORG_URL" --query 'value[].name' -o tsv
}

list_github_orgs() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI ('gh') is not installed." >&2
    exit 1
  fi

  if ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI is not authenticated. Run: gh auth login" >&2
    exit 1
  fi

  gh api user/orgs --jq '.[].login'
}

search_github() {
  if [[ -z "$GITHUB_ORG" ]]; then
    echo "ERROR: GitHub search requires --github-org." >&2
    exit 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI ('gh') is not installed." >&2
    exit 1
  fi

  if ! gh auth status >/dev/null 2>&1; then
    echo "ERROR: GitHub CLI is not authenticated. Run: gh auth login" >&2
    exit 1
  fi

  require_jq

  gh repo list "$GITHUB_ORG" --limit 1000 --json name,nameWithOwner \
    | jq --arg term "$SEARCH_TERM" '
      [.[]
        | select((.name | ascii_downcase | contains($term | ascii_downcase)) or (.nameWithOwner | ascii_downcase | contains($term | ascii_downcase)))
        | {
            provider: "github",
            scope: (.nameWithOwner | split("/")[0]),
            repo: .nameWithOwner,
            cloneUrl: ("git@github.com:" + .nameWithOwner + ".git")
          }]
    '
}

if [[ "$LIST_AZURE_PROJECTS" -eq 1 ]]; then
  list_azure_projects
elif [[ "$LIST_GITHUB_ORGS" -eq 1 ]]; then
  list_github_orgs
elif [[ -n "$AZURE_PROJECT" ]]; then
  search_azure
else
  search_github
fi
