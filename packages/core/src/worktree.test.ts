import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, ensureIgnored } from "./git.js";

/**
 * Against real repositories. Worktrees, merges and conflict detection are the
 * one part of the charrette where git's own behaviour *is* the behaviour under
 * test — a stubbed git would only prove that the stub agrees with itself, and
 * every bug this code has had (canonical paths on macOS, a wedged MERGE_HEAD,
 * a branch already checked out) came from git doing something the stub would
 * not have.
 */

const made: string[] = [];

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-wt-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "test@example.invalid");
  run("config", "user.name", "Test");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  return dir;
}

function commit(dir: string, file: string, body: string, message: string): void {
  writeFileSync(path.join(dir, file), body);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", message], { cwd: dir, stdio: "ignore" });
}

const sha = (dir: string, ref = "HEAD") => execFileSync("git", ["rev-parse", ref], { cwd: dir, encoding: "utf8" }).trim();

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("keeping .charrette out of the operator's commits", () => {
  it("adds the entry and reports that it did", () => {
    const dir = repo();

    expect(ensureIgnored(dir, ".charrette/")).toBe(true);
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".charrette/\n");
  });

  it("says nothing when git already ignores it", () => {
    const dir = repo();
    ensureIgnored(dir, ".charrette/");

    expect(ensureIgnored(dir, ".charrette/")).toBe(false);
  });

  it("starts a new line when the existing file does not end in one", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "node_modules");

    ensureIgnored(dir, ".charrette/");

    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.charrette/\n");
  });

  /**
   * The operator's business, not a reason to refuse to start the run: the
   * charrette has somewhere to put its state either way.
   */
  it("gives up quietly on a .gitignore it cannot write", () => {
    const dir = repo();
    // A directory where the file should be: appendFileSync throws EISDIR.
    mkdirSync(path.join(dir, ".gitignore"));

    expect(ensureIgnored(dir, ".charrette/")).toBe(false);
  });

  it("gives up quietly outside a repository, where it cannot reason at all", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "charrette-nogit-"));
    made.push(dir);

    expect(ensureIgnored(dir, ".charrette/")).toBe(false);
    expect(existsSync(path.join(dir, ".gitignore"))).toBe(false);
  });
});

describe("worktrees", () => {
  it("creates one per task, branched off the run's integration branch", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");

    const info = await wt.ensureWorktree("run1", "task1");

    expect(info.created).toBe(true);
    expect(info.branch).toBe("charrette/run1/task1");
    expect(existsSync(path.join(info.path, "README.md"))).toBe(true);
  });

  it("reuses the worktree on a resume rather than failing to re-add it", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    await wt.ensureWorktree("run1", "task1");

    const again = await wt.ensureWorktree("run1", "task1");

    expect(again.created).toBe(false);
  });

  /**
   * The branch outliving its worktree is what a resume after a crash looks
   * like: the directory was cleaned up, the commits were not. Re-adding with
   * `-b` would fail on "branch already exists".
   */
  it("re-attaches to a branch whose worktree is gone", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const first = await wt.ensureWorktree("run1", "task1");
    commit(first.path, "work.txt", "done\n", "task work");
    await wt.removeWorktree("run1", "task1");
    expect(existsSync(first.path)).toBe(false);

    const again = await wt.ensureWorktree("run1", "task1");

    expect(again.created).toBe(true);
    // The commits are still there — this is the same branch, not a fresh one.
    expect(readFileSync(path.join(again.path, "work.txt"), "utf8")).toBe("done\n");
  });

  it("shrugs off removing a worktree that is not there", async () => {
    const wt = new WorktreeManager(repo());

    await expect(wt.removeWorktree("run1", "never-existed")).resolves.toBeUndefined();
  });

  it("prunes without complaint on a repo with no worktrees at all", async () => {
    const wt = new WorktreeManager(repo());

    await expect(wt.pruneAndReconcile()).resolves.toBeUndefined();
  });

  it("creates the integration branch once and reuses it", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);

    expect(await wt.ensureIntegrationBranch("run1")).toBe("charrette/run1/main");
    expect(await wt.ensureIntegrationBranch("run1")).toBe("charrette/run1/main");
    expect(sha(dir, "charrette/run1/main")).toBe(sha(dir, "main"));
  });
});

describe("what a task branch actually carries", () => {
  it("reports nothing for a branch that was created and never committed to", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    await wt.ensureWorktree("run1", "task1");

    expect(await wt.taskBranchDelta("run1", "task1")).toEqual({ commits: 0, files: [], landed: "" });
  });

  it("reports the files a real branch would land", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");

    expect(await wt.taskBranchDelta("run1", "task1")).toEqual({ commits: 1, files: ["work.txt"], landed: "" });
  });

  /**
   * A branch can hold commits and still deliver nothing — a change and its own
   * revert, or an empty commit. The commit count says one thing and the diff
   * says the truth, so the diff is what the gate reads.
   */
  it("reports no files for commits that cancel each other out", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");
    execFileSync("git", ["revert", "--no-edit", "HEAD"], { cwd: info.path, stdio: "ignore" });

    const delta = await wt.taskBranchDelta("run1", "task1");
    expect(delta.commits).toBe(2);
    expect(delta.files).toEqual([]);
    // Nothing landed it — it is genuinely empty, not already delivered.
    expect(delta.landed).toBe("");
  });

  /**
   * The other way the diff comes back empty, and the expensive one to confuse.
   *
   * Once a branch has been merged into the integration branch it changes no
   * file against it — for the best possible reason. Run bc691359 read that as
   * "nothing has been committed" and re-dispatched `m1-exit-evidence` for six
   * days against a branch that could not be un-merged, through eight QA passes.
   */
  it("names the integration commit that already carries a merged branch", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");
    const merge = await wt.mergeTaskBranch("run1", "task1");
    expect(merge.ok).toBe(true);

    const delta = await wt.taskBranchDelta("run1", "task1");
    expect(delta.files).toEqual([]);
    expect(delta.landed).toBe(sha(dir, "charrette/run1/main"));
  });

  /**
   * Ancestry on its own would answer "yes, already merged" for every branch
   * that has just been created, because it is an ancestor of the integration
   * branch too. What separates them is that a branch that delivered nothing
   * sits on a commit the integration branch itself once pointed at.
   */
  it("does not mistake a fresh branch for one that already landed", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const first = await wt.ensureWorktree("run1", "task1");
    commit(first.path, "work.txt", "done\n", "task work");
    await wt.mergeTaskBranch("run1", "task1");

    // Branched from an integration branch that has moved since the run began.
    await wt.ensureWorktree("run1", "task2");
    expect(await wt.taskBranchDelta("run1", "task2")).toEqual({ commits: 0, files: [], landed: "" });
  });

  /**
   * A branch that only ever caught up with the integration branch has a merge
   * commit for a tip, which is not on the integration branch's first-parent
   * chain — but it is not contained in it either, so ancestry rules it out
   * before the chain is ever consulted.
   */
  it("does not call a catch-up merge a delivery", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const first = await wt.ensureWorktree("run1", "task1");
    commit(first.path, "work.txt", "done\n", "task work");
    await wt.mergeTaskBranch("run1", "task1");

    const second = await wt.ensureWorktree("run1", "task2");
    expect(await wt.catchUpTaskBranch("run1", "task2")).toEqual({ ok: true });
    const delta = await wt.taskBranchDelta("run1", "task2");
    expect(delta.files).toEqual([]);
    expect(delta.landed).toBe("");
    void second;
  });

  /**
   * The bug this exists for: git reports success. `merge --no-ff` on a branch
   * with nothing on it prints "Already up to date", exits 0, and leaves the
   * integration branch exactly where it was — which the caller used to record
   * as the task's own delivery.
   */
  it("refuses to call an empty merge a merge", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    await wt.ensureWorktree("run1", "task1");
    const before = sha(dir, "charrette/run1/main");

    const merge = await wt.mergeTaskBranch("run1", "task1");

    expect(merge).toEqual({ ok: false, empty: true });
    expect(sha(dir, "charrette/run1/main")).toBe(before);
  });

  it("still merges a branch that has something on it", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");

    const merge = await wt.mergeTaskBranch("run1", "task1");

    expect(merge.ok).toBe(true);
    expect(sha(dir, "charrette/run1/main")).toBe((merge as { sha: string }).sha);
  });

  /**
   * Run bc691359 stalled here for a day. A check run inside the integration
   * worktree rewrote a generated file that is tracked, git then refused every
   * later merge with "your local changes would be overwritten" — which names no
   * unmerged paths — and the refusal reached two QA-accepted tasks as a conflict
   * in an empty list of files. Nothing in the worktree was theirs to fix.
   */
  it("merges over a tracked file a check left modified in the integration worktree", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "README.md", "written by the task\n", "task work");
    const integration = await wt.ensureIntegrationWorktree("run1");
    writeFileSync(path.join(integration, "README.md"), "regenerated by a test run\n");

    const merge = await wt.mergeTaskBranch("run1", "task1");

    expect(merge.ok).toBe(true);
    expect(readFileSync(path.join(integration, "README.md"), "utf8")).toBe("written by the task\n");
  });

  /** The same refusal, from an artifact that was never tracked at all. */
  it("clears an untracked artifact the merge would have to write over", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "report.txt", "the task's report\n", "task work");
    const integration = await wt.ensureIntegrationWorktree("run1");
    writeFileSync(path.join(integration, "report.txt"), "left behind by a check\n");

    const merge = await wt.mergeTaskBranch("run1", "task1");

    expect(merge.ok).toBe(true);
    expect(readFileSync(path.join(integration, "report.txt"), "utf8")).toBe("the task's report\n");
  });

  /**
   * The blast radius of that cleaning. `mergeTaskBranch` resolves its path
   * through `ensureIntegrationWorktree`, which only ever returns
   * `<repo>-wt/<runId>/__integration__` — and unlike the session call sites it
   * has no `.catch(() => this.repoPath)` fallback. It must stay that way: the
   * operator's own checkout is where their uncommitted work lives, and a
   * `reset --hard` reaching it would be unrecoverable.
   */
  it("never resets the operator's own checkout", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");
    // Uncommitted work in the primary checkout, of both kinds.
    writeFileSync(path.join(dir, "README.md"), "the operator was mid-edit\n");
    writeFileSync(path.join(dir, "scratch.txt"), "and had a scratch file\n");

    expect((await wt.mergeTaskBranch("run1", "task1")).ok).toBe(true);

    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("the operator was mid-edit\n");
    expect(existsSync(path.join(dir, "scratch.txt"))).toBe(true);
  });

  /**
   * Cleaning the worktree removes the cause we know about, not every cause. A
   * merge that fails without naming a file is still not a conflict, and must not
   * be handed to a worker as one: there is nothing for it to reconcile, so it
   * fails the same way on every attempt until the caps run out.
   */
  it("will not call a merge that named no conflicting file a conflict", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");
    const hooks = path.join(dir, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(path.join(hooks, "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await expect(wt.mergeTaskBranch("run1", "task1")).rejects.toThrow(/failed without naming a conflict/);
  });
});

/**
 * Sampled around every worker session so that a commit written into the
 * operator's own checkout is at least recorded. It is asked before the run
 * knows anything about the repository, so it has to answer for a path that is
 * not one — an empty answer means "nothing to compare", and two of those never
 * look like a repository that moved.
 */
describe("watching the operator's own checkout", () => {
  it("names the branch and the commit it is sitting on", async () => {
    const dir = repo();

    expect(await new WorktreeManager(dir).primaryHead()).toBe(`main@${sha(dir)}`);
  });

  it("says nothing at all when the path is not a repository", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "charrette-notrepo-"));
    made.push(dir);

    expect(await new WorktreeManager(dir).primaryHead()).toBe("");
  });
});

describe("measuring the base a task is judged against", () => {
  it("checks out the baseline commit, and moves it on a second call", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const first = sha(dir);
    commit(dir, "later.txt", "second\n", "second commit");
    execFileSync("git", ["branch", "-f", "charrette/run1/main", "HEAD"], { cwd: dir, stdio: "ignore" });
    const second = sha(dir);

    const atFirst = await wt.withBaselineWorktree("run1", first, async (p) => existsSync(path.join(p, "later.txt")));
    // The second call reuses the same directory and checks the new commit out
    // in place — the arm a fresh baseline worktree never reaches.
    const atSecond = await wt.withBaselineWorktree("run1", second, async (p) => existsSync(path.join(p, "later.txt")));

    expect(atFirst).toBe(false);
    expect(atSecond).toBe(true);
  });

  it("clears leftovers from the previous commit's run", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const at = sha(dir);

    await wt.withBaselineWorktree("run1", at, async (p) => writeFileSync(path.join(p, "stray.log"), "from the last suite"));
    const survived = await wt.withBaselineWorktree("run1", at, async (p) => existsSync(path.join(p, "stray.log")));

    expect(survived).toBe(false);
  });

  it("serialises overlapping measurements instead of fighting over the directory", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const at = sha(dir);
    const order: string[] = [];

    await Promise.all([
      wt.withBaselineWorktree("run1", at, async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 20));
        order.push("a-end");
      }),
      wt.withBaselineWorktree("run1", at, async () => void order.push("b")),
    ]);

    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("frees the lock even when the measurement throws", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const at = sha(dir);

    await expect(
      wt.withBaselineWorktree("run1", at, async () => {
        throw new Error("the suite blew up");
      })
    ).rejects.toThrow("the suite blew up");

    // A wedged lock here would stall every later task in the run.
    await expect(wt.withBaselineWorktree("run1", at, async () => "fine")).resolves.toBe("fine");
  });
});

describe("catching a task branch up with what has merged since", () => {
  async function taskOn(dir: string): Promise<WorktreeManager> {
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    await wt.ensureWorktree("run1", "task1");
    return wt;
  }

  it("merges the integration branch in when there is no overlap", async () => {
    const dir = repo();
    const wt = await taskOn(dir);
    const task = path.join(wt.worktreeRoot(), "run1", "task1");
    commit(task, "mine.txt", "task work\n", "task work");
    // Another task merged meanwhile, touching a different file.
    execFileSync("git", ["checkout", "charrette/run1/main"], { cwd: dir, stdio: "ignore" });
    commit(dir, "theirs.txt", "other work\n", "other work");

    await expect(wt.catchUpTaskBranch("run1", "task1")).resolves.toEqual({ ok: true });
    expect(existsSync(path.join(task, "theirs.txt"))).toBe(true);
  });

  it("names the conflicted files and leaves them to be resolved in place", async () => {
    const dir = repo();
    const wt = await taskOn(dir);
    const task = path.join(wt.worktreeRoot(), "run1", "task1");
    commit(task, "shared.txt", "the task's version\n", "task work");
    execFileSync("git", ["checkout", "charrette/run1/main"], { cwd: dir, stdio: "ignore" });
    commit(dir, "shared.txt", "the other task's version\n", "other work");

    const result = await wt.catchUpTaskBranch("run1", "task1");

    expect(result).toEqual({ ok: false, conflicts: ["shared.txt"] });
    // Left conflicted on purpose, so the worker resolves it with the files in
    // front of it rather than being told about it second-hand.
    expect(readFileSync(path.join(task, "shared.txt"), "utf8")).toContain("<<<<<<<");
  });

  /**
   * A merge can fail for reasons that leave no unmerged paths — a dirty
   * worktree is the common one. Leaving a half-merge behind then helps nobody
   * and wedges the next attempt on MERGE_HEAD.
   */
  it("aborts a failed merge that left nothing to resolve", async () => {
    const dir = repo();
    const wt = await taskOn(dir);
    const task = path.join(wt.worktreeRoot(), "run1", "task1");
    execFileSync("git", ["checkout", "charrette/run1/main"], { cwd: dir, stdio: "ignore" });
    commit(dir, "incoming.txt", "from the other task\n", "other work");
    // Uncommitted local changes to the very file the merge wants to write.
    writeFileSync(path.join(task, "incoming.txt"), "dirty, uncommitted\n");

    const result = await wt.catchUpTaskBranch("run1", "task1");

    expect(result).toEqual({ ok: false, conflicts: [] });
    expect(existsSync(path.join(task, ".git", "MERGE_HEAD"))).toBe(false);
  });
});

/**
 * The two answers about the base that are not "it merged" or "it conflicted".
 *
 * Both exist because the caller publishes what it is told: an empty conflict
 * list that reads as a conflict would send an agent to resolve nothing, and a
 * containment check that says yes to an empty sha would let a run publish a
 * branch that never took the base at all.
 */
describe("catching up to a base that is not there", () => {
  it("reports a merge that failed without conflicts, and leaves no half-merge behind", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    await wt.ensureIntegrationWorktree("run1");

    const result = await wt.catchUpIntegrationBranch("run1", "no-such-branch");

    expect(result.ok).toBe(false);
    // An unresolvable ref is not a conflict anybody can resolve. Saying so with
    // an empty list is what tells the caller to report it rather than spend a
    // session on it.
    expect(result).toMatchObject({ conflicts: [] });
    await expect(wt.integrationMergeState("run1")).resolves.toMatchObject({ merging: false, conflicts: [] });
  });

  it("does not claim to contain a commit it was given no sha for", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    await wt.ensureIntegrationWorktree("run1");

    await expect(wt.integrationContains("run1", "")).resolves.toBe(false);
    await expect(wt.integrationContains("run1", sha(dir))).resolves.toBe(true);
  });
});
