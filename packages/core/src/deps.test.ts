import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedWorktreeDeps } from "./deps.js";

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), "harness-deps-"));
}

/** A package-lock.json with no dependencies: `npm ci` runs and finishes in a second. */
function emptyNpmProject(root: string, name: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify({ name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "1.0.0" } } })
  );
}

describe("worktree dependency seeding", () => {
  it("does nothing without a lockfile", async () => {
    expect(await seedWorktreeDeps(dir())).toEqual([]);
  });

  it("does nothing when node_modules already exists", async () => {
    const d = dir();
    writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(path.join(d, "node_modules"));
    expect(await seedWorktreeDeps(d)).toEqual([]);
  });

  it("installs from a lockfile and reports the manager", async () => {
    const d = dir();
    emptyNpmProject(d, "seedtest");
    const seeded = await seedWorktreeDeps(d);
    // A lockfile with zero deps may legitimately produce no node_modules dir —
    // what matters is that the right manager ran and reported success.
    expect(seeded).toEqual([{ dir: "", manager: "npm", ok: true, seconds: expect.any(Number) }]);
  }, 60_000);

  /**
   * The regression: seeding tested the worktree root only, so the Iceland/Alaska
   * layout got no install at all and every `cd frontend && npm run typecheck`
   * ran against an absent node_modules — a check that cannot pass in a fresh
   * worktree, which parks every task in the run.
   */
  it("seeds every subproject with a lockfile, not just the root", async () => {
    const d = dir();
    emptyNpmProject(path.join(d, "frontend"), "fe");
    emptyNpmProject(path.join(d, "backend"), "be");
    const seeded = await seedWorktreeDeps(d);
    expect(seeded.map((s) => s.dir).sort()).toEqual(["backend", "frontend"]);
    expect(seeded.every((s) => s.ok)).toBe(true);
  }, 120_000);

  it("seeds the root and a subproject together", async () => {
    const d = dir();
    emptyNpmProject(d, "root");
    emptyNpmProject(path.join(d, "backend"), "be");
    const seeded = await seedWorktreeDeps(d);
    expect(seeded.map((s) => s.dir)).toEqual(["", "backend"]);
    expect(seeded.every((s) => s.ok && s.manager === "npm")).toBe(true);
  }, 120_000);

  it("skips a subproject that already has node_modules", async () => {
    const d = dir();
    emptyNpmProject(path.join(d, "frontend"), "fe");
    mkdirSync(path.join(d, "frontend", "node_modules"));
    expect(await seedWorktreeDeps(d)).toEqual([]);
    expect(existsSync(path.join(d, "frontend", "node_modules"))).toBe(true);
  });

  it("reports a failed install instead of throwing", async () => {
    const d = dir();
    // A lockfile that does not match the manifest: `npm ci` refuses.
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "not-a-real-pkg-xyz": "^1.0.0" } }));
    writeFileSync(path.join(d, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "x", version: "1.0.0" } } }));
    const seeded = await seedWorktreeDeps(d);
    expect(seeded).toEqual([{ dir: "", manager: "npm", ok: false, seconds: expect.any(Number) }]);
  }, 60_000);
});
