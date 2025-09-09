// Central guard configuration for mrtask itself.
// Uses dep-fence 0.3.0 guard rules. You can override this file path
// by setting DEP_FENCE_CONFIG to a custom config.

import {
  allowedDirsRule,
  mtimeCompareRule,
  upstreamConflictRule,
  type Rule,
} from 'dep-fence/guards';

const rules: Rule[] = [
  // Keep permissive defaults for this repository to avoid blocking contributors.
  // Downstream consumers should tailor these globs to their monorepo layout.
  allowedDirsRule({
    allow: [
      '**/*',
      '!node_modules/**',
      '!**/dist/**',
      '!**/.cache/**',
      '!**/coverage/**',
    ],
    action: 'error', // enforce on pre-commit/pre-push
  }),

  mtimeCompareRule({
    groupA: ['src/**'],
    groupB: ['.mrtask/dep-fence.config.ts'],
    action: 'warn',
    epsilonMs: 5000,
  }),

  upstreamConflictRule({
    watch: ['src/**', '.mrtask/**', 'README*.md'],
    action: 'warn', // keep non-blocking for this repo; downstream can set to 'error'
  }),
];

export default rules;

