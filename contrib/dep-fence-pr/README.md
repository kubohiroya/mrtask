# dep-fense PR bundle

This folder packages three new rules intended for a PR to dep-fence:

- mtime-compare: warn/error when any file in group A is newer than the newest in group B.
- allowed-dirs: error when staged files include paths outside an allowlist.
- pessimistic-lock: error when upstream has commits by other authors touching protected files since your base.

Contents
- src/rules/*.ts — rule implementations
- src/utils/*.ts — tiny helpers (glob, git)
- src/types.ts, src/index.ts — lightweight Rule interfaces and exports
- test/*.test.ts — Vitest tests with mocks for git helpers
- PR_BODY.md — ready-to-paste pull request text

Run tests from the repo root:

```bash
pnpm test
```

Copy guidance for PR
- Drop `src/` files into dep-fence’s codebase under an appropriate location (e.g., `src/rules/` + shared utils or existing helpers).
- Adapt imports to dep-fence’s core types (Rule/Context) if they differ.
- Include parts of `PR_BODY.md` into the PR description.
