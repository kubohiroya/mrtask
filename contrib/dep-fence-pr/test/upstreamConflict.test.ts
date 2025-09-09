import { describe, it, expect, vi } from 'vitest';
import { upstreamConflictRule } from '../src/rules/upstreamConflict.js';

vi.mock('../src/utils/git.ts', () => ({
  gitUpstream: () => 'origin/main',
  gitMergeBase: () => 'BASE',
  gitRevListExclusive: () => ['C1', 'C2'],
  gitCommitAuthorEmail: (c: string) => (c === 'C1' ? 'other@example.com' : 'me@example.com'),
  gitCommitChangedFiles: (c: string) => (c === 'C1' ? ['packages/app/file.ts'] : ['README.md']),
  gitUserEmail: () => 'me@example.com',
}));

function makeCtx() {
  const warnings: any[] = [];
  const failures: any[] = [];
  return {
    ctx: {
      mode: 'pre-push' as const,
      cwd: process.cwd(),
      warn: (name: string, p: any) => warnings.push({ name, ...p }),
      fail: (name: string, p: any) => failures.push({ name, ...p }),
    },
    warnings,
    failures,
  };
}

describe('upstream-conflict', () => {
  it('fails when upstream has other-author commits touching watch', async () => {
    const rule = upstreamConflictRule({ watch: ['packages/**'], action: 'error' });
    const { ctx, failures } = makeCtx();
    await rule.run(ctx as any);
    expect(failures.length).toBe(1);
  });

  it('does not fail when author is allowed', async () => {
    const rule = upstreamConflictRule({ watch: ['packages/**'], action: 'error', allowedAuthors: ['other@example.com'] });
    const { ctx, failures } = makeCtx();
    await rule.run(ctx as any);
    expect(failures.length).toBe(0);
  });
});
