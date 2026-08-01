import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * A `git worktree add` produces a tree with no node_modules, so the first thing
 * every worker did was run the install itself — inside its own turn and budget
 * (measured: a 164 MB install per task worktree, repeated for every task of a
 * run). Seeding it here at worktree creation pays that cost once, off the
 * agent's clock, and warm from the package manager's content-addressed store.
 *
 * Best-effort by design: a repo with no lockfile, or an install that fails, is
 * the worker's problem to solve exactly as before — nothing here may sink a task.
 */
export async function seedWorktreeDeps(wtPath: string): Promise<{ manager: string; ok: boolean; seconds: number } | null> {
  const managers: [lockfile: string, command: string[]][] = [
    ["pnpm-lock.yaml", ["pnpm", "install", "--prefer-offline"]],
    ["package-lock.json", ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"]],
    ["yarn.lock", ["yarn", "install", "--frozen-lockfile", "--non-interactive"]],
  ];
  const hit = managers.find(([lockfile]) => existsSync(path.join(wtPath, lockfile)));
  if (!hit || existsSync(path.join(wtPath, "node_modules"))) return null;
  const [, command] = hit;
  const started = Date.now();
  try {
    await execFileP(command[0]!, command.slice(1), { cwd: wtPath, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    return { manager: command[0]!, ok: true, seconds: Math.round((Date.now() - started) / 1000) };
  } catch {
    return { manager: command[0]!, ok: false, seconds: Math.round((Date.now() - started) / 1000) };
  }
}
