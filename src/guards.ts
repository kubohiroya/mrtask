import path from 'node:path';
import * as fss from 'node:fs';
import fs from 'node:fs/promises';
import { MR_DIRNAME, ensureDir } from './utils.js';
import { listTaskFilesUnder, loadTaskFromFile } from './tasks.js';

export type GuardsLevel = 'ignore'|'warn'|'error';

function levelRank(l: GuardsLevel | undefined): number {
  if (l === 'error') return 2;
  if (l === 'warn' || l == null) return 1; // default behavior
  return 0; // ignore
}

export async function computeBranchUnion(root: string, branch: string, pkgRoots: string[]) {
  const search = [root, ...pkgRoots];
  const found = (await Promise.all(search.map(d => listTaskFilesUnder(d)))).flat();
  const allow = new Set<string>();
  let maxLevel: GuardsLevel = 'ignore';
  for (const f of found) {
    const t = await loadTaskFromFile(f);
    if ((t.status ?? 'open') !== 'open') continue;
    if ((t.branch ?? '') !== branch) continue;
    const level: GuardsLevel | undefined = (t.guards as any)?.level;
    if (levelRank(level) > levelRank(maxLevel)) maxLevel = (level ?? 'warn') as GuardsLevel;
    allow.add(`${(t.primaryDir || '').replace(/\\/g, '/')}/**`);
    for (const d of (t.workDirs ?? [])) allow.add(`${d.replace(/\\/g, '/')}/**`);
  }
  return { allow: Array.from(allow).filter(Boolean).sort(), level: maxLevel };
}

export async function writeGuardsConfig(worktreeRoot: string, allow: string[], level: GuardsLevel) {
  const cfgDir = path.join(worktreeRoot, MR_DIRNAME);
  await ensureDir(cfgDir);
  const cfgPath = path.join(cfgDir, 'dep-fence.config.ts');
  if (level === 'ignore' || allow.length === 0) {
    try { await fs.rm(cfgPath, { force: true }); } catch {}
    return;
  }
  const action = level === 'error' ? 'error' : 'warn';
  const cfg = `import { allowedDirsRule } from 'dep-fence/guards';\nexport default [allowedDirsRule({ allow: ${JSON.stringify(allow)}, action: '${action}' })];\n`;
  await fs.writeFile(cfgPath, cfg, 'utf8');
}

