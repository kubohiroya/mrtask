import path from "node:path";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import fg from "fast-glob";
import { MR_DIRNAME, readYaml, realpathSafe, statStatusFromPath } from "./utils.js";
import type { Task } from "./types.js";

export async function listTaskFilesUnder(pkgDir: string): Promise<string[]> {
  const base = path.join(pkgDir, MR_DIRNAME);
  if (!fss.existsSync(base)) return [];
  return fg(["**/*.yml", "**/*.yaml"], { cwd: base, absolute: true, onlyFiles: true });
}

export async function loadTaskFromFile(foundPath: string): Promise<Task & { filePath: string; linkPath?: string }> {
  const real = await realpathSafe(foundPath);
  const y = await readYaml<any>(real);
  const t: Task = {
    id: y?.id ?? path.basename(real).replace(/\.(ya?ml)$/i, ""),
    createdAt: y?.createdAt ?? new Date().toISOString(),
    branch: y?.branch ?? "",
    title: y?.title ?? "",
    description: y?.description,
    status: y?.status ?? statStatusFromPath(real),
    primaryDir: y?.primaryDir ?? "",
    workDirs: y?.workDirs ?? [],
    tags: y?.tags ?? [],
    checklist: y?.checklist ?? [],
    relatedPRs: y?.relatedPRs ?? [],
    assignees: y?.assignees ?? [],
  };
  return { ...t, filePath: real, linkPath: real !== foundPath ? foundPath : undefined };
}

export async function findTaskById(pkgs: string[], id: string) {
  for (const d of pkgs) {
    const files = await listTaskFilesUnder(d);
    for (const f of files) {
      if (path.basename(f).startsWith(id)) {
        return loadTaskFromFile(f);
      }
      // YAMLのid一致も見る
      const t = await loadTaskFromFile(f);
      if (t.id === id) return t;
    }
  }
  return null;
}
