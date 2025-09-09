import { execFileSync } from "node:child_process";
import { git } from "./utils.js";
import type { PRSpec } from "./builder.js";

function ghAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getRemoteUrl(remote: string, cwd: string): string | null {
  try {
    return git(["remote", "get-url", remote], { cwd });
  } catch {
    return null;
  }
}

function toGithubHttps(remoteUrl: string): string | null {
  // git@github.com:user/repo.git -> https://github.com/user/repo
  const ssh = remoteUrl.match(/^git@github\.com:([^#]+?)(?:\.git)?$/i);
  if (ssh) return `https://github.com/${ssh[1]}`.replace(/\.git$/, "");
  // https://github.com/user/repo(.git)?
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^#]+?)(?:\.git)?$/i);
  if (https) return `https://github.com/${https[1]}`.replace(/\.git$/, "");
  return null;
}

export function buildCompareUrl(remoteUrl: string | null, base: string, head: string): string | null {
  if (!remoteUrl) return null;
  const gh = toGithubHttps(remoteUrl);
  if (!gh) return null;
  const enc = (s: string) => encodeURIComponent(s);
  return `${gh}/compare/${enc(base)}...${enc(head)}`;
}

function remoteBranchExists(remote: string, branch: string, cwd: string): boolean {
  try {
    const out = git(["ls-remote", "--heads", remote, branch], { cwd });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function ensurePushed(remote: string, branch: string, cwd: string) {
  // リモートにブランチが無ければ作成（refs で明示）
  if (!remoteBranchExists(remote, branch, cwd)) {
    git(["push", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd });
  }
  // Upstream（追跡ブランチ）も設定しておく（現在のブランチでなくてもOK）
  try {
    git(["branch", "--set-upstream-to", `${remote}/${branch}`, branch], { cwd });
  } catch {
    // set-upstream に失敗しても致命ではないので無視
  }
}

export function createPRWithGh(spec: PRSpec, opts: { draft?: boolean; base: string; cwd: string }): string {
  if (!ghAvailable()) throw new Error("gh CLI not available");
  const args = ["pr", "create", "--title", spec.title, "--body", spec.body, "--base", opts.base];
  if (opts.draft) args.push("--draft");
  const out = execFileSync("gh", args, { cwd: opts.cwd, encoding: "utf8" }).trim();
  const url = out.split(/\s+/).find((s) => s.startsWith("http"));
  return url ?? out;
}

export function openInBrowser(url: string) {
  try { execFileSync("open", [url]); return; } catch {}
  try { execFileSync("xdg-open", [url]); return; } catch {}
  try { execFileSync("cmd", ["/c", "start", "", url]); } catch {}
}

export function planPR(spec: PRSpec, compareUrl: string | null): string {
  const lines: string[] = [];
  lines.push("=== PR DRAFT (dry-run) ===");
  lines.push("");
  lines.push(`# ${spec.title}`);
  lines.push("");
  lines.push(spec.body);
  lines.push("");
  lines.push(`Compare: ${compareUrl ?? "(no compare URL available)"}`);
  return lines.join("\n");
}

export function findOpenPrNumberByHead(branch: string, cwd: string): number | null {
  try {
    const out = execFileSync("gh", [
      "pr", "list", "--state", "open", "--head", branch, "--json", "number", "-q", ".[0].number"
    ], { cwd, encoding: "utf8" }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function mergePrWithGh(pr: string | number, opts: { strategy: 'squash' | 'merge' | 'rebase'; deleteBranch?: boolean; yes?: boolean; cwd: string }): void {
  const args = ["pr", "merge", String(pr), `--${opts.strategy}`];
  if (opts.deleteBranch) args.push("--delete-branch");
  if (opts.yes) args.push("--yes");
  execFileSync("gh", args, { cwd: opts.cwd, stdio: "inherit" });
}
