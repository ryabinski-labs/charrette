import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pushRunBranch, repoFileList, repoUnusable } from "./git.js";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-gate-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function commit(dir: string, files: string[]): void {
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "x\n");
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "c"], { cwd: dir, stdio: "ignore" });
}

describe("repoUnusable", () => {
  it("lets a repository with a commit through", async () => {
    const dir = repo();
    commit(dir, ["README.md"]);
    expect(await repoUnusable(dir)).toBeNull();
  });

  it("stops a repository with no commits, because a worktree has nothing to branch from", async () => {
    // The insurance run: `git init` and an untracked PRD. Every task would have
    // failed at `git worktree add` with `fatal: invalid reference: main`, one at
    // a time, after intake and planning had already been paid for.
    const dir = repo();
    writeFileSync(path.join(dir, "PRD.md"), "# the assignment\n");
    const why = await repoUnusable(dir);
    expect(why).toMatch(/no commits/);
  });

  it("tells the operator the command that fixes it, not just what is wrong", async () => {
    const why = await repoUnusable(repo());
    expect(why).toContain("git add -A && git commit");
  });

  it("says untracked files are unreadable in a worktree, since that is the other half of the trap", async () => {
    const why = await repoUnusable(repo());
    expect(why).toMatch(/[Uu]ntracked files are invisible inside a worktree/);
  });

  it("stops a directory that is not a repository at all", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-norepo-"));
    expect(await repoUnusable(dir)).toMatch(/not a git repository/);
  });
});

describe("repoFileList", () => {
  it("names every tracked file", async () => {
    const dir = repo();
    commit(dir, ["src/index.ts", "src/util.ts", "README.md"]);
    const list = await repoFileList(dir);
    expect(list.split("\n").sort()).toEqual(["README.md", "src/index.ts", "src/util.ts"]);
  });

  it("leaves out what git is ignoring, so the planner is not told about build output", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
    commit(dir, ["src/index.ts"]);
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "index.js"), "x\n");
    expect(await repoFileList(dir)).not.toContain("dist/");
  });

  it("is empty for a repository with nothing tracked, rather than an empty block in the prompt", async () => {
    expect(await repoFileList(repo())).toBe("");
  });

  it("is empty outside a repository instead of throwing into the planning phase", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-norepo-"));
    expect(await repoFileList(dir)).toBe("");
  });

  it("rolls up to directory counts when there are too many files to name", async () => {
    const dir = repo();
    commit(dir, [...Array.from({ length: 40 }, (_, i) => `src/a${i}.ts`), ...Array.from({ length: 10 }, (_, i) => `test/b${i}.ts`)]);
    // A cap the flat list cannot fit, so the rollup is what comes back.
    const list = await repoFileList(dir, 400);
    expect(list).toContain("50 tracked files");
    expect(list).toContain("src — 40 files");
    expect(list).toContain("test — 10 files");
    expect(list).not.toContain("src/a0.ts");
  });

  it("names the repository root rather than printing git's bare dot", async () => {
    const dir = repo();
    commit(dir, [...Array.from({ length: 30 }, (_, i) => `f${i}.ts`), "src/a.ts"]);
    const list = await repoFileList(dir, 200);
    expect(list).toContain("(repository root) — 30 files");
  });

  it("counts a lone file in a directory in the singular", async () => {
    const dir = repo();
    commit(dir, [...Array.from({ length: 30 }, (_, i) => `src/a${i}.ts`), "test/only.ts"]);
    const list = await repoFileList(dir, 300);
    expect(list).toContain("test — 1 file");
  });

  it("says how many directories it dropped when even the rollup does not fit", async () => {
    const dir = repo();
    commit(dir, Array.from({ length: 40 }, (_, i) => `d${i}/f.ts`));
    const list = await repoFileList(dir, 200);
    expect(list).toMatch(/… and \d+ more directories/);
    expect(list.length).toBeLessThanOrEqual(230);
  });

  it("uses the singular when exactly one directory was dropped", async () => {
    const dir = repo();
    commit(dir, [...Array.from({ length: 20 }, (_, i) => `aaaa/f${i}.ts`), ...Array.from({ length: 20 }, (_, i) => `bbbb/f${i}.ts`)]);
    // Room for the header and the first of the two directories, and nothing after it.
    const cap = "40 tracked files — too many to name. The directories they are in:\n".length + "aaaa — 20 files".length + 1;
    const list = await repoFileList(dir, cap);
    expect(list).toContain("aaaa — 20 files");
    expect(list).toContain("… and 1 more directory");
    expect(list).not.toContain("more directories");
  });
});

describe("pushRunBranch", () => {
  /** A repo with a bare `origin` it can actually push to. */
  function withOrigin(): { dir: string; remote: string } {
    const dir = repo();
    commit(dir, ["README.md"]);
    const remote = mkdtempSync(path.join(tmpdir(), "harness-origin-"));
    execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
    return { dir, remote };
  }

  const branch = "harness/abc12345/main";

  it("pushes a branch that fast-forwards, and says nothing", async () => {
    const { dir } = withOrigin();
    execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: dir, stdio: "ignore" });
    commit(dir, ["a.ts"]);
    await expect(pushRunBranch(dir, branch)).resolves.toBeUndefined();
  });

  it("names the divergence when someone merged into the branch on GitHub", async () => {
    // Run 3ae58e02: a pull request was opened against the run's integration
    // branch and merged, so origin held commits the local branch had never
    // seen. What the operator got was "Command failed: git push".
    const { dir, remote } = withOrigin();
    execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: dir, stdio: "ignore" });
    commit(dir, ["a.ts"]);
    execFileSync("git", ["push", "-q", "origin", branch], { cwd: dir, stdio: "ignore" });

    // Someone else's commit lands on origin's copy of the branch...
    const theirs = mkdtempSync(path.join(tmpdir(), "harness-theirs-"));
    execFileSync("git", ["clone", "-q", "--branch", branch, remote, theirs], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: theirs, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: theirs, stdio: "ignore" });
    commit(theirs, ["browser-fix.ts"]);
    execFileSync("git", ["push", "-q", "origin", branch], { cwd: theirs, stdio: "ignore" });

    // ...while the run kept merging tasks locally.
    commit(dir, ["b.ts"]);
    commit(dir, ["c.ts"]);

    await expect(pushRunBranch(dir, branch)).rejects.toThrow(
      /has diverged from origin: 1 commit\(s\) on origin are not in the local branch, and 2 local commit\(s\)/
    );
  });

  it("tells them to merge, and never offers a force push", async () => {
    const { dir, remote } = withOrigin();
    execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: dir, stdio: "ignore" });
    commit(dir, ["a.ts"]);
    execFileSync("git", ["push", "-q", "origin", branch], { cwd: dir, stdio: "ignore" });
    const theirs = mkdtempSync(path.join(tmpdir(), "harness-theirs2-"));
    execFileSync("git", ["clone", "-q", "--branch", branch, remote, theirs], { stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: theirs, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: theirs, stdio: "ignore" });
    commit(theirs, ["x.ts"]);
    execFileSync("git", ["push", "-q", "origin", branch], { cwd: theirs, stdio: "ignore" });
    commit(dir, ["b.ts"]);

    const why = await pushRunBranch(dir, branch).then(
      () => "",
      (e: unknown) => String(e)
    );
    expect(why).toContain(`git merge origin/${branch}`);
    expect(why).toContain("harness resume");
    expect(why).not.toMatch(/--force|-f\b/);
  });

  it("re-raises git's own error when the rejection is not a divergence", async () => {
    // No remote named origin at all: nothing to fetch, nothing behind, so
    // dressing it up as a merge problem would send the operator somewhere
    // there is no answer.
    const dir = repo();
    commit(dir, ["README.md"]);
    await expect(pushRunBranch(dir, "main")).rejects.toThrow(/origin/);
  });
});
