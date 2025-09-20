import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import * as fss from 'node:fs';
import fs from 'node:fs/promises';
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin } from './helpers.js';
import YAML from 'yaml';

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe('guards option writes YAML and config appropriately', () => {
  it('--guards error writes guards.level=error and generates error rule', async () => {
    const repo = await makeTempRepo();
    // precreate package dir to force fallback worktree (sibling)
    await fs.mkdir(path.join(repo, 'packages', 'app'), { recursive: true });
    const out = runNodeBin(cli(), ['add', 'feature/g1', 'g1', 'packages/app', '--guards', 'error'], repo);
    const match = out.match(/YAML: (.+)\n\s+Worktree: (.+) on branch/);
    expect(match).toBeTruthy();
    const yamlRel = match![1];
    const wtRel = match![2];
    const yamlAbs = path.resolve(repo, yamlRel);
    const wtAbs = path.resolve(repo, wtRel);
    const repoParent = path.dirname(repo);
    expect(path.relative(repoParent, wtAbs)).not.toMatch(/^\.\./);
    const y = YAML.parse(await fs.readFile(yamlAbs, 'utf8'));
    expect(y.guards?.level).toBe('error');
    const cfg = path.join(wtAbs, '.mrtask', 'dep-fence.config.ts');
    expect(fss.existsSync(cfg)).toBe(true);
    const text = await fs.readFile(cfg, 'utf8');
    expect(text).toMatch(/action: 'error'|action: \"error\"/);
  });

  it('--guards ignore writes guards.level=ignore and skips config generation', async () => {
    const repo = await makeTempRepo();
    await fs.mkdir(path.join(repo, 'packages', 'app'), { recursive: true });
    const out = runNodeBin(cli(), ['add', 'feature/g2', 'g2', 'packages/app', '--guards', 'ignore'], repo);
    const match = out.match(/YAML: (.+)\n\s+Worktree: (.+) on branch/);
    expect(match).toBeTruthy();
    const yamlAbs = path.resolve(repo, match![1]);
    const wtAbs = path.resolve(repo, match![2]);
    const repoParent = path.dirname(repo);
    expect(path.relative(repoParent, wtAbs)).not.toMatch(/^\.\./);
    const y = YAML.parse(await fs.readFile(yamlAbs, 'utf8'));
    expect(y.guards?.level).toBe('ignore');
    const cfg = path.join(wtAbs, '.mrtask', 'dep-fence.config.ts');
    expect(fss.existsSync(cfg)).toBe(false);
  });
});
