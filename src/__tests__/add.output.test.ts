import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin, runNodeBinWithResult } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("mrtask create output behavior", () => {
  it("prints YAML content on success", async () => {
    const repo = await makeTempRepo();
    const res = runNodeBinWithResult(
      cli(),
      ["create", "feature/print", "print", "-d", "hello", "packages/app"],
      repo,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/✔ Created task/);
    // YAML content should be present
    expect(res.stdout).toMatch(/branch: feature\/print/);
    expect(res.stdout).toMatch(/title: print/);
    // File should exist
    const files = await fg(["packages/app/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(1);
  });

  it("prints YAML content in --dry-run and writes nothing", async () => {
    const repo = await makeTempRepo();
    const res = runNodeBinWithResult(
      cli(),
      ["create", "feature/dry", "dry", "--dry-run", "packages/dryapp"],
      repo,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\(dry-run\) No files written/);
    expect(res.stdout).toMatch(/branch: feature\/dry/);
    // Ensure no directories/files created
    const files = await fg(["packages/dryapp/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(0);
  });

  it("--silent suppresses output on success", async () => {
    const repo = await makeTempRepo();
    const res = runNodeBinWithResult(
      cli(),
      ["create", "feature/silent", "silent", "--silent", "packages/silentapp"],
      repo,
    );
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe("");
    // But YAML file is created
    const files = await fg(["packages/silentapp/.mrtask/*.yml"], { cwd: repo, absolute: true });
    expect(files.length).toBe(1);
  });
});
