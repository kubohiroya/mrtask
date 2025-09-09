import { execSync, spawnSync } from 'node:child_process';

export function git(args: string[], opts: { cwd?: string; stdio?: 'pipe'|'inherit' } = {}) {
  const res = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', stdio: opts.stdio ?? 'pipe' });
  if (res.status !== 0) {
    const msg = res.stderr?.toString() || `git ${args.join(' ')} failed with code ${res.status}`;
    throw new Error(msg);
  }
  return res.stdout?.toString() ?? '';
}

export function gitTry(args: string[], opts: { cwd?: string } = {}) {
  try { return git(args, opts); } catch { return ''; }
}

export function gitTrackedFiles(cwd = process.cwd()): string[] {
  const out = git(['ls-files', '-z'], { cwd });
  return out.split('\u0000').filter(Boolean);
}

export function gitStagedFiles(cwd = process.cwd()): string[] {
  const out = gitTry(['diff', '--name-only', '--cached'], { cwd });
  return out.split('\n').filter(Boolean);
}

export function gitUnstagedFiles(cwd = process.cwd()): string[] {
  const out = gitTry(['diff', '--name-only'], { cwd });
  return out.split('\n').filter(Boolean);
}

export function gitUserEmail(cwd = process.cwd()): string | null {
  const out = gitTry(['config', 'user.email'], { cwd }).trim();
  return out || null;
}

export function gitUpstreamRef(cwd = process.cwd()): string | null {
  const out = gitTry(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd }).trim();
  return out || null;
}

export function gitMergeBase(a: string, b: string, cwd = process.cwd()): string | null {
  const out = gitTry(['merge-base', a, b], { cwd }).trim();
  return out || null;
}

export function gitCommitsExclusive(ancestor: string, head: string, cwd = process.cwd()): string[] {
  const out = gitTry(['rev-list', '--no-merges', `${ancestor}..${head}`], { cwd });
  return out.split('\n').filter(Boolean);
}

export function gitCommitAuthorEmail(commit: string, cwd = process.cwd()): string | null {
  const out = gitTry(['show', '-s', '--format=%ae', commit], { cwd }).trim();
  return out || null;
}

export function gitCommitChangedFiles(commit: string, cwd = process.cwd()): string[] {
  const out = gitTry(['diff', '--name-only', `${commit}^!`], { cwd });
  return out.split('\n').filter(Boolean);
}
