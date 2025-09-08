import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as fss from "node:fs";
import fs from "node:fs/promises";
import { git, gitRoot } from "./utils.js";

export function sha8(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 8);
}

export function detectProjectName(cwd?: string) {
  try {
    const pkg = JSON.parse(fss.readFileSync(path.join(cwd ?? process.cwd(), "package.json"), "utf8"));
    return String(pkg.name || path.basename(cwd ?? process.cwd()));
  } catch {
    return path.basename(cwd ?? process.cwd());
  }
}

export function resolveDefaultHome() {
  const env = (process.env.MRTASK_HOME || "").trim();
  if (env) return path.resolve(env);
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "mrtask");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "mrtask");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "mrtask");
}

export function projectKeyFromPath(projectName: string, repoRoot?: string) {
  let p = repoRoot ?? gitRoot();
  if (process.platform === "win32") p = p.toLowerCase();
  return `${projectName}-${sha8(p)}`;
}

export function ensureHome(projectName: string, explicitHome?: string) {
  const home = explicitHome ? path.resolve(explicitHome) : resolveDefaultHome();
  const cfgPath = path.join(home, "config.json");
  fss.mkdirSync(path.join(home, "workTrees"), { recursive: true });
  if (!fss.existsSync(cfgPath)) fss.writeFileSync(cfgPath, JSON.stringify({ workTrees: {} }, null, 2));
  const workTreesDir = path.join(home, "workTrees");
  const legacy = path.join(workTreesDir, projectName);
  const projectKey = fss.existsSync(legacy) ? projectName : projectKeyFromPath(projectName);
  const wtBase = path.join(workTreesDir, projectKey);
  fss.mkdirSync(wtBase, { recursive: true });
  return { home, cfgPath, wtBase, projectKey };
}

export function printInitGuide(home: string, wtBase: string) {
  const header = `mrtask initialized.\n\nHome: ${home}\nProject workTrees base: ${wtBase}\n`;
  const bash = `# Bash/Zsh\nexport MRTASK_HOME=\"${home}\"\n# persist:\necho 'export MRTASK_HOME=\"${home}\"' >> ~/.bashrc  # bash\necho 'export MRTASK_HOME=\"${home}\"' >> ~/.zshrc   # zsh\n`;
  const fish = `# fish\nset -Ux MRTASK_HOME \"${home}\"\n`;
  const ps = `# PowerShell\nsetx MRTASK_HOME \"${home}\"\n# current session only:\n$env:MRTASK_HOME=\"${home}\"\n`;
  const cmd = `# CMD\nsetx MRTASK_HOME \"${home}\"\n`;
  let guide = header;
  if (process.platform === "win32") guide += `${ps}\n${cmd}`; else guide += `${bash}\n${fish}`;
  console.log(guide.trim());
}

export function sanitizeBranchForPath(branch: string) {
  return String(branch).replace(/[^A-Za-z0-9._\/-]+/g, "-");
}

export async function writeFileAtomic(p: string, data: string) {
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, p);
}

export function gitWorktreeAdd(targetDir: string, branch: string, repoCwd: string) {
  git(["worktree", "add", targetDir, branch], { cwd: repoCwd });
}

