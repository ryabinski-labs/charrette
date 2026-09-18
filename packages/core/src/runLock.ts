import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

/**
 * One charrette process per run.
 *
 * Everything the scheduler does assumes it is the only thing driving a run.
 * The clearest statement of that assumption is the requeue sweeper at the top
 * of `execute`: a task it finds in WORKING or QA "belongs to a charrette process
 * that died mid-task: this controller is the only runner, so nothing can
 * actually be WORKING or in QA when the loop starts". Nothing enforced it.
 *
 * Run bc691359 had two `charrette resume bc691359` processes alive at once — one
 * started an hour and fifty-four minutes before the other, neither aware of the
 * other. The second one's sweeper requeued WORKING -> READY a task the *first*
 * one was still running. Twelve minutes later the first finished its
 * deterministic checks and tried WORKING -> QA, found READY, and threw
 * `InvalidTransition` — which parked the task as NEEDS_HUMAN with the reason
 * "crashed: task m1-live-block-witness: READY -> QA". The worker had already
 * committed the whole job and signed off on it. The state machine was working
 * exactly as designed; the invariant underneath it was simply false.
 *
 * A lock file is enough because the failure it has to catch is two operators
 * (or one operator and a forgotten terminal) on one machine, not a distributed
 * one. `openSync(..., "wx")` is the atomic primitive: it creates or it fails,
 * with no window between the two.
 *
 * Staleness is decided by asking the operating system whether the recorded pid
 * is still alive, not by a timeout. A charrette killed with SIGKILL, or gone with
 * its terminal, leaves its lock file behind and takes its pid with it, so the
 * next acquire reclaims it — which is also why nothing here needs to run from a
 * signal handler.
 */

export type LockHolder = {
  pid: number;
  runId: string;
  /** When the holder took the lock. */
  startedAt: number;
  /** Refreshed while the holder is alive; see `heartbeatMs`. */
  heartbeatAt: number;
  host: string;
};

export type RunLock = {
  path: string;
  /** Idempotent, and never removes a lock this process no longer owns. */
  release(): void;
};

/** How often a holder rewrites `heartbeatAt`. Informational, not a timeout. */
const HEARTBEAT_MS = 15_000;

/**
 * Locks this process is actually holding.
 *
 * A pid is not enough to tell "I am already driving this run" from "a dead
 * process that happened to have my number left this behind": both read as a
 * lock file naming `process.pid`. The set answers it exactly — if it is in
 * here, this process is driving; if it is not, whatever is on disk under our
 * own number is a leftover, and reclaiming it is right.
 */
const held = new Set<string>();

export class RunLocked extends Error {
  constructor(readonly heldBy: LockHolder, readonly lockPath: string) {
    super(
      `run ${heldBy.runId} is already being driven by charrette pid ${heldBy.pid}` +
        (heldBy.host === hostname() ? "" : ` on ${heldBy.host}`) +
        ` (started ${new Date(heldBy.startedAt).toISOString()}, last heartbeat ${ago(heldBy.heartbeatAt)}).\n` +
        `Two charrette processes on one run corrupt each other's task states — one requeues a task the other is still working, ` +
        `and the work that was already committed gets parked as NEEDS_HUMAN.\n` +
        `Stop the other one first:  kill -INT ${heldBy.pid}\n` +
        `If pid ${heldBy.pid} is not a charrette (the number was reused), delete ${lockPath} and try again.`
    );
    this.name = "RunLocked";
  }
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

/**
 * True when a process with this pid exists. Signal 0 performs the permission
 * and existence checks and delivers nothing; EPERM means it exists and belongs
 * to somebody else, which for our purposes is just as alive.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(p: string): LockHolder | null {
  try {
    const h = JSON.parse(readFileSync(p, "utf8")) as Partial<LockHolder>;
    if (typeof h.pid !== "number") return null;
    return {
      pid: h.pid,
      runId: typeof h.runId === "string" ? h.runId : "",
      startedAt: typeof h.startedAt === "number" ? h.startedAt : 0,
      // An older lock file, or one caught mid-write, still names a pid — which
      // is the only field staleness actually turns on.
      heartbeatAt: typeof h.heartbeatAt === "number" ? h.heartbeatAt : (h.startedAt ?? 0),
      host: typeof h.host === "string" ? h.host : "",
    };
  } catch {
    // Unreadable or truncated: it cannot name a live holder, so it cannot
    // justify refusing. Treated as stale below.
    return null;
  }
}

export function lockPathFor(stateDir: string, runId: string): string {
  return path.join(stateDir, "locks", `${runId}.lock`);
}

/**
 * Take the lock for `runId`, or throw `RunLocked` naming the process that has it.
 *
 * `deps` exists for the tests, which need to stand up a holder that is alive or
 * dead on demand without spawning one.
 */
export function acquireRunLock(
  stateDir: string,
  runId: string,
  deps: { alive?: (pid: number) => boolean; now?: () => number; pid?: number } = {}
): RunLock {
  const alive = deps.alive ?? pidAlive;
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const p = lockPathFor(stateDir, runId);
  if (held.has(p)) {
    throw new RunLocked({ pid, runId, startedAt: now(), heartbeatAt: now(), host: hostname() }, p);
  }
  mkdirSync(path.dirname(p), { recursive: true });

  // Two passes at most: the first can lose to a stale file, the second cannot
  // lose to the same one because it has just been removed. A third would only
  // be racing a live competitor, and losing that race is the correct outcome.
  for (let attempt = 0; attempt < 2; attempt++) {
    const holder: LockHolder = { pid, runId, startedAt: now(), heartbeatAt: now(), host: hostname() };
    let fd: number;
    try {
      fd = openSync(p, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const other = readHolder(p);
      if (other && alive(other.pid) && other.pid !== pid) throw new RunLocked(other, p);
      // Nobody is behind it: a charrette that was SIGKILLed, a machine that went
      // down mid-run, or a file that never finished being written. Clear it and
      // take the lock properly rather than writing over it in place — the
      // exclusive create is the only thing keeping two simultaneous reclaimers
      // from both believing they won.
      try {
        rmSync(p, { force: true });
      } catch {
        // Someone else got there first; the next create decides it.
      }
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(holder));
    } finally {
      closeSync(fd);
    }

    held.add(p);
    let released = false;
    const beat = setInterval(() => {
      // Only ever refreshes a file this process still owns. A lock reclaimed by
      // someone else while this process was suspended must not be stamped back
      // to life underneath them.
      try {
        if (readHolder(p)?.pid !== pid) return;
        const fd2 = openSync(p, "w");
        try {
          writeSync(fd2, JSON.stringify({ ...holder, heartbeatAt: now() }));
        } finally {
          closeSync(fd2);
        }
        /* v8 ignore start -- a transient write failure on a file this process
           just created and still owns; there is no portable way to manufacture
           one that does not also break the read above it. */
      } catch {
        // A heartbeat is a courtesy to whoever reads the refusal message. It is
        // never what decides whether the lock is held.
      }
      /* v8 ignore stop */
    }, HEARTBEAT_MS);
    beat.unref();

    const release = () => {
      if (released) return;
      released = true;
      held.delete(p);
      clearInterval(beat);
      // Taken off again on release: a process that drives several runs in its
      // lifetime would otherwise leave one exit listener behind per run, and
      // Node starts warning about a leak at ten.
      process.off("exit", release);
      try {
        if (readHolder(p)?.pid === pid) rmSync(p, { force: true });
        /* v8 ignore start -- same as the heartbeat: a delete that fails on a
           file this process owns. Recorded because it is survivable, not
           because a test can produce it. */
      } catch {
        // Leaving the file behind is survivable: this process is on its way out,
        // its pid dies with it, and the next acquire reads it as stale.
      }
      /* v8 ignore stop */
    };
    process.once("exit", release);
    return { path: p, release };
  }
  // Two passes and still nothing: the path exists, names no live holder, and
  // will not go away — a directory sitting where the lock file belongs, or a
  // file this user cannot delete. Not the case the lock is for, and not
  // something to drive a run through either.
  throw new Error(
    `could not take the lock for run ${runId}: ${p} exists, names no running charrette, and could not be removed. Delete it and try again.`
  );
}

/** What holds the lock right now, or null. Read-only; used by `status`. */
export function runLockHolder(stateDir: string, runId: string, alive: (pid: number) => boolean = pidAlive): LockHolder | null {
  if (!existsFile(lockPathFor(stateDir, runId))) return null;
  const h = readHolder(lockPathFor(stateDir, runId));
  return h && alive(h.pid) ? h : null;
}

function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
