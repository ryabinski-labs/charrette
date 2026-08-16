import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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

  /**
   * The regression this file exists to prevent twice over. A postinstall that
   * never returns — measured in the wild as puppeteer downloading Chromium onto
   * a half-open socket — used to hold a worker slot forever: `execFile`'s
   * `timeout` signalled the package manager and not the grandchild actually
   * stuck, and then awaited a `close` event that could never arrive. Three of
   * those froze a 43-task run at zero completed, still reporting EXECUTING.
   *
   * Both halves are asserted: seeding returns, and the grandchild is reaped.
   */
  it("gives up on an install whose postinstall never returns, and reaps it", async () => {
    const d = dir();
    const pidfile = path.join(d, "grandchild.pid");
    emptyNpmProject(d, "wedged");
    writeFileSync(
      path.join(d, "package.json"),
      JSON.stringify({ name: "wedged", version: "1.0.0", scripts: { postinstall: "node hang.js" } })
    );
    // It must ignore the polite signals. A postinstall that dies on SIGTERM is
    // not the bug — the package manager reaps that one itself and the old code
    // handled it. The wedge needs a grandchild that outlives the signal, which
    // leaves the package manager waiting on it and never exiting. Verified: the
    // old `execFile({ timeout })` path never settles at all against this
    // fixture, and leaves the grandchild running.
    writeFileSync(
      path.join(d, "hang.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(pidfile)}, String(process.pid));\n` +
        `for (const s of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(s, () => {});\n` +
        `setInterval(() => {}, 1000);\n`
    );

    const started = Date.now();
    const seeded = await seedWorktreeDeps(d, 8_000);
    const elapsed = Date.now() - started;

    expect(seeded).toEqual([{ dir: "", manager: "npm", ok: false, seconds: expect.any(Number) }]);
    // The point of the timer: it settled on its own deadline, not on a child
    // exit that was never coming.
    expect(elapsed).toBeLessThan(30_000);

    // And the kill reached past npm to the process actually wedged — SIGTERM
    // first, which this fixture ignores, then SIGKILL after the grace, which
    // nothing ignores.
    const pid = Number(readFileSync(pidfile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 8_000));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 60_000);

  it("reports a failed install instead of throwing", async () => {
    const d = dir();
    // A lockfile that does not match the manifest: `npm ci` refuses.
    writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "not-a-real-pkg-xyz": "^1.0.0" } }));
    writeFileSync(path.join(d, "package-lock.json"), JSON.stringify({ name: "x", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "x", version: "1.0.0" } } }));
    const seeded = await seedWorktreeDeps(d);
    expect(seeded).toEqual([{ dir: "", manager: "npm", ok: false, seconds: expect.any(Number) }]);
  }, 60_000);
});
