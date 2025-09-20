import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import * as fss from 'node:fs';
import fs from 'node:fs/promises';
import fg from 'fast-glob';
import YAML from 'yaml';
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin } from './helpers.js';

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe('mrtask add (shared) end-to-end', () => {
  it('adds a shared task under a parent and prints paths', async () => {
    const repo = await makeTempRepo();
    await fs.mkdir(path.join(repo, 'packages', 'app'), { recursive: true });

    // Create a full (isolated) parent task
    const outCreate = runNodeBin(
      cli(),
      ['create', 'feature/parent', 'parent', 'packages/app'],
      repo,
    );
    const m1 = outCreate.match(/YAML: (.+)\n\s+Worktree: (.+) on branch ([^\n]+)/);
    expect(m1).toBeTruthy();
    const parentYamlRel = m1![1];
    const parentWtRel = m1![2];
    const parentWtAbs = path.resolve(repo, parentWtRel);
    const repoParent = path.dirname(repo);
    expect(path.relative(repoParent, parentWtAbs)).not.toMatch(/^\.\./);

    // Add a shared child task pointing to the parent
    const outAdd = runNodeBin(
      cli(),
      ['add', 'child-shared', 'packages/app', '--parent', parentYamlRel],
      repo,
    );
    expect(outAdd).toContain('✔ Added shared task');
    const m2 = outAdd.match(/YAML: (.+)\n\s+Worktree: (.+) on branch ([^\n]+)/);
    expect(m2).toBeTruthy();
    const childYamlRel = m2![1];
    const childYamlAbs = path.resolve(repo, childYamlRel);
    expect(fss.existsSync(childYamlAbs)).toBe(true);
    const childWtRel = m2![2];
    const childWtAbs = path.resolve(repo, childWtRel);
    expect(path.relative(repoParent, childWtAbs)).not.toMatch(/^\.\./);

    // Validate YAML contents: mode shared and parentId set
    const childY = YAML.parse(await fs.readFile(childYamlAbs, 'utf8'));
    expect(childY.mode).toBe('shared');
    expect(typeof childY.parentId === 'string' && childY.parentId.length > 0).toBe(true);

    // Ensure exactly two YAMLs now exist under the package (parent + child)
    const files = await fg(['packages/app/.mrtask/*.yml'], { cwd: repo, absolute: true });
    expect(files.length).toBe(2);
  });
});
