import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin, runNodeBinWithResult } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("CSV header 'dir1' is recognized as primary work dir", () => {
  it("does not prompt for primary dir and creates YAML", async () => {
    const repo = await makeTempRepo();
    // Pre-create branch to avoid branch-creation prompt
    const { execSync } = await import("node:child_process");
    execSync("git checkout -b feature/dir1", { cwd: repo });
    execSync("git checkout main", { cwd: repo });

    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      "title,description,branch,dir1\nFrom CSV,Desc,feature/dir1,packages/dir1app\n",
      "utf8",
    );

    const res = runNodeBinWithResult(cli(), ["add", "-t", "TASKS.csv:2"], repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Created task/);
    expect(res.stdout).not.toMatch(/Enter primary work dir/i);
    const files = await fg(["packages/dir1app/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(1);
  });
});

