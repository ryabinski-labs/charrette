import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { outsideWorktreeWrite, worktreeGuardHook } from "./worktreeGuard.js";

const WT = "/tmp/repo-wt/run1/task-a";

/** What the guard would block, as a short string, or null. */
const blocked = (command: string, worktree = WT) => {
  const found = outsideWorktreeWrite(command, worktree);
  return found ? `${found.what} -> ${found.where}` : null;
};

/**
 * The failure this exists for, from run da8325bd: a worker put 1e257ea,
 * eb9e0a8 and da2ce77 — its entire deliverable — onto the primary
 * repository's checked-out branch instead of its worktree's. The task branch
 * stayed empty, merged "cleanly", and was reported as MERGED.
 */
describe("git writes aimed outside the task's worktree", () => {
  it("catches the shape that actually happened: -C at another repository", () => {
    expect(blocked("git -C /tmp/repo commit -am 'pricing rows'")).toBe("git commit -> /tmp/repo");
  });

  it("catches a cd out of the worktree and back to git", () => {
    expect(blocked("cd /tmp/repo && git add -A && git commit -m x")).toBe("git add -> /tmp/repo");
  });

  it("follows a relative cd, not just an absolute one", () => {
    expect(blocked("cd ../../.. && git commit -am x")).toBe("git commit -> /tmp");
  });

  it("catches --git-dir and --work-tree, in either spelling", () => {
    expect(blocked("git --git-dir=/tmp/repo/.git commit -m x")).toBe("git commit -> /tmp/repo/.git");
    expect(blocked("git --work-tree /tmp/repo add .")).toBe("git add -> /tmp/repo");
  });

  it("sees through a wrapper and a nested shell", () => {
    expect(blocked("sudo git -C /tmp/repo push")).toBe("git push -> /tmp/repo");
    expect(blocked(`bash -c "git -C /tmp/repo commit -am x"`)).toBe("git commit -> /tmp/repo");
    // The nested shell starts where the outer one currently is.
    expect(blocked(`cd /tmp/repo && bash -c "git commit -am x"`)).toBe("git commit -> /tmp/repo");
  });

  it("catches a push from a directory the agent moved to earlier in the same command", () => {
    expect(blocked("cd /tmp/repo; git status; git push origin main")).toBe("git push -> /tmp/repo");
  });
});

describe("what the guard deliberately allows", () => {
  it("allows every git write inside the worktree", () => {
    expect(blocked("git commit -am 'real work'")).toBeNull();
    expect(blocked(`git -C ${WT} commit -am x`)).toBeNull();
    expect(blocked(`cd ${WT}/frontend && git add -A && git commit -m x`)).toBeNull();
    expect(blocked("git push origin HEAD")).toBeNull();
  });

  /**
   * Reading another repository is legitimate and often necessary — the history
   * of the primary repo answers questions a worktree cannot — so the guard
   * denies a list of writing verbs and permits everything else, including any
   * verb it does not recognise.
   */
  it("allows reads anywhere", () => {
    expect(blocked("git -C /tmp/repo log --oneline -20")).toBeNull();
    expect(blocked("git -C /tmp/repo show HEAD:app/main.py")).toBeNull();
    expect(blocked("git -C /tmp/repo diff main...HEAD")).toBeNull();
    expect(blocked("git -C /tmp/repo status")).toBeNull();
    expect(blocked("git -C /tmp/repo rev-parse HEAD")).toBeNull();
    expect(blocked("git -C /tmp/repo cat-file -p HEAD")).toBeNull();
  });

  it("tells a listing apart from a change for the verbs that do both", () => {
    expect(blocked("git -C /tmp/repo branch")).toBeNull();
    expect(blocked("git -C /tmp/repo branch --list 'harness/*'")).toBeNull();
    expect(blocked("git -C /tmp/repo config --get user.email")).toBeNull();
    expect(blocked("git -C /tmp/repo remote -v")).toBeNull();

    expect(blocked("git -C /tmp/repo branch feature-x")).toBe("git branch -> /tmp/repo");
    expect(blocked("git -C /tmp/repo branch -D harness/old")).toBe("git branch -> /tmp/repo");
    expect(blocked("git -C /tmp/repo config user.email a@b.c")).toBe("git config -> /tmp/repo");
    expect(blocked("git -C /tmp/repo remote add upstream u")).toBe("git remote -> /tmp/repo");
  });

  /**
   * The worst outcome this guard can produce is not letting a write through —
   * it is refusing the task's own commits. A worktree reached through a symlink
   * has two true absolute paths, and an agent gets the second one for free:
   * `git rev-parse --show-toplevel` answers with the canonical form while the
   * session's cwd is the form the harness recorded. Judging them as strings
   * denies every commit the task makes, and a task that cannot commit delivers
   * an empty branch — precisely the failure the guard was written to stop.
   *
   * Not hypothetical on macOS, where /tmp and /var are symlinks into /private,
   * and already paid for once in this codebase: `ensureWorktree` compares
   * worktrees by the filesystem rather than `git worktree list` for this exact
   * reason ("/private/var vs /var").
   */
  it("allows the task's own commits when the worktree is reached through a symlink", () => {
    const real = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-wt-"));
    const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
    symlinkSync(real, link);

    // Whichever form the harness recorded, the other is still the same tree.
    expect(blocked("git commit -am x", link)).toBeNull();
    expect(blocked(`cd ${real} && git commit -am x`, link)).toBeNull();
    expect(blocked(`git -C ${real} commit -am x`, link)).toBeNull();
    expect(blocked(`cd ${link} && git commit -am x`, real)).toBeNull();
    expect(blocked(`git -C ${link}/frontend add -A`, real)).toBeNull();

    // And a genuine escape is still caught through either spelling.
    expect(blocked(`git -C ${path.dirname(real)} commit -am x`, link)).not.toBeNull();

    unlinkSync(link);
    rmSync(real, { recursive: true, force: true });
  });

  it("reads `git remote` as a listing until a sub-verb makes it a change", () => {
    expect(blocked("git -C /tmp/repo remote")).toBeNull();
    expect(blocked("git -C /tmp/repo remote show origin")).toBeNull();
    expect(blocked("git -C /tmp/repo remote get-url origin")).toBeNull();

    expect(blocked("git -C /tmp/repo remote set-url origin u")).toBe("git remote -> /tmp/repo");
  });

  /**
   * Global flags sit before the verb, and an agent that has been told to avoid
   * a pager writes one without thinking about it. Skipping them is what lets
   * the verb after them still be read.
   */
  it("steps over git's own flags to reach the verb", () => {
    expect(blocked("git --no-pager -C /tmp/repo log")).toBeNull();
    expect(blocked("git --no-pager -C /tmp/repo commit -am x")).toBe("git commit -> /tmp/repo");
  });

  /**
   * A truncated command is not a write. Convicting on one would deny work over
   * something git itself would refuse to run.
   */
  it("does not convict on a git invocation with no verb at all", () => {
    expect(blocked("git")).toBeNull();
    expect(blocked("git --version")).toBeNull();
    expect(blocked("git -C")).toBeNull();
    expect(blocked("git --git-dir=$HOME/.git commit -am x")).toBeNull();
  });

  it("keeps reading past a nested shell that did nothing wrong", () => {
    expect(blocked(`bash -c "git status" && git commit -am x`)).toBeNull();
    // …and the segment after a clean one is still judged.
    expect(blocked(`bash -c "git log" && git -C /tmp/repo commit -am x`)).toBe("git commit -> /tmp/repo");
  });

  /**
   * A shell inside a shell inside a shell is a wrapper, not a plan; past a
   * handful of levels the guard stops unwrapping rather than recurse without a
   * floor. Allowing is the conservative direction here — the same direction
   * every other unknown takes.
   */
  it("gives up at the recursion floor", () => {
    expect(outsideWorktreeWrite("git -C /tmp/repo commit -am x", WT, 4)).toBeNull();
  });

  it("reads past a segment that invokes nothing", () => {
    expect(blocked("&& ||")).toBeNull();
    // An exported variable is a segment with no command in it, and the segment
    // after it still has to be judged.
    expect(blocked("cd /tmp/repo && CI=1 && git commit -am x")).toBe("git commit -> /tmp/repo");
  });

  it("is not fooled by a command that only mentions git", () => {
    expect(blocked(`echo "cd /tmp/repo && git commit -am x" >> notes.md`)).toBeNull();
    expect(blocked("grep -rn 'git commit' docs/")).toBeNull();
  });

  it("leaves a heredoc body alone, so a runbook can document the command", () => {
    expect(blocked("cat > runbook.md <<'EOF'\ncd /tmp/repo && git commit -am x\nEOF")).toBeNull();
  });

  /**
   * Guessing in the deny direction would block ordinary scripted work, so a
   * path the guard cannot resolve makes it stop reading rather than convict.
   */
  it("does not convict on a path it cannot resolve", () => {
    expect(blocked("cd $REPO && git commit -am x")).toBeNull();
    expect(blocked("git -C $(pwd)/../other commit -am x")).toBeNull();
    expect(blocked("cd - && git commit -am x")).toBeNull();
  });

  it("does not fire on commands that are not git at all", () => {
    expect(blocked("cd /tmp/repo && npm test")).toBeNull();
    expect(blocked("rm -rf /tmp/repo/node_modules")).toBeNull();
  });
});

describe("the hook around it", () => {
  const bash = (command: string) =>
    ({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }) as unknown as HookInput;
  const fire = (input: HookInput, worktree = WT, allow = false) =>
    worktreeGuardHook(worktree, allow)(input) as Promise<{
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }>;

  it("denies with a reason that says where the work would have gone and why that is fatal", async () => {
    const out = await fire(bash("git -C /tmp/repo commit -am x"));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    const why = out.hookSpecificOutput?.permissionDecisionReason ?? "";
    expect(why).toContain("/tmp/repo");
    expect(why).toContain("as if you delivered nothing");
    // A denial an agent can act on: it says what IS allowed, and what to do if
    // it disagrees, so the usual outcome is that it commits in the right place.
    expect(why).toContain("Reading other repositories is fine");
    expect(why).toContain("say so plainly in your final summary and stop");
  });

  it("ignores anything that is not a Bash PreToolUse with a command", async () => {
    expect(await fire({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} } as unknown as HookInput)).toEqual({});
    expect(await fire({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} } as unknown as HookInput)).toEqual({});
    expect(await fire(bash("   "))).toEqual({});
  });

  it("lets the task's own commit through untouched", async () => {
    // The common case by a wide margin: every Bash command in every session
    // passes through here, and all but the aimed-elsewhere ones must be a
    // no-op — a hook that returns anything at all is a hook that can be wrong.
    expect(await fire(bash("git commit -am 'real work'"))).toEqual({});
    expect(await fire(bash("pnpm test"))).toEqual({});
  });

  it("enforces nothing without a worktree, and nothing when explicitly allowed", async () => {
    expect(await fire(bash("git -C /tmp/repo commit -am x"), "")).toEqual({});
    expect(await fire(bash("git -C /tmp/repo commit -am x"), WT, true)).toEqual({});
  });
});
