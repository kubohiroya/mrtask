import { describe, it, expect, beforeAll } from "vitest";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("dump command outputs AI-friendly JSON", () => {
  it("returns JSON array by default", async () => {
    const repo = await makeTempRepo();
    runNodeBin(cli(), ["add", "feature/dump", "dump", "packages/app"], repo);
    const out = runNodeBin(cli(), ["dump"], repo);
    const arr = JSON.parse(out);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[0]).toHaveProperty("id_short");
    expect(arr[0]).toHaveProperty("title");
    expect(arr[0]).toHaveProperty("branch", "feature/dump");
  });

  it("supports ndjson", async () => {
    const repo = await makeTempRepo();
    runNodeBin(cli(), ["add", "feature/ndjson", "ndjson", "packages/app"], repo);
    const out = runNodeBin(cli(), ["dump", "--ndjson"], repo);
    const lines = out.trim().split(/\n+/);
    expect(lines.length).toBeGreaterThan(0);
    const obj = JSON.parse(lines[0]);
    expect(obj).toHaveProperty("id_short");
  });
});

