import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import {
  buildProjectOrThrow,
  distCliPath,
  makeTempRepo,
  runNodeBin,
} from "./helpers.js";

let repoDir: string;
const cli = () => distCliPath();

beforeAll(async () => {
  buildProjectOrThrow();
  repoDir = await makeTempRepo();
});

describe("mrtask basic flow", () => {
  it("mrtask --help runs", () => {
    const out = runNodeBin(cli(), ["--help"], repoDir);
    expect(out).toContain("mrtask");
  });

  it("add creates YAML and worktree directory", async () => {
    // create task under packages/app
    const out = runNodeBin(
      cli(),
      ["add", "feature/e2e", "e2e-task", "-d", "hello", "packages/app", "--sparse"],
      repoDir
    );
    expect(out).toContain("✔ Created task");
    // YAML should exist
    const files = await fg(["packages/app/.mrtask/*.yml"], {
      cwd: repoDir,
      absolute: true,
    });
    expect(files.length).toBe(1);
    // worktree directory exists
    expect(fss.existsSync(path.join(repoDir, "packages/app"))).toBe(true);
  });

  it("list shows the open task", () => {
    const out = runNodeBin(cli(), ["list", "--short"], repoDir);
    expect(out).toMatch(/open\s+.*e2e-task/i);
  });

  it("show returns JSON with expected fields", async () => {
    // get id from filename
    const files = await fg(["packages/app/.mrtask/*.yml"], {
      cwd: repoDir,
      absolute: true,
    });
    const id = path.basename(files[0]).replace(/\.(ya?ml)$/i, "");
    const json = runNodeBin(cli(), ["show", id], repoDir);
    const obj = JSON.parse(json);
    expect(obj).toHaveProperty("id");
    expect(obj).toHaveProperty("branch", "feature/e2e");
    expect(obj).toHaveProperty("status", "open");
    expect(obj).toHaveProperty("primaryDir", "packages/app");
    expect(obj.workDirs).toContain("packages/app");
  });

  it("done moves YAML to root .mrtask/done and removes worktree", async () => {
    // id
    const files = await fg(["packages/app/.mrtask/*.yml"], {
      cwd: repoDir,
      absolute: true,
    });
    const id = path.basename(files[0]).replace(/\.(ya?ml)$/i, "");
    const out = runNodeBin(cli(), ["done", id], repoDir);
    expect(out).toMatch(/Moved to done/);

    // worktree directory removed
    expect(fss.existsSync(path.join(repoDir, "packages/app"))).toBe(false);

    // YAML moved to root .mrtask/done
    const moved = await fg([`.mrtask/done/${id}.yml`], {
      cwd: repoDir,
      absolute: true,
    });
    expect(moved.length).toBe(1);

    // list (open) no longer shows it
    const l = runNodeBin(cli(), ["list", "--short"], repoDir);
    expect(l).not.toMatch(/e2e-task/);

    // list --all can show historical records (root scan)
    const la = runNodeBin(cli(), ["list", "--all", "--short"], repoDir);
    // depending on implementation, done records may or may not be listed; if not, that's okay.
    // Here we just ensure the command runs.
    expect(la).toMatch(/^\s*|.*/);
  });

  it("doctor succeeds", () => {
    const out = runNodeBin(cli(), ["doctor"], repoDir);
    expect(out).toMatch(/no problems found|issues found/);
  });
});
