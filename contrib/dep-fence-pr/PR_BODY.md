# PR: Add three guard rules (mtime-compare, allowed-dirs, pessimistic-lock)

## Motivation
Monorepo teams using `git worktree` need predictable, lightweight guardrails that work before commit and at push/CI time. This PR proposes three minimal rules that cover the most common failure modes without hidden heuristics or state.

## Summary
- mtime-compare (light): warn/error when any file in group A is newer than the newest file in group B.
- allowed-dirs: error when a commit includes staged files outside an allowlist of directories.
- pessimistic-lock (heavy): error if upstream has commits by other authors touching protected files since the caller’s base (merge-base of HEAD vs upstream or origin/main).

All rules share a simple shape and have no repo-specific dependencies beyond calling `git`.

## API (TypeScript)
```ts
import { Rule } from 'dep-fence';

export type MtimeCompareOptions = {
  groupA: string[]; // globs
  groupB: string[]; // globs
  action?: 'error' | 'warn';
  epsilonMs?: number; // default 1500
  onlyTracked?: boolean; // default true
};

export declare function mtimeCompareRule(opts: MtimeCompareOptions): Rule;

export type AllowedDirsOptions = {
  allow: string[]; // globs
  action?: 'error' | 'warn';
};

export declare function allowedDirsRule(opts: AllowedDirsOptions): Rule;

export type PessimisticLockOptions = {
  watch: string[]; // globs
  baseRef?: string; // default: upstream if present else origin/main
  allowedAuthors?: string[]; // default: current git user.email
  action?: 'error' | 'warn';
};

export declare function pessimisticLockRule(opts: PessimisticLockOptions): Rule;
```

## Usage
Single project-wide config (predictable ordering):
```ts
// dep-fense.config.ts
import {
  mtimeCompareRule,
  allowedDirsRule,
  pessimisticLockRule,
} from 'dep-fence/rules';

export default [
  allowedDirsRule({
    allow: ['packages/**', 'src/**', 'README.md', 'LICENSE', '.github/**'],
    action: 'error',
  }),
  mtimeCompareRule({
    groupA: ['packages/**', 'src/**', '!**/dist/**', '!**/.cache/**', '!**/coverage/**', '!**/node_modules/**'],
    groupB: ['dep-fence.config.ts', 'packages/**/.mrtask/**'],
    action: 'warn',
    epsilonMs: 1500,
  }),
  pessimisticLockRule({
    watch: ['packages/**', 'src/**', '!**/dist/**', '!**/.cache/**', '!**/coverage/**', '!**/node_modules/**'],
    action: 'error',
  }),
];
```

## Implementation Notes
- Globbing: minimal engine supporting `**`, `*`, `?`, and leading `!` excludes; paths normalized to `/`.
- Git: uses `git` CLI (`rev-parse`, `merge-base`, `rev-list`, `show`, `diff`, `ls-files`). No fetch is performed implicitly.
- Predictability: no hidden state; failure messages list the offending files and the rule name.

## Tests
- Unit tests for glob matching edge cases.
- Mocks for git helpers to simulate staged files, upstream commits, and changed-file sets.
- Golden tests for rule outcomes (warn/error) and file listings.

## Backward Compatibility
- Fully additive. Rules are opt-in and configured in user’s `dep-fence.config.ts`.

## Alternatives Considered
- mtime via file-watches (rejected: cross-platform variance and complexity).
- Rename detection in pessimistic-lock (deferred: can be added with `--find-renames` if desired).

## Checklist
- [x] Docs with examples
- [x] Type-safe options
- [x] Helpful error messages with file lists
- [x] Tests (unit + integration-ready mocks)
