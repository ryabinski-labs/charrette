import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, ensureIgnored } from "./git.js";

/**
 * Against real repositories. Worktrees, merges and conflict detection are the
 * one part of the harness where git's own behaviour *is* the behaviour under
 * test — a stubbed git would only prove that the stub agrees with itself, and
 * every bug this code has had (canonical paths on macOS, a wedged MERGE_HEAD,
 * a branch already checked out) came from git doing something the stub would
 * not have.
 */

const made: string[] = [];

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-wt-"));
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

describe("keeping .harness out of the operator's commits", () => {
  it("adds the entry and reports that it did", () => {
    const dir = repo();

    expect(ensureIgnored(dir, ".harness/")).toBe(true);
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".harness/\n");
  });

  it("says nothing when git already ignores it", () => {
    const dir = repo();
    ensureIgnored(dir, ".harness/");

    expect(ensureIgnored(dir, ".harness/")).toBe(false);
  });

  it("starts a new line when the existing file does not end in one", () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "node_modules");

    ensureIgnored(dir, ".harness/");

    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.harness/\n");
  });

  /**
   * The operator's business, not a reason to refuse to start the run: the
   * harness has somewhere to put its state either way.
   */
  it("gives up quietly on a .gitignore it cannot write", () => {
    const dir = repo();
    // A directory where the file should be: appendFileSync throws EISDIR.
    mkdirSync(path.join(dir, ".gitignore"));

    expect(ensureIgnored(dir, ".harness/")).toBe(false);
  });

  it("gives up quietly outside a repository, where it cannot reason at all", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-nogit-"));
    made.push(dir);

    expect(ensureIgnored(dir, ".harness/")).toBe(false);
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
    expect(info.branch).toBe("harness/run1/task1");
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

    expect(await wt.ensureIntegrationBranch("run1")).toBe("harness/run1/main");
    expect(await wt.ensureIntegrationBranch("run1")).toBe("harness/run1/main");
    expect(sha(dir, "harness/run1/main")).toBe(sha(dir, "main"));
  });
});

describe("what a task branch actually carries", () => {
  it("reports nothing for a branch that was created and never committed to", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    await wt.ensureWorktree("run1", "task1");

    expect(await wt.taskBranchDelta("run1", "task1")).toEqual({ commits: 0, files: [] });
  });

  it("reports the files a real branch would land", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");

    expect(await wt.taskBranchDelta("run1", "task1")).toEqual({ commits: 1, files: ["work.txt"] });
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
    const before = sha(dir, "harness/run1/main");

    const merge = await wt.mergeTaskBranch("run1", "task1");

    expect(merge).toEqual({ ok: false, empty: true });
    expect(sha(dir, "harness/run1/main")).toBe(before);
  });

  it("still merges a branch that has something on it", async () => {
    const dir = repo();
    const wt = new WorktreeManager(dir);
    await wt.ensureIntegrationBranch("run1");
    const info = await wt.ensureWorktree("run1", "task1");
    commit(info.path, "work.txt", "done\n", "task work");

    const merge = await wt.mergeTaskBranch("run1", "task1");

    expect(merge.ok).toBe(true);
    expect(sha(dir, "harness/run1/main")).toBe((merge as { sha: string }).sha);
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
    const dir = mkdtempSync(path.join(tmpdir(), "harness-notrepo-"));
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
    execFileSync("git", ["branch", "-f", "harness/run1/main", "HEAD"], { cwd: dir, stdio: "ignore" });
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
    execFileSync("git", ["checkout", "harness/run1/main"], { cwd: dir, stdio: "ignore" });
    commit(dir, "theirs.txt", "other work\n", "other work");

    await expect(wt.catchUpTaskBranch("run1", "task1")).resolves.toEqual({ ok: true });
    expect(existsSync(path.join(task, "theirs.txt"))).toBe(true);
  });

  it("names the conflicted files and leaves them to be resolved in place", async () => {
    const dir = repo();
    const wt = await taskOn(dir);
    const task = path.join(wt.worktreeRoot(), "run1", "task1");
    commit(task, "shared.txt", "the task's version\n", "task work");
    execFileSync("git", ["checkout", "harness/run1/main"], { cwd: dir, stdio: "ignore" });
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
    execFileSync("git", ["checkout", "harness/run1/main"], { cwd: dir, stdio: "ignore" });
    commit(dir, "incoming.txt", "from the other task\n", "other work");
    // Uncommitted local changes to the very file the merge wants to write.
    writeFileSync(path.join(task, "incoming.txt"), "dirty, uncommitted\n");

    const result = await wt.catchUpTaskBranch("run1", "task1");

    expect(result).toEqual({ ok: false, conflicts: [] });
    expect(existsSync(path.join(task, ".git", "MERGE_HEAD"))).toBe(false);
  });
});
