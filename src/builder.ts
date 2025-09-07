import path from "node:path";
import { git } from "./utils.js";
import type { Task } from "./types.js";

export type DiffSummary = {
  all: string[];
  byWorkDir: Record<string, string[]>;
};

export type PRSpec = {
  title: string;
  body: string;
  base: string;
  head: string;
  compareUrl?: string | null;
};

function unique<T>(arr: T[]) { return Array.from(new Set(arr)); }

export function gitDiffNames(base: string, headRef: string, cwd: string): string[] {
  const out = git(["diff", "--name-only", `${base}...${headRef}`], { cwd });
  return out.split("\n").map(s => s.trim()).filter(Boolean);
}

export function summariseByWorkDir(files: string[], workDirs: string[]): DiffSummary {
  const byWorkDir: Record<string, string[]> = {};
  for (const wd of workDirs) byWorkDir[wd] = [];
  for (const f of files) {
    const match = workDirs
      .filter(wd => f === wd || f.startsWith(wd + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (match) byWorkDir[match].push(f);
  }
  for (const k of Object.keys(byWorkDir)) {
    byWorkDir[k] = unique(byWorkDir[k]).sort();
  }
  return { all: unique(files).sort(), byWorkDir };
}

function workDirNames(workDirs: string[]): string[] {
  return workDirs.map(wd => {
    const parts = wd.split(/[\\/]/g).filter(Boolean);
    return parts[parts.length - 1] || wd;
  });
}

export function makeTitle(task: Task, diff: DiffSummary): string {
  const names = workDirNames(task.workDirs ?? []);
  const scope = names.length ? `[${names.join(",")}] ` : "";
  const baseTitle = task.title || task.id;
  return `${scope}${baseTitle} (mrtask:${task.id})`;
}

export function makeBody(task: Task, diff: DiffSummary, repoRootRel = "."): string {
  const names = workDirNames(task.workDirs ?? []);
  const affected = names.length ? names.join(", ") : "(unknown)";
  const lines: string[] = [];
  lines.push("## Summary");
  lines.push(task.description || "(no description)");
  lines.push("");
  lines.push("## Scope");
  lines.push(`- Branch: \`${task.branch}\``);
  lines.push(`- WorkDirs: ${task.workDirs?.join(", ") || "(none)"}`);
  lines.push(`- Affected packages: ${affected}`);
  lines.push("");
  lines.push("## Changes");
  if (diff.all.length === 0) {
    lines.push("- (no committed changes vs base)");
  } else {
    for (const [wd, files] of Object.entries(diff.byWorkDir)) {
      if (files.length === 0) continue;
      lines.push(`- ${wd}`);
      for (const f of files) lines.push(`  - \`${f}\``);
    }
  }
  lines.push("");
  lines.push("## Test Plan");
  lines.push("- [ ] Unit/E2E as appropriate");
  lines.push("");
  lines.push("## Checklist");
  lines.push("- [ ] Docs updated");
  lines.push("- [ ] Types stable / no breaking API");
  lines.push("");
  lines.push("## Related");
  lines.push(`- Task: \`.mrtask/${task.id}.yml\``);
  return lines.join("\n");
}

export function buildPRSpec(task: Task, base: string, repoRoot: string): PRSpec {
  const files = gitDiffNames(base, task.branch, repoRoot);
  const diff = summariseByWorkDir(files, task.workDirs ?? []);
  const title = makeTitle(task, diff);
  const body = makeBody(task, diff);
  return { title, body, base, head: task.branch };
}
