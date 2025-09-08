#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  MR_DIRNAME, ensureDir, nowId, slugify, writeYamlAtomic, readYaml,
  ensureOnMainOrForce, branchExists, createBranchFromMain,
  worktreeAdd, worktreeRemove, sparseInit, sparseSet, isBrokenSymlink
} from "./utils.js";
import { findRepoRoot, loadPNPMWorkspaces, loadFallbackWorkspaces } from "./workspaces.js";
import { listTaskFilesUnder, loadTaskFromFile, findTaskById } from "./tasks.js";
import type { Task } from "./types.js";
// ★ 追加
import { buildPRSpec } from "./builder.js";
import { buildCompareUrl, createPRWithGh, ensurePushed, getRemoteUrl, openInBrowser, planPR } from "./providers.js";

// Resolve package version without JSON import attributes (Node 18 compatible)
let pkgVersion = "0.0.0";
try {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const raw = fss.readFileSync(pkgPath, "utf8");
  pkgVersion = JSON.parse(raw)?.version ?? pkgVersion;
} catch {}

const program = new Command();
program
  .name("mrtask")
  .description("Mono-repo task manager on top of git worktree")
  .version(String(pkgVersion));

program
  .command("pr")
  .description("Generate a pull request from mrtask YAML and git diff")
  .argument("<id>", "task id (prefix ok)")
  .argument("[task-file-path]", "direct path to task YAML file (optional)")
  .option("--base <branch>", "base branch (default: main)", "main")
  .option("--remote <name>", "git remote (default: origin)", "origin")
  .option("--push", "push branch to remote if not yet upstream")
  .option("--draft", "create Draft PR when using GitHub gh CLI")
  .option("--open", "open compare/PR URL in browser")
  .option("--dry-run", "do not create PR via provider; print PR draft and compare URL", true)
  .action(async (id, taskFilePath, opts) => {
    try {
      const root = await findRepoRoot();
      let t;

      if (taskFilePath) {
        // Load task directly from specified file path
        const resolvedPath = path.resolve(root, taskFilePath);
        t = await loadTaskFromFile(resolvedPath);
      } else {
        // Use existing ID-based search
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        // ルートも探索
        pkgs = [root, ...pkgs];

        t = await findTaskById(pkgs, id);
        if (!t) throw new Error(`Task not found: ${id}`);
      }

      // PR 下書きを構築
      const spec = buildPRSpec(t, opts.base, root);

      // リモート情報と compare URL
      const remoteUrl = getRemoteUrl(opts.remote, root);
      const compareUrl = buildCompareUrl(remoteUrl, spec.base, spec.head);

      // --push が指定なら upstream 設定まで行う
      if (opts.push) {
        if (!remoteUrl) throw new Error(`Remote not found: ${opts.remote}`);
        ensurePushed(opts.remote, t.branch, root);
      }

      // dry-run: 標準出力＆ファイル保存して終了
      if (opts.dryRun) {
        const outText = planPR(spec, compareUrl);
        console.log(outText);
        // ファイルにも書き出す
        const outDir = path.join(root, MR_DIRNAME, "out");
        await ensureDir(outDir);
        await writeYamlAtomic(path.join(outDir, `${t.id}.pr.md`), outText);
        if (opts.open && compareUrl) openInBrowser(compareUrl);
        return;
      }

      // 実PR: gh が使えれば作成、なければ compare URL を出力
      let createdUrl = compareUrl ?? null;
      try {
        createdUrl = createPRWithGh(spec, { draft: !!opts.draft, base: opts.base, cwd: root }) || compareUrl;
      } catch {
        // gh が無い/失敗 → compare URL でフォールバック
        console.log("gh CLI not available or failed; showing compare URL instead.");
      }
      console.log(`PR: ${createdUrl ?? "(no URL available)"}`);
      if (opts.open && createdUrl) openInBrowser(createdUrl);
    } catch (e: any) {
      console.error(`✖ pr failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("add")
  .description("Create task YAML and git worktree; prints YAML to stdout unless --silent. Use --dry-run to preview without changes.")
  // Allow CSV-only mode by making args optional; we will validate later.
  .argument("[branch]", "branch name to use")
  .argument("[task-name-segment]", "short slug for task title")
  .option("-d, --description <text>", "task description")
  .option("-f, --file <yamlFile>", "use existing YAML as definition")
  .option("-t, --from-csv <csv:line>", "create from CSV (file.csv:12)")
  .option("--sparse", "enable sparse-checkout for provided dirs")
  .option("--dry-run", "print YAML without modifying git or filesystem")
  .option("--silent", "suppress output on success (errors still shown)")
  .option("--force", "allow running off main branch")
  .argument("[dir1]", "primary work dir (package dir)")
  .argument("[dirN...]", "secondary work dirs")
  .action(async (branchArg: string | undefined, taskSegArg: string | undefined, dir1Arg: string | undefined, dirNArg: string[] = [], opts: any) => {
    try {
      ensureOnMainOrForce(!!opts.force);
      const root = await findRepoRoot();

      // Resolve inputs possibly coming from CSV
      let branch = branchArg;
      let taskSeg = taskSegArg;
      let dir1 = dir1Arg;
      let dirN = dirNArg;
      let description = opts.description as string | undefined;

      if (opts.file) {
        const y = await readYaml<any>(path.resolve(opts.file));
        description = y?.description ?? description;
      }

      if (opts.fromCsv) {
        // Minimal CSV parser that supports quoted fields and commas within quotes
        const parseCsvLine = (line: string): string[] => {
          const out: string[] = [];
          let cur = "";
          let inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
              else { inQ = !inQ; }
            } else if (ch === ',' && !inQ) {
              out.push(cur);
              cur = "";
            } else {
              cur += ch;
            }
          }
          out.push(cur);
          return out.map(s => s.trim().replace(/^\uFEFF/, ""));
        };
        const stripOuterQuotes = (s: string) => s.replace(/^['\"](.*)['\"]$/s, "$1");

        const [csvPath, lineStr] = String(opts.fromCsv).split(":");
        const lineNo = Number(lineStr);
        const raw = await fs.readFile(path.resolve(csvPath), "utf8");
        const rows = raw.split(/\r?\n/);
        const header = parseCsvLine(rows[0] ?? "");
        const row = parseCsvLine(rows[lineNo - 1] ?? "");
        const get = (key: string) => {
          const idx = header.findIndex(h => h.toLowerCase() === key.toLowerCase());
          return idx >= 0 ? stripOuterQuotes((row[idx] ?? "").trim()) : "";
        };
        // Prefer explicit columns; fallback to legacy [title, description]
        const csvTitle = get("title") || stripOuterQuotes((row[0]?.trim() ?? ""));
        const csvDesc = get("description") || stripOuterQuotes((row[1]?.trim() ?? ""));
        const csvBranch = get("branch");
        const csvDir = get("dir") || get("primaryDir") || get("dir1");
        const csvDirs = (get("dirs") || "").replace(/^\[(.*)\]$/, "$1").split(/[,;\s]+/).filter(Boolean).map(stripOuterQuotes);
        const csvSlug = get("slug");

        if (!description && csvDesc) description = csvDesc;
        if (!taskSeg && (csvSlug || csvTitle)) taskSeg = (csvSlug || csvTitle).toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
        if (!branch && csvBranch) branch = csvBranch;
        if (!dir1 && csvDir) dir1 = csvDir;
        if (dirN.length === 0 && csvDirs.length > 0) dirN = csvDirs;
      }

      // Interactive fallback for any still-missing required inputs when CSV mode used
      // Single readline instance for the whole interactive flow to play nicely with piped stdin in tests/CI
      let rlRef: any = null;
      const getRl = () => (rlRef ??= readline.createInterface({ input, output }));

      if (opts.fromCsv) {
        const rl = getRl();
        if (!branch) {
          branch = (await rl.question("Enter branch name: ")).trim();
        }
        if (!taskSeg) {
          taskSeg = (await rl.question("Enter task slug/title: ")).trim();
        }
        if (!dir1) {
          dir1 = (await rl.question("Enter primary work dir: ")).trim();
        }
      }

      // Validate
      if (!branch) throw new Error("missing required argument 'branch'");
      if (!taskSeg) throw new Error("missing required argument 'task-name-segment'");
      if (!dir1) throw new Error("missing required argument 'dir1'");

      const primary = path.resolve(root, dir1);
      const dirs = [primary, ...dirN.map(d => path.resolve(root, d))];

      // If branch does not exist, decide how to handle it.
      if (!branchExists(branch)) {
        // For CSV-driven adds, ask before creating the branch to avoid surprises.
        if (opts.fromCsv) {
          const rl = getRl();
          const ans = (await rl.question(`The branch "${branch}" does not exist. Create it now? (y/N) `)).trim().toLowerCase();
          if (ans === "y") {
            if (!opts.dryRun) createBranchFromMain(branch, "main");
          } else {
            console.error("Aborted. Branch not created.");
            try { await rlRef?.close?.(); } catch {}
            process.exitCode = 1;
            return;
          }
        } else {
          // Non-CSV mode keeps existing behavior (auto-create from main/base).
          if (!opts.dryRun) createBranchFromMain(branch, "main");
        }
      }

      // git worktree add on primary (skip in dry-run)
      if (!opts.dryRun) {
        worktreeAdd(primary, branch);
      }
      const mrDir = path.join(primary, MR_DIRNAME);
      if (!opts.dryRun) await ensureDir(mrDir);

      // Task ID & YAML
      const title = taskSeg.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
      const id = nowId(branch, slugify(taskSeg));
      const fileName = `${id}.yml`;
      const filePath = path.join(mrDir, fileName);


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

      if (!opts.dryRun) {
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
      }

      // sparse-checkout
      if (opts.sparse && !opts.dryRun) {
        sparseInit(primary);
        const rels = dirs.map(d => path.relative(primary, d)).map(p => p.replace(/^(\.\/)?/, ""));
        // ルートから見たパスの方が安全だが、シンプルに
        sparseSet(primary, rels);
      }

      // Output section
      if (!opts.silent) {
        console.log(`✔ Created task ${id}`);
        if (!opts.dryRun) {
          console.log(`  YAML: ${path.relative(root, filePath)}`);
          console.log(`  Worktree: ${path.relative(root, primary)} on branch ${branch}`);
        } else {
          console.log(`  (dry-run) No files written.`);
        }
        // Print YAML content (either from object or file)
        // We use the in-memory object to avoid I/O in dry-run and to keep consistent formatting
        try {
          const YAMLMod = await import("yaml");
          const yamlText = YAMLMod.default.stringify(task);
          process.stdout.write(yamlText.endsWith("\n") ? yamlText : yamlText + "\n");
        } catch {}
      }
      try { await rlRef?.close?.(); } catch {}
    } catch (e: any) {
      console.error(`✖ add failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  }).hook("postAction", async () => {
    // Ensure any lingering readline is closed (best-effort)
    try { (output as any).write(""); } catch {}
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
      pkgs = [root, ...pkgs];

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
  pkgs = [root, ...pkgs];
  const t = await findTaskById(pkgs, id);
  if (!t) throw new Error(`Task not found: ${id}`);
  const historyBase = path.join(root, MR_DIRNAME, target);
  await ensureDir(historyBase);
  const targetPath = path.join(historyBase, path.basename(t.filePath));
  await fs.rename(t.filePath, targetPath);
  const primaryDirAbs = path.resolve(root, t.primaryDir);
  worktreeRemove(primaryDirAbs);
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
