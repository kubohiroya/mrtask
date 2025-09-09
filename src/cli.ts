#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
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
import { buildCompareUrl, createPRWithGh, ensurePushed, getRemoteUrl, openInBrowser, planPR, findOpenPrNumberByHead, mergePrWithGh } from "./providers.js";
import { git, fetchAll, isMergedOrEquivalent } from "./utils.js";
import { detectProjectName, ensureHome, printInitGuide } from "./home.js";

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
  .command("init")
  .description("Initialize mrtask home directory and workTrees base")
  .argument("[path]", "custom MRTASK_HOME path")
  .action(async (p?: string) => {
    try {
      const name = detectProjectName();
      const { home, wtBase } = ensureHome(name, p);
      printInitGuide(home, wtBase);
    } catch (e: any) {
      console.error(`✖ init failed: ${e.message ?? e}`);
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
        // Prefer explicit columns; fallback to [title, description] positions only
        const csvTitle = get("title") || stripOuterQuotes((row[0]?.trim() ?? ""));
        const csvDesc = get("description") || stripOuterQuotes((row[1]?.trim() ?? ""));
        const csvBranch = get("branch");

        // Collect dirN columns deterministically (dir1 required; no deprecated aliases)
        const dirNs: string[] = [];
        for (let i = 1; i <= 20; i++) {
          const v = get(`dir${i}`);
          if (v) dirNs.push(v);
        }

        const primaryDirCsv = dirNs[0] || "";
        const secondaryFromNs = dirNs.slice(1);

        const csvSlug = get("slug");

        if (!description && csvDesc) description = csvDesc;
        if (!taskSeg && (csvSlug || csvTitle)) taskSeg = (csvSlug || csvTitle).toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
        if (!branch && csvBranch) branch = csvBranch;
        if (!dir1 && primaryDirCsv) dir1 = primaryDirCsv;
        if (dirN.length === 0 && secondaryFromNs.length > 0) dirN = secondaryFromNs;
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


      const primaryRepoPath = path.resolve(root, dir1);
      const repoDirAbsList = [primaryRepoPath, ...dirN.map(d => path.resolve(root, d))];

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

      // Decide worktree root: use package path if it does not exist; otherwise place under .mrtask/wt/<id>
      const title = (taskSeg ?? "").replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
      const id = nowId(branch, slugify(taskSeg ?? (title || "task")));
      const wtFallback = path.join(root, MR_DIRNAME, "wt", id);
      const useFallback = fss.existsSync(primaryRepoPath);
      const wtRoot = useFallback ? wtFallback : primaryRepoPath;

      // git worktree add (skip in dry-run)
      if (!opts.dryRun) {
        if (useFallback) await ensureDir(path.dirname(wtRoot));
        worktreeAdd(wtRoot, branch);
      }
      // YAML directory lives under the repository's package path (not the worktree root) for discoverability
      const mrDir = path.join(primaryRepoPath, MR_DIRNAME);
      if (!opts.dryRun) await ensureDir(mrDir);

      // Task ID & YAML
      const fileName = `${id}.yml`;
      const filePath = path.join(mrDir, fileName);


      const task: Task = {
        id,
        createdAt: new Date().toISOString(),
        branch,
        title,
        description,
        status: "open",
        primaryDir: dir1,
        workDirs: [dir1, ...dirN],
        tags: [],
        checklist: [],
        relatedPRs: [],
        assignees: [],
      };

      if (!opts.dryRun) {
        await writeYamlAtomic(filePath, task);

        // symlinks on secondary dirs
        for (const d of repoDirAbsList.slice(1)) {
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
        sparseInit(wtRoot);
        const rels = [dir1, ...dirN];
        sparseSet(wtRoot, rels);
      }

      // Output section
      if (!opts.silent) {
        console.log(`✔ Created task ${id}`);
        if (!opts.dryRun) {
          console.log(`  YAML: ${path.relative(root, filePath)}`);
          console.log(`  Worktree: ${path.relative(root, wtRoot)} on branch ${branch}`);
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
        // Filter out non-task YAMLs (e.g., pnpm-workspace.yaml that slipped through)
        const isValid = Boolean((t.id ?? "").trim()) && Boolean((t.branch ?? "").trim()) && Boolean((t.title ?? "").trim());
        if (!isValid) continue;
        if (!seen.has(key)) seen.set(key, t);
      }

      let list = Array.from(seen.values());
      if (!opts.all && !opts.status) list = list.filter(t => (t.status ?? "open") === "open");
      if (opts.status) list = list.filter(t => t.status === opts.status);

      list.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

      const shortId = (id: string) => crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
      for (const t of list) {
        const wd = t.workDirs?.length ? ` (${t.workDirs.length} dirs)` : "";
        const idPart = `[${shortId(t.id)}] `;
        const head = `${t.status?.padEnd(9)} ${idPart}${t.title}${wd} [${t.branch}]`;
        if (opts.short) console.log(head);
        else {
          console.log(head);
          console.log(`  ${path.relative(root, t.filePath)}`);
        }
      }
    } catch (e: any) {
      console.error(`✖ list failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("dump")
  .description("Dump tasks as machine-friendly JSON (for AI/automation)")
  .option("--all", "include all statuses (default: open only)")
  .option("--status <status>", "open|done|cancelled")
  .option("--ndjson", "newline-delimited JSON (1 object per line)")
  .action(async (opts) => {
    try {
      const root = await findRepoRoot();
      let pkgs = await loadPNPMWorkspaces(root);
      if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
      pkgs = [root, ...pkgs];

      const found: string[] = (await Promise.all(pkgs.map(d => listTaskFilesUnder(d)))).flat();
      const shortId = (id: string) => crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
      const rows: any[] = [];
      for (const f of found) {
        const t = await loadTaskFromFile(f);
        const isValid = Boolean((t.id ?? "").trim()) && Boolean((t.branch ?? "").trim()) && Boolean((t.title ?? "").trim());
        if (!isValid) continue;
        if (!opts.all && !opts.status && (t.status ?? "open") !== "open") continue;
        if (opts.status && (t.status ?? "open") !== opts.status) continue;
        rows.push({
          id: t.id,
          id_short: shortId(t.id),
          title: t.title,
          description: t.description ?? null,
          branch: t.branch,
          status: t.status,
          primaryDir: t.primaryDir,
          workDirs: t.workDirs,
          file: path.relative(root, (t as any).filePath ?? t.filePath),
          createdAt: t.createdAt,
          tags: t.tags ?? [],
          checklistCount: (t.checklist ?? []).length,
        });
      }
      if (opts.ndjson) {
        for (const r of rows) console.log(JSON.stringify(r));
      } else {
        console.log(JSON.stringify(rows, null, 2));
      }
    } catch (e: any) {
      console.error(`✖ dump failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("show")
  .description("Show a task by id or file path")
  .argument("<id-or-path>", "task id (prefix ok) or direct YAML path")
  .action(async (input, optsCmd) => {
    try {
      const root = await findRepoRoot();
      const asPath = path.resolve(root, input);
      let t: any;
      if (fss.existsSync(asPath)) t = await loadTaskFromFile(asPath);
      else {
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        t = await findTaskById([root, ...pkgs], input);
        if (!t) throw new Error(`Task not found: ${input}`);
      }
      console.log(JSON.stringify(t, null, 2));
    } catch (e: any) {
      console.error(`✖ show failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("pr")
  .description("Generate a pull request from mrtask YAML and git diff")
  .argument("<id-or-path>", "task id (prefix ok) or direct path to task YAML file")
  .option("--base <branch>", "base branch (default: main)", "main")
  .option("--remote <name>", "git remote (default: origin)", "origin")
  .option("--push", "push branch to remote if not yet upstream")
  .option("--draft", "create Draft PR when using GitHub gh CLI")
  .option("--open", "open compare/PR URL in browser")
  .option("--dry-run", "do not create PR via provider; print PR draft and compare URL", true)
  .action(async (input, opts) => {
    try {
      const root = await findRepoRoot();
      let t;
      const asPath = path.resolve(root, input);
      if (fss.existsSync(asPath)) {
        t = await loadTaskFromFile(asPath);
      } else {
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        pkgs = [root, ...pkgs];
        t = await findTaskById(pkgs, input);
        if (!t) throw new Error(`Task not found: ${input}`);
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

async function moveTaskAndRemoveWorktree(idOrPath: string, target: "done" | "cancel") {
  const root = await findRepoRoot();
  const asPath = path.resolve(root, idOrPath);
  let t: any;
  if (fss.existsSync(asPath)) t = await loadTaskFromFile(asPath);
  else {
    let pkgs = await loadPNPMWorkspaces(root);
    if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
    t = await findTaskById([root, ...pkgs], idOrPath);
    if (!t) throw new Error(`Task not found: ${idOrPath}`);
  }
  const historyBase = path.join(root, MR_DIRNAME, target);
  await ensureDir(historyBase);
  const targetPath = path.join(historyBase, path.basename(t.filePath));
  await fs.rename(t.filePath, targetPath);
  // Prefer removing dedicated worktree under .mrtask/wt/<id> if present; fallback to legacy behavior
  const wtRoot = path.join(root, MR_DIRNAME, "wt", t.id);
  let removedPath: string | null = null;
  if (fss.existsSync(wtRoot)) {
    worktreeRemove(wtRoot);
    removedPath = wtRoot;
  } else {
    const primaryDirAbs = path.resolve(root, t.primaryDir);
    try {
      worktreeRemove(primaryDirAbs);
      removedPath = primaryDirAbs;
    } catch {
      removedPath = null;
    }
  }
  console.log(`✔ Moved to ${target}: ${path.relative(root, targetPath)}`);
  console.log(`  Worktree removed: ${removedPath ? path.relative(root, removedPath) : "(none)"}`);
  console.log(`  Branch kept: ${t.branch}`);
}

program
  .command("done")
  .description("Mark task done: verify merged state, then move YAML to .mrtask/done/ and remove worktree")
  .argument("<id-or-path>", "task id (prefix ok) or direct YAML path")
  .option("--base <branch>", "base branch to verify against (default: main)", "main")
  .option("--remote <name>", "remote to fetch before verifying (default: origin)", "origin")
  .option("--keep-branch", "do not delete the branch (default: delete safely)")
  .option("--force-delete-branch", "force delete local branch even if not merged (-D)")
  .option("--delete-remote", "also delete remote branch if upstream exists")
  .action(async (input, optsCmd) => {
    try {
      const root = await findRepoRoot();
      const asPath = path.resolve(root, input);
      let t: any;
      if (fss.existsSync(asPath)) t = await loadTaskFromFile(asPath);
      else {
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        t = await findTaskById([root, ...pkgs], input);
        if (!t) throw new Error(`Task not found: ${input}`);
      }
      // Verify merge state before cleanup
      const base = optsCmd.base ?? "main";
      const remote = optsCmd.remote ?? "origin";
      try { fetchAll(root); } catch {}
      const baseRef = ((): string => {
        const cand = `${remote}/${base}`;
        try { git(["rev-parse", "--verify", cand], { cwd: root }); return cand; } catch { return base; }
      })();
      const merged = isMergedOrEquivalent(t.branch, baseRef, root);
      if (!merged && !optsCmd.forceDeleteBranch) {
        console.error(`✖ Not merged: branch '${t.branch}' is not merged into '${baseRef}'.`);
        console.error(`  Hint: open/merge a PR first:`);
        console.error(`    mrtask pr ${input} --base ${base} --push --open`);
        console.error(`  Or accept explicitly (GitHub):`);
        console.error(`    mrtask accept ${input} --strategy squash --delete-branch`);
        console.error(`  If you intend to abandon the work, use:`);
        console.error(`    mrtask cancel ${input}   # keeps record`);
        console.error(`    mrtask remove ${input}   # deletes record`);
        process.exitCode = 2;
        return;
      }

      // Proceed with cleanup
      await moveTaskAndRemoveWorktree(input, "done");
      // branch deletion policy for done: safe delete by default
      const optsLocal: any = optsCmd ?? {};
      if (t && !optsLocal.keepBranch) {
        try {
          const force = !!optsLocal.forceDeleteBranch;
          git(["branch", force ? "-D" : "-d", t.branch], { cwd: root });
          console.log(`  Branch deleted (local): ${t.branch}${force ? " (forced)" : ""}`);
        } catch (e: any) {
          console.log(`  Branch kept (not merged?): ${t?.branch ?? "(unknown)"}`);
        }
        if (optsLocal.deleteRemote) {
          const remote = optsLocal.remote ?? "origin";
          try { git(["push", remote, `:refs/heads/${t.branch}`], { cwd: root }); console.log(`  Branch deleted (remote): ${remote}/${t.branch}`); } catch {}
        }
      } else {
        if (t) console.log(`  Branch kept: ${t.branch}`);
      }
    } catch (e: any) {
      console.error(`✖ done failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("accept")
  .description("Accept a task by merging its PR (GitHub via gh) or fast-forward locally (opt-in)")
  .argument("<id-or-path>", "task id (prefix ok) or direct YAML path")
  .option("--strategy <squash|merge|rebase>", "merge strategy when using gh (default: squash)", "squash")
  .option("--delete-branch", "delete the branch on merge (when using gh)")
  .option("--yes", "assume yes for gh prompts")
  .option("--base <branch>", "base branch (default: main)", "main")
  .option("--remote <name>", "remote (default: origin)", "origin")
  .option("--local-ff", "perform local fast-forward merge into base if possible (no gh)")
  .action(async (input, opts) => {
    try {
      const root = await findRepoRoot();
      const asPath = path.resolve(root, input);
      let t: any;
      if (fss.existsSync(asPath)) t = await loadTaskFromFile(asPath);
      else {
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        t = await findTaskById([root, ...pkgs], input);
        if (!t) throw new Error(`Task not found: ${input}`);
      }

      const remote = opts.remote ?? "origin";
      const base = opts.base ?? "main";
      fetchAll(root);
      // Try GitHub first
      try {
        const remoteUrl = getRemoteUrl(remote, root);
        if (!remoteUrl) throw new Error("remote URL not found");
        ensurePushed(remote, t.branch, root);
        const prNum = findOpenPrNumberByHead(t.branch, root);
        if (prNum == null) {
          console.log("No open PR found for this branch. Create one first: \n  mrtask pr", input, "--push --open");
          return;
        }
        mergePrWithGh(prNum, { strategy: opts.strategy, deleteBranch: !!opts.deleteBranch, yes: !!opts.yes, cwd: root });
        console.log(`✔ PR merged (#${prNum}) using strategy: ${opts.strategy}`);
        return;
      } catch {
        // Fallback: local fast-forward if explicitly allowed
        if (!opts.localFf) {
          console.error("✖ gh merge failed or not available. Use --local-ff to attempt a local fast-forward merge, or install GitHub CLI.");
          process.exitCode = 2;
          return;
        }
        const baseRef = `${remote}/${base}`;
        // Switch to base safely and try ff-only
        const prev = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
        try {
          git(["switch", base], { cwd: root });
          try { git(["merge", "--ff-only", t.branch], { cwd: root }); }
          catch (e: any) { throw new Error(`Fast-forward not possible: ${e?.message ?? e}`); }
          try { git(["push", remote, base], { cwd: root }); } catch {}
          console.log(`✔ Locally fast-forwarded ${base} <- ${t.branch} and pushed to ${remote}`);
        } finally {
          try { git(["switch", prev], { cwd: root }); } catch {}
        }
      }
    } catch (e: any) {
      console.error(`✖ accept failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("cancel")
  .description("Cancel task (moves YAML to .mrtask/cancel/ and removes worktree)")
  .argument("<id-or-path>", "task id (prefix ok) or direct YAML path")
  .option("--keep-branch", "do not delete the branch (default: force delete)")
  .option("--delete-remote", "also delete remote branch if upstream exists")
  .option("--remote <name>", "remote name for deletion (default: origin)", "origin")
  .action(async (input, optsCmd) => {
    try {
      await moveTaskAndRemoveWorktree(input, "cancel");
      const root = await findRepoRoot();
      const asPath = path.resolve(root, input);
      let t: any;
      if (fss.existsSync(asPath)) t = await loadTaskFromFile(asPath);
      else {
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        t = await findTaskById([root, ...pkgs], input);
      }
      const optsCancel: any = optsCmd ?? {};
      if (t && !optsCancel.keepBranch) {
        try { git(["branch", "-D", t.branch], { cwd: root }); console.log(`  Branch deleted (local, forced): ${t.branch}`); } catch {}
        if (optsCancel.deleteRemote) {
          const remote = optsCancel.remote ?? "origin";
          try { git(["push", remote, `:refs/heads/${t.branch}`], { cwd: root }); console.log(`  Branch deleted (remote): ${remote}/${t.branch}`); } catch {}
        }
      } else { if (t) console.log(`  Branch kept: ${t.branch}`); }
    } catch (e: any) {
      console.error(`✖ cancel failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("remove")
  .description("Remove task YAML and worktree (no record kept)")
  .argument("<id-or-path>", "task id (prefix ok) or direct YAML path")
  .option("--keep-branch", "do not delete the branch (default: force delete)")
  .option("--delete-remote", "also delete remote branch if upstream exists")
  .option("--remote <name>", "remote name for deletion (default: origin)", "origin")
  .action(async (input, optsCmd) => {
    try {
      const root = await findRepoRoot();
      const asPath = path.resolve(root, input);
      let t: any;
      if (fss.existsSync(asPath)) t = await loadTaskFromFile(asPath);
      else {
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        t = await findTaskById([root, ...pkgs], input);
        if (!t) throw new Error(`Task not found: ${input}`);
      }
      // delete YAML (primary), unlink secondary shims/links
      await fs.rm(t.filePath, { force: true });
      // remove worktree
      const wtRoot = path.join(root, MR_DIRNAME, "wt", t.id);
      let removedPath: string | null = null;
      if (fss.existsSync(wtRoot)) {
        worktreeRemove(wtRoot);
        removedPath = wtRoot;
      } else {
        const primaryDir = path.resolve(root, t.primaryDir);
        try { worktreeRemove(primaryDir); removedPath = primaryDir; } catch { removedPath = null; }
      }
      console.log(`✔ removed: ${t.id}`);
      console.log(`  Worktree removed: ${removedPath ? path.relative(root, removedPath) : "(none)"}`);
      const optsRemove: any = optsCmd ?? {};
      if (!optsRemove.keepBranch) {
        try { git(["branch", "-D", t.branch], { cwd: root }); console.log(`  Branch deleted (local, forced): ${t.branch}`); } catch {}
        if (optsRemove.deleteRemote) {
          const remote = optsRemove.remote ?? "origin";
          try { git(["push", remote, `:refs/heads/${t.branch}`], { cwd: root }); console.log(`  Branch deleted (remote): ${remote}/${t.branch}`); } catch {}
        }
      } else {
        console.log(`  Branch kept: ${t.branch}`);
      }
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
