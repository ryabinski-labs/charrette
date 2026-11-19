import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { missingKeys } from "@charrette/core";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "./env.js";

/**
 * The operator-facing half of the DeepSeek default: the key is read from the
 * working directory's `.env`, and the published docs say what the run will do.
 */

describe("REQ-009 — DEEPSEEK_API_KEY in the working directory .env is loaded before the routing check", () => {
  it("SC-009-a the key in .env reaches the routing check", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "charrette-deepseek-env-"));
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    writeFileSync(path.join(dir, ".env"), "DEEPSEEK_API_KEY=from_file\n");
    try {
      expect(loadDotEnv(dir)).toBe(path.join(dir, ".env"));
      expect(process.env.DEEPSEEK_API_KEY).toBe("from_file");
      expect(missingKeys({ worker: "deepseek-flash" }, process.env)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets an exported key win over the file, as every other vendor key does", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "charrette-deepseek-env-"));
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "from_shell";
    writeFileSync(path.join(dir, ".env"), "DEEPSEEK_API_KEY=from_file\n");
    try {
      loadDotEnv(dir);
      expect(process.env.DEEPSEEK_API_KEY).toBe("from_shell");
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("REQ-014 — the published docs describe the DeepSeek default", () => {
  it("SC-014-a the published docs describe the DeepSeek default", () => {
    const readme = readFileSync("README.md", "utf8");
    const operations = readFileSync("docs/OPERATIONS.md", "utf8");

    expect(readme).toContain("DEEPSEEK_API_KEY");
    expect(readme).toContain("deepseek-flash");
    expect(operations).toContain("| `models.worker` | `deepseek-flash` |");
    expect(operations).toContain("| `models.workerLight` | `deepseek-flash` |");
    expect(operations).toContain("| `DEEPSEEK_API_KEY` | **always** |");
    expect(operations).toContain("`deepseek-*` to DeepSeek");
  });
});
