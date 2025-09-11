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
import { listTaskFilesUnder, loadTaskFromFile, findTaskById, findTaskByBranch } from "./tasks.js";
import type { Task } from "./types.js";
// ★ 追加
import { buildPRSpec } from "./builder.js";
import { buildCompareUrl, createPRWithGh, ensurePushed, getRemoteUrl, openInBrowser, planPR, findOpenPrNumberByHead, mergePrWithGh } from "./providers.js";
import { git, fetchAll, isMergedOrEquivalent } from "./utils.js";
import fg from "fast-glob";
import { detectProjectName, ensureHome, printInitGuide } from "./home.js";
import { computeBranchUnion, writeGuardsConfig } from "./guards.js";

// Resolve package version without JSON import attributes (Node 18 compatible)
let pkgVersion = "0.0.0";
try {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const raw = fss.readFileSync(pkgPath, "utf8");
  pkgVersion = JSON.parse(raw)?.version ?? pkgVersion;
} catch {}

const program = new Command();
 
/*
program
  .name("mrtask")
  .description("Mono-repo task manager on top of git worktree")
  .version(String(pkgVersion));

*/
program
  .command("create")
  .description("Create a full (isolated) task: branch + worktree + YAML")
  .argument("<branch>", "branch name to use")
  .argument("<task-name-segment>", "short slug for task title")
  .option("-d, --description <text>", "task description")
  .option("-f, --file <yamlFile>", "use existing YAML as definition")
  .option("-t, --from-csv <csv:line>", "create from CSV (file.csv:12)")
  .option("--sparse", "enable sparse-checkout for provided dirs")
  .option("--guards <level>", "guards level: ignore|warn|error")
  .option("--wt-mode <mode>", "worktree placement: sibling|home|repo-subdir", "sibling")
  .option("--dry-run", "print YAML without modifying git or filesystem")
  .option("--silent", "suppress output on success (errors still shown)")
  .option("--force", "allow running off main branch")
  .argument("<dir1>", "primary work dir (package dir)")
  .argument("[dirN...]", "secondary work dirs")
  .action(async (branchArg: string, taskSegArg: string, dir1Arg: string, dirNArg: string[] = [], opts: any) => {
    try {
      ensureOnMainOrForce(!!opts.force);
      const root = await findRepoRoot();
      // Allow CSV to backfill/override missing values
      let branch = branchArg;
      let taskSeg = taskSegArg;
      let description = opts.description as string | undefined;
      let dir1 = dir1Arg;
      let dirN = dirNArg || [];

      if (opts.fromCsv) {
        // Minimal CSV parsing utilities
        const parseCsvLine = (line: string): string[] => {
          const out: string[] = [];
          let cur = ""; let inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
            else if (ch === ',' && !inQ) { out.push(cur); cur = ""; }
            else { cur += ch; }
          }
          out.push(cur);
          return out.map(s => s.trim().replace(/^\uFEFF/, ""));
        };
        const stripOuterQuotes = (s: string) => s.replace(/^["'](.*)["']$/s, "$1");
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
        const csvTitle = get("title") || stripOuterQuotes((row[0]?.trim() ?? ""));
        const csvDesc = get("description") || stripOuterQuotes((row[1]?.trim() ?? ""));
        const csvBranch = get("branch");
        const dirNs: string[] = [];
        for (let i = 1; i <= 20; i++) { const v = get(`dir${i}`); if (v) dirNs.push(v); }
        const primaryDirCsv = dirNs[0] || "";
        const secondaryFromNs = dirNs.slice(1);
        const csvSlug = get("slug");
        if (!description && csvDesc) description = csvDesc;
        if (!taskSeg && (csvSlug || csvTitle)) taskSeg = (csvSlug || csvTitle).toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
        if (!branch && csvBranch) branch = csvBranch;
        if (!dir1 && primaryDirCsv) dir1 = primaryDirCsv;
        if (dirN.length === 0 && secondaryFromNs.length > 0) dirN = secondaryFromNs;

        // Interactive fallback for still-missing required values
        let rlRef: any = null; const getRl = () => (rlRef ??= readline.createInterface({ input, output }));
        const rl = getRl();
        if (!branch) branch = (await rl.question("Enter branch name: ")).trim();
        if (!taskSeg) taskSeg = (await rl.question("Enter task slug/title: ")).trim();
        if (!dir1) dir1 = (await rl.question("Enter primary work dir: ")).trim();
        try { await rlRef?.close?.(); } catch {}
      }

      // Validate
      if (!branch) throw new Error("missing required argument 'branch' (first positional arg)");
      if (!taskSeg) throw new Error("missing required argument 'task-name-segment' (second positional arg)");
      if (!dir1) throw new Error("missing required argument 'dir1'");

      const primaryRepoPath = path.resolve(root, dir1);
      const repoDirAbsList = [primaryRepoPath, ...dirN.map(d => path.resolve(root, d))];

      // Create branch if needed (CSV mode asks for confirmation)
      if (!branchExists(branch)) {
        if (opts.fromCsv) {
          const rl = readline.createInterface({ input, output });
          const ans = (await rl.question(`The branch "${branch}" does not exist. Create it now? (y/N) `)).trim().toLowerCase();
          try { await rl.close(); } catch {}
          if (ans === "y") { if (!opts.dryRun) createBranchFromMain(branch, "main"); }
          else { console.error("Aborted. Branch not created."); process.exitCode = 1; return; }
        } else {
          if (!opts.dryRun) createBranchFromMain(branch, "main");
        }
      }

      // Decide worktree placement
      const title = (taskSeg ?? '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
      const id = nowId(branch, slugify(taskSeg ?? (title || 'task')));
      const repoName = path.basename(root);
      const siblingBase = path.join(path.dirname(root), `${repoName}-wt`);
      const homeBaseLazy = () => ensureHome(detectProjectName()).wtBase;
      const repoSubdirBase = path.join(root, '.worktrees');
      const mode = String(opts.wtMode || 'sibling');
      const base = mode === 'home' ? homeBaseLazy() : mode === 'repo-subdir' ? repoSubdirBase : siblingBase;
      const wtFallback = path.join(base, id);
      const useFallback = fss.existsSync(primaryRepoPath);
      const wtRoot = useFallback ? wtFallback : primaryRepoPath;
      if (!opts.dryRun) { if (useFallback) await ensureDir(path.dirname(wtRoot)); worktreeAdd(wtRoot, branch); }

      // Write YAML under the repository's package path
      const mrDir = path.join(primaryRepoPath, MR_DIRNAME);
      if (!opts.dryRun) await ensureDir(mrDir);
      const fileName = `${id}.yml`;
      const filePath = path.join(mrDir, fileName);
      const task: Task = {
        id,
        createdAt: new Date().toISOString(),
        branch,
        title,
        description,
        status: 'open',
        primaryDir: dir1,
        workDirs: [dir1, ...dirN],
        tags: [], checklist: [], relatedPRs: [], assignees: [],
      };
      // guards option (no legacy flags here; add keeps deprecation mapping)
      const norm = (s: string) => String(s || '').trim().toLowerCase();
      const mapSyn = (s: string) => s === 'off' ? 'ignore' : (s === 'block' ? 'error' : s);
      let guardsLevelFromOpt: string | undefined = undefined;
      if (opts.guards) guardsLevelFromOpt = mapSyn(norm(opts.guards));
      if (guardsLevelFromOpt != null) (task as any).guards = { level: guardsLevelFromOpt };

      if (!opts.dryRun) {
        await writeYamlAtomic(filePath, task);
        // create shims/symlinks for secondary dirs
        for (const d of repoDirAbsList.slice(1)) {
          const linkDir = path.join(d, MR_DIRNAME);
          await ensureDir(linkDir);
          const rel = path.relative(linkDir, filePath);
          try { await fs.symlink(rel, path.join(linkDir, fileName)); }
          catch { await writeYamlAtomic(path.join(linkDir, fileName), { $ref: path.relative(d, filePath) }); }
        }
      }

      // sparse-checkout
      if (opts.sparse && !opts.dryRun) {
        sparseInit(wtRoot);
        const rels = [dir1, ...dirN];
        sparseSet(wtRoot, rels);
      }

      // Output
      if (!opts.silent) {
        console.log(`✔ Created task ${id}`);
        if (!opts.dryRun) {
          console.log(`  YAML: ${path.relative(root, filePath)}`);
          console.log(`  Worktree: ${path.relative(root, wtRoot)} on branch ${branch}`);
        } else {
          console.log(`  (dry-run) No files written.`);
        }
        try { const YAMLMod = await import('yaml'); const yamlText = YAMLMod.default.stringify(task); process.stdout.write(yamlText.endsWith('\n') ? yamlText : yamlText + '\n'); } catch {}
      }
    } catch (e: any) {
      console.error(`✖ create failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });


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
  .description("Add a lightweight task on an existing worktree (shared). Use 'mrtask create' for full tasks.")
  .argument("<slug>", "short slug for task title (no slashes)")
  .option("-d, --description <text>", "task description")
  .option("-f, --file <yamlFile>", "use existing YAML as definition")
  .option("-t, --from-csv <csv:line>", "create from CSV (file.csv:12)")
  .option("--sparse", "enable sparse-checkout for provided dirs")
  .option("--guards <level>", "guards level: ignore|warn|error")
  // Legacy flags: keep for compatibility, map to guards with deprecation warnings
  .option("--strict", "DEPRECATED: use --guards error")
  .option("--no-strict", "DEPRECATED: use --guards warn")
  .option("--wt-mode <mode>", "worktree placement: sibling|home|repo-subdir", "sibling")
  .option("--parent <id|short8|yaml>", "explicit parent task for --shared")
  .option("--dry-run", "print YAML without modifying git or filesystem")
  .option("--silent", "suppress output on success (errors still shown)")
  .option("--force", "allow running off main branch")
  .argument("<dir1>", "primary work dir (package dir)")
  .argument("[dirN...]", "secondary work dirs")
  .action(async (slugArg: string, dir1Arg: string, dirNArg: string[] = [], opts: any) => {
    try {
      // Enforce shared-only: if slug looks like a branch, guide users to 'create'
      if (slugArg.includes('/')) {
        throw new Error(`'add' is for lightweight tasks. For full tasks use: mrtask create <branch> <slug> <dir1> ...`);
      }
      // Shared (lightweight): create YAML only, reuse existing worktree
        const root = await findRepoRoot();
        const slug = slugArg;
        const taskSeg = slugArg;
        const dir1 = dir1Arg;
        const dirN = dirNArg || [];

        // Resolve parent/branch/worktree
        let parent: any | null = null;
        if (opts.parent) {
          try { parent = await resolveTaskTarget(opts.parent, {}); } catch {}
          if (!parent) throw new Error(`Parent task not found: ${opts.parent}`);
        }
        const branch = parent?.branch ?? (opts.branch || git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }));
        // Worktree root: prefer parent's; otherwise infer from any task on this branch; fallback to current if inside some worktree
        let wtRoot = parent ? resolveWorktreeRootForTask(parent, root) : '';
        if (!wtRoot || !fss.existsSync(wtRoot)) {
          let pkgs = await loadPNPMWorkspaces(root); if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
          const all = (await Promise.all([root, ...pkgs].map(d => listTaskFilesUnder(d)))).flat();
          for (const f of all) {
            const cand = await loadTaskFromFile(f);
            if (cand.branch === branch) {
              const r = resolveWorktreeRootForTask(cand, root);
              if (fss.existsSync(r)) { wtRoot = r; break; }
            }
          }
        }
        if (!wtRoot) {
          // Last resort: if current cwd is inside some task worktree, use it
          const cwd = process.cwd();
          let pkgs = await loadPNPMWorkspaces(root); if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
          const all = (await Promise.all([root, ...pkgs].map(d => listTaskFilesUnder(d)))).flat();
          for (const f of all) {
            const cand = await loadTaskFromFile(f);
            const r = resolveWorktreeRootForTask(cand, root);
            if (cwd.startsWith(path.resolve(r) + path.sep) || cwd === path.resolve(r)) { wtRoot = r; break; }
          }
        }
        if (!wtRoot) throw new Error("Failed to resolve target worktree (specify --parent/--branch/--worktree)");

        // If parent not provided, auto-select based on dir1 and recency
        if (!parent) {
          let pkgs = await loadPNPMWorkspaces(root); if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
          const all = (await Promise.all([root, ...pkgs].map(d => listTaskFilesUnder(d)))).flat();
          type Scored = { t: any; score: number; reason: string };
          const cands: Scored[] = [];
          for (const f of all) {
            const cand = await loadTaskFromFile(f);
            if ((cand.status ?? 'open') !== 'open') continue;
            if (String(cand.branch) !== String(branch)) continue;
            let score = 0; let reason = '';
            if (String(cand.primaryDir) === String(dir1)) { score = 3; reason = 'primaryDir match'; }
            else if ((cand.workDirs ?? []).includes(dir1)) { score = 2; reason = 'included in workDirs'; }
            if (score > 0) {
              // Tie-breaker: newer createdAt preferred
              const ts = Date.parse(cand.createdAt ?? '') || 0; score = score * 1e9 + ts; // weight primary>includes
              cands.push({ t: cand, score, reason });
            }
          }
          if (cands.length) {
            cands.sort((a,b)=> b.score - a.score);
            parent = cands[0].t;
            if (!opts.silent) console.log(`  Parent: ${parent.title || parent.id} [${parent.branch}] (${cands[0].reason})`);
          } else {
            if (!opts.silent) console.log(`  Parent: (none) — branch-level shared`);
          }
        }

        // Compose YAML
        const id = nowId(branch, slugify(taskSeg));
        const primaryRepoPath = path.resolve(root, dir1);
        const mrDir = path.join(primaryRepoPath, MR_DIRNAME);
        const repoDirAbsList = [primaryRepoPath, ...dirN.map(d => path.resolve(root, d))];
        if (!opts.dryRun) await ensureDir(mrDir);
        const fileName = `${id}.yml`;
        const filePath = path.join(mrDir, fileName);
        const task: Task = {
          id,
          createdAt: new Date().toISOString(),
          branch,
          title: (taskSeg ?? '').replace(/[-_]/g, ' ').trim(),
          description: opts.description,
          status: 'open',
          primaryDir: dir1,
          workDirs: [dir1, ...dirN],
          mode: 'shared',
          parentId: parent?.id,
          tags: [], checklist: [], relatedPRs: [], assignees: [],
        };
        // guards (explicit only)
        const norm = (s: string) => String(s || '').trim().toLowerCase();
        const mapSyn = (s: string) => s === 'off' ? 'ignore' : (s === 'block' ? 'error' : s);
        let guardsLevelFromOpt: string | undefined = undefined;
        if (opts.guards) guardsLevelFromOpt = mapSyn(norm(opts.guards));
        if (guardsLevelFromOpt != null) (task as any).guards = { level: guardsLevelFromOpt };

        if (!opts.dryRun) {
          await writeYamlAtomic(filePath, task);
          // secondary symlinks/shims
          for (const d of repoDirAbsList.slice(1)) {
            const linkDir = path.join(d, MR_DIRNAME);
            await ensureDir(linkDir);
            const rel = path.relative(linkDir, filePath);
            try { await fs.symlink(rel, path.join(linkDir, fileName)); }
            catch { await writeYamlAtomic(path.join(linkDir, fileName), { $ref: path.relative(d, filePath) }); }
          }
        }

        // Guards sync (union of open tasks on the branch)
        if (!opts.dryRun) {
          let pkgs = await loadPNPMWorkspaces(root); if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
          const union = await computeBranchUnion(root, branch, pkgs);
          await writeGuardsConfig(wtRoot, union.allow, union.level);
          if (!opts.silent) console.log(`  Guards: level=${union.level}, allow=${union.allow.length} globs`);
        }

        // Output
        if (!opts.silent) {
          console.log(`✔ Added shared task ${id}`);
          if (!opts.dryRun) {
            console.log(`  YAML: ${path.relative(root, filePath)}`);
            console.log(`  Worktree: ${path.relative(root, wtRoot)} on branch ${branch}`);
          } else {
            console.log(`  (dry-run) No files written.`);
          }
          try {
            const YAMLMod = await import('yaml');
            const yamlText = YAMLMod.default.stringify(task);
            process.stdout.write(yamlText.endsWith('\n') ? yamlText : yamlText + '\n');
          } catch {}
        }
        return;

    } catch (e: any) {
      console.error(`✖ add failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  }).hook("postAction", async () => {
    try { (output as any).write(""); } catch {}
  });

// (removed legacy full-add implementation)

program
  .command("list")
  .description("List tasks across workspaces (.mrtask). If a parent id|short8|yaml is given, lists its subtasks.")
  .option("--all", "show all statuses")
  .option("--status <status>", "open|done|cancelled")
  .option("--short", "compact format")
  .option("--flat", "force flat listing (default on non-main branches; on main shows hierarchical by default)")
  .argument("[parent-id-or-path]", "parent task id/short8 or YAML path (when provided, show that parent's subtasks)")
  .action(async (parentArg, opts) => {
    try {
      const root = await findRepoRoot();
      let pkgs = await loadPNPMWorkspaces(root); if (pkgs == null) pkgs = await loadFallbackWorkspaces(root); const searchDirs = [root, ...pkgs];
      const found: string[] = (await Promise.all(searchDirs.map(d => listTaskFilesUnder(d)))).flat();

      if (Boolean(parentArg)) {
        // Resolve parent task
        let parent: any | null = null;
        if (parentArg) {
          const asPath = path.resolve(root, parentArg);
          if (fss.existsSync(asPath)) parent = await loadTaskFromFile(asPath);
          else parent = await findTaskById(searchDirs, parentArg);
        }
        if (!parent) throw new Error("Parent task not found. Provide id/short8/path.");

        // Children = tasks that point to parentId == parent.id. Fallback: shared tasks on same branch without parentId
        const children: (Task & { filePath: string })[] = [];
        for (const f of found) {
          const t = await loadTaskFromFile(f);
          const isValid = Boolean((t.id ?? "").trim()) && Boolean((t.branch ?? "").trim()) && Boolean((t.title ?? "").trim());
          if (!isValid) continue;
          if ((t.parentId && t.parentId === parent.id) || (!t.parentId && t.mode === 'shared' && t.branch === parent.branch)) {
            if (!opts.all && !opts.status && (t.status ?? 'open') !== 'open') continue;
            if (opts.status && (t.status ?? 'open') !== opts.status) continue;
            children.push({ ...(t as any) });
          }
        }
        children.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        const shortId = (id: string) => crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
        console.log(`# Children of ${parent.title || parent.id} [${parent.branch}]`);
        for (const t of children) {
          const wd = t.workDirs?.length ? ` (${t.workDirs.length} dirs)` : "";
          const head = `${(t.status ?? 'open').padEnd(9)} [${shortId(t.id)}] ${t.title}${wd} [${t.branch}]`;
          if (opts.short) console.log(head);
          else {
            console.log(head);
            console.log(`  ${path.relative(root, (t as any).filePath)}`);
          }
        }
      } else {
        // Decide default style: hierarchical on main unless --flat
        let isMain = false;
        try { isMain = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }) === "main"; } catch {}

        // Load all tasks
        const seen = new Map<string, Task & { filePath: string }>();
        for (const f of found) {
          const t = await loadTaskFromFile(f);
          const key = (t as any).filePath;
          const isValid = Boolean((t.id ?? "").trim()) && Boolean((t.branch ?? "").trim()) && Boolean((t.title ?? "").trim());
          if (!isValid) continue;
          if (!seen.has(key)) seen.set(key, t);
        }
        let allTasks = Array.from(seen.values());
        if (!opts.all && !opts.status) allTasks = allTasks.filter(t => (t.status ?? "open") === "open");
        if (opts.status) allTasks = allTasks.filter(t => t.status === opts.status);

        const shortId = (id: string) => crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);

        if (isMain && !opts.flat) {
          // Hierarchical: parents and their children
          const byId = new Map(allTasks.map(t => [t.id, t] as const));
          const childrenByParent = new Map<string, (Task & { filePath: string })[]>();
          for (const t of allTasks) {
            const p = (t.parentId && byId.get(t.parentId)) || null;
            if (p) {
              if (!childrenByParent.has(p.id)) childrenByParent.set(p.id, []);
              childrenByParent.get(p.id)!.push(t);
            }
          }
          // Parents: all isolated tasks + any shared with children + shared without parent (treated as top-level leafs)
          const parents: (Task & { filePath: string })[] = [];
          for (const t of allTasks) {
            const hasParent = Boolean(t.parentId);
            const isIsolated = (t.mode ?? 'isolated') !== 'shared';
            const hasChildren = childrenByParent.has(t.id);
            if (isIsolated || hasChildren || (!hasParent && (t.mode ?? 'isolated') === 'shared')) parents.push(t);
          }
          // Sort parents
          parents.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
          for (const p of parents) {
            const wd = p.workDirs?.length ? ` (${p.workDirs.length} dirs)` : "";
            const head = `${(p.status ?? 'open').padEnd(9)} [${shortId(p.id)}] ${p.title}${wd} [${p.branch}]`;
            if (opts.short) console.log(head);
            else { console.log(head); console.log(`  ${path.relative(root, (p as any).filePath)}`); }
            const kids = (childrenByParent.get(p.id) ?? []).slice().sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
            for (const c of kids) {
              const cwd2 = c.workDirs?.length ? ` (${c.workDirs.length} dirs)` : "";
              const line = `  - ${(c.status ?? 'open').padEnd(9)} [${shortId(c.id)}] ${c.title}${cwd2} [${c.branch}]`;
              if (opts.short) console.log(line);
              else { console.log(line); console.log(`    ${path.relative(root, (c as any).filePath)}`); }
            }
          }
        } else {
          // Flat listing (default on non-main or when --flat)
          allTasks.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
          for (const t of allTasks) {
            const wd = t.workDirs?.length ? ` (${t.workDirs.length} dirs)` : "";
            const idPart = `[${shortId(t.id)}] `;
            const head = `${t.status?.padEnd(9)} ${idPart}${t.title}${wd} [${t.branch}]`;
            if (opts.short) console.log(head);
            else { console.log(head); console.log(`  ${path.relative(root, (t as any).filePath)}`); }
          }
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
  .command("info")
  .description("Show task YAML: info <id|short8|path> or info (current worktree's parent)")
  .argument("[id-or-path]", "task id (prefix/short8 ok) or YAML path; omit to use current worktree's parent")
  .action(async (input) => {
    try {
      const root = await findRepoRoot();
      let t: any | null = null;
      if (input) {
        const asPath = path.resolve(root, input);
        if (fss.existsSync(asPath)) t = await loadTaskFromFile(asPath);
        else {
          let pkgs = await loadPNPMWorkspaces(root);
          if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
          t = await findTaskById([root, ...pkgs], input);
        }
      }
      if (!t) {
        // Resolve by current worktree ownership
        let pkgs = await loadPNPMWorkspaces(root);
        if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
        const all = (await Promise.all([root, ...pkgs].map(d => listTaskFilesUnder(d)))).flat();
        const cwd = process.cwd();
        for (const f of all) {
          const cand = await loadTaskFromFile(f);
          const wt = resolveWorktreeRootForTask(cand, root);
          if (cwd.startsWith(path.resolve(wt) + path.sep) || cwd === path.resolve(wt)) { t = cand; break; }
        }
      }
      if (!t) throw new Error("Task not found (provide id/short8/path, or run inside a task worktree)");
      // Print raw YAML as stored
      const raw = await fs.readFile((t as any).filePath, "utf8");
      process.stdout.write(raw.endsWith("\n") ? raw : raw + "\n");
    } catch (e: any) {
      console.error(`✖ info failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program
  .command("pr")
  .description("Generate a pull request from mrtask YAML and git diff")
  .argument("[id-or-path]", "task id (prefix ok) or direct path to task YAML file")
  .option("--base <branch>", "base branch (default: main)", "main")
  .option("--remote <name>", "git remote (default: origin)", "origin")
  .option("--push", "push branch to remote if not yet upstream")
  .option("--draft", "create Draft PR when using GitHub gh CLI")
  .option("--open", "open compare/PR URL in browser")
  .option("--dry-run", "do not create PR via provider; skip git side effects; print PR draft and compare URL", true)
  .option("--no-dry-run", "override default dry-run to enable side effects explicitly")
  .option("--task <yaml>", "explicit task YAML path")
  .option("--taskid <id>", "task id (prefix/short-hash ok)")
  .option("--branch <name>", "task branch name")
  .option("--worktree <path>", "target worktree path")
  .action(async (input, opts) => {
    try {
      const root = await findRepoRoot();
      const t = await resolveTaskTarget(input, opts);

      // PR 下書きを構築
      const spec = buildPRSpec(t, opts.base, root);

      // リモート情報と compare URL
      const remoteUrl = getRemoteUrl(opts.remote, root);
      const compareUrl = buildCompareUrl(remoteUrl, spec.base, spec.head);

      // --push が指定なら upstream 設定まで行う（dry-run の場合はスキップ）
      if (opts.push && !opts.dryRun) {
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
  .command("ci")
  .description("Bootstrap CI workflow files, commit, push, and create PR for a task")
  .argument("<id-or-path>", "task id (prefix/short-hash ok) or YAML path")
  .option("--template <path>", "workflow template path (relative to repo root)", ".github/workflows/dep-fence-guards.yml")
  .option("--add <pattern...>", "additional file globs to stage (relative to repo root)")
  .option("--message <msg>", "commit message", "ci(guards): add dep-fence guards workflow")
  .option("--base <branch>", "base branch (default: main)", "main")
  .option("--remote <name>", "git remote (default: origin)", "origin")
  .option("--draft", "create Draft PR when using GitHub gh CLI")
  .option("--open", "open compare/PR URL in browser")
  .option("--dry-run", "preview actions without writing or pushing", true)
  .option("--no-dry-run", "enable side effects explicitly")
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

      // worktree root detection
      const wtRoot = resolveWorktreeRootForTask(t, root);

      // Ensure branch exists and checked out in worktree
      try { git(["rev-parse", "--verify", t.branch], { cwd: root }); }
      catch { if (!opts.dryRun) createBranchFromMain(t.branch, opts.base ?? "main"); }
      try {
        const cur = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtRoot });
        if (cur !== t.branch && !opts.dryRun) git(["switch", t.branch], { cwd: wtRoot });
      } catch { if (!opts.dryRun) git(["switch", t.branch], { cwd: wtRoot }); }

      // Prepare workflow file
      const templateAbs = path.resolve(root, opts.template);
      const targetDir = path.join(wtRoot, ".github", "workflows");
      const targetFile = path.join(targetDir, path.basename(templateAbs));
      if (opts.dryRun) {
        console.log(`[dry-run] mkdir -p ${path.relative(wtRoot, targetDir)}`);
        console.log(`[dry-run] copy ${path.relative(root, templateAbs)} -> ${path.relative(wtRoot, targetFile)}`);
      } else {
        await ensureDir(targetDir);
        if (!fss.existsSync(templateAbs)) throw new Error(`Template not found: ${opts.template}`);
        await fs.copyFile(templateAbs, targetFile);
      }

      // Stage files
      const stageList: string[] = [path.relative(wtRoot, targetFile)];
      const patterns: string[] = ([] as string[]).concat(opts.add ?? []);
      if (patterns.length) {
        const found = await fg(patterns, { cwd: wtRoot, dot: false, onlyFiles: false, unique: true });
        for (const p of found) stageList.push(p);
      }
      if (opts.dryRun) {
        console.log(`[dry-run] git add ${stageList.join(' ')}`);
      } else {
        for (const p of stageList) git(["add", p], { cwd: wtRoot });
      }

      // Commit if there are staged changes
      if (opts.dryRun) {
        console.log(`[dry-run] git commit -m ${JSON.stringify(opts.message)}`);
      } else {
        try { git(["commit", "-m", opts.message], { cwd: wtRoot }); } catch {}
      }

      // Push and PR
      const remote = opts.remote ?? "origin";
      const base = opts.base ?? "main";
      if (opts.dryRun) {
        console.log(`[dry-run] git push -u ${remote} ${t.branch}`);
        const remoteUrl = getRemoteUrl(remote, root);
        const spec = buildPRSpec(t, base, root);
        const compareUrl = buildCompareUrl(remoteUrl, spec.base, spec.head);
        const plan = planPR(spec, compareUrl);
        console.log(plan);
        return;
      }

      try { git(["push", "-u", remote, t.branch], { cwd: wtRoot }); } catch {}

      const spec = buildPRSpec(t, base, root);
      const remoteUrl = getRemoteUrl(remote, root);
      const compareUrl = buildCompareUrl(remoteUrl, spec.base, spec.head);
      let createdUrl = compareUrl ?? null;
      try {
        createdUrl = createPRWithGh(spec, { draft: !!opts.draft, base, cwd: root }) || compareUrl;
      } catch {
        console.log("gh CLI not available or failed; showing compare URL instead.");
      }
      console.log(`PR: ${createdUrl ?? "(no URL available)"}`);
      if (opts.open && createdUrl) openInBrowser(createdUrl);
    } catch (e: any) {
      console.error(`✖ ci failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

function resolveWorktreeRootForTask(t: any, root: string) {
  let homeBase: string | null = null;
  try { homeBase = ensureHome(detectProjectName()).wtBase; } catch { homeBase = null; }
  const repoName = path.basename(root);
  const siblingBase = path.join(path.dirname(root), `${repoName}-wt`);
  const candidates = [
    path.join(root, MR_DIRNAME, "wt", t.id), // legacy in-repo
    ...(homeBase ? [path.join(homeBase, t.id)] : []), // home base (if available)
    path.join(root, ".worktrees", t.id),     // repo-subdir base
    path.join(siblingBase, t.id),             // sibling base
    path.resolve(root, t.primaryDir),
  ];
  for (const c of candidates) if (fss.existsSync(c)) return c;
  return path.resolve(root, t.primaryDir);
}

async function moveTaskAndRemoveWorktree(idOrPath: string | undefined, target: "done" | "cancel", opts?: any) {
  const root = await findRepoRoot();
  let t: any;
  try { t = await resolveTaskTarget(idOrPath, opts ?? {}); }
  catch { throw new Error(`Task not found or not specified`); }
  const historyBase = path.join(root, MR_DIRNAME, target);
  await ensureDir(historyBase);
  const targetPath = path.join(historyBase, path.basename(t.filePath));
  await fs.rename(t.filePath, targetPath);
  // Remove worktree at resolved location (home/repo fallback or primary dir)
  const wtRoot = resolveWorktreeRootForTask(t, root);
  let removedPath: string | null = null;
  if ((t.mode ?? 'isolated') === 'shared') {
    removedPath = null; // shared task: do not remove worktree
  } else {
    try { worktreeRemove(wtRoot); removedPath = wtRoot; } catch { removedPath = null; }
  }
  console.log(`✔ Moved to ${target}: ${path.relative(root, targetPath)}`);
  console.log(`  Worktree removed: ${removedPath ? path.relative(root, removedPath) : "(none)"}`);
  console.log(`  Branch kept: ${t.branch}`);
  // Recompute guards for shared branch (if shared) after removal
  if ((t.mode ?? 'isolated') === 'shared') {
    try {
      let pkgs = await loadPNPMWorkspaces(root); if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
      const union = await computeBranchUnion(root, t.branch, pkgs);
      await writeGuardsConfig(wtRoot, union.allow, union.level);
      console.log(`  Guards updated: level=${union.level}, allow=${union.allow.length} globs`);
    } catch {}
  }
}

program
  .command("done")
  .description("Mark task done: verify merged state, then move YAML to .mrtask/done/ and remove worktree")
  .argument("[id-or-path]", "task id (prefix ok) or direct YAML path")
  .option("--base <branch>", "base branch to verify against (default: main)", "main")
  .option("--remote <name>", "remote to fetch before verifying (default: origin)", "origin")
  .option("--keep-branch", "do not delete the branch (default: delete safely)")
  .option("--force-delete-branch", "force delete local branch even if not merged (-D)")
  .option("--delete-remote", "also delete remote branch if upstream exists")
  .option("--task <yaml>", "explicit task YAML path")
  .option("--taskid <id>", "task id (prefix/short-hash ok)")
  .option("--branch <name>", "task branch name")
  .option("--worktree <path>", "target worktree path")
  .action(async (input, optsCmd) => {
    try {
      const root = await findRepoRoot();
      const t: any = await resolveTaskTarget(input, optsCmd);
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
      await moveTaskAndRemoveWorktree(input, "done", optsCmd);
      // branch deletion policy for done: safe delete by default (isolated only)
      const optsLocal: any = optsCmd ?? {};
      if (t && (t.mode ?? 'isolated') !== 'shared' && !optsLocal.keepBranch) {
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
  .argument("[id-or-path]", "task id (prefix ok) or direct YAML path")
  .option("--keep-branch", "do not delete the branch (default: force delete)")
  .option("--delete-remote", "also delete remote branch if upstream exists")
  .option("--remote <name>", "remote name for deletion (default: origin)", "origin")
  .option("--task <yaml>", "explicit task YAML path")
  .option("--taskid <id>", "task id (prefix/short-hash ok)")
  .option("--branch <name>", "task branch name")
  .option("--worktree <path>", "target worktree path")
  .action(async (input, optsCmd) => {
    try {
      await moveTaskAndRemoveWorktree(input, "cancel", optsCmd);
      const root = await findRepoRoot();
      let t: any;
      try { t = await resolveTaskTarget(input, optsCmd); } catch { t = null; }
      const optsCancel: any = optsCmd ?? {};
      if (t && (t.mode ?? 'isolated') !== 'shared' && !optsCancel.keepBranch) {
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
  .argument("[id-or-path]", "task id (prefix ok) or direct YAML path")
  .option("--keep-branch", "do not delete the branch (default: force delete)")
  .option("--delete-remote", "also delete remote branch if upstream exists")
  .option("--remote <name>", "remote name for deletion (default: origin)", "origin")
  .option("--task <yaml>", "explicit task YAML path")
  .option("--taskid <id>", "task id (prefix/short-hash ok)")
  .option("--branch <name>", "task branch name")
  .option("--worktree <path>", "target worktree path")
  .action(async (input, optsCmd) => {
    try {
      const root = await findRepoRoot();
      const t: any = await resolveTaskTarget(input, optsCmd);
      // delete YAML (primary), unlink secondary shims/links
      await fs.rm(t.filePath, { force: true });
      // remove worktree (home/repo fallback or primary dir)
      const wtRoot = resolveWorktreeRootForTask(t, root);
      let removedPath: string | null = null;
      if ((t.mode ?? 'isolated') === 'shared') { removedPath = null; }
      else { try { worktreeRemove(wtRoot); removedPath = wtRoot; } catch { removedPath = null; } }
      console.log(`✔ removed: ${t.id}`);
      console.log(`  Worktree removed: ${removedPath ? path.relative(root, removedPath) : "(none)"}`);
      const optsRemove: any = optsCmd ?? {};
      if ((t.mode ?? 'isolated') !== 'shared' && !optsRemove.keepBranch) {
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

program
  .command("rename")
  .description("Rename a task: title only (any), or for isolated tasks also rename branch and optionally move its worktree")
  .argument("[id-or-path]", "task id (prefix/short8 ok) or YAML path; omit to target current worktree's parent task")
  .option("--title <text>", "new task title")
  .option("--branch <name>", "new branch name (isolated tasks only)")
  .option("--wt-path <path>", "move worktree directory to this path (isolated tasks only)")
  .option("--remote <name>", "remote for branch updates (default: origin)", "origin")
  .option("--delete-remote-old", "delete the old remote branch after renaming")
  .option("--dry-run", "preview without making changes", true)
  .option("--no-dry-run", "apply changes")
  .action(async (input, opts) => {
    try {
      const root = await findRepoRoot();
      const t: any = await resolveTaskTarget(input, opts);
      const isShared = (t.mode ?? 'isolated') === 'shared';
      if (!opts.title && !opts.branch && !opts.wtPath) {
        console.error("Nothing to do. Specify --title and/or --branch and/or --wt-path.");
        process.exitCode = 2; return;
      }

      // 1) Title rename (any task)
      if (opts.title) {
        if (opts.dryRun) {
          console.log(`[dry-run] update title: ${t.title} -> ${opts.title}`);
        } else {
          const y: any = await readYaml<any>(t.filePath);
          y.title = String(opts.title);
          await writeYamlAtomic(t.filePath, y);
          console.log(`✔ Title updated: ${t.title} -> ${opts.title}`);
        }
      }

      // 2) Branch rename (isolated only)
      if (opts.branch) {
        if (isShared) throw new Error("Branch rename is not allowed on shared (lightweight) tasks. Rename the parent (isolated) task instead.");
        const oldBr = String(t.branch);
        const newBr = String(opts.branch);
        if (oldBr === newBr) {
          console.log(`= Branch unchanged: ${oldBr}`);
        } else if (opts.dryRun) {
          console.log(`[dry-run] git branch -m ${oldBr} ${newBr}`);
          console.log(`[dry-run] update YAML branch in all tasks: ${oldBr} -> ${newBr}`);
        } else {
          // rename branch locally
          git(["branch", "-m", oldBr, newBr], { cwd: root });
          // update all YAMLs that reference the branch
          let pkgs = await loadPNPMWorkspaces(root); if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
          const found: string[] = (await Promise.all([root, ...pkgs].map(d => listTaskFilesUnder(d)))).flat();
          for (const f of found) {
            const y: any = await readYaml<any>(f);
            if ((y?.branch ?? '') === oldBr) { y.branch = newBr; await writeYamlAtomic(f, y); }
          }
          console.log(`✔ Branch renamed: ${oldBr} -> ${newBr}`);
          // remote updates
          const remote = opts.remote ?? 'origin';
          try { git(["push", remote, `${newBr}:${newBr}`], { cwd: root }); git(["branch", "--set-upstream-to", `${remote}/${newBr}`, newBr], { cwd: root }); } catch {}
          if (opts.deleteRemoteOld) { try { git(["push", remote, `:refs/heads/${oldBr}`], { cwd: root }); console.log(`  Remote old deleted: ${remote}/${oldBr}`); } catch {} }
        }
      }

      // 3) Worktree move (isolated only)
      if (opts.wtPath) {
        if (isShared) throw new Error("Worktree move is not applicable to shared tasks.");
        const oldPath = resolveWorktreeRootForTask(t, root);
        const newPath = path.resolve(root, opts.wtPath);
        if (opts.dryRun) {
          console.log(`[dry-run] git worktree move ${path.relative(root, oldPath)} ${path.relative(root, newPath)}`);
        } else {
          try { git(["worktree", "move", oldPath, newPath], { cwd: root }); }
          catch (e: any) {
            throw new Error(`worktree move failed: ${e?.message ?? e}`);
          }
          console.log(`✔ Worktree moved: ${path.relative(root, oldPath)} -> ${path.relative(root, newPath)}`);
        }
      }
    } catch (e: any) {
      console.error(`✖ rename failed: ${e.message ?? e}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
async function resolveTaskTarget(input: string | undefined, optsAny: any) {
  const root = await findRepoRoot();
  const asPath = input ? path.resolve(root, input) : null;
  // 1) explicit --task YAML path
  if (optsAny?.task) {
    const p = path.resolve(root, optsAny.task);
    return await loadTaskFromFile(p);
  }
  // 2) explicit --taskid
  if (optsAny?.taskid) {
    let pkgs = await loadPNPMWorkspaces(root);
    if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
    const t = await findTaskById([root, ...pkgs], String(optsAny.taskid));
    if (t) return t;
  }
  // 3) explicit --branch
  if (optsAny?.branch) {
    let pkgs = await loadPNPMWorkspaces(root);
    if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
    const t = await findTaskByBranch([root, ...pkgs], String(optsAny.branch));
    if (t) return t;
  }
  // 4) explicit --worktree path
  if (optsAny?.worktree) {
    const wt = path.resolve(root, optsAny.worktree);
    let pkgs = await loadPNPMWorkspaces(root);
    if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
    const tasks = await Promise.all([root, ...pkgs].map(async (d) => (await listTaskFilesUnder(d))));
    for (const arr of tasks) for (const f of arr) {
      const t = await loadTaskFromFile(f);
      const resolved = resolveWorktreeRootForTask(t, root);
      if (path.resolve(resolved) === wt) return t;
    }
  }
  // 5) input id-or-path fallback
  if (asPath && fss.existsSync(asPath)) return await loadTaskFromFile(asPath);
  if (input) {
    let pkgs = await loadPNPMWorkspaces(root);
    if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
    const t = await findTaskById([root, ...pkgs], input);
    if (t) return t;
  }
  // 6) current worktree branch
  try {
    const cur = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
    let pkgs = await loadPNPMWorkspaces(root);
    if (pkgs == null) pkgs = await loadFallbackWorkspaces(root);
    const t = await findTaskByBranch([root, ...pkgs], cur);
    if (t) return t;
  } catch {}
  throw new Error(`Task target not resolved. Provide --task, --taskid, --branch, --worktree, or id/path.`);
}
