import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileP = promisify(execFile);

/**
 * Add `entry` to the target repo's `.gitignore` unless git already ignores it.
 *
 * The charrette writes its state into the repo it is working on, and that state is
 * not source: `.charrette/charrette.db` is the run ledger, holding every prompt,
 * every tool result and every file an agent read. A stray `git add -A` in the
 * target repo would commit the whole transcript — megabytes that rewrite on
 * every event. So the charrette cleans up after itself rather than leaving the
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
 * Push one of the run's own branches, and explain a rejection instead of
 * relaying git's.
 *
 * The charrette only ever pushes `charrette/<runId>/*` (SEC-5), and it treats those
 * as append-only, so a plain push is expected to fast-forward and nothing is
 * ever forced. That held until a human opened a pull request *into* a run's
 * integration branch and merged it: origin moved ahead of the local branch, and
 * every subsequent push was rejected as non-fast-forward. Run 3ae58e02 reported
 * `merged locally, but the pull request could not be opened: Command failed:
 * git push origin charrette/3ae58e02/main` — 60 merged tasks, and nothing in that
 * sentence says the remote has commits the operator wants to keep.
 *
 * A force push is not the answer and is not offered here: the commits on the
 * remote are the ones a person deliberately merged. Reconciling them is a merge
 * with conflicts to resolve, which is the operator's call, so this says exactly
 * that and stops.
 */
export async function pushRunBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await git(repoPath, ["push", "origin", branch], { serialize: true });
    return;
  } catch (e) {
    // The tracking ref may be absent or stale — a rejection is precisely the
    // case where what we last saw of origin is out of date. Ask origin.
    const fetched = await git(repoPath, ["fetch", "origin", branch], { serialize: true }).then(
      () => true,
      () => false
    );
    const behind = fetched ? await git(repoPath, ["rev-list", "--count", `${branch}..FETCH_HEAD`]).catch(() => "0") : "0";
    if (behind === "0") throw e; // a rejection for some other reason: no credentials, protected branch, a hook
    const ahead = await git(repoPath, ["rev-list", "--count", `FETCH_HEAD..${branch}`]).catch(() => "?");
    throw new Error(
      `${branch} has diverged from origin: ${behind} commit(s) on origin are not in the local branch, and ${ahead} local commit(s) are not on origin.\n\n` +
        `Something merged into this branch on GitHub — a pull request opened against it, most likely. Those commits are not the charrette's to discard, and it never force-pushes, so publishing has to wait for the two to be reconciled:\n\n` +
        `  git fetch origin ${branch}\n` +
        `  git merge origin/${branch}      # in the run's integration worktree\n\n` +
        `then \`charrette resume\` opens the pull request.`
    );
  }
}

/**
 * Whether this repository can host a run at all — asked before anything is spent.
 *
 * Every task the charrette dispatches runs in a `git worktree`, and a worktree
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
    return `${repoPath} is not a git repository.\n\nThe charrette builds every task on a branch in its own worktree, so it needs one. Run \`git init\`, commit what is already there, and start the run again.`;
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

/**
 * What happened when a task branch was offered to the integration branch.
 *
 * `empty` is its own outcome rather than a flavour of failure: a conflict means
 * two pieces of real work disagree and a worker can resolve it, while an empty
 * branch means there is no work at all, and telling a worker to "resolve the
 * conflict" in that state sends it looking for something that does not exist.
 */
export type MergeOutcome = { ok: true; sha: string } | { ok: false; empty: true } | { ok: false; conflicts: string[] };

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

  /**
   * Run one merge sequence with the merge lock held, and hand the lock on
   * whatever the sequence did.
   *
   * `then(run, run)` rather than `then(run)`: the next sequence is owed its turn
   * even when the last one threw. What the lock is then left holding must not be
   * the rejection itself — nothing awaits the lock, so a rejected promise parked
   * in it is an unhandled rejection, which this suite's reporter turns into a
   * failed run (see `vitest.config.ts`). The caller still gets the rejection;
   * only the lock's copy is neutralised.
   */
  private serialiseMerge<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mergeLock.then(run, run);
    this.mergeLock = next.catch(() => undefined);
    return next;
  }

  worktreeRoot(): string {
    return path.join(path.dirname(this.repoPath), `${path.basename(this.repoPath)}-wt`);
  }

  branchName(runId: string, taskId: string): string {
    return `charrette/${runId}/${taskId}`;
  }

  integrationBranch(runId: string): string {
    return `charrette/${runId}/main`;
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

  /**
   * The primary repository's own checked-out branch and commit.
   *
   * The one place in the whole run that nothing should ever write. Every task
   * has a worktree; the operator's checkout is not one of them, and work that
   * lands there lands on a branch no part of the run will look at. Sampled
   * around each worker session so that when the guard is evaded — by a shell
   * script, a Makefile, anything indirect enough to read as ordinary — the run
   * still records that it happened, and which task was live at the time.
   */
  async primaryHead(): Promise<string> {
    const branch = await git(this.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"], { serialize: true }).catch(() => "");
    const sha = await git(this.repoPath, ["rev-parse", "HEAD"], { serialize: true }).catch(() => "");
    return branch && sha ? `${branch}@${sha}` : "";
  }

  /** The commit the integration branch currently points at — the base every task is judged against. */
  async integrationHead(runId: string): Promise<string> {
    return git(this.repoPath, ["rev-parse", this.integrationBranch(runId)], { serialize: true }).catch(() => "");
  }

  /**
   * What a task's branch actually carries over the base it will merge into.
   *
   * Nothing else in the charrette ever asks. `git merge --no-ff` on a branch with
   * no commits prints `Already up to date.` and exits 0, so `mergeTaskBranch`
   * reports success, `integrate` books MERGED, and `mergedShas` records the
   * integration branch's own pre-existing commit as the task's delivery — which
   * is then the sha posted to the task's GitHub issue. In run da8325bd three
   * branches were in exactly that state, and the ledger called all three
   * merged; the operator did not find out until a demo agent rendered the page
   * the work was supposed to have changed.
   *
   * The file list is the signal, not the commit count: a task branch also picks
   * up catch-up merges from the integration branch, and those are commits that
   * deliver nothing of the task's own. A three-dot diff is measured from the
   * merge base, so it answers the question that matters — what would landing
   * this branch change? — whatever the topology above it looks like.
   *
   * `landed` is the other way that question comes back empty, and until it
   * existed the two were indistinguishable. A branch whose work is *already on*
   * the integration branch also changes no file against it — for the best
   * possible reason — and calling that "nothing has been committed" sends a
   * worker to find work that is not lost and cannot be re-delivered, because a
   * branch cannot be un-merged. Run bc691359 lost six days to exactly that: QA
   * accepted `m1-exit-evidence` eight times, the merges failed on a dirty
   * integration worktree, the work reached the integration branch anyway, and
   * every dispatch after that parked it as an empty branch that no answer from
   * the operator could ever have fixed.
   *
   * Ancestry alone does not separate them: a branch that has just been created
   * is an ancestor of the integration branch too. What separates them is *how*
   * the tip got there. This charrette only ever moves the integration branch by
   * `merge --no-ff` of a task branch, so its first-parent chain is exactly the
   * list of commits it has ever pointed at — a branch that delivered nothing
   * still sits on one of them, and a branch that was merged in hangs off a
   * second parent and is not on the chain. The sha reported is the integration
   * commit that carries it: the oldest one that has the tip as an ancestor,
   * which is the merge that brought it in.
   */
  async taskBranchDelta(runId: string, taskId: string): Promise<{ commits: number; files: string[]; landed: string }> {
    const branch = this.branchName(runId, taskId);
    const base = this.integrationBranch(runId);
    const count = await git(this.repoPath, ["rev-list", "--count", `${base}..${branch}`], { serialize: true }).catch(() => "0");
    const files = await git(this.repoPath, ["diff", "--name-only", `${base}...${branch}`], { serialize: true }).catch(() => "");
    return { commits: Number(count) || 0, files: files.split("\n").filter(Boolean), landed: await this.landedSha(branch, base) };
  }

  /**
   * The integration-branch commit that already carries this branch, or "".
   *
   * Only asked when the branch changes no file against the integration branch,
   * which is the one case where "it is already in there" and "there was never
   * anything in it" look the same from the outside.
   */
  private async landedSha(branch: string, base: string): Promise<string> {
    // Asked first because it also answers "does this branch exist?" — an
    // unresolvable ref fails here, and "not contained" is the right answer for
    // it. Everything below can then take the branch for granted.
    const contained = await git(this.repoPath, ["merge-base", "--is-ancestor", branch, base], { serialize: true }).then(
      () => true,
      () => false
    );
    if (!contained) return "";
    const tip = await git(this.repoPath, ["rev-parse", branch], { serialize: true });
    const chain = await git(this.repoPath, ["rev-list", "--first-parent", base], { serialize: true });
    // On the chain: the tip is a commit the integration branch itself once
    // pointed at, so this branch is sitting where it was created and has
    // delivered nothing.
    if (chain.split("\n").includes(tip)) return "";
    const carried = await git(this.repoPath, ["rev-list", "--ancestry-path", `${tip}..${base}`], { serialize: true });
    // Contained, but not a commit the integration branch ever pointed at: it
    // descends past the tip through something that merged the branch in, so
    // the path always holds at least that merge. Its oldest commit is it.
    return carried.split("\n").filter(Boolean).at(-1)!;
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

  /**
   * A checkout of the merged branch that nothing in this run has ever built in.
   *
   * The live-exercise gate's tree. Deliberately not the integration worktree
   * and not the baseline one: both have had installs, builds and suites run in
   * them all run long, and a product that only starts because a previous agent
   * left a `node_modules`, a built binary or a seeded database behind is a
   * product that does not start. `-fdx` removes ignored files too, which is
   * exactly the difference from `withBaselineWorktree` — there, the seeded
   * install surviving is the point; here, it is the thing being tested.
   *
   * Removed and re-added rather than cleaned when it already exists, so a
   * resume gets the same clean tree as a first run.
   */
  async freshWorktree(runId: string, name: string): Promise<string> {
    const wtPath = path.join(this.worktreeRoot(), runId, name);
    if (existsSync(wtPath)) {
      await git(this.repoPath, ["worktree", "remove", "--force", wtPath], { serialize: true }).catch(() => undefined);
      rmSync(wtPath, { recursive: true, force: true });
    }
    await git(this.repoPath, ["worktree", "add", "--detach", wtPath, this.integrationBranch(runId)], { serialize: true });
    await git(wtPath, ["clean", "-fdx"], { serialize: true }).catch(() => undefined);
    return wtPath;
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
    return this.serialiseMerge(run);
  }

  /**
   * Bring the base branch *into* the run's integration branch, so the pull
   * request it opens can actually be merged.
   *
   * A run branches once, at the start, and merges every accepted task into that
   * branch. `main` does not stop moving while it works — and on a run of any
   * length the two diverge, so the rollup opened at the end is one GitHub
   * refuses to merge. Nothing in the charrette ever looked: run 5743ce85 spent
   * $373, merged 64 tasks, opened #834 CONFLICTING, and reported it to the
   * operator as "1 pull request open for review".
   *
   * `origin` is re-read first, because the local ref is only ever as fresh as
   * the operator's last fetch and is routinely months stale — reconciling
   * against it would produce a branch that still cannot merge. A repo with no
   * remote, or a fetch that fails, falls back to the local branch and says so:
   * a stale answer is worth more than no answer here, and the pull request's own
   * mergeability is checked against GitHub afterwards either way.
   *
   * A conflicted merge is left in place exactly as `catchUpTaskBranch` leaves
   * one. The integration worktree is where the agent that resolves it works,
   * and it needs the markers; `abortIntegrationMerge` is the way back out.
   */
  async catchUpIntegrationBranch(
    runId: string,
    base: string
  ): Promise<{ ok: true; moved: boolean; ref: string; sha: string } | { ok: false; conflicts: string[]; ref: string; sha: string }> {
    const run = async (): Promise<{ ok: true; moved: boolean; ref: string; sha: string } | { ok: false; conflicts: string[]; ref: string; sha: string }> => {
      const wtPath = await this.ensureIntegrationWorktree(runId);
      // Fetched in the worktree rather than the primary checkout so FETCH_HEAD
      // is unambiguously the ref that was just written, whatever else the
      // operator's repository is doing.
      const fetched = await git(wtPath, ["fetch", "origin", base], { serialize: true }).then(
        () => true,
        () => false
      );
      const ref = fetched ? "FETCH_HEAD" : base;
      const label = fetched ? `origin/${base}` : base;
      // Resolved once, here. `FETCH_HEAD` is rewritten by the next fetch of any
      // ref, so it is not something a later call can ask a question about — and
      // "did the agent actually merge the base?" is asked after an agent has had
      // a whole session to run git commands of its own.
      const sha = await git(wtPath, ["rev-parse", ref], { serialize: true }).catch(() => "");
      // Already contained: `git merge` would print "Already up to date" and exit
      // 0, which is indistinguishable from a merge that landed a commit.
      const contained = await git(wtPath, ["merge-base", "--is-ancestor", ref, "HEAD"], { serialize: true }).then(
        () => true,
        () => false
      );
      if (contained) return { ok: true, moved: false, ref: label, sha };
      try {
        await git(wtPath, ["merge", "--no-ff", "--no-edit", ref], { serialize: true });
        return { ok: true, moved: true, ref: label, sha };
      } catch {
        const status = await git(wtPath, ["diff", "--name-only", "--diff-filter=U"], { serialize: true }).catch(() => "");
        const conflicts = status.split("\n").filter(Boolean);
        // No unmerged paths means the merge failed for some other reason — an
        // unresolvable ref, a dirty worktree. A half-merge left behind then
        // helps nobody, and the empty list tells the caller to say so.
        if (!conflicts.length) await git(wtPath, ["merge", "--abort"], { serialize: true }).catch(() => undefined);
        return { ok: false, conflicts, ref: label, sha };
      }
    };
    return this.serialiseMerge(run);
  }

  /**
   * Whether the integration worktree is sitting on an unfinished merge, and what
   * is still conflicted in it.
   *
   * Asked after an agent has been sent to resolve one. An agent that resolved
   * and committed leaves no MERGE_HEAD; one that gave up half way leaves the
   * merge open, and a run must never publish that tree as if it were finished.
   */
  async integrationMergeState(runId: string): Promise<{ merging: boolean; conflicts: string[] }> {
    const wtPath = await this.ensureIntegrationWorktree(runId);
    const merging = await git(wtPath, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { serialize: true }).then(
      (out) => Boolean(out),
      () => false
    );
    const status = await git(wtPath, ["diff", "--name-only", "--diff-filter=U"], { serialize: true }).catch(() => "");
    return { merging, conflicts: status.split("\n").filter(Boolean) };
  }

  /**
   * Whether the integration branch actually contains a commit.
   *
   * Asked of the base's own sha after an agent has been let loose on a conflict,
   * because the cheap proxies both lie. "The head moved" is also true of an
   * agent that aborted the merge and then committed something else; "no
   * conflicts left" is also true of an agent that aborted and tidied up. Only
   * ancestry answers the question the pull request depends on.
   */
  async integrationContains(runId: string, sha: string): Promise<boolean> {
    if (!sha) return false;
    const wtPath = await this.ensureIntegrationWorktree(runId);
    return git(wtPath, ["merge-base", "--is-ancestor", sha, "HEAD"], { serialize: true }).then(
      () => true,
      () => false
    );
  }

  /** Put the integration worktree back where it was after a merge nobody could resolve. */
  async abortIntegrationMerge(runId: string): Promise<void> {
    const run = async (): Promise<void> => {
      const wtPath = await this.ensureIntegrationWorktree(runId);
      await git(wtPath, ["merge", "--abort"], { serialize: true }).catch(() => undefined);
    };
    return this.serialiseMerge(run);
  }

  /**
   * Continuous integration (PRD §11.1): merge an accepted task branch into the run's
   * integration branch. Returns conflict file list on failure instead of throwing.
   * One merge sequence at a time (see mergeLock).
   */
  async mergeTaskBranch(runId: string, taskId: string): Promise<MergeOutcome> {
    const run = async (): Promise<MergeOutcome> => {
      const branch = this.branchName(runId, taskId);
      const wtPath = await this.ensureIntegrationWorktree(runId);
      try {
        // The integration worktree holds no work of its own — every commit in it
        // arrives by merge — so anything in its working tree is an artifact some
        // check left behind, and git refuses to merge over it. That refusal is
        // not a conflict: it names no unmerged paths, so it used to reach the
        // worker as "resolve the conflicts in " with an empty list, pointing at
        // a worktree where nothing was wrong. Run bc691359 lost two QA-accepted
        // tasks that way, to one generated markdown file a test suite rewrote in
        // here. Ignored files are left alone: they are build caches, and
        // discarding them costs a rebuild without preventing anything.
        await git(wtPath, ["reset", "--hard", "HEAD"], { serialize: true });
        await git(wtPath, ["clean", "-fd"], { serialize: true });
        const before = await git(wtPath, ["rev-parse", "HEAD"], { serialize: true });
        await git(wtPath, ["merge", "--no-ff", "--no-edit", branch], { serialize: true });
        const sha = await git(wtPath, ["rev-parse", "HEAD"], { serialize: true });
        // `--no-ff` commits for any merge that has something to merge, so a HEAD
        // that did not move is git's "Already up to date" — an exit code of 0
        // reporting that the branch carried nothing. The pre-QA gate normally
        // catches this long before here; this is the backstop that makes it
        // impossible to book a MERGED task against a commit it did not write.
        if (sha === before) return { ok: false, empty: true };
        return { ok: true, sha };
      } catch (e) {
        const status = await git(wtPath, ["diff", "--name-only", "--diff-filter=U"], { serialize: true }).catch(() => "");
        await git(wtPath, ["merge", "--abort"], { serialize: true }).catch(() => undefined);
        const conflicts = status.split("\n").filter(Boolean);
        // A merge can fail without conflicting — a hook that rejected it, an
        // index left wedged, a worktree that could not be cleaned above. Git
        // names no files in those cases, and an empty conflict list is not a
        // conflict: handed back as one it sends a worker to reconcile files
        // nothing reported, and the failure repeats on every attempt because
        // the worker was never able to address its cause. Say what happened
        // instead and let the caller park it for a human.
        if (!conflicts.length) {
          // execFile folds git's stderr into the message, which is where the
          // actual reason lives ("your local changes would be overwritten by
          // merge", a hook's own words) — the exit status alone says nothing.
          const detail = String(e).trim().split("\n").slice(0, 4).join("; ");
          throw new Error(`merging ${branch} into ${this.integrationBranch(runId)} failed without naming a conflict: ${detail}`);
        }
        return { ok: false, conflicts };
      }
    };
    return this.serialiseMerge(run);
  }
}
