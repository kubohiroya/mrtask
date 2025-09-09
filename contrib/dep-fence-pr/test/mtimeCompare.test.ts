import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mtimeCompareRule } from '../src/rules/mtimeCompare.js';

function touch(p: string, ms: number) {
  fs.writeFileSync(p, 'x');
  const t = new Date(ms);
  fs.utimesSync(p, t, t);
}

describe('mtime-compare', () => {
  it('warns when A newer than max(B)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-mtime-'));
    const a = path.join(dir, 'src/a.ts');
    const b = path.join(dir, 'dep-fence.config.ts');
    fs.mkdirSync(path.dirname(a), { recursive: true });
    touch(b, Date.now() - 10_000);
    touch(a, Date.now());

    vi.doMock('../src/utils/git.ts', () => ({
      gitTrackedFiles: () => [path.relative(dir, a), path.relative(dir, b)],
    }));
    const { mtimeCompareRule: ruleFactory } = await import('../src/rules/mtimeCompare.js');
    const rule = ruleFactory({
      groupA: ['src/**'],
      groupB: ['dep-fence.config.ts'],
      action: 'warn',
      onlyTracked: true,
      epsilonMs: 0,
    });

    const warnings: any[] = [];
    const ctx = { mode: 'manual', cwd: dir, warn: (n: string, p: any) => warnings.push(p), fail: () => {} } as any;
    await rule.run(ctx);
    expect(warnings.length).toBe(1);
    expect(warnings[0].files).toContain('src/a.ts');
  });
});
