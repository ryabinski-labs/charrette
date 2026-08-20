import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireRunLock, lockPathFor, pidAlive, RunLocked, runLockHolder } from "./runLock.js";

const dir = () => mkdtempSync(path.join(tmpdir(), "runlock-"));

/** A holder file written by hand, standing in for another harness process. */
function plant(stateDir: string, runId: string, pid: number, startedAt = Date.now()): string {
  const p = lockPathFor(stateDir, runId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ pid, runId, startedAt, heartbeatAt: startedAt, host: "somebox" }));
  return p;
}

describe("run lock", () => {
  it("takes the lock and records who holds it", () => {
    const d = dir();
    const lock = acquireRunLock(d, "r1", { pid: 4242 });
    const holder = JSON.parse(readFileSync(lock.path, "utf8"));
    expect(holder.pid).toBe(4242);
    expect(holder.runId).toBe("r1");
    lock.release();
  });

  /**
   * The bug this whole module exists for. Run bc691359 had two `harness resume`
   * processes on it; the second one's requeue sweeper moved a task the first was
   * still working from WORKING to READY, and the first one's WORKING -> QA then
   * threw InvalidTransition and parked committed, finished work as NEEDS_HUMAN.
   */
  it("refuses a second process while the first is alive", () => {
    const d = dir();
    plant(d, "bc691359", 47427);
    expect(() => acquireRunLock(d, "bc691359", { pid: 74529, alive: (pid) => pid === 47427 })).toThrow(RunLocked);
  });

  it("names the live process and how to stop it", () => {
    const d = dir();
    plant(d, "bc691359", 47427);
    let err: unknown;
    try {
      acquireRunLock(d, "bc691359", { pid: 74529, alive: () => true });
    } catch (e) {
      err = e;
    }
    const message = (err as Error).message;
    expect(message).toContain("already being driven by harness pid 47427");
    expect(message).toContain("kill -INT 47427");
    // The recycled-pid escape hatch has to name the file, or the operator has
    // nothing to act on but a number.
    expect(message).toContain(lockPathFor(d, "bc691359"));
  });

  /**
   * A harness that was SIGKILLed, or went down with its machine, never runs a
   * `finally`. Its lock file outlives it — and must not outlive it as a refusal,
   * or every hard kill would need a manual `rm` before the run could be resumed.
   */
  it("reclaims a lock whose process is gone", () => {
    const d = dir();
    plant(d, "r1", 999999);
    const lock = acquireRunLock(d, "r1", { pid: 5, alive: () => false });
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(5);
  });

  it("reclaims a lock file that was never finished being written", () => {
    const d = dir();
    const p = lockPathFor(d, "r1");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, '{"pid": 12');
    const lock = acquireRunLock(d, "r1", { pid: 5, alive: () => true });
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(5);
  });

  it("lets the same process re-take its own lock", () => {
    const d = dir();
    const first = acquireRunLock(d, "r1", { pid: 7, alive: () => true });
    first.release();
    // Every test in this repo resumes in-process, and an operator who never
    // leaves the dashboard does the same.
    const second = acquireRunLock(d, "r1", { pid: 7, alive: () => true });
    expect(second.path).toBe(first.path);
    second.release();
  });

  it("does not refuse a different run in the same repo", () => {
    const d = dir();
    plant(d, "r1", 47427);
    const other = acquireRunLock(d, "r2", { pid: 5, alive: () => true });
    expect(other.path).toBe(lockPathFor(d, "r2"));
    other.release();
  });

  it("releases once, and never removes a lock it no longer owns", () => {
    const d = dir();
    const lock = acquireRunLock(d, "r1", { pid: 7 });
    lock.release();
    plant(d, "r1", 47427);
    lock.release(); // idempotent: must not delete the new holder's file
    expect(JSON.parse(readFileSync(lockPathFor(d, "r1"), "utf8")).pid).toBe(47427);
  });

  it("reports the live holder, and nothing once it is gone", () => {
    const d = dir();
    plant(d, "r1", 47427);
    expect(runLockHolder(d, "r1", () => true)?.pid).toBe(47427);
    expect(runLockHolder(d, "r1", () => false)).toBeNull();
    rmSync(lockPathFor(d, "r1"));
    expect(runLockHolder(d, "r1", () => true)).toBeNull();
  });

  /**
   * The same-pid case cuts two ways, and the pid alone cannot tell them apart:
   * a lock this process really is holding, and one a dead predecessor with the
   * same number left behind. Only the first is a reason to refuse.
   */
  it("refuses a run this process is already driving", () => {
    const d = dir();
    const lock = acquireRunLock(d, "r1", { alive: () => true });
    expect(() => acquireRunLock(d, "r1", { alive: () => true })).toThrow(RunLocked);
    lock.release();
    expect(() => acquireRunLock(d, "r1", { alive: () => true }).release()).not.toThrow();
  });

  it("reclaims a leftover lock that happens to carry this process's own pid", () => {
    const d = dir();
    plant(d, "r1", 4242);
    const lock = acquireRunLock(d, "r1", { pid: 4242, alive: () => true });
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(4242);
    lock.release();
  });

  it("reads this process as alive and pid 0 as not a process", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    // ESRCH: no such process. A pid this high is not in use.
    expect(pidAlive(4_194_303)).toBe(false);
    // EPERM: pid 1 belongs to root, and "you may not signal it" is only ever
    // said about a process that exists.
    expect(pidAlive(1)).toBe(true);
  });

  it("takes the lock with no help from the caller", () => {
    const d = dir();
    const lock = acquireRunLock(d, "r1");
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(process.pid);
    lock.release();
  });

  /**
   * The heartbeat is what tells an operator reading the refusal whether the
   * other process is working or wedged, so it has to actually advance.
   */
  it("keeps the heartbeat moving while the lock is held", () => {
    vi.useFakeTimers();
    try {
      const d = dir();
      const lock = acquireRunLock(d, "r1");
      const before = JSON.parse(readFileSync(lock.path, "utf8")).heartbeatAt;
      vi.advanceTimersByTime(60_000);
      expect(JSON.parse(readFileSync(lock.path, "utf8")).heartbeatAt).toBeGreaterThan(before);
      // …and stops the moment the lock changes hands, so a suspended process
      // cannot stamp somebody else's lock back to life.
      rmSync(lock.path);
      plant(d, "r1", 47427);
      const other = readFileSync(lock.path, "utf8");
      vi.advanceTimersByTime(60_000);
      expect(readFileSync(lock.path, "utf8")).toBe(other);
      lock.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says how long ago the holder was last heard from", () => {
    const d = dir();
    plant(d, "bc691359", 47427, Date.now() - 45 * 60 * 1000);
    expect(() => acquireRunLock(d, "bc691359", { pid: 1, alive: () => true })).toThrow(/last heartbeat 45m ago/);
  });

  it("does not name the host when the other process is on this one", () => {
    const d = dir();
    const p = lockPathFor(d, "r1");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid: 47427, runId: "r1", startedAt: Date.now(), heartbeatAt: Date.now(), host: hostname() }));
    let message = "";
    try {
      acquireRunLock(d, "r1", { pid: 1, alive: () => true });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("harness pid 47427 (started");
    expect(message).not.toContain(` on ${hostname()}`);
  });

  /** A lock file from a build that wrote fewer fields still names a pid. */
  it("reads a lock file that is missing everything but the pid", () => {
    const d = dir();
    const p = lockPathFor(d, "r1");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid: 47427 }));
    expect(runLockHolder(d, "r1", () => true)).toMatchObject({ pid: 47427, runId: "", startedAt: 0, heartbeatAt: 0, host: "" });
  });

  it("treats a lock file that names no pid as no lock at all", () => {
    const d = dir();
    const p = lockPathFor(d, "r1");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ runId: "r1", host: "somebox" }));
    expect(runLockHolder(d, "r1", () => true)).toBeNull();
    const lock = acquireRunLock(d, "r1", { pid: 5, alive: () => true });
    expect(JSON.parse(readFileSync(lock.path, "utf8")).pid).toBe(5);
    lock.release();
  });

  it("falls back to the start time when a lock file carries no heartbeat", () => {
    const d = dir();
    const p = lockPathFor(d, "r1");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ pid: 47427, runId: "r1", startedAt: 1_700_000_000_000, host: "somebox" }));
    expect(runLockHolder(d, "r1", () => true)).toMatchObject({ heartbeatAt: 1_700_000_000_000 });
  });

  /** Anything that is not "the file is already there" belongs to the caller. */
  it("does not swallow a filesystem error that is not a lock", () => {
    const d = dir();
    expect(() => acquireRunLock(d, "r".repeat(400))).toThrow(/ENAMETOOLONG/);
  });

  /**
   * Not the case the lock is for, but the one that would otherwise loop: a path
   * that exists, names nobody, and will not be removed. Refusing beats driving
   * a run this process cannot prove it is alone on.
   */
  it("gives up, with the path, when the lock cannot be created or cleared", () => {
    const d = dir();
    const p = lockPathFor(d, "r1");
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, "in-the-way"), "");
    expect(() => acquireRunLock(d, "r1")).toThrow(/could not take the lock for run r1/);
  });
});
