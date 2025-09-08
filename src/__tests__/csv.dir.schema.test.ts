import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBinWithResult } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("CSV dir columns (simple, no aliases)", () => {
  it("uses dir1, dir2 as primary/secondary dirs", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      "title,branch,dir1,dir2\nT,feature/simple,packages/app,packages/lib\n",
      "utf8",
    );
    const res = runNodeBinWithResult(cli(), ["add", "-t", "TASKS.csv:2"], repo, "y\n");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/primaryDir: packages\/app/);
  });

  it("prompts when only deprecated 'dir' exists (dir1 missing)", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      "title,branch,dir\nT,feature/err,packages/app\n",
      "utf8",
    );
    const res = runNodeBinWithResult(cli(), ["add", "-t", "TASKS.csv:2"], repo, "packages/app\n");
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Enter primary work dir");
  });
});
