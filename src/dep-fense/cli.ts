#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runRules } from './engine.js';
import type { GuardMode, Rule } from './types.js';

async function main() {
  const mode = (process.argv.includes('--mode')
    ? (process.argv[process.argv.indexOf('--mode') + 1] as GuardMode)
    : 'pre-commit') as GuardMode;

  const cfgPath = resolveConfigPath();
  const configMod = await import(pathToFileURL(cfgPath).toString());
  const rules: Rule[] = (configMod.default ?? configMod.rules) as Rule[];
  if (!Array.isArray(rules)) {
    console.error('dep-fence: config must export default Rule[]');
    process.exit(2);
  }

  const result = await runRules(rules, mode, process.cwd());

  for (const w of result.warnings) {
    console.warn(`WARN [${w.name}] ${w.message}`);
    if (w.files?.length) w.files.forEach(f => console.warn(`  - ${f}`));
  }
  if (result.failures.length) {
    for (const f of result.failures) {
      console.error(`ERROR [${f.name}] ${f.message}`);
      if (f.files?.length) f.files.forEach(ff => console.error(`  - ${ff}`));
    }
    process.exit(1);
  }
}

function resolveConfigPath(): string {
  const cwd = process.cwd();
  const env = process.env.DEP_FENCE_CONFIG;
  if (env) return path.resolve(cwd, env);
  const inDot = path.resolve(cwd, '.mrtask', 'dep-fence.config.ts');
  if (fs.existsSync(inDot)) return inDot;
  return path.resolve(cwd, 'dep-fence.config.ts');
}

main().catch((e) => {
  console.error('dep-fence: fatal', e);
  process.exit(1);
});
