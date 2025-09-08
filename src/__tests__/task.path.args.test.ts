import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fg from "fast-glob";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("id or file path accepted in show/done/cancel/remove", () => {
  it("show accepts YAML file path", async () => {
    const repo = await makeTempRepo();
    runNodeBin(cli(), ["add", "feature/path", "path", "packages/app"], repo);
    const files = await fg(["packages/app/.mrtask/*.yml"], { cwd: repo, absolute: true });
    const file = files[0];
    const out = runNodeBin(cli(), ["show", path.relative(repo, file)], repo);
    const obj = JSON.parse(out);
    expect(obj).toHaveProperty("branch", "feature/path");
  });

  it("done accepts YAML file path", async () => {
    const repo = await makeTempRepo();
    runNodeBin(cli(), ["add", "feature/donepath", "donepath", "packages/app"], repo);
    const files = await fg(["packages/app/.mrtask/*.yml"], { cwd: repo, absolute: true });
    const file = files[0];
    const out = runNodeBin(cli(), ["done", path.relative(repo, file)], repo);
    expect(out).toMatch(/Moved to done/);
  });
});

