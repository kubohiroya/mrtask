#!/usr/bin/env tsx
import fs from 'node:fs';
import path from 'node:path';

function installHook(name: string, lines: string[]) {
  const hookDir = path.resolve(process.cwd(), '.git', 'hooks');
  if (!fs.existsSync(hookDir)) {
    console.error('No .git/hooks directory found. Is this a git repo?');
    return;
  }
  const p = path.join(hookDir, name);
  if (fs.existsSync(p)) {
    console.log(`hook exists: ${name} (skipped)`);
    return;
  }
  const content = lines.join('\n') + '\n';
  fs.writeFileSync(p, content, { mode: 0o755 });
  console.log(`hook installed: ${name}`);
}

installHook('pre-commit', [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'pnpm run guard -- --mode pre-commit',
]);

installHook('pre-push', [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'pnpm run guard -- --mode pre-push',
]);

