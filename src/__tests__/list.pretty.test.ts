import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fg from "fast-glob";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("list pretty id modes", () => {
  it("shows short id by default", async () => {
    const repo = await makeTempRepo();
    // create a task
    runNodeBin(cli(), ["add", "feature/list-ui", "list-ui", "packages/app"], repo);

    const outDefault = runNodeBin(cli(), ["list", "--short"], repo);
    expect(outDefault).toMatch(/\[([0-9a-f]{8})\]/); // short id in brackets
    expect(outDefault).toContain("list-ui");

  });
});
