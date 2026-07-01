---
name: workspace
description: Use when a task spans multiple git repositories or local folders. The workspace CLI groups git worktrees and symlinks into a named workspace folder so the whole change can be opened as one multi-folder project.
---

# workspace CLI

Use `workspace` to manage named multi-repo workspace folders.

## Naming

Prefer Title Case workspace names when creating or suggesting workspace names, such as `Customer Portal Refresh` instead of `customer-portal-refresh`.

## Core Commands

- `workspace create <name> [folder-path]`: creates a workspace folder and optionally adds one child folder.
- `workspace add <folder-path>`: adds one git repo as a worktree or one non-git folder as a symlink to the current or targeted workspace.
- `workspace rm <folder-name...>`: safely removes folders. Use `--force` only when dirty/unpushed work can be discarded from worktree folders.
- `workspace delete [name]`: deletes an empty workspace; `--force` removes all worktrees and files.
- `workspace rename <new-name>`: updates `.workspace` and current branch descriptions in git repo folders without renaming the directory or branches.
- `workspace list`: lists workspace names and paths under the configured workspaces directory. Use `--verbose` to include folders.
- `workspace info [name]`: shows one workspace.

## Targeting

Most commands infer the workspace by walking up from the current directory to a `.workspace` file. Use `--workspace <name|slug|path>` to override. Path values must point to a directory containing `.workspace`. Name values can match the workspace directory slug or the display name stored in `.workspace`.

## Safety

Removal does not delete branches. Without `--force`, `rm` requires no tracked changes, no untracked files, and no unique commits unreachable from any other local or remote-tracking ref.

## Setup Script

After `create` or `add`, the CLI initializes submodules when `.gitmodules` exists, then runs the configured setup script. `--no-setup` skips both. `--background-setup` runs both in a detached background process and prints the temp log file path. The script receives `<source-path> <worktree-path>` and runs with cwd set to the worktree. Run `workspace add` once per additional folder.
