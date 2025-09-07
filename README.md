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

- ➕ **Task creation** with `mrtask add`
- 📂 **Multiple directories** supported (symlinked task files)
- 🔄 **Task lifecycle commands**: `done`, `cancel`, `remove`
- 🛡️ **Safety guards** (main branch enforcement, single worktree per branch)
- 📋 **Listing and querying** with `mrtask list`

---

## 📦 Installation

`mrtask` will be distributed via npm once released.

### Using npm
    npm install -g mrtask

### Using pnpm
    pnpm add -g mrtask

### Using yarn
    yarn global add mrtask

After installation, the `mrtask` command will be available in your shell:

    mrtask --help

### Requirements
- 🐙 Git ≥ 2.20 (for `git worktree` support)  
- 🟢 Node.js ≥ 18  
- 📦 A mono-repo managed with `pnpm`, `yarn`, or `npm` workspaces is recommended

---

## 🖥️ Usage

### `mrtask add` ➕

Create a new task, a corresponding git worktree, and a `.mrtask/<task-id>.yml` metadata file.

    mrtask add <branch-name> <task-name-segment> \
      -d "Task description" <dir1> [dir2...]

**Options**
- 📝 `-d <text>` — task description (inline).  
- 📄 `-f <file.yml>` — use an existing YAML file as the task definition.  
- 📊 `-t <file.csv:line>` — create task from CSV line.  
- 🌲 `--sparse` — enable sparse-checkout for the listed directories.  

**Example**
    mrtask add feature/login-ui login-ui \
      -d "Implement login form with validation" packages/app

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

## 🗺️ Roadmap

- [ ] 🧑‍💻 Interactive task creation wizard  
- [ ] 🔀 `mrtask pr` for pull request scaffolding  
- [ ] 🤖 CI/CD integration hooks  
- [ ] 🏷️ Richer YAML schema (tags, assignees, checklist)

---

## 📜 License

MIT
