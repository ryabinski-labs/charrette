import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Where a Node project commonly lives when the repo root is not one.
 *
 * A repo shaped `frontend/` + `backend/` — the Iceland Co-Pilot and Alaska
 * layout — has real manifests and real checks, just not at the top. Both the
 * check detector and the dependency seeder walk this list, and they must walk
 * the same one: checks inferred for a directory that never gets an install are
 * a red baseline on every worktree, which parks every task in the run.
 */
export const SUBPROJECT_DIRS = ["frontend", "backend", "client", "server", "web", "api", "app", "src"];

const MANAGERS: [lockfile: string, command: string[]][] = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--prefer-offline"]],
  ["package-lock.json", ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile", "--non-interactive"]],
];

export interface SeededDeps {
  /** Relative to the worktree; "" for the root. */
  dir: string;
  manager: string;
  ok: boolean;
  seconds: number;
}

/** Per-install ceiling, and the ceiling on a whole worktree's seeding. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const SEED_TIMEOUT_MS = 20 * 60 * 1000;
/** How long a killed install gets to exit on its own before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * Signal the child's whole process group, not just the child.
 *
 * Negating the pid is what reaches grandchildren; it only works because the
 * child was spawned `detached`, which makes it a group leader. `try` because
 * the group is routinely gone already — that is a win, not an error.
 */
function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    /* the group is already gone, which is the outcome this was asking for */
  }
}

/**
 * Run one install, and always settle.
 *
 * `execFile`'s own `timeout` looked like it covered this and did not, twice
 * over. It signals the direct child only, so a wedged postinstall grandchild —
 * measured: puppeteer's Chromium download on a half-open socket — survives and
 * keeps the package manager alive; and the promise settles on the child's
 * `close`, so a package manager that never exits is awaited forever. A run hit
 * this with all three worker slots held by installs that had already been
 * timed out 40 minutes earlier, and no escalation could reach them because a
 * task's wall clock does not start until seeding returns.
 *
 * So: kill the group, and resolve on the timer rather than on the child. A
 * process that ignores both signals is left to the OS; it can no longer hold a
 * slot.
 */
function run(command: string[], cwd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    // stdio is discarded, not piped: nothing reads an install's output, and a
    // pipe nobody drains is its own way to wedge.
    const child = spawn(command[0]!, command.slice(1), { cwd, detached: true, stdio: "ignore" });
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      // `child.pid` is undefined only when the spawn itself failed, and that
      // path settles through `error` — measured at a millisecond, against a
      // timeout measured in minutes — so this timer is long cleared by then.
      const pid = child.pid!;
      killTree(pid, "SIGTERM");
      setTimeout(() => killTree(pid, "SIGKILL"), KILL_GRACE_MS).unref();
      settle(false);
    }, timeoutMs);
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
}

async function install(wtPath: string, dir: string, deadline: number): Promise<SeededDeps | null> {
  const root = path.join(wtPath, dir);
  const hit = MANAGERS.find(([lockfile]) => existsSync(path.join(root, lockfile)));
  if (!hit || existsSync(path.join(root, "node_modules"))) return null;
  const [, command] = hit;
  const started = Date.now();
  const budget = Math.min(INSTALL_TIMEOUT_MS, deadline - started);
  const ok = budget > 0 && (await run(command, root, budget));
  return { dir, manager: command[0]!, ok, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * A `git worktree add` produces a tree with no node_modules, so the first thing
 * every worker did was run the install itself — inside its own turn and budget
 * (measured: a 164 MB install per task worktree, repeated for every task of a
 * run). Seeding it here at worktree creation pays that cost once, off the
 * agent's clock, and warm from the package manager's content-addressed store.
 *
 * Every directory with a lockfile is seeded, not only the root. Testing the root
 * alone meant a repo whose lockfiles live in `frontend/` and `backend/` got no
 * install at all, and then every worktree ran `cd frontend && npm run typecheck`
 * against an absent node_modules — a check that cannot pass in a fresh worktree,
 * which parks the task it is charged to and, since it is charged to all of them,
 * the whole run. The workaround in icelandcopilot-companion was to fold `npm ci`
 * into the check itself, paying the install once per check invocation instead of
 * once per worktree.
 *
 * Best-effort by design: a repo with no lockfile, or an install that fails, is
 * the worker's problem to solve exactly as before — nothing here may sink a task.
 * That promise is load-bearing: the caller holds a worker slot across this call
 * and the task's wall clock has not started yet, so this must return come what
 * may. Hence a deadline over the whole thing and not only over each install —
 * nine subproject directories at a ten-minute ceiling each is a slot held for
 * ninety minutes, which is a hang with extra steps.
 */
export async function seedWorktreeDeps(wtPath: string, timeoutMs = SEED_TIMEOUT_MS): Promise<SeededDeps[]> {
  const deadline = Date.now() + timeoutMs;
  const seeded: SeededDeps[] = [];
  const root = await install(wtPath, "", deadline);
  if (root) seeded.push(root);
  // Run one at a time rather than in parallel: two package managers installing
  // at once contend on the same content-addressed store, and the whole point of
  // seeding here is that nobody is waiting on it.
  for (const dir of SUBPROJECT_DIRS) {
    const sub = await install(wtPath, dir, deadline);
    if (sub) seeded.push(sub);
  }
  return seeded;
}
