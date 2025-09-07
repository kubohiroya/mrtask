import path from "node:path";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import fg from "fast-glob";
import YAML from "yaml";

export async function findRepoRoot(start = process.cwd()): Promise<string> {
  let dir = start;
  // walk up to .git
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fss.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Failed to find git repo root (.git)");
    dir = parent;
  }
}

export async function loadPNPMWorkspaces(root: string): Promise<string[] | null> {
  const p = path.join(root, "pnpm-workspace.yaml");
  if (!fss.existsSync(p)) return null;
  const y = YAML.parse(await fs.readFile(p, "utf8"));
  const patterns: string[] = Array.isArray(y?.packages) ? y.packages : [];
  const dirs = patterns.length
    ? await fg(patterns, { cwd: root, onlyDirectories: true, unique: true, ignore: ["**/node_modules/**", "**/.git/**"] })
    : [];
  return dirs.map(d => path.join(root, d));
}

export async function loadFallbackWorkspaces(root: string): Promise<string[]> {
  const pkgPath = path.join(root, "package.json");
  if (fss.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
      const ws = pkg.workspaces;
      const patterns: string[] = Array.isArray(ws) ? ws : ws?.packages;
      if (patterns?.length) {
        const dirs = await fg(patterns, { cwd: root, onlyDirectories: true, unique: true, ignore: ["**/node_modules/**", "**/.git/**"] });
        return dirs.map(d => path.join(root, d));
      }
    } catch {}
  }
  // shallow guess
  const guesses = await fg(["*", "packages/*", "apps/*"], { cwd: root, onlyDirectories: true, unique: true, ignore: ["**/node_modules/**", "**/.git/**"] });
  return guesses.map(d => path.join(root, d)).filter(d => fss.existsSync(path.join(d, "package.json")));
}
