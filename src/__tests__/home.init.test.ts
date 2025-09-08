import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import * as fss from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildProjectOrThrow, distCliPath, runNodeBin } from "./helpers.js";

const cli = () => distCliPath();

beforeAll(() => buildProjectOrThrow());

describe("mrtask init", () => {
  it("initializes home and prints guide", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mrtask-home-"));
    const out = runNodeBin(cli(), ["init", tmpHome], process.cwd());
    expect(out).toContain("mrtask initialized.");
    expect(out).toContain(`Home: ${tmpHome}`);
    const wt = path.join(tmpHome, "workTrees");
    expect(fss.existsSync(wt)).toBe(true);
    expect(fss.existsSync(path.join(tmpHome, "config.json"))).toBe(true);
  });
});

