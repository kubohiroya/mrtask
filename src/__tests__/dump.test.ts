import { describe, it, expect, beforeAll } from "vitest";
import { buildProjectOrThrow, distCliPath, makeTempRepo, runNodeBin, runNodeBinWithInput } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("dump command outputs AI-friendly JSON", () => {
  it("returns JSON array by default", async () => {
    const repo = await makeTempRepo();
    runNodeBin(cli(), ["add", "feature/dump", "dump", "-d", "hello desc", "packages/app"], repo);
    const out = runNodeBin(cli(), ["dump"], repo);
    const arr = JSON.parse(out);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr[0]).toHaveProperty("id_short");
    expect(arr[0]).toHaveProperty("title");
    expect(arr[0]).toHaveProperty("branch", "feature/dump");
    expect(arr[0]).toHaveProperty("description", "hello desc");
  });

  it("supports ndjson", async () => {
    const repo = await makeTempRepo();
    runNodeBin(cli(), ["add", "feature/ndjson", "ndjson", "-d", "hi", "packages/app"], repo);
    const out = runNodeBin(cli(), ["dump", "--ndjson"], repo);
    const lines = out.trim().split(/\n+/);
    expect(lines.length).toBeGreaterThan(0);
    const obj = JSON.parse(lines[0]);
    expect(obj).toHaveProperty("id_short");
    expect(obj).toHaveProperty("description");
  });

  it("includes description when created from CSV", async () => {
    const repo = await makeTempRepo();
    // CSV with description
    const csv = "title,description,branch,dir1\nFrom CSV,Desc via CSV,feature/csvdump,packages/app\n";
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(path.join(repo, "TASKS.csv"), csv, "utf8");
    runNodeBinWithInput(cli(), ["add", "-t", "TASKS.csv:2"], repo, "y\n");
    const out = runNodeBin(cli(), ["dump"], repo);
    const arr = JSON.parse(out);
    const rec = arr.find((r: any) => r.branch === "feature/csvdump");
    expect(rec).toBeTruthy();
    expect(rec).toHaveProperty("description", "Desc via CSV");
  });
});
