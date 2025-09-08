import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBinWithInput } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("CSV with quoted branch prints prompt with single quotes around branch", () => {
  it("no duplicate quotes in prompt", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      'title,description,branch,dir1\nFrom CSV,Desc,"feature/quoted",packages/qapp\n',
      "utf8",
    );

    const out = runNodeBinWithInput(
      cli(),
      ["add", "-t", "TASKS.csv:2"],
      repo,
      "y\n",
    );

    expect(out).toContain('The branch "feature/quoted" does not exist');
    // Should not contain doubled quotes
    expect(out).not.toContain('""feature/quoted""');

    const files = await fg(["packages/qapp/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(1);
  });
});
