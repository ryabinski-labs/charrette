import { execFile } from "node:child_process";
import { readlink, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

/**
 * Kill what an agent session left behind.
 *
 * A session ends; the shells it started do not. Run 40da9337 finished with 37
 * orphaned processes across 6 chains in 5 already-merged worktrees, two of them
 * 13 hours old, all still writing to the DynamoDB table every other task's
 * deterministic checks were reading. That is the inverse of the background-shell
 * bug: there the shell killed the session, here the session dies and the shell
 * outlives the run.
 *
 * Identified by working directory rather than by parent, because the parent is
 * exactly what an orphan no longer has: `cmd > log 2>&1 &` — the form the
 * background-shell denial recommends — survives its shell, is reparented to
 * init, and keeps nothing of its ancestry. What it does keep is the cwd it
 * inherited, and every agent session runs in a worktree of its own. Marking the
 * environment instead would be tidier and does not work: macOS refuses to show
 * another process's environment (`ps -E` prints none of it, SIP), so the cwd is
 * the only handle left that survives reparenting on both platforms.
 */

/** One row of the process table, enough to decide whether a pid may be killed. */
interface Proc {
  pid: number;
  ppid: number;
  /** "??" (macOS) or "?" (Linux) when the process has no controlling terminal. */
  tty: string;
  command: string;
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;

async function processTable(): Promise<Map<number, Proc>> {
  const table = new Map<number, Proc>();
  // Timed out rather than trusted: this runs inside a session's teardown, and a
  // wedged `ps` must not be able to hold a finished task open.
  const { stdout } = await execFileP("ps", ["-Ao", "pid=,ppid=,tty=,command="], { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }).catch(() => ({ stdout: "" }));
  for (const line of stdout.split("\n")) {
    const m = PS_LINE.exec(line);
    if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), tty: m[3]!, command: m[4]! });
  }
  return table;
}

/**
 * pid → cwd for every process this user can see. lsof answers it in one call on
 * both platforms (~0.1s for a thousand processes); /proc is the fallback for a
 * Linux box without lsof installed.
 */
async function workingDirs(): Promise<Map<number, string>> {
  const dirs = new Map<number, string>();
  const { stdout } = await execFileP("lsof", ["-a", "-d", "cwd", "-F", "pn", "-w"], { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 }).catch(() => ({ stdout: "" }));
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) dirs.set(pid, line.slice(1));
  }
  if (dirs.size > 0) return dirs;
  // No lsof. On Linux the same answer is a directory listing away; on macOS
  // there is no /proc and this returns nothing, which is the honest result —
  // the sweep finds no orphans rather than killing the wrong thing.
  const entries = await readdir("/proc").catch(() => [] as string[]);
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const cwd = await readlink(`/proc/${entry}/cwd`).catch(() => null);
    if (cwd) dirs.set(Number(entry), cwd);
  }
  return dirs;
}

/** Follow the ppid chain from this process, so a sweep can never kill its own ancestry. */
function ancestry(table: Map<number, Proc>): Set<number> {
  const chain = new Set<number>([process.pid]);
  let cursor = table.get(process.pid)?.ppid;
  while (cursor && cursor > 1 && !chain.has(cursor)) {
    chain.add(cursor);
    cursor = table.get(cursor)?.ppid;
  }
  return chain;
}

/**
 * Resolve symlinks so the comparison holds: on macOS a worktree under /var is
 * reported by lsof as /private/var, and the prefix test silently matches nothing.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Processes running inside `root` that this process is allowed to kill. */
export async function processesUnder(root: string): Promise<Proc[]> {
  const resolved = canonical(root);
  const [table, dirs] = await Promise.all([processTable(), workingDirs()]);
  const mine = ancestry(table);
  const found: Proc[] = [];
  for (const [pid, cwd] of dirs) {
    const c = canonical(cwd);
    if (c !== resolved && !c.startsWith(`${resolved}${path.sep}`)) continue;
    if (pid <= 1 || mine.has(pid)) continue;
    const proc = table.get(pid);
    if (!proc) continue;
    // A controlling terminal means a human is sitting in front of it. Agent
    // sessions are spawned onto pipes and never have one, so this costs the
    // sweep nothing and protects the operator's own shell in the worktree the
    // gate just told them to go and look at.
    if (proc.tty !== "??" && proc.tty !== "?" && proc.tty !== "-") continue;
    found.push(proc);
  }
  return found;
}

export interface Reaped {
  pid: number;
  command: string;
  /** The signal it actually died to: SIGKILL means it ignored the polite one. */
  signal: "SIGTERM" | "SIGKILL";
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Terminate every process working inside `root`, and say what was killed.
 *
 * SIGTERM first so a test runner can drop its database connections and a
 * container client can tidy up, then SIGKILL for whatever ignored it. Never
 * throws: a sweep that fails is a sweep that found nothing, and no session
 * result may depend on it.
 */
export async function reapUnder(root: string, opts: { graceMs?: number } = {}): Promise<Reaped[]> {
  let candidates: Proc[];
  try {
    candidates = await processesUnder(root);
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  for (const p of candidates) {
    try {
      process.kill(p.pid, "SIGTERM");
    } catch {
      // Already gone, or not ours to signal. Either way there is nothing to do.
    }
  }
  const grace = opts.graceMs ?? 2000;
  await new Promise((resolve) => setTimeout(resolve, grace));

  const reaped: Reaped[] = [];
  for (const p of candidates) {
    if (!alive(p.pid)) {
      reaped.push({ pid: p.pid, command: p.command, signal: "SIGTERM" });
      continue;
    }
    try {
      process.kill(p.pid, "SIGKILL");
      reaped.push({ pid: p.pid, command: p.command, signal: "SIGKILL" });
    } catch {
      // Survived both signals and cannot be signalled: not ours. Leave it.
    }
  }
  return reaped;
}
