import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processesUnder, reapUnder } from "./reaper.js";

function dir(name: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `harness-${name}-`)));
}

const started: number[] = [];

/**
 * An orphan of exactly the shape the run left behind: detached from its parent,
 * no controlling terminal, still sitting in the worktree it was started in.
 */
function orphan(cwd: string): number {
  const child = spawn("sleep", ["120"], { cwd, detached: true, stdio: "ignore" });
  child.unref();
  started.push(child.pid!);
  return child.pid!;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped, which is the point of most of these tests.
    }
  }
});

describe("orphan reaper", () => {
  it("finds a process still running in the worktree after its session is gone", async () => {
    const wt = dir("wt");
    const pid = orphan(wt);
    await new Promise((r) => setTimeout(r, 300));
    expect((await processesUnder(wt)).map((p) => p.pid)).toContain(pid);
  });

  it("kills it, and says what it killed", async () => {
    const wt = dir("wt");
    const pid = orphan(wt);
    await new Promise((r) => setTimeout(r, 300));
    const reaped = await reapUnder(wt, { graceMs: 500 });
    expect(reaped.map((r) => r.pid)).toContain(pid);
    expect(reaped.find((r) => r.pid === pid)!.command).toMatch(/sleep/);
    expect(alive(pid)).toBe(false);
  });

  /**
   * SIGTERM first so a test runner can drop its database connections; SIGKILL
   * for whatever ignores it. A wedged test process — the exact thing that held
   * a worktree open for 13 hours — is under no obligation to take the hint.
   */
  it("escalates to SIGKILL for a process that ignores SIGTERM, and says which signal killed it", async () => {
    const wt = dir("wt");
    const child = spawn("sh", ["-c", 'trap "" TERM; sleep 120'], { cwd: wt, detached: true, stdio: "ignore" });
    child.unref();
    started.push(child.pid!);
    await new Promise((r) => setTimeout(r, 300));

    const reaped = await reapUnder(wt, { graceMs: 500 });

    const mine = reaped.find((r) => r.pid === child.pid);
    expect(mine?.signal).toBe("SIGKILL");
    // Waited for rather than probed: a just-killed child stays a zombie, and so
    // still answers signal 0, until this process reaps it.
    await expect(new Promise((r) => child.on("exit", (_c, s) => r(s)))).resolves.toBe("SIGKILL");
  });

  it("reaches a process in a subdirectory of the worktree", async () => {
    const wt = dir("wt");
    const sub = realpathSync(mkdtempSync(path.join(wt, "backend-")));
    const pid = orphan(sub);
    await new Promise((r) => setTimeout(r, 300));
    await reapUnder(wt, { graceMs: 500 });
    expect(alive(pid)).toBe(false);
  });

  /**
   * The sweep runs against one task's worktree while other tasks are working in
   * theirs. Killing past the boundary would be worse than the leak it fixes.
   */
  it("leaves processes outside the worktree alone", async () => {
    const mine = dir("mine");
    const theirs = dir("theirs");
    const pid = orphan(theirs);
    await new Promise((r) => setTimeout(r, 300));
    expect(await reapUnder(mine, { graceMs: 100 })).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  it("does not match a sibling directory that shares a name prefix", async () => {
    const base = dir("base");
    const a = realpathSync(mkdtempSync(path.join(base, "task-")));
    const sibling = `${a}-2`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(sibling);
    const pid = orphan(sibling);
    await new Promise((r) => setTimeout(r, 300));
    expect(await reapUnder(a, { graceMs: 100 })).toEqual([]);
    expect(alive(pid)).toBe(true);
  });

  it("never reports this process or its ancestors as reapable", async () => {
    const found = await processesUnder(process.cwd());
    expect(found.map((p) => p.pid)).not.toContain(process.pid);
    expect(found.map((p) => p.pid)).not.toContain(process.ppid);
  });

  it("returns nothing for a directory nobody is working in", async () => {
    expect(await reapUnder(dir("empty"), { graceMs: 50 })).toEqual([]);
  });

  it("does not throw on a path that does not exist", async () => {
    expect(await reapUnder(path.join(tmpdir(), "harness-does-not-exist-9d3f"), { graceMs: 50 })).toEqual([]);
  });
});
