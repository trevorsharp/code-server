---
name: repo-discovery
description: Find Azure DevOps or GitHub repositories by name to inspect code locally. Should only be used after looking in the current workspace or ~/projects for the repo first.
---

# Repo Discovery

Search for Azure DevOps or GitHub repositories by name and clone locally for inspecting code.

## Search for repo

- Use only the bundled script [repo-discovery.sh](repo-discovery.sh) to search for repos. 
- Searches require an Azure DevOps project or GitHub org `--azure-project <project>` or `--github-org <org>`.

If the Azure DevOps project is unclear, list projects and pick the one(s) most likely from the list of names. Use `Carvana.Transaction` by default if there is no better context.

```bash
repo-discovery.sh --azure-projects
```

If the GitHub org is unclear, list accessible orgs and pick the one(s) most likely from the list of names. Use `CVNA-TAF` by default if there is no better context.

```bash
repo-discovery.sh --github-orgs
```

After identifying the project or org, search for repos by name.

```bash
repo-discovery.sh <search-term> --azure-project <project>
```

```bash
repo-discovery.sh <search-term> --github-org <org>
```

## Clone repo

Azure DevOps repos are cloned using the `https` URL, while GitHub repos are cloned using the `ssh` URL.

```bash
git clone "<cloneUrl>" "~/projects/RepoDiscovery/<chosen-local-name>"
```

If `~/projects/RepoDiscovery/<chosen-local-name>` already exists, do not reclone. Use the existing folder.

Local folder naming rules:
- Strip any leading `Carvana.` prefix.
- Convert to PascalCase by removing `.`, `-`, `_`, and space separators and capitalizing each segment while preserving existing acronym casing.

Examples:

- `Carvana.Purchase.API` -> `~/projects/RepoDiscovery/PurchaseAPI`
- `purchaseApi` -> `~/projects/RepoDiscovery/PurchaseApi`
- `carvana.payments.testing` -> `~/projects/RepoDiscovery/PaymentsTesting`