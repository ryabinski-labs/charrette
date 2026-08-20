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
  /**
   * True when this was the session's own tooling rather than work the session
   * started — an MCP server the SDK launched on its behalf. Killed either way;
   * the flag only decides what the kill is allowed to explain. See
   * `toolingMarkers`.
   */
  tooling: boolean;
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
export async function reapUnder(root: string, opts: { graceMs?: number; tooling?: string[] } = {}): Promise<Reaped[]> {
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

  const markers = opts.tooling ?? [];
  const isTooling = (command: string): boolean => markers.some((m) => command.includes(m));

  const reaped: Reaped[] = [];
  for (const p of candidates) {
    if (!alive(p.pid)) {
      reaped.push({ pid: p.pid, command: p.command, signal: "SIGTERM", tooling: isTooling(p.command) });
      continue;
    }
    try {
      process.kill(p.pid, "SIGKILL");
      reaped.push({ pid: p.pid, command: p.command, signal: "SIGKILL", tooling: isTooling(p.command) });
    } catch {
      // Survived both signals and cannot be signalled: not ours. Leave it.
    }
  }
  return reaped;
}

/**
 * Runtimes that launch someone else's program. Named because the marker rules
 * below cannot tell `python3` the MCP launcher from `python3` the job an agent
 * started — the distinguishing token is always the thing being launched, never
 * the thing launching it.
 */
const RUNTIMES = new Set([
  "npx", "node", "nodejs", "bun", "bunx", "deno", "python", "python3", "py", "uv", "uvx",
  "ruby", "perl", "php", "java", "dotnet", "sh", "bash", "zsh", "env", "docker", "podman", "pwsh", "powershell",
]);

/**
 * The substrings that identify a session's own tooling in a process listing.
 *
 * Every agent session runs with `settingSources: ["user"]`, so the SDK starts
 * the operator's MCP servers inside the session — with the session's cwd, which
 * is the worktree, and no controlling terminal. That is precisely the shape the
 * sweep hunts for, so `chrome-devtools` (`npx -y chrome-devtools-mcp@latest`)
 * was killed and reported as abandoned work at the end of every single session,
 * including ones that never ran a command at all. In run bc691359 a
 * 19-second session that was blocked on its first tool call and started nothing
 * spent the second and last of `m1-live-block-witness`'s abandoned-job retries
 * on it.
 *
 * The markers are read out of the same declarations the SDK launched the servers
 * from rather than guessed, so this is not a denylist of things that look like
 * tooling — it is the list of what this session was actually given. A
 * declaration that yields no usable marker simply contributes nothing, and its
 * server goes back to being reported as work: the direction that costs a retry
 * and a confusing message, not one that hides a real job.
 */
export function toolingMarkers(...declarations: unknown[]): string[] {
  const markers = new Set<string>();
  for (const decl of declarations) {
    if (!decl || typeof decl !== "object") continue;
    for (const server of Object.values(decl as Record<string, unknown>)) {
      if (!server || typeof server !== "object") continue;
      const { command, args } = server as { command?: unknown; args?: unknown };
      const tokens = [command, ...(Array.isArray(args) ? args : [])];
      for (const token of tokens) {
        const m = typeof token === "string" ? marker(token) : null;
        if (m) markers.add(m);
      }
    }
  }
  return [...markers];
}

/**
 * One argument reduced to what would still identify it in `ps`, or nothing.
 *
 * Conservative on purpose: a token that is short, or a bare word with no path
 * or package punctuation in it, is thrown away rather than allowed to match
 * half the process table. The cost of dropping one is a tooling process
 * reported as work — today's behaviour. The cost of keeping a loose one is a
 * killed build reported as tooling, which is silence about the very thing the
 * abandoned-job path exists to explain.
 */
function marker(token: string): string | null {
  if (!token || token.startsWith("-")) return null;
  // `pkg@latest` and `@scope/pkg@1.2.3` run from a path that has no version in
  // it; `@scope/pkg` unversioned has its only `@` at the front and keeps it.
  const at = token.lastIndexOf("@");
  const stripped = at > 0 ? token.slice(0, at) : token;
  if (stripped.length < 6 || !/[/\-_.]/.test(stripped)) return null;
  if (RUNTIMES.has(path.basename(stripped).toLowerCase())) return null;
  return stripped;
}
