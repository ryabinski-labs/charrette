import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureIgnored } from "./git.js";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-ignore-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  return dir;
}

const read = (dir: string) => readFileSync(path.join(dir, ".gitignore"), "utf8");

describe("ensureIgnored", () => {
  it("creates .gitignore when the repo has none", () => {
    const dir = repo();
    expect(ensureIgnored(dir, ".charrette/")).toBe(true);
    expect(read(dir)).toBe(".charrette/\n");
  });

  it("appends to an existing .gitignore without disturbing it", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\ndist/\n");
    expect(ensureIgnored(dir, ".charrette/")).toBe(true);
    expect(read(dir)).toBe("node_modules/\ndist/\n.charrette/\n");
  });

  it("does not glue the entry onto a file with no trailing newline", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/");
    ensureIgnored(dir, ".charrette/");
    expect(read(dir)).toBe("node_modules/\n.charrette/\n");
  });

  it("is idempotent — a second run leaves the file alone", () => {
    const dir = repo();
    expect(ensureIgnored(dir, ".charrette/")).toBe(true);
    expect(ensureIgnored(dir, ".charrette/")).toBe(false);
    expect(read(dir)).toBe(".charrette/\n");
  });

  it("writes nothing when a parent rule already ignores the path", () => {
    const dir = repo();
    // A broad rule the operator wrote themselves still counts as ignored; the
    // charrette must not add a redundant line to someone else's repo.
    writeFileSync(path.join(dir, ".gitignore"), ".charrette*\n");
    expect(ensureIgnored(dir, ".charrette/")).toBe(false);
    expect(read(dir)).toBe(".charrette*\n");
  });

  it("refuses to write outside a git repository", () => {
    // No .git here, so git cannot tell us whether the entry is ignored — and a
    // directory that is not a repo has no business acquiring a .gitignore.
    const dir = mkdtempSync(path.join(tmpdir(), "charrette-norepo-"));
    expect(ensureIgnored(dir, ".charrette/")).toBe(false);
    expect(() => read(dir)).toThrow();
  });
});
