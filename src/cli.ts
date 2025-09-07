#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import { Command } from "commander";
import fg from "fast-glob";
import {
  MR_DIRNAME, ensureDir, pathExists, nowId, slugify, writeYamlAtomic, readYaml,
  git, gitRoot, ensureOnMainOrForce, branchExists, createBranchFromMain,
  worktreeAdd, worktreeRemove, sparseInit, sparseSet, unlinkIfSymlink, isBrokenSymlink
} from "./utils.js";
import { findRepoRoot, loadPNPMWorkspaces, loadFallbackWorkspaces } from "./workspaces.js";
import { listTaskFilesUnder, loadTaskFromFile, findTaskById } from "./tasks.js";
import type { Task, TaskStatus } from "./types.js";

const program = new Command();
program.name("mrtask").description("Mono-repo task manager on top of git worktree");

program
  .command("add")
  .description("Create task YAML and git worktree")
  .argument("<branch>", "branch name to use")
  .argument("<task-name-segment>", "short slug for task title")
  .option("-d, --description <text>", "task description")
  .option("-f, --file <yamlFile>", "use existing YAML as definition")
  .option("-t, --from-csv <csv:line>", "create from CSV (file.csv:12)")
  .option("--sparse", "enable sparse-checkout for provided dirs")
  .option("--force", "allow running off main branch")
  .argument("<dir1>", "primary work dir (package dir)")
  .argument("[dirN...]", "secondary work dirs")
  .action(async (branch: string, taskSeg: string, dir1: string, dirN: string[] = [], opts: any) => {
    try {
      ensureOnMainOrForce(!!opts.force);
      const root = await findRepoRoot();
      const primary = path.resolve(root, dir1);
      const dirs = [primary, ...dirN.map(d => path.resolve(root, d))];

      if (!branchExists(branch)) {
        createBranchFromMain(branch, "main");
      }

      // git worktree add on primary
      worktreeAdd(primary, branch);
      const mrDir = path.join(primary, MR_DIRNAME);
      await ensureDir(mrDir);

      // Task ID & YAML
      const title = taskSeg.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
      const id = nowId(branch, slugify(taskSeg));
      const fileName = `${id}.yml`;
      const filePath = path.join(mrDir, fileName);

      let description = opts.description as string | undefined;
      if (opts.file) {
        const y = await readYaml<any>(path.resolve(opts.file));
        description = y?.description ?? description;
      } else if (opts.fromCsv) {
        const [csvPath, lineStr] = String(opts.fromCsv).split(":");
        const lineNo = Number(lineStr);
        const raw = await fs.readFile(path.resolve(csvPath), "utf8");
        const rows = raw.split(/\r?\n/);
        const row = rows[lineNo - 1] ?? "";
        // 超ざっくり: 1列目=title, 2列目=description
        const [titleCsv, descCsv] = row.split(",");
        if (!description && descCsv) description = descCsv.trim();
      }

      const task: Task = {
        id,
        createdAt: new Date().toISOString(),
        branch,
        title,
        description,
        status: "open",
        primaryDir: path.relative(root, primary),
        workDirs: dirs.map(d => path.relative(root, d)),
        tags: [],
        checklist: [],
        relatedPRs: [],
        assignees: [],
      };

      await writeYamlAtomic(filePath, task);

      // symlinks on secondary dirs
      for (const d of dirs.slice(1)) {
        const linkDir = path.join(d, MR_DIRNAME);
        await ensureDir(linkDir);
        const rel = path.relative(linkDir, filePath);
        try { await fs.symlink(rel, path.join(linkDir, fileName)); }
        catch (e) {
          // Windows等で失敗したら薄いYAMLを置く（参照先のみ）。
          const shim = { $ref: path.relative(d, filePath) };
          await writeYamlAtomic(path.join(linkDir, fileName), shim);
        }
      }

      // sparse-checkout
      if (opts.sparse) {
        sparseInit(primary);
        const rels = dirs.map(d => path.relative(primary, d)).map(p => p.replace(/^(\.\/)?/, ""));
        // ルートから見たパスの方が安全だが、シンプルに
        sparseSet(primary, rels);
      }

      console.log(`✔ Created task ${id}`);
      console.log(`  YAML: ${path.relative(root, filePath)}`);
      console.log(`  Worktree: ${path.relative(root, primary)} on branch ${branch}`);
    } catch (e: any) {
      console.error(`✖ add failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("list")
  .description("List tasks across workspaces (.mrtask)")
  .option("--all", "show all statuses")
  .option("--status <status>", "open|done|cancelled")
  .option("--json", "print JSON")
  .option("--short", "compact format")
  .action(async (opts) => {
    try {
      const root = await findRepoRoot();
      let pkgs = await loadPNPMWorkspaces(root);
      if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);

      const found: string[] = (await Promise.all(pkgs.map(d => listTaskFilesUnder(d)))).flat();
      const seen = new Map<string, Task & { filePath: string }>();
      for (const f of found) {
        const t = await loadTaskFromFile(f);
        const key = t.filePath;
        if (!seen.has(key)) seen.set(key, t);
      }

      let list = Array.from(seen.values());
      if (!opts.all && !opts.status) list = list.filter(t => (t.status ?? "open") === "open");
      if (opts.status) list = list.filter(t => t.status === opts.status);

      list.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
      } else {
        for (const t of list) {
          const wd = t.workDirs?.length ? ` (${t.workDirs.length} dirs)` : "";
          if (opts.short) {
            console.log(`${t.status?.padEnd(9)} ${t.id} ${t.title}${wd}`);
          } else {
            console.log(`${t.status?.padEnd(9)} ${t.id}  ${t.title}${wd}`);
            console.log(`  ${path.relative(root, t.filePath)}`);
          }
        }
      }
    } catch (e: any) {
      console.error(`✖ list failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("show")
  .description("Show a task by id")
  .argument("<id>", "task id (prefix ok)")
  .action(async (id) => {
    try {
      const root = await findRepoRoot();
      let pkgs = await loadPNPMWorkspaces(root);
      if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
      const t = await findTaskById(pkgs, id);
      if (!t) throw new Error(`Task not found: ${id}`);
      console.log(JSON.stringify(t, null, 2));
    } catch (e: any) {
      console.error(`✖ show failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

async function moveTaskAndRemoveWorktree(id: string, target: "done" | "cancel") {
  const root = await findRepoRoot();
  let pkgs = await loadPNPMWorkspaces(root);
  if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
  const t = await findTaskById(pkgs, id);
  if (!t) throw new Error(`Task not found: ${id}`);
  const taskDir = path.dirname(t.filePath);
  const isPrimary = taskDir.endsWith(`/${MR_DIRNAME}`) || taskDir.endsWith(`\\${MR_DIRNAME}`);
  const primaryDir = isPrimary ? path.dirname(taskDir) : path.resolve(root, t.primaryDir);
  const targetDir = path.join(primaryDir, MR_DIRNAME, target);
  await ensureDir(targetDir);
  const targetPath = path.join(targetDir, path.basename(t.filePath));
  await fs.rename(t.filePath, targetPath);
  // ブランチの worktree を primaryDir から削除
  worktreeRemove(primaryDir);
  console.log(`✔ Moved to ${target}: ${path.relative(root, targetPath)}`);
}

program
  .command("done")
  .description("Mark task done (moves YAML to .mrtask/done/ and removes worktree)")
  .argument("<id>", "task id (prefix ok)")
  .action(async (id) => {
    try {
      await moveTaskAndRemoveWorktree(id, "done");
    } catch (e: any) {
      console.error(`✖ done failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("cancel")
  .description("Cancel task (moves YAML to .mrtask/cancel/ and removes worktree)")
  .argument("<id>", "task id (prefix ok)")
  .action(async (id) => {
    try {
      await moveTaskAndRemoveWorktree(id, "cancel");
    } catch (e: any) {
      console.error(`✖ cancel failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("remove")
  .description("Remove task YAML and worktree (no record kept)")
  .argument("<id>", "task id (prefix ok)")
  .action(async (id) => {
    try {
      const root = await findRepoRoot();
      let pkgs = await loadPNPMWorkspaces(root);
      if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
      const t = await findTaskById(pkgs, id);
      if (!t) throw new Error(`Task not found: ${id}`);
      // delete YAML (primary), unlink secondary shims/links
      await fs.rm(t.filePath, { force: true });
      // remove worktree
      const primaryDir = path.resolve(root, t.primaryDir);
      worktreeRemove(primaryDir);
      console.log(`✔ removed: ${id}`);
    } catch (e: any) {
      console.error(`✖ remove failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Check symlinks and orphaned files")
  .action(async () => {
    try {
      const root = await findRepoRoot();
      let pkgs = await loadPNPMWorkspaces(root);
      if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
      const problems: string[] = [];
      for (const d of pkgs) {
        const files = await listTaskFilesUnder(d);
        for (const f of files) {
          if (await isBrokenSymlink(f)) {
            problems.push(`broken symlink: ${path.relative(root, f)}`);
          } else {
            // try parse YAML
            try { await loadTaskFromFile(f); } catch (e: any) {
              problems.push(`invalid YAML: ${path.relative(root, f)} (${e.message ?? e})`);
            }
          }
        }
      }
      if (problems.length === 0) {
        console.log("✔ no problems found");
      } else {
        console.log("✖ issues found:");
        for (const p of problems) console.log(`  - ${p}`);
        process.exitCode = 2;
      }
    } catch (e: any) {
      console.error(`✖ doctor failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
