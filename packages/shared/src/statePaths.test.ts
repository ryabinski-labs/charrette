import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { statePaths } from "./statePaths.js";

const repo = (): string => mkdtempSync(path.join(os.tmpdir(), "statepaths-"));

describe("statePaths", () => {
  it("puts a fresh repository on the current layout", () => {
    const dir = repo();
    const p = statePaths(dir);
    expect(p.dirName).toBe(".charrette");
    expect(p.db).toBe(path.join(dir, ".charrette", "charrette.db"));
    expect(p.log).toBe(path.join(dir, ".charrette", "charrette.log"));
    expect(p.legacy).toBe(false);
  });

  it("keeps reading a repository that only has the pre-rename directory", () => {
    // The whole point of the compatibility rule: every run on disk before the
    // rename stays findable. Pointing at `.charrette/` here would show the
    // operator an empty repo where a finished run is.
    const dir = repo();
    mkdirSync(path.join(dir, ".harness"));
    const p = statePaths(dir);
    expect(p.dir).toBe(path.join(dir, ".harness"));
    expect(p.legacy).toBe(true);
  });

  it("names the legacy files too, not just the legacy directory", () => {
    // A half-rename — old directory, new filenames — finds nothing inside it.
    const dir = repo();
    mkdirSync(path.join(dir, ".harness"));
    const p = statePaths(dir);
    expect(p.db).toBe(path.join(dir, ".harness", "harness.db"));
    expect(p.log).toBe(path.join(dir, ".harness", "harness.log"));
  });

  it("prefers the new directory when a migration left both behind", () => {
    const dir = repo();
    mkdirSync(path.join(dir, ".harness"));
    mkdirSync(path.join(dir, ".charrette"));
    const p = statePaths(dir);
    expect(p.dirName).toBe(".charrette");
    expect(p.legacy).toBe(false);
  });
});
