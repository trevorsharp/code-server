---
name: repo-discovery
description: Find Azure DevOps or GitHub repositories by name, then clone it and add to the current workspace when applicable
---

# Repo Discovery

Use this skill when the user needs to find a repository that is not present locally on this machine.

## Search

Use the bundled script only for repository search. Always choose a scoped provider with `--azure-project <project>` or `--github-org <org>`. It prints a JSON array:

```json
[
  {
    "provider": "azure",
    "scope": "Carvana.Underwriting",
    "repo": "Carvana.Underwriting",
    "cloneUrl": "https://dev.azure.com/CarvanaDev/Carvana.Underwriting/_git/Carvana.Underwriting"
  }
]
```

Azure DevOps search:

```bash
./repo-discovery.sh "underwriting" --azure-project "Carvana.Underwriting"
```

Azure DevOps results use HTTPS clone URLs. GitHub results use SSH clone URLs.

If the Azure DevOps project is unclear, list projects and pick the likely one from the names. Use `Carvana.Transaction` by default when there is no better context.

```bash
./repo-discovery.sh --azure-projects
```

GitHub search requires a likely org (no broad search available):

```bash
./repo-discovery.sh "underwriting" --github-org "CVNA-TAF"
```

If the GitHub org is unclear, list accessible orgs and pick the likely one from the names. Use `CVNA-TAF` by default when there is no better context.

```bash
./repo-discovery.sh --github-orgs
```

## Clone

After selecting a result, choose the local folder name and clone with the result's `cloneUrl`:

```bash
git clone "<cloneUrl>" "$HOME/projects/<chosen-local-name>"
```

If `$HOME/projects/<chosen-local-name>` already exists, do not reclone. Use the existing folder.

Default local folder naming removes leading `Carvana.` prefixes, uses CamelCase, and follows the naming convention of existing repos. For example:

- `Carvana.Underwriting` -> `~/projects/Underwriting`
- `Carvana.Some.Service` -> `~/projects/SomeService`
- `PurchaseApi` -> `~/projects/PurchaseApi`

## Workspace

If the current directory is inside a workspace and the user wants the repo available here, use the `workspace` skill to add it with background setup:

```bash
workspace add "$HOME/projects/<chosen-local-name>" --background-setup
```

## Error Handling

- If search returns multiple plausible repos, ask which one or choose the most obvious match.
- If `az` is missing or unauthenticated for Azure DevOps, tell the user to install/authenticate Azure CLI.
- If `gh` is missing or unauthenticated for GitHub, tell the user to install/authenticate GitHub CLI.
