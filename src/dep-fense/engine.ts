import { GuardContext, GuardMode, Rule, RunResult } from './types.js';

export async function runRules(rules: Rule[], mode: GuardMode, cwd = process.cwd()): Promise<RunResult> {
  const warnings: RunResult['warnings'] = [];
  const failures: RunResult['failures'] = [];

  const ctx: GuardContext = {
    mode,
    cwd,
    warn(name, p) { warnings.push({ name, message: p.message, files: p.files }); },
    fail(name, p) { failures.push({ name, message: p.message, files: p.files }); },
  };

  for (const r of rules) {
    try {
      await r.run(ctx);
    } catch (e: any) {
      failures.push({ name: r.name, message: e?.message ?? String(e) });
    }
  }

  return { warnings, failures };
}

