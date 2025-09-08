import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import fg from "fast-glob";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin } from "./helpers.js";

let repoDir: string;
const cli = () => distCliPath();

function makeBareRemote(): { bareDir: string; url: string } {
  const bareDir = fss.mkdtempSync(path.join(os.tmpdir(), "mrtask-remote-"));
  execSync("git init --bare", { cwd: bareDir });
  return { bareDir, url: bareDir };
}

beforeAll(async () => {
  buildProjectOrThrow();
  repoDir = await makeTempRepo();
  // set origin to bare and push main
  const { url } = makeBareRemote();
  execSync(`git remote add origin ${url}`, { cwd: repoDir });
  execSync("git push -u origin main", { cwd: repoDir });
});

describe("mrtask pr stage-2 flow", () => {
  it("prepare a feature branch with a change", () => {
    // add task & worktree
    const out = runNodeBin(cli(), ["add", "feature/e2e", "e2e-task", "-d", "e2e task", "packages/app"], repoDir);
    expect(out).toContain("✔ Created task");
    // create a file and commit on that branch (in the worktree dir)
    const appDir = path.join(repoDir, "packages", "app");
    fss.mkdirSync(path.join(appDir, "src"), { recursive: true });
    fss.writeFileSync(path.join(appDir, "src", "hello.ts"), "export const hi='ok';\n");
    execSync("git add . && git commit -m \"feat: add hello.ts\"", { cwd: appDir });
    // ensure the YAML exists
    const files = fg.sync(["packages/app/.mrtask/*.yml"], { cwd: repoDir });
    expect(files.length).toBe(1);
  });

  it("dry-run prints PR draft and compare URL", async () => {
    const files = await fg(["packages/app/.mrtask/*.yml"], { cwd: repoDir, absolute: true });
    const id = path.basename(files[0]).replace(/\.(ya?ml)$/i, "");
    const out = runNodeBin(cli(), ["pr", id, "--base", "main", "--dry-run"], repoDir);
    expect(out).toContain("PR DRAFT");
    expect(out).toContain("# [app] e2e task"); // title scope
    expect(out).toContain("## Summary");
    expect(out).toMatch(/Compare:\s/);
    // file output
    const prFile = path.join(repoDir, ".mrtask", "out", `${id}.pr.md`);
    expect(fss.existsSync(prFile)).toBe(true);
  });

  it("--push sets upstream for branch", () => {
    const files = fg.sync(["packages/app/.mrtask/*.yml"], { cwd: repoDir, absolute: true });
    const id = path.basename(files[0]).replace(/\.(ya?ml)$/i, "");
    const out = runNodeBin(cli(), ["pr", id, "--push", "--dry-run"], repoDir);
    expect(out).toContain("PR DRAFT"); // still dry-run, but push executed
    // verify remote branch exists
    const ls = execSync("git ls-remote --heads origin", { cwd: repoDir, encoding: "utf8" });
    expect(ls).toMatch(/refs\/heads\/feature\/e2e/);
  });

  it("accepts task file path as second argument", async () => {
    const files = await fg(["packages/app/.mrtask/*.yml"], { cwd: repoDir, absolute: true });
    const taskFilePath = path.relative(repoDir, files[0]);
    const id = path.basename(files[0]).replace(/\.(ya?ml)$/i, "");
    
    // Test using task file path instead of ID
    const out = runNodeBin(cli(), ["pr", id, taskFilePath, "--base", "main", "--dry-run"], repoDir);
    expect(out).toContain("PR DRAFT");
    expect(out).toContain("# [app] e2e task"); // title scope should be the same
    expect(out).toContain("## Summary");
    expect(out).toMatch(/Compare:\s/);
    
    // file output should still work
    const prFile = path.join(repoDir, ".mrtask", "out", `${id}.pr.md`);
    expect(fss.existsSync(prFile)).toBe(true);
  });
});
