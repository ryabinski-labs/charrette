import { realpathSync } from "node:fs";
import path from "node:path";
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { MAX_NESTING, invocation, segments, stripHeredocBodies, unquote } from "./shellParse.js";

/**
 * Keep a task's commits on the task's branch.
 *
 * Every task runs in a git worktree of its own, and the whole of the harness
 * downstream of a worker assumes that: the deterministic checks read that tree,
 * QA reviews that branch's diff, the integrator merges that branch, and the
 * ledger reports what that branch delivered. An agent that writes to a
 * different repository has not done less work — it has done the work somewhere
 * nothing will ever look.
 *
 * That is not hypothetical. In run da8325bd a worker put three commits —
 * 1e257ea, eb9e0a8, da2ce77, the entire deliverable of its task — onto the
 * primary repository's own checked-out branch instead of its worktree's. Its
 * task branch stayed exactly as it had been created, so the branch merged
 * "cleanly" while delivering nothing, the ledger recorded the task as MERGED,
 * and the operator learned the work was missing when a demo agent rendered the
 * page it was supposed to have changed. The commits were still on disk, on a
 * branch no part of the run knew about.
 *
 * The isolation was always filesystem isolation and never a control: agents run
 * under `permissionMode: "bypassPermissions"`, and `cwd` is where a session
 * starts, not a boundary. `git -C <elsewhere> commit` was always going to work.
 *
 * Reads are deliberately untouched. Consulting the primary repository's history
 * is legitimate and often necessary — `git -C .. log` answers questions a
 * worktree cannot — so this denies a list of verbs that change a repository and
 * allows everything else, including any verb it does not recognise.
 *
 * The honest limit, the same one the infra guard has: indirection through a
 * file it cannot read — a shell script, a Makefile target, an npm script that
 * shells out to git — is not caught. This catches the direct invocation, which
 * is what agents actually write.
 */

/** Git verbs that change the repository they are aimed at, whatever else they do. */
const ALWAYS_WRITES = new Set([
  "commit", "push", "merge", "rebase", "reset", "revert", "cherry-pick", "am", "apply",
  "stash", "clean", "gc", "prune", "update-ref", "update-index", "filter-branch",
  "init", "clone", "fetch", "pull", "checkout", "switch", "restore", "rm", "mv", "add",
  "worktree", "submodule", "sparse-checkout", "symbolic-ref", "replace", "notes", "reflog",
]);

/**
 * Verbs that read or write depending on how they are called. `git branch` lists;
 * `git branch feat` creates one. The rule is the same for each: a positional
 * argument or an explicitly mutating flag makes it a write.
 */
const CONDITIONAL = new Set(["branch", "tag", "config", "remote"]);

/** The mutating flags of the conditional verbs — `-d`, `--delete`, `--unset`, and friends. */
const MUTATING_FLAG = /^(-[dDmMf]|--delete|--move|--copy|--force|--unset|--unset-all|--add|--replace-all|--edit|--set-upstream(-to)?(=.*)?)$/;

/** The flags of the conditional verbs that pin them as reads, whatever positional arguments follow. */
const READING_FLAG = /^(--list|--get|--get-all|--get-regexp|--show-current|--contains|--merged|--no-merged|--points-at|-l|-v|-vv|-a|-r|--all|--remotes|--verbose)$/;

/** `remote`'s own sub-verbs, which is where its writes actually live. */
const REMOTE_WRITES = new Set(["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"]);

/** Where a git invocation was aimed, and what it would have done there. */
export interface OutsideWrite {
  /** The verb, as the agent wrote it — `git commit`, `git push`. */
  what: string;
  /** The resolved directory it would have written to. */
  where: string;
}

/**
 * A path with its symlinks resolved as far as the filesystem can answer.
 *
 * A worktree reached through a symlink has two true absolute paths, and an
 * agent gets the second one for free: `git rev-parse --show-toplevel` answers
 * with the canonical form while the session's cwd is the form the harness
 * recorded. Comparing them as strings refuses the task's own commits, and a
 * task that cannot commit delivers the empty branch this guard exists to
 * prevent. macOS makes it the default case — /tmp and /var are symlinks into
 * /private — and this codebase has paid for it once already, in the worktree
 * lookup that compares by filesystem rather than by `git worktree list`.
 *
 * Only the leading directories that exist can be resolved; the rest is a path
 * to something not created yet and is kept as written.
 */
function canonical(target: string): string {
  const tail: string[] = [];
  let head = target;
  for (;;) {
    try {
      return path.join(realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      // Reached the filesystem root without resolving anything: nothing to fix.
      if (parent === head) return target;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** True when `target` is the worktree or something inside it. */
function inside(worktree: string, target: string): boolean {
  const rel = path.relative(canonical(worktree), canonical(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A path a guard can reason about: absolute, lexically resolved, and free of shell expansion. */
function resolveTarget(cwd: string, raw: string): string | null {
  const value = unquote(raw);
  // `$HOME`, `$(pwd)`, backticks — the guard cannot know where these land, and
  // guessing in the deny direction would block ordinary scripted work.
  if (!value || /[$`*?]/.test(value)) return null;
  return path.resolve(cwd, value);
}

/** The directory a `cd` moves to, or null when it cannot be known. */
function cdTarget(cwd: string, args: string[]): string | null {
  const positional = args.find((a) => !a.startsWith("-"));
  // Bare `cd` goes home and `cd -` goes back; neither is a path this can follow.
  if (!positional || positional === "-") return null;
  return resolveTarget(cwd, positional);
}

/**
 * What a `git` invocation would write, and where — or null if it writes nothing
 * outside the worktree.
 *
 * `-C`, `--git-dir` and `--work-tree` are read in the order git reads them,
 * because they are how an agent aims git somewhere else without moving.
 */
function gitWrite(cwd: string, args: string[]): { verb: string; target: string } | null {
  let target = cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const arg = unquote(args[i]!);
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      const next = args[i + 1];
      if (!next) return null;
      const resolved = resolveTarget(target, next);
      if (!resolved) return null;
      target = resolved;
      i++;
      continue;
    }
    const eq = /^--(git-dir|work-tree)=(.*)$/.exec(arg);
    if (eq) {
      const resolved = resolveTarget(target, eq[2]!);
      if (!resolved) return null;
      target = resolved;
      continue;
    }
    if (arg.startsWith("-")) continue;
    break;
  }
  const verb = args[i] ? unquote(args[i]!) : "";
  if (!verb) return null;
  const rest = args.slice(i + 1).map(unquote);
  if (ALWAYS_WRITES.has(verb)) return { verb, target };
  if (!CONDITIONAL.has(verb)) return null;
  if (rest.some((a) => READING_FLAG.test(a))) return null;
  if (rest.some((a) => MUTATING_FLAG.test(a))) return { verb, target };
  if (verb === "remote") return rest[0] && REMOTE_WRITES.has(rest[0]) ? { verb, target } : null;
  // `git branch`/`git tag`/`git config` with a positional argument is setting
  // something; with none, it is listing.
  return rest.some((a) => !a.startsWith("-")) ? { verb, target } : null;
}

/**
 * The git write this command would perform outside `worktree`, or null.
 *
 * Segments are walked in order with a running directory, so the `cd` half of
 * `cd ../../repo && git commit -am wip` is what the git half is judged against.
 */
export function outsideWorktreeWrite(command: string, worktree: string, depth = 0): OutsideWrite | null {
  const root = path.resolve(worktree);
  return scan(command, root, root, depth);
}

/**
 * `root` is the boundary and `startCwd` is where this shell begins — two
 * different things, and a nested shell is exactly where they come apart.
 * `cd /elsewhere && bash -c "git commit"` runs the inner shell in /elsewhere
 * while the boundary it must not cross is still the worktree.
 */
function scan(command: string, root: string, startCwd: string, depth: number): OutsideWrite | null {
  if (depth > MAX_NESTING) return null;
  let cwd = startCwd;
  for (const segment of segments(stripHeredocBodies(command))) {
    const found = invocation(segment);
    if (!found) continue;
    if ("inline" in found) {
      const nested = scan(found.inline, root, cwd, depth + 1);
      if (nested) return nested;
      continue;
    }
    if (found.bin === "cd" || found.bin === "pushd") {
      const moved = cdTarget(cwd, found.args);
      // An unknowable `cd` makes everything after it unknowable too. Stop
      // reading rather than judge later segments against a directory they are
      // not running in.
      if (!moved) return null;
      cwd = moved;
      continue;
    }
    if (found.bin !== "git") continue;
    const write = gitWrite(cwd, found.args);
    if (write && !inside(root, write.target)) return { what: `git ${write.verb}`, where: write.target };
  }
  return null;
}

/** The refusal an agent reads — what was blocked, where it was aimed, and what to do instead. */
export function denialReason(w: OutsideWrite, worktree: string): string {
  return `Blocked: \`${w.what}\` would write to ${w.where}, which is outside this task's worktree (${worktree}). Only commits on this task's own branch, made in this directory, are reviewed, merged, or reported as your work — a commit written anywhere else is invisible to the run and will be reported as if you delivered nothing. Reading other repositories is fine and is not blocked; writing to them is not. Run this from ${worktree}, against the branch already checked out here. If you believe the change genuinely belongs in another repository, do not work around this: say so plainly in your final summary and stop, so the operator can decide.`;
}

/**
 * PreToolUse hook keeping an agent's git writes inside its own worktree.
 * `allow` short-circuits it, for the test that pins the seam.
 */
export function worktreeGuardHook(worktree: string, allow = false) {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (allow || !worktree) return {};
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const command = (input.tool_input as { command?: unknown })?.command;
    if (typeof command !== "string" || !command.trim()) return {};
    const write = outsideWorktreeWrite(command, worktree);
    if (!write) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denialReason(write, path.resolve(worktree)),
      },
    };
  };
}
