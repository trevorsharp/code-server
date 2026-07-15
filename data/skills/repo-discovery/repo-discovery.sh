#!/usr/bin/env bash
set -euo pipefail

AZURE_ORG_URL="https://dev.azure.com/CarvanaDev"
AZURE_PROJECT=""
GITHUB_ORG=""
LIST_AZURE_PROJECTS=0
LIST_GITHUB_ORGS=0

usage() {
  cat >&2 <<'USAGE'
Usage: repo-discovery.sh <search-term> (--azure-project <project> | --github-org <org>)
       repo-discovery.sh --azure-projects
       repo-discovery.sh --github-orgs

Options:
  --azure-project <name>  Azure DevOps project scope and provider.
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
    --azure-project)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: --azure-project requires a non-empty value." >&2
        usage
        exit 1
      fi
      AZURE_PROJECT="$2"
      shift 2
      ;;
    --github-org)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: --github-org requires a non-empty value." >&2
        usage
        exit 1
      fi
      GITHUB_ORG="$2"
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

if [[ "${#POSITIONAL[@]}" -gt 1 ]]; then
  echo "ERROR: Provide at most one search term." >&2
  usage
  exit 1
fi

MODE_COUNT=$((LIST_AZURE_PROJECTS + LIST_GITHUB_ORGS))
[[ -n "$AZURE_PROJECT" ]] && MODE_COUNT=$((MODE_COUNT + 1))
[[ -n "$GITHUB_ORG" ]] && MODE_COUNT=$((MODE_COUNT + 1))

if [[ "$MODE_COUNT" -ne 1 ]]; then
  echo "ERROR: Choose exactly one mode: --azure-project, --github-org, --azure-projects, or --github-orgs." >&2
  usage
  exit 1
fi

SEARCH_TERM="${POSITIONAL[0]:-}"

if [[ "$LIST_AZURE_PROJECTS" -eq 1 || "$LIST_GITHUB_ORGS" -eq 1 ]]; then
  if [[ "${#POSITIONAL[@]}" -ne 0 ]]; then
    echo "ERROR: Project and organization listing modes do not accept a search term." >&2
    usage
    exit 1
  fi
elif [[ "${#POSITIONAL[@]}" -ne 1 || -z "$SEARCH_TERM" ]]; then
  echo "ERROR: Search modes require one non-empty search term." >&2
  usage
  exit 1
fi

search_azure() {
  az repos list --organization "$AZURE_ORG_URL" --project "$AZURE_PROJECT" --query '[].[name,remoteUrl]' -o tsv \
    | awk -F'\t' -v t="${SEARCH_TERM,,}" 'index(tolower($1),t)'
}

list_azure_projects() {
  az devops project list --organization "$AZURE_ORG_URL" --query 'value[].name' -o tsv
}

list_github_orgs() {
  gh api --paginate user/orgs --jq '.[].login'
}

search_github() {
  SEARCH_TERM="$SEARCH_TERM" gh repo list "$GITHUB_ORG" --limit 1000 --json name,sshUrl \
    --jq '.[] | select(.name|ascii_downcase|contains(env.SEARCH_TERM|ascii_downcase)) | [.name,.sshUrl]|@tsv'
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
