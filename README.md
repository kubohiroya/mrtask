# mrtask 🚀

`mrtask` (Mono-Repo Task Manager) is a command-line tool that helps developers manage **task-specific worktrees** in mono-repositories.  
It integrates with `git worktree` to create isolated working directories for feature branches, and stores structured task metadata in `.mrtask/` files.

---

## ✨ Motivation

When working in a mono-repo with multiple packages, it’s common to:
- 🛠️ Work on multiple tasks in parallel.
- 🧹 Keep tasks isolated to avoid mixing unrelated changes.
- 📝 Track the purpose and scope of each task.

`mrtask` provides a **lightweight task lifecycle** on top of `git worktree`,  
with YAML metadata that makes tasks searchable, sharable, and automatable.

---

## 🔑 Features

- ➕ `mrtask add` — create a task YAML and a git worktree
- 📋 `mrtask list/show` — query tasks across workspaces
- ✅ `mrtask done/cancel/remove` — move or delete task records, remove worktrees
- 🩺 `mrtask doctor` — basic integrity checks
- 🔀 `mrtask pr` — **Stage-2**: build a PR draft from Task + Git diff, optionally `--push` the branch and open compare/PR (GitHub gh optional)


---

## 📦 Installation

Install from npm:

    npm install -g mrtask
    # or
    pnpm add -g mrtask
    # or
    yarn global add mrtask

After installation, the `mrtask` command will be available in your shell:

    mrtask --help
    mrtask --version

### Requirements
- 🐙 Git ≥ 2.20 (for `git worktree` support)  
- 🟢 Node.js ≥ 18  
- 📦 A mono-repo managed with `pnpm`, `yarn`, or `npm` workspaces is recommended

---

## 🖥️ Usage

### `mrtask add` ➕

Create a new task, a corresponding git worktree, and a `.mrtask/<task-id>.yml` metadata file.
On success (including `--dry-run`), the YAML content of the task is printed to stdout. Use `--silent` to suppress it.

    mrtask add <branch-name> <task-name-segment> \
      -d "Task description" <dir1> [dir2...]

**Options**
- 📝 `-d <text>` — task description (inline).  
- 📄 `-f <file.yml>` — use an existing YAML file as the task definition.  
- 📊 `-t <file.csv:line>` — create task from CSV line.  
  - Recognized CSV headers: `title`, `description`, `branch`, `dir`/`primaryDir`/`dir1`, `dirs`, `slug`（不足は対話で補完）。  
  - With `-t`, positional args are optional; values can come from CSV and prompts.  
- 🌲 `--sparse` — enable sparse-checkout for the listed directories.  
- 🧪 `--dry-run` — preview only; does not create branch/worktree or write files, but prints the YAML that would be written.  
- 🤫 `--silent` — suppress output on success (errors still printed).  

**Examples**
    mrtask add feature/login-ui login-ui \
      -d "Implement login form with validation" packages/app
    # CSV-only (no positional args)
    mrtask add -t TASKS.csv:2
    # Preview only
    mrtask add feature/login-ui login-ui --dry-run packages/app

---

### `mrtask list` 📋

List tasks across the repository.  
Looks for `.mrtask/` directories in packages defined in `pnpm-workspace.yaml` or workspaces in `package.json`.

    mrtask list [options]

**Options**
- `--all` — show all tasks (open + done + cancelled).  
- `--status <open|done|cancelled>` — filter by status.  
- `--json` — output in JSON format.  
- `--short` — compact one-line format.  

---

### `mrtask show` 🔍

Display details of a single task.

    mrtask show <task-id>

**Example**
    mrtask show 2025-09-08T14-03-12Z-feature-login-ui

---

### `mrtask done` ✅

Mark a task as completed.  
Moves the YAML file to `.mrtask/done/` and removes the git worktree.

    mrtask done <task-id>

---

### `mrtask cancel` ❌

Cancel a task without merging.  
Moves the YAML file to `.mrtask/cancel/` and removes the git worktree.

    mrtask cancel <task-id>

---

### `mrtask remove` 🗑️

Remove a task entirely (no record kept).  
Deletes the YAML file and removes the git worktree.

    mrtask remove <task-id>

---

### `mrtask doctor` 🩺

Check the repository for inconsistencies:
- 🏚️ Orphaned worktrees without task files.
- 🔗 Broken symlinks in `.mrtask/`.
- ⚠️ Invalid YAML.

    mrtask doctor

---

### `mrtask config` ⚙️

Show or edit configuration (e.g. CSV column mapping, default branch).

    mrtask config [options]

---

## 🔄 Example Workflow

    # ➕ Create a new task
    mrtask add feature/login-ui login-ui \
      -d "Implement login form with validation" packages/app --sparse

    # 📋 List open tasks
    mrtask list

    # 🔍 Inspect a task
    mrtask show 2025-09-08T14-03-12Z-feature-login-ui

    # ✅ Complete the task
    mrtask done 2025-09-08T14-03-12Z-feature-login-ui

---
### `mrtask pr` 🔀
Generate a pull request from an existing task (`.mrtask/<id>.yml`) and current git diff.

    mrtask pr <task-id> [task-file-path] [--base main] [--remote origin] [--push] [--draft] [--open] [--dry-run]

**Arguments**
- `<task-id>` — task id (prefix ok)
- `[task-file-path]` — direct path to task YAML file (optional alternative to searching by ID)

**Options**
- `--dry-run` (default): Print PR **draft** (Title/Body) and a **compare URL** if available.
  - Saves the draft to `.mrtask/out/<id>.pr.md`
  - With `--open`, opens the compare URL in a browser.
- `--push`: Push the branch to `<remote>` and set upstream (safe to use with `--dry-run`).
- If GitHub CLI `gh` is available and `--dry-run` is **not** set:
  - Creates a PR (use `--draft` for draft PRs). Otherwise, prints the compare URL.

**Examples**
    # Using task ID (existing approach)
    mrtask pr 2025-09-08T14-03-12Z-feature_login-ui --base main --push --dry-run
    
    # Using direct file path (new approach)
    mrtask pr any-id packages/app/.mrtask/2025-09-08T14-03-12Z-feature_login-ui.yml --push --dry-run

---

## 🔄 Example Flow
    mrtask add feature/login-ui login-ui -d "Implement login form" packages/app
    # (commit your changes on that branch)
    mrtask pr <task-id> --push --dry-run     # preview using task ID
    mrtask pr <task-id> packages/app/.mrtask/<task-id>.yml --push --dry-run  # preview using file path
    mrtask pr <task-id> --push --draft --open --no-dry-run   # create a Draft PR via gh and open it

---

## 🗺️ Roadmap

- [ ] 🧑‍💻 Interactive task creation wizard  
- [ ] 🔀 `mrtask pr` for pull request scaffolding  
- [ ] 🤖 CI/CD integration hooks  
- [ ] 🏷️ Richer YAML schema (tags, assignees, checklist)

---

## 📜 License

MIT — see `LICENSE` for full text.
MIT
