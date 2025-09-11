import path from "node:path";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import fg from "fast-glob";
import { MR_DIRNAME, readYaml, realpathSafe, statStatusFromPath } from "./utils.js";
import crypto from "node:crypto";
import type { Task } from "./types.js";

export async function listTaskFilesUnder(pkgOrRootDir: string): Promise<string[]> {
  const base = path.join(pkgOrRootDir, MR_DIRNAME);
  if (!fss.existsSync(base)) return [];
  // Exclude worktree and output areas under .mrtask
  return fg(["**/*.yml", "**/*.yaml", "!wt/**", "!out/**"], {
    cwd: base,
    absolute: true,
    onlyFiles: true,
    ignore: ["wt/**", "out/**"],
  });
}

export async function loadTaskFromFile(foundPath: string): Promise<Task & { filePath: string; linkPath?: string }> {
  const real = await realpathSafe(foundPath);
  const y = await readYaml<any>(real);

  // パスから status を優先的に決定（done/cancel ディレクトリならそれを採用）
  const status = statStatusFromPath(real) ?? y?.status ?? "open";

  const t: Task = {
    id: y?.id ?? path.basename(real).replace(/\.(ya?ml)$/i, ""),
    createdAt: y?.createdAt ?? new Date().toISOString(),
    branch: y?.branch ?? "",
    title: y?.title ?? "",
    description: y?.description,
    status,
    primaryDir: y?.primaryDir ?? "",
    workDirs: y?.workDirs ?? [],
    // Prefer new guards.level; map legacy strict if present
    guards: y?.guards?.level ? { level: y.guards.level } : (typeof y?.strict === 'boolean' ? { level: y.strict ? 'error' : 'warn' } : undefined),
    strict: typeof y?.strict === 'boolean' ? y.strict : undefined,
    mode: y?.mode ?? undefined,
    parentId: y?.parentId ?? undefined,
    tags: y?.tags ?? [],
    checklist: y?.checklist ?? [],
    relatedPRs: y?.relatedPRs ?? [],
    assignees: y?.assignees ?? [],
  };
  return { ...t, filePath: real, linkPath: real !== foundPath ? foundPath : undefined };
}

export async function findTaskById(searchDirs: string[], id: string) {
  for (const d of searchDirs) {
    const files = await listTaskFilesUnder(d);
    for (const f of files) {
      // まずファイル名プレフィックス一致
      if (path.basename(f).startsWith(id)) {
        return loadTaskFromFile(f);
      }
      // 次に YAML の id 一致
      const t = await loadTaskFromFile(f);
      if (t.id === id) return t;
      // 最後に短いハッシュ一致（mrtask list の8桁ハッシュ）
      const short = crypto.createHash("sha256").update(t.id).digest("hex").slice(0, 8);
      if (short === id) return t;
    }
  }
  return null;
}

export async function findTaskByBranch(searchDirs: string[], branch: string) {
  for (const d of searchDirs) {
    const files = await listTaskFilesUnder(d);
    for (const f of files) {
      const t = await loadTaskFromFile(f);
      if ((t.branch ?? '') === branch) return t;
    }
  }
  return null;
}
