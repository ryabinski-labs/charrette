import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorktreeManager, pushRunBranch } from "./git.js";

/**
 * What every git call in `git.ts` does when the git call under it gives out.
 *
 * `git.ts` is written so that a run survives a git command failing where the
 * answer is not worth stopping for — seventeen `.catch(() => fallback)`
 * handlers say so. None of them had ever run. They are not decoration: they
 * decide whether a run reports "0 commits" or dies on a `rev-list` against a
 * branch that is not there, and whether a leftover directory ends a run or is
 * cleaned up around.
 *
 * Reaching them needs *one specific* git invocation to fail while every other
 * one in the same method still works, which no arrangement of real
 * repositories produces — so a shim earlier on `PATH` fails exactly the
 * invocation whose whole argument list matches `GIT_FAIL_GLOB` and executes
 * the real binary for everything else. Nothing is mocked: the method under
 * test is talking to real git for every call but the one being broken, which
 * is the only way the surrounding behaviour proves anything. Where a real
 * repository *can* produce the failure on its own — a branch that does not
 * exist, a worktree that is gone — it is used in preference to the shim.
 *
 * `PATH` and `GIT_FAIL_GLOB` are process-wide, and `git()` spawns with the
 * inherited environment, so there is nowhere narrower to put them. That is safe
 * because vitest's default `forks` pool gives every test file its own process
 * and the cases in a file run one at a time: nothing else is spawning git while
 * a glob is set. A `pool` of `threads` would put every file in one process and
 * break that — which is the one config change this file would not survive.
 */

const made: string[] = [];
let shimDir = "";
let realPath = "";

beforeAll(() => {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  // Deliberately not in `made`: that list is emptied after every test, and the
  // shim has to outlive all of them. Deleted out from under `PATH` it does not
  // fail loudly — the real git is still further along `PATH`, so every
  // injection after the first simply stops happening and the tests pass
  // against an unbroken git.
  shimDir = mkdtempSync(path.join(tmpdir(), "charrette-gitshim-"));
  const bin = path.join(shimDir, "git");
  // `${GIT_FAIL_GLOB:-…}` unquoted in pattern position: the expansion is used
  // as a shell pattern, so a test can name an exact argument list or use `*`.
  // The default can never match a real invocation, so an unset variable means
  // the shim is a straight pass-through.
  writeFileSync(
    bin,
    `#!/bin/sh\ncase "$*" in\n  \${GIT_FAIL_GLOB:-__no_such_git_invocation__}) printf 'fatal: injected git failure\\n' >&2; exit 128 ;;\nesac\nexec ${realGit} "$@"\n`
  );
  chmodSync(bin, 0o755);
  realPath = process.env.PATH ?? "";
  process.env.PATH = `${shimDir}${path.delimiter}${realPath}`;
});

afterAll(() => {
  process.env.PATH = realPath;
  rmSync(shimDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.GIT_FAIL_GLOB;
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Break one git invocation for the duration of one call, and nothing else. */
async function whileFailing<T>(glob: string, fn: () => Promise<T>): Promise<T> {
  process.env.GIT_FAIL_GLOB = glob;
  try {
    return await fn();
  } finally {
    delete process.env.GIT_FAIL_GLOB;
  }
}

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-gitfail-"));
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

const RUN = "run1234";

describe("explaining a rejected push when git cannot count the divergence", () => {
  const branch = "charrette/run1234/main";

  /** A repo whose branch is behind a bare origin, which is what rejects the push. */
  function diverged(): string {
    const dir = repo();
    const remote = mkdtempSync(path.join(tmpdir(), "charrette-gitfail-origin-"));
    made.push(remote);
    execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: dir, stdio: "ignore" });
    commit(dir, "a.ts", "a\n", "ours");
    execFileSync("git", ["push", "-q", "origin", branch], { cwd: dir, stdio: "ignore" });

    const theirs = mkdtempSync(path.join(tmpdir(), "charrette-gitfail-theirs-"));
    made.push(theirs);
    execFileSync("git", ["clone", "-q", "--branch", branch, remote, theirs], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: theirs, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: theirs, stdio: "ignore" });
    commit(theirs, "theirs.ts", "t\n", "theirs");
    execFileSync("git", ["push", "-q", "origin", branch], { cwd: theirs, stdio: "ignore" });

    commit(dir, "b.ts", "b\n", "ours again");
    return dir;
  }

  /**
   * Counting how far behind is what separates "someone merged into this branch"
   * from "no credentials". Unanswerable, it has to read as the second: telling
   * an operator to reconcile a divergence nothing has measured sends them to
   * merge a branch that may be perfectly in sync.
   */
  it("re-raises git's own rejection rather than inventing a divergence it could not measure", async () => {
    const dir = diverged();

    const why = await whileFailing("rev-list --count *..FETCH_HEAD", () =>
      pushRunBranch(dir, branch).then(
        () => "",
        (e: unknown) => String(e)
      )
    );

    expect(why).not.toContain("has diverged from origin");
    expect(why).toMatch(/push/);
  });

  /**
   * The other count only decorates the message, so losing it must not cost the
   * operator the instructions underneath.
   */
  it("says the local side is unknown rather than losing the explanation with it", async () => {
    const dir = diverged();

    const why = await whileFailing("rev-list --count FETCH_HEAD..*", () =>
      pushRunBranch(dir, branch).then(
        () => "",
        (e: unknown) => String(e)
      )
    );

    expect(why).toContain("has diverged from origin: 1 commit(s)");
    expect(why).toContain("and ? local commit(s)");
    expect(why).toContain(`git merge origin/${branch}`);
  });
});

describe("reading a repository that cannot answer", () => {
  it("prunes nothing, quietly, outside a repository", async () => {
    const notARepo = mkdtempSync(path.join(tmpdir(), "charrette-gitfail-plain-"));
    made.push(notARepo);

    await expect(new WorktreeManager(notARepo).pruneAndReconcile()).resolves.toBeUndefined();
  });

  /**
   * Asked on every merge and every report. Before the integration branch has
   * been created there is no commit to name, and that is an empty string rather
   * than the end of the run.
   */
  it("reports no integration head before the branch exists", async () => {
    const mgr = new WorktreeManager(repo());

    expect(await mgr.integrationHead(RUN)).toBe("");
  });

  /**
   * A task that was planned but never dispatched has no branch at all, and both
   * halves of the delta are asked against it. Neither is worth throwing over:
   * "nothing committed" is the true answer and the one the gate wants.
   */
  it("reports an empty delta for a task branch that was never created", async () => {
    const mgr = new WorktreeManager(repo());

    expect(await mgr.taskBranchDelta(RUN, "t1")).toEqual({ commits: 0, files: [], landed: "" });
  });

  /**
   * Run bc691359's worktrees were removed by hand mid-run. A catch-up that
   * cannot even read `git status` has no conflicts to name, and an empty list is
   * exactly how the caller is told to park it rather than send a worker in.
   */
  it("names no conflicts when the task worktree is gone", async () => {
    const mgr = new WorktreeManager(repo());
    await mgr.ensureIntegrationBranch(RUN);

    expect(await mgr.catchUpTaskBranch(RUN, "t1")).toEqual({ ok: false, conflicts: [] });
  });
});

describe("cleaning worktrees that git will not clean", () => {
  /**
   * `clean -fd` removes the previous commit's build output. It failing is not a
   * reason to skip the measurement — a slightly dirty tree still measures, and
   * refusing to measure is what the baseline exists to avoid.
   */
  it("measures the baseline even when the leftovers cannot be cleared", async () => {
    const dir = repo();
    const mgr = new WorktreeManager(dir);
    const first = sha(dir);
    commit(dir, "b.txt", "b\n", "second");
    const second = sha(dir);
    await mgr.withBaselineWorktree(RUN, first, async () => undefined);

    const seen = await whileFailing("clean -fd", () => mgr.withBaselineWorktree(RUN, second, async (wt) => sha(wt)));

    expect(seen).toBe(second);
  });

  /**
   * A directory git has no worktree registered for — a `worktree prune` ran, or
   * a previous run was killed between the add and the register. `worktree
   * remove` refuses it, and the answer is to delete the directory and add it
   * again, not to fail the gate that needs the tree.
   */
  it("replaces a stale directory git does not recognise as a worktree", async () => {
    const dir = repo();
    const mgr = new WorktreeManager(dir);
    await mgr.ensureIntegrationBranch(RUN);
    const target = path.join(mgr.worktreeRoot(), RUN, "live");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "stale.txt"), "left over\n");

    const wt = await mgr.freshWorktree(RUN, "live");

    expect(wt).toBe(target);
    expect(existsSync(path.join(target, "stale.txt"))).toBe(false);
    expect(existsSync(path.join(target, "README.md"))).toBe(true);
  });

  /**
   * `-fdx` is belt and braces on a worktree git has just created, so it has
   * nothing to remove and nothing to report if it cannot run.
   */
  it("hands back a fresh worktree even when the final clean fails", async () => {
    const mgr = new WorktreeManager(repo());
    await mgr.ensureIntegrationBranch(RUN);

    const wt = await whileFailing("clean -fdx", () => mgr.freshWorktree(RUN, "live"));

    expect(existsSync(path.join(wt, "README.md"))).toBe(true);
  });
});

describe("merges that fail while git is failing too", () => {
  /** An integration branch and a task branch that both rewrote the same file. */
  async function conflicting(): Promise<{ mgr: WorktreeManager; task: string }> {
    const dir = repo();
    const mgr = new WorktreeManager(dir);
    await mgr.ensureIntegrationBranch(RUN);
    const { path: wtPath } = await mgr.ensureWorktree(RUN, "t1");
    commit(wtPath, "README.md", "the task's line\n", "task side");
    const integration = await mgr.ensureIntegrationWorktree(RUN);
    commit(integration, "README.md", "the integration line\n", "integration side");
    return { mgr, task: "t1" };
  }

  /**
   * An empty conflict list is not a conflict. Handed back as one it sends a
   * worker to reconcile files nothing named — run bc691359's two lost tasks —
   * so a merge that conflicted for real but could not be read must still come
   * back as the unexplained failure it now is, with git's own words attached.
   */
  it("refuses to report a conflict it could not read the files of", async () => {
    const { mgr, task } = await conflicting();

    await expect(
      whileFailing("diff --name-only --diff-filter=U", () => mgr.mergeTaskBranch(RUN, task))
    ).rejects.toThrow(/failed without naming a conflict/);
  });

  /**
   * The abort is tidying, not the result. A conflict that was named is still a
   * conflict to hand to a worker even if the tree could not be put back.
   */
  it("still names the conflicts when the abort behind them fails", async () => {
    const { mgr, task } = await conflicting();

    const outcome = await whileFailing("merge --abort", () => mgr.mergeTaskBranch(RUN, task));

    expect(outcome).toEqual({ ok: false, conflicts: ["README.md"] });
  });

  /** The same unreadable-status case on the base's side of the run. */
  it("reports a base catch-up that conflicted with no files it could name", async () => {
    const dir = repo();
    const mgr = new WorktreeManager(dir);
    await mgr.ensureIntegrationBranch(RUN);
    const integration = await mgr.ensureIntegrationWorktree(RUN);
    commit(integration, "README.md", "the integration line\n", "integration side");
    commit(dir, "README.md", "the base's line\n", "base side");

    const outcome = await whileFailing("diff --name-only --diff-filter=U", () => mgr.catchUpIntegrationBranch(RUN, "main"));

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ conflicts: [], ref: "main" });
  });

  /**
   * Asked after an agent has been sent to resolve a merge. With nothing
   * readable it answers "not merging, nothing conflicted", which is the state
   * that lets the run go on to check the branch's ancestry — the question that
   * actually decides whether a pull request can be opened.
   */
  it("reports a quiet integration worktree when the status cannot be read", async () => {
    const mgr = new WorktreeManager(repo());
    await mgr.ensureIntegrationBranch(RUN);

    const state = await whileFailing("diff --name-only --diff-filter=U", () => mgr.integrationMergeState(RUN));

    expect(state).toEqual({ merging: false, conflicts: [] });
  });
});

/**
 * The merge lock's own failure path. Every merge sequence runs through one
 * lock, and a sequence that throws must release it — the next merge takes the
 * lock whether the last one resolved or rejected, and a rejected promise left
 * in the lock with nothing attached to it fails the whole suite as an unhandled
 * rejection.
 *
 * Reaching it needs the part of a sequence that is *not* guarded to fail, which
 * is making the integration worktree: without the run's integration branch
 * there is nothing for `worktree add` to check out.
 */
describe("releasing the merge lock after a sequence that threw", () => {
  it("rejects a base catch-up that has no integration branch to work in, and merges after it", async () => {
    const dir = repo();
    const mgr = new WorktreeManager(dir);

    await expect(mgr.catchUpIntegrationBranch(RUN, "main")).rejects.toThrow();

    // The lock is free: a sequence that can run, runs.
    await mgr.ensureIntegrationBranch(RUN);
    await expect(mgr.integrationMergeState(RUN)).resolves.toEqual({ merging: false, conflicts: [] });
  });

  it("rejects an abort that has no integration branch to work in", async () => {
    const mgr = new WorktreeManager(repo());

    await expect(mgr.abortIntegrationMerge(RUN)).rejects.toThrow();
  });
});
