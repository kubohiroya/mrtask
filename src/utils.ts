import fs from "node:fs/promises";
import * as fss from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import type { TaskStatus } from "./types.js";

export const MR_DIRNAME = ".mrtask";

export async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

export async function pathExists(p: string) {
  try { await fs.access(p); return true; } catch { return false; }
}

export function nowId(branch: string, slug: string) {
  const iso = new Date().toISOString();               // e.g. 2025-09-08T14:03:12.345Z
  const safe = iso.replace(/:/g, "-");                 // 2025-09-08T14-03-12.345Z
  const b = branch.replace(/[\/\\]/g, "_");
  return `${safe}-${b}-${slug}`;
}

export function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function writeYamlAtomic(filePath: string, data: unknown) {
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, YAML.stringify(data), "utf8");
  await fs.rename(tmp, filePath);
}

export async function readYaml<T = unknown>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8");
  return YAML.parse(raw) as T;
}

export async function realpathSafe(p: string) {
  try { return await fs.realpath(p); } catch { return p; }
}

// ---------- Git helpers ----------

export function git(args: string[], opts?: { cwd?: string }) {
  return execFileSync("git", args, { stdio: "pipe", encoding: "utf8", cwd: opts?.cwd }).trim();
}

export function refExists(ref: string, cwd?: string): boolean {
  try {
    git(["rev-parse", "--verify", ref], { cwd });
    return true;
  } catch {
    return false;
  }
}

export function getCurrentBranch(cwd?: string) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
}

export function listBranches(cwd?: string) {
  const out = git(["branch", "--format=%(refname:short)"], { cwd });
  return out.split("\n").map(s => s.trim()).filter(Boolean);
}

export function ensureOnMainOrForce(force = false, mainName?: string) {
  if (force) return;
  const cur = getCurrentBranch();
  const main = mainName ?? "main";
  if (cur !== main) {
    throw new Error(`Refusing to run on '${cur}'. Switch to '${main}' or use --force.`);
  }
}

export function branchExists(name: string) {
  return listBranches().includes(name);
}

// Create a new branch using best-effort base:
//   origin/main -> main -> current branch (HEAD)
export function createBranchFromMain(name: string, mainName = "main") {
  let base = `origin/${mainName}`;
  if (!refExists(base)) {
    base = mainName;
  }
  if (!refExists(base)) {
    base = getCurrentBranch();
  }
  git(["branch", name, base]);
}

export function worktreeAdd(dir: string, branch: string) {
  git(["worktree", "add", dir, branch]);
}

export function worktreeRemove(dir: string) {
  git(["worktree", "remove", dir, "--force"]);
}

export function sparseInit(cwd: string) {
  try { git(["sparse-checkout", "init", "--cone"], { cwd }); } catch {}
}

export function sparseSet(cwd: string, paths: string[]) {
  git(["sparse-checkout", "set", ...paths], { cwd });
}

export function gitRoot(cwd?: string) {
  return git(["rev-parse", "--show-toplevel"], { cwd });
}

export function fetchAll(cwd?: string) {
  try { git(["fetch", "--all", "--prune"], { cwd }); } catch {}
}

export function isMergedOrEquivalent(branch: string, baseRef: string, cwd?: string): boolean {
  // 1) Fast path: branch is ancestor of base (merged via merge/rebase/ff)
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branch, baseRef], { cwd });
    return true; // exit code 0 -> ancestor
  } catch {}
  // 2) Snapshot equality: trees identical (typical after squash merge)
  try {
    execFileSync("git", ["diff", "--quiet", `${baseRef}`, `${branch}`], { cwd });
    return true; // no diff
  } catch {}
  return false;
}

export function statStatusFromPath(p: string): TaskStatus {
  if (p.includes(`${MR_DIRNAME}/done/`)) return "done";
  if (p.includes(`${MR_DIRNAME}/cancel/`)) return "cancelled";
  return "open";
}

export async function removeFileSafe(p: string) {
  try { await fs.rm(p, { force: true }); } catch {}
}

export async function unlinkIfSymlink(p: string) {
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) await fs.unlink(p);
  } catch {}
}

export async function isBrokenSymlink(p: string) {
  try {
    const st = await fs.lstat(p);
    if (!st.isSymbolicLink()) return false;
    const tgt = await fs.readlink(p);
    const abs = path.isAbsolute(tgt) ? tgt : path.resolve(path.dirname(p), tgt);
    return !fss.existsSync(abs);
  } catch {
    return false;
  }
}
