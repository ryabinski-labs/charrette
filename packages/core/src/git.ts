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

/**
 * Whether this repository can host a run at all — asked before anything is spent.
 *
 * Every task the harness dispatches runs in a `git worktree`, and a worktree
 * needs a commit to branch from. A repository with no commits — `git init` and
 * nothing since — fails at `git worktree add` with `fatal: invalid reference:
 * main`, and it fails once per task, after intake and planning have already been
 * paid for and the operator has approved a plan that was never going to run. One
 * live run died exactly this way, with the PRD it was pointed at sitting
 * untracked in the working tree.
 *
 * Returns why the run cannot start, or null when it can.
 */
export async function repoUnusable(repoPath: string): Promise<string | null> {
  const inside = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]).catch(() => "");
  if (inside !== "true") {
    return `${repoPath} is not a git repository.\n\nThe harness builds every task on a branch in its own worktree, so it needs one. Run \`git init\`, commit what is already there, and start the run again.`;
  }
  const head = await git(repoPath, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
  if (!head) {
    return (
      `${repoPath} is a git repository with no commits, so there is nothing for a worktree to branch from.\n\n` +
      `Every task runs in its own worktree, and \`git worktree add\` on an unborn branch fails outright — the run would interview you, plan, charge for both, and then fail once per task. ` +
      `Untracked files are invisible inside a worktree too, so anything the assignment points at has to be committed to be readable there.\n\n` +
      `  git add -A && git commit -m "initial commit"\n\n` +
      `then start the run again.`
    );
  }
  return null;
}

/**
 * How much of the file list the planner is given, in characters. Roughly four
 * characters per token, so a few thousand tokens at the cap — measurably worth
 * it (see below) and still an order of magnitude under anything that crowds out
 * the PRD.
 */
const FILE_LIST_CHARS = 16_000;

/**
 * The repository's tracked files, as text for the planning prompt.
 *
 * Phase B of planning runs with no tools, so anything it knows about the
 * repository has to arrive as prompt text. Measured against what two merged
 * pull requests actually shipped, handing it this list took the ordering
 * constraints a plan gets right from 1.67 to 3.50 — the same score as a full
 * AST dependency graph of the repository, at ~300 tokens and no dependency.
 * Knowing which files exist is the whole of the effect; knowing what imports
 * what added nothing.
 *
 * Over the cap the list becomes directory counts. An alphabetical list cut off
 * at the cap is worse than no list: it tells the planner the repository ends at
 * "m", and a plan that believes that names paths in a tree it cannot see.
 */
export async function repoFileList(repoPath: string, cap = FILE_LIST_CHARS): Promise<string> {
  const out = await git(repoPath, ["ls-files"]).catch(() => "");
  const files = out.split("\n").filter(Boolean);
  if (!files.length) return "";
  const flat = files.join("\n");
  if (flat.length <= cap) return flat;

  const counts = new Map<string, number>();
  for (const f of files) {
    const dir = path.dirname(f);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const header = `${files.length} tracked files — too many to name. The directories they are in:\n`;
  const rolled = [...counts.keys()].sort().map((d) => `${d === "." ? "(repository root)" : d} — ${counts.get(d)} file${counts.get(d) === 1 ? "" : "s"}`);
  const kept: string[] = [];
  let used = header.length;
  for (const line of rolled) {
    if (used + line.length + 1 > cap) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = rolled.length - kept.length;
  // Say what was dropped. A silently truncated list reads as a complete one.
  return header + kept.join("\n") + (omitted ? `\n… and ${omitted} more director${omitted === 1 ? "y" : "ies"}` : "");
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
  /** Its own lock, so measuring the base never waits on a merge or blocks one. */
  private baselineLock: Promise<unknown> = Promise.resolve();

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

  /** The commit the integration branch currently points at — the base every task is judged against. */
  async integrationHead(runId: string): Promise<string> {
    return git(this.repoPath, ["rev-parse", this.integrationBranch(runId)], { serialize: true }).catch(() => "");
  }

  /**
   * Run something against one commit of the integration branch, in a worktree of
   * its own, and give the caller its path.
   *
   * Deliberately not the integration worktree: what runs here is a full test
   * suite that can take minutes, and the integration worktree is where merges
   * land — a merge landing under a running suite would corrupt both. Serialized
   * so a second caller cannot check out a different commit mid-suite, and reused
   * across commits so the dependency install is paid once per run.
   */
  async withBaselineWorktree<T>(runId: string, sha: string, fn: (wtPath: string) => Promise<T>): Promise<T> {
    const wtPath = path.join(this.worktreeRoot(), runId, "__baseline__");
    const run = async (): Promise<T> => {
      if (!existsSync(wtPath)) {
        await git(this.repoPath, ["worktree", "add", "--detach", wtPath, sha], { serialize: true });
      } else {
        await git(wtPath, ["checkout", "--detach", "--force", sha], { serialize: true });
        // Leftovers from the previous commit's suite. Without -x, so the seeded
        // node_modules (gitignored) survives and is not reinstalled every time.
        await git(wtPath, ["clean", "-fd"], { serialize: true }).catch(() => undefined);
      }
      return fn(wtPath);
    };
    const next = this.baselineLock.then(run, run);
    this.baselineLock = next.catch(() => undefined);
    return next;
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
   * Bring the integration branch *into* a task's worktree, so the worker that
   * wrote the code can resolve the conflict itself.
   *
   * A task branches from the integration branch when it starts and merges back
   * when it is accepted; anything that merged in between is divergence it has
   * never seen. That is not a defect in the work — one run parked two tasks
   * this way, both carrying QA-accepted code, both colliding on the same shared
   * registry module that the plan told every task to append to.
   *
   * A failed merge is deliberately left in place rather than aborted: the
   * worker gets real conflict markers and a `git status` that says what to fix,
   * which is the thing it is best at. `git merge --abort` remains available to
   * it if it decides the merge is wrong.
   */
  async catchUpTaskBranch(runId: string, taskId: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    const wtPath = path.join(this.worktreeRoot(), runId, taskId);
    const integration = this.integrationBranch(runId);
    const run = async (): Promise<{ ok: true } | { ok: false; conflicts: string[] }> => {
      try {
        await git(wtPath, ["merge", "--no-ff", "--no-edit", integration], { serialize: true });
        return { ok: true };
      } catch {
        const status = await git(wtPath, ["diff", "--name-only", "--diff-filter=U"], { serialize: true }).catch(() => "");
        const conflicts = status.split("\n").filter(Boolean);
        // No unmerged paths means the merge failed for some other reason (a
        // dirty worktree, say). Leaving a half-merge behind then helps nobody.
        if (!conflicts.length) await git(wtPath, ["merge", "--abort"], { serialize: true }).catch(() => undefined);
        return { ok: false, conflicts };
      }
    };
    const next = this.mergeLock.then(run, run);
    this.mergeLock = next.catch(() => undefined);
    return next;
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
