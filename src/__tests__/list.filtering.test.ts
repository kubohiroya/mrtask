import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import path from "node:path";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("list filters out wt/ and non-task YAMLs", () => {
  it("does not show pnpm-workspace.yaml under .mrtask/wt", async () => {
    const repo = await makeTempRepo();
    // Create a fake YAML under .mrtask/wt that should be ignored by list
    const wtDir = path.join(repo, ".mrtask", "wt", "dummy-id");
    await fs.mkdir(wtDir, { recursive: true });
    await fs.writeFile(path.join(wtDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");

    const out = runNodeBin(cli(), ["list", "--all"], repo);
    expect(out).not.toMatch(/pnpm-workspace/);
    expect(out).not.toMatch(/\.mrtask\/wt\//);
  });
});

