import { Rule } from '../types.js';
import { compile, matches } from '../utils/glob.js';
import {
  gitMergeBase,
  gitUpstreamRef,
  gitUserEmail,
  gitCommitsExclusive,
  gitCommitAuthorEmail,
  gitCommitChangedFiles,
} from '../utils/git.js';

export type UpstreamConflictOptions = {
  watch: string[]; // globs for files to protect
  baseRef?: string; // default: upstream if exists, else origin/main
  allowedAuthors?: string[]; // default: current user email only
  action?: 'error' | 'warn';
};

export function upstreamConflictRule(opts: UpstreamConflictOptions): Rule {
  const { watch, baseRef, allowedAuthors, action = 'error' } = opts;
  const set = compile(watch);

  return {
    name: 'upstream-conflict',
    async run(ctx) {
      const cwd = ctx.cwd;
      const upstream = baseRef || gitUpstreamRef(cwd) || 'origin/main';
      const base = gitMergeBase('HEAD', upstream, cwd);
      if (!base) return; // cannot determine; stay silent

      const commits = gitCommitsExclusive(base, upstream, cwd);
      if (commits.length === 0) return; // nothing new upstream

      const me = gitUserEmail(cwd);
      const allow = new Set((allowedAuthors && allowedAuthors.length ? allowedAuthors : (me ? [me] : [])).map(s => s.toLowerCase()));

      const offenders: { commit: string; author: string | null; files: string[] }[] = [];

      for (const c of commits) {
        const author = (gitCommitAuthorEmail(c, cwd) || '').toLowerCase();
        if (allow.has(author)) continue; // skip self/allowed authors
        const files = gitCommitChangedFiles(c, cwd);
        const hit = files.filter(f => matches(f.replace(/\\/g, '/'), set));
        if (hit.length) offenders.push({ commit: c, author, files: hit });
      }

      if (offenders.length) {
        const files = Array.from(new Set(offenders.flatMap(o => o.files)));
        const message = `Upstream has commits by other authors touching protected files since base (${upstream}).`;
        if (action === 'warn') ctx.warn('upstream-conflict', { message, files, meta: { upstream, count: offenders.length } });
        else ctx.fail('upstream-conflict', { message, files, meta: { upstream, count: offenders.length } });
      }
    }
  };
}

