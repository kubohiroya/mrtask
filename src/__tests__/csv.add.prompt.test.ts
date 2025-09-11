import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import {
  buildProjectOrThrow,
  distCliPath,
  makeTempRepo,
  runNodeBinWithInput,
} from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => {
  // Ensure dist/ is built once for this test suite
  buildProjectOrThrow();
});

describe("mrtask create --from-csv prompts for missing branch", () => {
  it("creates the branch and continues when 'y' is entered", async () => {
    const repo = await makeTempRepo();

    // simple CSV with two lines; we will reference line 2
    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      "title,description,branch,dir1\nCSV Task,From CSV,feature/csv-accept,packages/csvapp\n",
      "utf8",
    );

    const out = runNodeBinWithInput(
      cli(),
      [
        "create",
        "feature/csv-accept",
        "csv-accept",
        "-t",
        "TASKS.csv:2",
        "packages/csvapp",
      ],
      repo,
      // confirm branch creation only
      "y\n",
    );

    expect(out).toContain('The branch "feature/csv-accept" does not exist');
    expect(out).toContain("Created task");

    // YAML should exist under the newly created worktree dir
    const files = await fg(["packages/csvapp/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(1);
    expect(fss.existsSync(path.join(repo, "packages/csvapp"))).toBe(true);
  });

  it("aborts without creating when input is empty (default N)", async () => {
    const repo = await makeTempRepo();
    await fs.writeFile(
      path.join(repo, "TASKS.csv"),
      "title,description,branch,dir1\nCSV Task,From CSV,feature/csv-decline,packages/csvapp2\n",
      "utf8",
    );

    let err: any | null = null;
    try {
      runNodeBinWithInput(
        cli(),
        [
          "create",
          "-t",
          "TASKS.csv:2",
        ],
        repo,
        "\n", // default: decline
      );
    } catch (e: any) {
      err = e;
    }

    expect(err).not.toBeNull();
    // exit status should be 1
    expect(err?.status ?? 0).toBe(1);
    // message printed to stderr in CLI
    const stderr = String(err?.stderr ?? "");
    expect(stderr).toContain("Aborted. Branch not created.");
    // ensure no YAML and no worktree directory
    const files = await fg(["packages/csvapp2/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(0);
    expect(fss.existsSync(path.join(repo, "packages/csvapp2"))).toBe(false);
  });
});
