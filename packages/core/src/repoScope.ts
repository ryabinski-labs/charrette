import os from "node:os";
import path from "node:path";
import type { PlannedTask } from "@harness/shared";

/**
 * Whether a task the planner wrote is about the repository the run owns.
 *
 * A run has exactly one repository. It branches there, merges there, opens its
 * pull request there, and every check it runs reads that working tree. A task
 * whose spec says "in ~/Documents/projects/other-repo, add …" therefore cannot
 * be finished by this run at all — and nothing downstream can tell you that.
 *
 * Run 7ef8fb4d is the whole argument. Its repo was `api-service-new-ui`; task
 * `api-delivery-table-infra` opened with "In `~/Documents/projects/api-service-new-api/`,
 * add the api-service_delivery_log DynamoDB table". The worker did the only
 * sensible thing available to it — nested a worktree of the *other* repo inside
 * its own and committed the full implementation there — and the harness, which
 * measures deliveries against its own repo, reported an empty branch five times
 * and parked the task telling whoever read it to go looking for a lost commit.
 * The work was never lost. It was never in scope.
 *
 * This is knowable at plan time, from the plan text alone, before a worker
 * token is spent.
 */

/**
 * The paths a task names that belong to a sibling checkout of the run's repo.
 *
 * The rule is deliberately narrow: a path counts only when it resolves inside
 * the run repository's *parent* directory but outside the run repository
 * itself. That is what a sibling project checkout looks like on disk, and it is
 * the shape that produced every cross-repo task seen so far.
 *
 * Narrow because the alternative is unusable. "Any absolute path outside the
 * repo" flags `/pricing` in a spec about a route, `/tmp` in one about fixtures,
 * and `arn:...:table/x/index/*` in one about IAM. Those are not scope errors and
 * a check that cries about them gets switched off. The cost of the narrow rule
 * is that a repo somewhere else entirely — a different parent directory, or
 * named without a leading slash — is not caught here; the empty-branch path
 * still catches those, late and expensively, which is the state everything was
 * in before.
 *
 * Dot-directories are never siblings for this purpose: `~/.claude`, `~/.config`
 * and friends sit next to a repo checked out directly in `$HOME` and are
 * tooling, not somebody's source tree.
 */
export function foreignRepoPaths(task: Pick<PlannedTask, "spec" | "acceptanceCriteria" | "touchedPaths">, repoPath: string): string[] {
  const repo = path.resolve(repoPath);
  const parent = path.dirname(repo);
  // A repository checked out at a filesystem root has no meaningful sibling
  // set — every absolute path in the plan would be "next to" it.
  if (parent === repo || parent === path.dirname(parent)) return [];
  const found = new Set<string>();
  for (const text of [task.spec, ...task.acceptanceCriteria, ...task.touchedPaths]) {
    for (const token of text.match(/~?\/[A-Za-z0-9._\-/]+/g) ?? []) {
      const resolved = path.resolve(expandHome(token));
      if (!within(parent, resolved) || within(repo, resolved)) continue;
      // The sibling itself, not the file inside it: the planner's mistake is
      // the repository it chose, and naming twelve files in it says that once
      // twelve times. Empty means the token *is* the parent directory, which
      // names no repository at all.
      const sibling = path.relative(parent, resolved).split(path.sep)[0]!;
      if (!sibling || sibling.startsWith(".")) continue;
      found.add(path.join(parent, sibling));
    }
  }
  return [...found];
}

/**
 * Plan-level scope errors, in the same shape `validatePlanDag` returns them:
 * one string per problem, empty when the plan is in scope.
 *
 * Returned to the planner's retry loop rather than thrown. A plan that reaches
 * outside the run's repo is the kind of mistake a planner fixes on the next
 * attempt when told plainly what it did, and the loop that tells it already
 * exists.
 */
export function validatePlanScope(tasks: Pick<PlannedTask, "id" | "spec" | "acceptanceCriteria" | "touchedPaths">[], repoPath: string): string[] {
  const errors: string[] = [];
  for (const t of tasks) {
    const foreign = foreignRepoPaths(t, repoPath);
    if (!foreign.length) continue;
    errors.push(
      `task ${t.id} is written against ${foreign.map((p) => path.basename(p)).join(", ")}, ` +
        `which this run does not own — it can only branch, merge and open a pull request in ${path.basename(path.resolve(repoPath))}. ` +
        `Re-scope the task to work this repository can do, or drop it and raise it as a separate run.`
    );
  }
  return errors;
}

/** `~/x` only — the tokens this reads always carry a separator, and `~user` is somebody else's home. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** Is `child` at or below `dir`? Compared as path segments, so `/a/bc` is not in `/a/b`. */
function within(dir: string, child: string): boolean {
  const rel = path.relative(dir, child);
  return rel === "" || !rel.startsWith("..");
}
