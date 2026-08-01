import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

/** Serialize mutating git ops in the main repo — parallel worktree ops corrupt via git's global locks. */
let mainRepoLock: Promise<unknown> = Promise.resolve();

export async function git(cwd: string, args: string[], opts: { serialize?: boolean } = {}): Promise<string> {
  const run = async () => {
    const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  };
  if (!opts.serialize) return run();
  const next = mainRepoLock.then(run, run);
  mainRepoLock = next.catch(() => undefined);
  return next;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export class WorktreeManager {
  constructor(private repoPath: string) {}

  worktreeRoot(): string {
    return path.join(path.dirname(this.repoPath), `${path.basename(this.repoPath)}-wt`);
  }

  branchName(runId: string, taskId: string): string {
    return `harness/${runId}/${taskId}`;
  }

  integrationBranch(runId: string): string {
    return `harness/${runId}/main`;
  }

  async ensureIntegrationBranch(runId: string, baseRef = "HEAD"): Promise<string> {
    const branch = this.integrationBranch(runId);
    const exists = await git(this.repoPath, ["branch", "--list", branch], { serialize: true });
    if (!exists) await git(this.repoPath, ["branch", branch, baseRef], { serialize: true });
    return branch;
  }

  /** Create (or reuse, on resume) a worktree for a task, branched from the integration branch. */
  async ensureWorktree(runId: string, taskId: string): Promise<WorktreeInfo> {
    const branch = this.branchName(runId, taskId);
    const wtPath = path.join(this.worktreeRoot(), runId, taskId);
    const existing = await git(this.repoPath, ["worktree", "list", "--porcelain"], { serialize: true });
    if (existing.includes(`worktree ${wtPath}`)) return { path: wtPath, branch };
    const branchExists = await git(this.repoPath, ["branch", "--list", branch], { serialize: true });
    if (branchExists) {
      await git(this.repoPath, ["worktree", "add", wtPath, branch], { serialize: true });
    } else {
      await git(this.repoPath, ["worktree", "add", "-b", branch, wtPath, this.integrationBranch(runId)], { serialize: true });
    }
    return { path: wtPath, branch };
  }

  async removeWorktree(runId: string, taskId: string): Promise<void> {
    const wtPath = path.join(this.worktreeRoot(), runId, taskId);
    await git(this.repoPath, ["worktree", "remove", "--force", wtPath], { serialize: true }).catch(() => undefined);
  }

  async pruneAndReconcile(): Promise<void> {
    await git(this.repoPath, ["worktree", "prune"], { serialize: true }).catch(() => undefined);
  }

  /**
   * Continuous integration (PRD §11.1): merge an accepted task branch into the run's
   * integration branch. Returns conflict file list on failure instead of throwing.
   */
  async mergeTaskBranch(runId: string, taskId: string): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }> {
    const branch = this.branchName(runId, taskId);
    const integration = this.integrationBranch(runId);
    const wtPath = path.join(this.worktreeRoot(), runId, "__integration__");
    const existing = await git(this.repoPath, ["worktree", "list", "--porcelain"], { serialize: true });
    if (!existing.includes(`worktree ${wtPath}`)) {
      await git(this.repoPath, ["worktree", "add", wtPath, integration], { serialize: true });
    }
    try {
      await git(wtPath, ["merge", "--no-ff", "--no-edit", branch], { serialize: true });
      const sha = await git(wtPath, ["rev-parse", "HEAD"], { serialize: true });
      return { ok: true, sha };
    } catch {
      const status = await git(wtPath, ["diff", "--name-only", "--diff-filter=U"], { serialize: true }).catch(() => "");
      await git(wtPath, ["merge", "--abort"], { serialize: true }).catch(() => undefined);
      return { ok: false, conflicts: status.split("\n").filter(Boolean) };
    }
  }
}
