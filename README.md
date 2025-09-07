# mrtask

`mrtask` (Mono-Repo Task Manager) is a command-line tool that helps developers manage **task-specific worktrees** in mono-repositories.  
It integrates with `git worktree` to create isolated working directories for feature branches, and stores structured task metadata in `.mrtask/` files.

---

## Motivation

When working in a mono-repo with multiple packages, it’s common to:
- Work on multiple tasks in parallel.
- Keep tasks isolated to avoid mixing unrelated changes.
- Track the purpose and scope of each task.

`mrtask` provides a **lightweight task lifecycle** on top of `git worktree`,  
with YAML metadata that makes tasks searchable, sharable, and automatable.

---

## Features

- **Task creation** with `mrtask add`  
  - Creates a new git worktree for the given branch.  
  - Generates a YAML file in `.mrtask/` with metadata (description, directories, branch, etc.).  
  - Supports creating tasks from inline description, external YAML, or CSV rows.

- **Multiple directories**  
  - Primary directory contains the YAML file.  
  - Secondary directories get symbolic links to the same YAML, so tasks can cover multiple packages.

- **Task lifecycle commands**  
  - `mrtask done`: mark task as finished (move YAML into `.mrtask/done/`).  
  - `mrtask cancel`: cancel task (move YAML into `.mrtask/cancel/`).  
  - `mrtask remove`: delete task and remove the worktree.

- **Safety guards**  
  - Prevents running on non-main branches (unless forced).  
  - Ensures only one worktree per branch.  

- **Listing and querying**  
  - `mrtask list` scans packages (from `pnpm-workspace.yaml` or fallback heuristics).  
  - Lists all tasks, with filters (`--status open|done|cancelled`, `--all`, `--json`).

---

## Example Workflow

```bash
# Create a new task on branch `feature/login-ui`
mrtask add feature/login-ui "Implement login page" \
  -d "Create new login form with validation" packages/app --sparse

# Show all open tasks
mrtask list

# Mark the task as done
mrtask done 2025-09-08T14-03-12Z-feature-login-ui
```

## A task YAML looks like this:
```yaml
id: 2025-09-08T14-03-12Z-feature-login-ui
createdAt: 2025-09-08T14:03:12Z
branch: feature/login-ui
title: Implement login page
description: Create new login form with validation
status: open
primaryDir: packages/app
workDirs:
  - packages/app
tags: [ui, auth]
checklist: []
relatedPRs: []
assignees: []
```

## Installation

### ⚠️ mrtask is currently experimental.

Build from source
```bash
git clone https://github.com/yourname/mrtask.git
cd mrtask
pnpm install
pnpm build
pnpm link --global
```

## Requirements

* Git ≥ 2.20 (for worktree support)
* Node.js ≥ 18
* pnpm ≥ 8 (recommended for mono-repo scanning)

## Roadmap

* Interactive task creation wizard.
* Integration with git sparse-checkout.
* mrtask doctor for broken symlinks and orphaned tasks.
* mrtask pr to scaffold pull request templates.
* CI/CD hooks for automated task validation.

## Why .mrtask/?

Each package (or the repo root) has its own .mrtask/ directory.
This isolates task metadata from source code while making it easy to search and script around.

## Contributing

Contributions are welcome!
Please open issues for bugs or feature requests, and feel free to send pull requests.

## License

MIT
