import { describe, it, expect, vi, beforeEach } from 'vitest';
import { allowedDirsRule } from '../src/rules/allowedDirs.js';

vi.mock('../src/utils/git.ts', () => ({
  gitStagedFiles: () => ['src/a.ts', 'docs/readme.md'],
}));

function makeCtx() {
  const warnings: any[] = [];
  const failures: any[] = [];
  return {
    ctx: {
      mode: 'pre-commit' as const,
      cwd: process.cwd(),
      warn: (name: string, p: any) => warnings.push({ name, ...p }),
      fail: (name: string, p: any) => failures.push({ name, ...p }),
    },
    warnings,
    failures,
  };
}

describe('allowed-dirs', () => {
  it('fails when staged includes paths outside allow', async () => {
    const rule = allowedDirsRule({ allow: ['src/**'], action: 'error' });
    const { ctx, failures } = makeCtx();
    await rule.run(ctx as any);
    expect(failures.length).toBe(1);
    expect(failures[0].files).toContain('docs/readme.md');
  });
});

