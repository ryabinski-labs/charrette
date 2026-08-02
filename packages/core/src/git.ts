import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

/**
 * Add `entry` to the target repo's `.gitignore` unless git already ignores it.
 *
 * The harness writes its state into the repo it is working on, and that state is
 * not source: `.harness/harness.db` is the run ledger, holding every prompt,
 * every tool result and every file an agent read. A stray `git add -A` in the
 * target repo would commit the whole transcript — megabytes that rewrite on
 * every event. So the harness cleans up after itself rather than leaving the
 * operator to notice.
 *
 * Deliberately synchronous: this runs once at startup, before the run exists,
 * and making it async would turn the controller's construction async with it.
 */
export function ensureIgnored(repoPath: string, entry: string): boolean {
  try {
    // Ask git rather than reading the file: the entry may already be covered by
    // a parent .gitignore, the global excludesfile, or .git/info/exclude, and a
    // redundant line in someone else's repo is still an unwanted diff.
    execFileSync("git", ["check-ignore", "-q", "--no-index", entry], { cwd: repoPath, stdio: "ignore" });
    return false; // already ignored
  } catch (e) {
    // Exit 1 is the answer "not ignored". Anything else — not a repo, no git on
    // PATH — means we cannot reason about the repo and must not write to it.
    if ((e as { status?: number }).status !== 1) return false;
  }
  const file = path.join(repoPath, ".gitignore");
  try {
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    const lead = existing === "" || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(file, `${lead}${entry}\n`);
    return true;
  } catch {
    // An unwritable .gitignore is the operator's business, not a reason to
    // refuse to start the run.
    return false;
  }
}

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
  /** False when the worktree already existed (resume) — its deps are already seeded. */
  created: boolean;
}

export class WorktreeManager {
  /**
   * The integration worktree, memoized per run. The exists-check and the
   * `worktree add` must act as one unit: with parallel workers two tasks can
   * finish together, both see the worktree missing, and the second add throws.
   */
  private integrationReady = new Map<string, Promise<string>>();
  /**
   * Merges are a check-merge-abort *sequence* of git calls; the per-call repo
   * lock alone would let two concurrent merges interleave (B's merge landing
   * between A's failed merge and A's abort wedges the worktree on MERGE_HEAD).
   */
  private mergeLock: Promise<unknown> = Promise.resolve();

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
    // The filesystem, not `git worktree list` — the list prints canonical paths
    // (/private/var vs /var on macOS), so the string comparison missed existing
    // worktrees and the re-add failed on "branch already checked out".
    if (existsSync(wtPath)) return { path: wtPath, branch, created: false };
    const branchExists = await git(this.repoPath, ["branch", "--list", branch], { serialize: true });
    if (branchExists) {
      await git(this.repoPath, ["worktree", "add", wtPath, branch], { serialize: true });
    } else {
      await git(this.repoPath, ["worktree", "add", "-b", branch, wtPath, this.integrationBranch(runId)], { serialize: true });
    }
    return { path: wtPath, branch, created: true };
  }

  async removeWorktree(runId: string, taskId: string): Promise<void> {
    const wtPath = path.join(this.worktreeRoot(), runId, taskId);
    await git(this.repoPath, ["worktree", "remove", "--force", wtPath], { serialize: true }).catch(() => undefined);
  }

  async pruneAndReconcile(): Promise<void> {
    await git(this.repoPath, ["worktree", "prune"], { serialize: true }).catch(() => undefined);
  }

  /** The integration branch checked out on disk — where merges land and the validator reads. */
  async ensureIntegrationWorktree(runId: string): Promise<string> {
    let ready = this.integrationReady.get(runId);
    if (!ready) {
      ready = (async () => {
        const wtPath = path.join(this.worktreeRoot(), runId, "__integration__");
        // The filesystem, not `git worktree list`: the list prints canonical paths,
        // and on macOS /var is a symlink to /private/var — the string comparison
        // missed an existing worktree and the second add failed on it.
        if (!existsSync(wtPath)) {
          await git(this.repoPath, ["worktree", "add", wtPath, this.integrationBranch(runId)], { serialize: true });
        }
        return wtPath;
      })();
      this.integrationReady.set(runId, ready);
      // A failed add must not poison every later merge with the same rejection.
      ready.catch(() => this.integrationReady.delete(runId));
    }
    return ready;
  }

  /**
   * Continuous integration (PRD §11.1): merge an accepted task branch into the run's
   * integration branch. Returns conflict file list on failure instead of throwing.
   * One merge sequence at a time (see mergeLock).
   */
  async mergeTaskBranch(runId: string, taskId: string): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }> {
    const run = async (): Promise<{ ok: true; sha: string } | { ok: false; conflicts: string[] }> => {
      const branch = this.branchName(runId, taskId);
      const wtPath = await this.ensureIntegrationWorktree(runId);
      try {
        await git(wtPath, ["merge", "--no-ff", "--no-edit", branch], { serialize: true });
        const sha = await git(wtPath, ["rev-parse", "HEAD"], { serialize: true });
        return { ok: true, sha };
      } catch {
        const status = await git(wtPath, ["diff", "--name-only", "--diff-filter=U"], { serialize: true }).catch(() => "");
        await git(wtPath, ["merge", "--abort"], { serialize: true }).catch(() => undefined);
        return { ok: false, conflicts: status.split("\n").filter(Boolean) };
      }
    };
    const next = this.mergeLock.then(run, run);
    this.mergeLock = next.catch(() => undefined);
    return next;
  }
}
