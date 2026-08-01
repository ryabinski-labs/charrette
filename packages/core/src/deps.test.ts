import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedWorktreeDeps } from "./deps.js";

function dir(): string {
  return mkdtempSync(path.join(tmpdir(), "harness-deps-"));
}

describe("worktree dependency seeding", () => {
  it("does nothing without a lockfile", async () => {
    expect(await seedWorktreeDeps(dir())).toBeNull();
  });

  it("does nothing when node_modules already exists", async () => {
    const d = dir();
    writeFileSync(path.join(d, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(path.join(d, "node_modules"));
    expect(await seedWorktreeDeps(d)).toBeNull();
  });

  it("installs from a lockfile and reports the manager", async () => {
    const d = dir();
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "seedtest", version: "1.0.0" }));
    writeFileSync(
      path.join(d, "package-lock.json"),
      JSON.stringify({
        name: "seedtest",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "seedtest", version: "1.0.0" } },
      })
    );
    const seeded = await seedWorktreeDeps(d);
    // A lockfile with zero deps may legitimately produce no node_modules dir —
    // what matters is that the right manager ran and reported success.
    expect(seeded).toEqual({ manager: "npm", ok: true, seconds: expect.any(Number) });
  }, 60_000);
});
