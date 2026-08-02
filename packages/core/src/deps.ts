import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

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

async function install(wtPath: string, dir: string): Promise<SeededDeps | null> {
  const root = path.join(wtPath, dir);
  const hit = MANAGERS.find(([lockfile]) => existsSync(path.join(root, lockfile)));
  if (!hit || existsSync(path.join(root, "node_modules"))) return null;
  const [, command] = hit;
  const started = Date.now();
  try {
    await execFileP(command[0]!, command.slice(1), { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    return { dir, manager: command[0]!, ok: true, seconds: Math.round((Date.now() - started) / 1000) };
  } catch {
    return { dir, manager: command[0]!, ok: false, seconds: Math.round((Date.now() - started) / 1000) };
  }
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
 */
export async function seedWorktreeDeps(wtPath: string): Promise<SeededDeps[]> {
  const seeded: SeededDeps[] = [];
  const root = await install(wtPath, "");
  if (root) seeded.push(root);
  // Run one at a time rather than in parallel: two package managers installing
  // at once contend on the same content-addressed store, and the whole point of
  // seeding here is that nobody is waiting on it.
  for (const dir of SUBPROJECT_DIRS) {
    const sub = await install(wtPath, dir);
    if (sub) seeded.push(sub);
  }
  return seeded;
}
