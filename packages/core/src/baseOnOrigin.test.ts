import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureBaseOnOrigin } from "./git.js";

/**
 * The one push outside `charrette/<runId>/*`: creating a base branch origin
 * does not have. Real repositories and a real bare remote throughout — the
 * property worth proving is git's, not this module's: that the push can create
 * a branch and can never move one.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function local(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-base-"));
  made.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.invalid");
  sh(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "first");
  return dir;
}

function bare(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-base-remote-"));
  made.push(dir);
  sh(dir, "init", "-q", "--bare", "-b", "main");
  return dir;
}

/** What origin's branch points at, or "" when it has none. */
const remoteHead = (remote: string, branch: string) => {
  try {
    return sh(remote, "rev-parse", "--verify", `refs/heads/${branch}`);
  } catch {
    return "";
  }
};

describe("making sure origin has the base branch", () => {
  it("does nothing in a repository with no origin", async () => {
    expect(await ensureBaseOnOrigin(local(), "main")).toEqual({ state: "no-remote" });
  });

  it("leaves a base branch origin already has exactly where it is", async () => {
    const dir = local();
    const remote = bare();
    sh(dir, "remote", "add", "origin", remote);
    sh(dir, "push", "-q", "origin", "main");
    const before = remoteHead(remote, "main");
    // A local commit origin has not seen: a plain push would fast-forward it.
    writeFileSync(path.join(dir, "later.txt"), "later\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "later");

    expect(await ensureBaseOnOrigin(dir, "main")).toEqual({ state: "present" });
    expect(remoteHead(remote, "main")).toBe(before);
  });

  it("creates the base branch on an origin with no commits at all", async () => {
    // Run 614e06d5: a GitHub repository with nothing in it, and a pull request
    // with no base to open against after a whole run's work.
    const dir = local();
    const remote = bare();
    sh(dir, "remote", "add", "origin", remote);

    expect(await ensureBaseOnOrigin(dir, "main")).toEqual({ state: "created" });
    expect(remoteHead(remote, "main")).toBe(sh(dir, "rev-parse", "main"));
  });

  it("does not mistake a branch that merely ends in the base's name for it", async () => {
    const dir = local();
    const remote = bare();
    sh(dir, "remote", "add", "origin", remote);
    sh(dir, "push", "-q", "origin", "main:refs/heads/feature/main");

    expect(await ensureBaseOnOrigin(dir, "main")).toEqual({ state: "created" });
    expect(remoteHead(remote, "main")).toBe(sh(dir, "rev-parse", "main"));
  });

  it("refuses to overwrite a base branch that appeared between the check and the push", async () => {
    // The check is not the guarantee; the lease is. A pre-push hook runs after
    // git has read origin's refs and before it sends the update, which is
    // exactly the window: somebody else creates `main` there, and the push
    // must fail rather than replace it.
    const dir = local();
    const remote = bare();
    sh(dir, "remote", "add", "origin", remote);
    sh(dir, "branch", "theirs");
    sh(dir, "checkout", "-q", "theirs");
    writeFileSync(path.join(dir, "theirs.txt"), "theirs\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "theirs");
    sh(dir, "checkout", "-q", "main");
    const theirs = sh(dir, "rev-parse", "theirs");
    const hook = path.join(dir, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\ngit push -q --no-verify "${remote}" theirs:refs/heads/main\n`);
    chmodSync(hook, 0o755);

    const out = await ensureBaseOnOrigin(dir, "main");

    expect(out).toMatchObject({ state: "failed", step: "push" });
    expect(remoteHead(remote, "main")).toBe(theirs);
  });

  it("says it could not ask, rather than guessing, when origin cannot be reached", async () => {
    const dir = local();
    sh(dir, "remote", "add", "origin", path.join(tmpdir(), "charrette-no-such-remote-anywhere"));

    const out = await ensureBaseOnOrigin(dir, "main");

    expect(out).toMatchObject({ state: "failed", step: "check" });
    expect((out as { error: string }).error).toMatch(/ls-remote/);
  });
});
