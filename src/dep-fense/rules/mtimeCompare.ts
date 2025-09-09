import fs from 'node:fs';
import path from 'node:path';
import { Rule } from '../types.js';
import { gitTrackedFiles } from '../utils/git.js';
import { compile, matches } from '../utils/glob.js';

export type MtimeCompareOptions = {
  groupA: string[];
  groupB: string[];
  action?: 'error' | 'warn';
  epsilonMs?: number; // tolerate small clock/resolution differences
  onlyTracked?: boolean; // default true
};

export function mtimeCompareRule(opts: MtimeCompareOptions): Rule {
  const {
    groupA,
    groupB,
    action = 'error',
    epsilonMs = 1500,
    onlyTracked = true,
  } = opts;

  const setA = compile(groupA);
  const setB = compile(groupB);

  return {
    name: 'mtime-compare',
    async run(ctx) {
      const files = onlyTracked ? gitTrackedFiles(ctx.cwd) : listAllFiles(ctx.cwd);

      let maxB = Number.NEGATIVE_INFINITY;
      const newerA: string[] = [];

      for (const f of files) {
        const rel = f.replace(/\\/g, '/');
        // Max mtime of B
        if (matches(rel, setB)) {
          try {
            const t = fs.statSync(path.join(ctx.cwd, rel)).mtimeMs;
            if (Number.isFinite(t)) maxB = Math.max(maxB, t);
          } catch { /* ignore */ }
        }
      }

      if (!Number.isFinite(maxB)) return; // no B files -> do nothing

      for (const f of files) {
        const rel = f.replace(/\\/g, '/');
        if (!matches(rel, setA)) continue;
        try {
          const t = fs.statSync(path.join(ctx.cwd, rel)).mtimeMs;
          if (Number.isFinite(t) && t > maxB + epsilonMs) newerA.push(rel);
        } catch { /* ignore */ }
      }

      if (newerA.length) {
        const message = `Files in groupA are newer than groupB (maxB=${new Date(maxB).toISOString()}).`;
        if (action === 'warn') ctx.warn('mtime-compare', { message, files: newerA, meta: { maxB, epsilonMs } });
        else ctx.fail('mtime-compare', { message, files: newerA, meta: { maxB, epsilonMs } });
      }
    }
  };
}

function listAllFiles(cwd: string): string[] {
  // Fallback: enumerate via git ignored files excluded by default would be complex;
  // we keep it simple: rely on gitTrackedFiles by default. This is a conservative fallback.
  return gitTrackedFiles(cwd);
}

