import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin, runNodeBinWithInput, runNodeBinWithResult } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => {
  buildProjectOrThrow();
});

describe("mrtask add -t file:line works without positional args", () => {
  it("creates task when branch already exists (no prompt)", async () => {
    const repo = await makeTempRepo();
    // create branch beforehand
    runNodeBin(cli(), ["--help"], repo); // ensure node binary runs once (build warmup)
    const { execSync } = await import("node:child_process");
    execSync("git checkout -b feature/exist", { cwd: repo });
    execSync("git checkout main", { cwd: repo });

    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      "title,description,branch,dir\nCSV Task,From CSV,feature/exist,packages/exist\n",
      "utf8",
    );

    const out = runNodeBinWithInput(
      cli(),
      ["add", "-t", "TASKS.csv:2"],
      repo,
      "\n",
    );

    expect(out).toContain("Created task");
    const files = await fg(["packages/exist/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(1);
  });

  it("prompts for missing branch/title/dir if CSV lacks them", async () => {
    const repo = await makeTempRepo();
    // Pre-create the branch to avoid confirmation prompt in CI
    const { execSync } = await import("node:child_process");
    execSync("git checkout -b feature/from-prompts", { cwd: repo });
    execSync("git checkout main", { cwd: repo });
    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      "title\nOnlyTitle\n",
      "utf8",
    );

    // Provide interactive answers: branch and dir
    const input = [
      // CSV has only title; CLI will ask for branch and primary dir.
      "feature/from-prompts\n",
      "packages/prompted\n",
    ].join("");

    const res = runNodeBinWithResult(cli(), ["add", "-t", "TASKS.csv:2"], repo, input);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Enter branch name");
    expect(res.stdout).toContain("Enter primary work dir");
    expect(res.stderr).not.toMatch(/missing required argument 'branch'/i);
  });
});
