import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// 上位に向かって package.json か .git があるところをプロジェクトルートにする
export function projectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  let dir = path.dirname(__filename);
  // __tests__ から上へ
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, "package.json");
    const git = path.join(dir, ".git");
    if (fss.existsSync(pkg) || fss.existsSync(git)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("projectRoot(): failed to locate repository root");
}

export function distCliPath() {
  return path.resolve(projectRoot(), "dist", "cli.js");
}

export function runNodeBin(binJsPath: string, args: string[], cwd: string) {
  return execFileSync(process.execPath, [binJsPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runGit(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function makeTempRepo(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mrtask-test-"));
  execSync("git init", { cwd: tmp });
  execSync('git config user.email "test@example.com"', { cwd: tmp });
  execSync('git config user.name "Test User"', { cwd: tmp });
  await fs.writeFile(path.join(tmp, "README.md"), "# temp\n");
  await fs.writeFile(path.join(tmp, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await fs.mkdir(path.join(tmp, "packages"), { recursive: true });
  execSync("git add .", { cwd: tmp });
  execSync('git commit -m "init"', { cwd: tmp });
  execSync("git branch -M main", { cwd: tmp });
  return tmp;
}

export function buildProjectOrThrow() {
  // typescript/bin/tsc を正しく解決（ESMでもOK）
  const tscJs = require.resolve("typescript/bin/tsc", { paths: [projectRoot()] });
  execFileSync(process.execPath, [tscJs, "-p", "tsconfig.json"], {
    cwd: projectRoot(),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const out = distCliPath();
  if (!fss.existsSync(out)) {
    throw new Error("Build failed: dist/cli.js not found");
  }
}
