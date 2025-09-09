import path from 'node:path';
import { Rule } from '../types.js';
import { compile, matches } from '../utils/glob.js';
import { gitStagedFiles } from '../utils/git.js';

export type AllowedDirsOptions = {
  allow: string[]; // directory globs, e.g. ['packages/foo/**', 'src/**']
  action?: 'error' | 'warn';
};

export function allowedDirsRule(opts: AllowedDirsOptions): Rule {
  const { allow, action = 'error' } = opts;
  const allowSet = compile(allow);

  return {
    name: 'allowed-dirs',
    async run(ctx) {
      // Commit hook use case: check staged files only
      const staged = gitStagedFiles(ctx.cwd).map((f) => f.replace(/\\/g, '/'));
      if (staged.length === 0) return;

      const outside = staged.filter((f) => !matches(f, allowSet));
      if (outside.length) {
        const message = 'Staged files outside allowed directories were found.';
        if (action === 'warn') ctx.warn('allowed-dirs', { message, files: outside });
        else ctx.fail('allowed-dirs', { message, files: outside });
      }
    },
  };
}

