import path from "node:path";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import fg from "fast-glob";
import { MR_DIRNAME, readYaml, realpathSafe, statStatusFromPath } from "./utils.js";
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
    }
  }
  return null;
}
