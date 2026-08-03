import type { TaskState } from "@harness/shared";

/** The states a task can no longer do work in. */
const TERMINAL: TaskState[] = ["MERGED", "NEEDS_HUMAN", "CANCELLED"];

/** Just enough of a task to order it; `TaskRow` satisfies this. */
export interface Dispatchable {
  id: string;
  state: TaskState;
  dependsOn: string[];
  /** What the planner expects this task to edit. Empty means it did not say. */
  touchedPaths: string[];
}

/** Trim the spellings of one path that mean the same file: `./a/b/`, `a/b`. */
function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * Do these two path sets name any of the same work?
 *
 * A directory contains everything under it, so `src/api` and `src/api/orders.ts`
 * collide — but `src/apiary.ts` does not, which is why the prefix test has to
 * land on a separator rather than on a character.
 */
export function pathsCollide(a: string[], b: string[]): boolean {
  const left = a.map(normalizePath).filter(Boolean);
  const right = b.map(normalizePath).filter(Boolean);
  return left.some((l) => right.some((r) => l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`)));
}

/**
 * How much unfinished work this task is standing in front of: the number of
 * still-live tasks that cannot start until it merges, counted transitively.
 *
 * Direct dependents undercount badly on a deep graph. `returns-and-disputes`
 * has two direct dependents, but one of them (`ops-console`) is itself the last
 * gate on a third — so finishing it releases three tasks, not two, and a
 * one-hop count would rank it level with a task that releases nothing beyond
 * its own dependent.
 *
 * Terminal dependents are not counted. A task whose only dependents are parked
 * or cancelled is a leaf now, whatever the plan said, and ranking it as trunk
 * work would spend the remaining budget clearing a path to nothing.
 */
export function leverage(tasks: Dispatchable[], id: string): number {
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const d of t.dependsOn) dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
  }
  const live = new Map(tasks.filter((t) => !TERMINAL.includes(t.state)).map((t) => [t.id, t]));
  const seen = new Set<string>([id]);
  const queue = [id];
  let count = 0;
  // A validated plan is acyclic, but `seen` is what makes that a property of
  // this function rather than of its caller.
  while (queue.length) {
    for (const next of dependents.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      if (live.has(next)) count++;
    }
  }
  return count;
}

/**
 * The task to dispatch next, or undefined when nothing can start.
 *
 * Dispatch used to be `find` over the plan's own order: whichever runnable task
 * the planner happened to list first went first. That is fine while a run
 * finishes, and wrong the moment it does not. A budget cap truncates the run
 * wherever it lands, so the order tasks start in decides which ones never get
 * built — and plan order encodes no opinion about that. Run 40da9337 reached
 * 70% of its cap with 12 tasks left and three of them runnable: documentation,
 * a regression suite, and a dashboard. All three block nothing. Behind them sat
 * the two tasks gating five others.
 *
 * So: leverage first. Clearing trunk work keeps the graph draining and pushes
 * the leaves — docs, dashboards, extra test suites — to the end, which is where
 * a truncated run should lose work. Among tasks of equal leverage the planner's
 * order stands, so an operator who wants a specific order still gets one by
 * asking the planner for it.
 *
 * READY still outranks everything. That state means an operator revived the
 * task by hand or a dead process left it mid-flight, and both want it picked up
 * now rather than ranked against the plan.
 *
 * A task whose `touchedPaths` overlap something already in flight is held back.
 * Two workers editing one file each branch from the same commit and each commit
 * a different version of it, so whichever merges second meets a conflict — 23 of
 * them across 36 tasks in run 40da9337, each costing a re-dispatched worker or,
 * past the conflict cap, an operator. The planner has always emitted the paths;
 * nothing read them. Waiting is nearly free by comparison: the colliding task is
 * next in line the moment the other one merges, and if nothing else is runnable
 * the run loses one slot for a few minutes rather than a whole re-run of a task.
 *
 * `nearby` widens both sides of that comparison with files the repository has
 * historically shipped alongside the declared ones (see `coChange.ts`). Declared
 * paths alone catch 43% of the collisions that really happen, because the
 * planner names four or five files out of a dozen; widened, 70%. Omit it and
 * every line above still describes the behaviour exactly.
 */
export function nextDispatch<T extends Dispatchable>(
  tasks: T[],
  inFlight: ReadonlySet<string>,
  nearby?: (paths: string[]) => string[],
): T | undefined {
  const merged = new Set(tasks.filter((t) => t.state === "MERGED").map((t) => t.id));
  // Widened once per task per dispatch rather than inside the comparison: the
  // in-flight set is re-tested against every candidate.
  const claim = (t: T) => (nearby ? [...t.touchedPaths, ...nearby(t.touchedPaths)] : t.touchedPaths);
  const busy = tasks.filter((t) => inFlight.has(t.id)).flatMap(claim);
  const runnable = tasks.filter(
    (t) =>
      !inFlight.has(t.id) &&
      (t.state === "READY" || (t.state === "PENDING" && t.dependsOn.every((d) => merged.has(d)))) &&
      // A planner that named no paths has told us nothing, so this cannot hold
      // anything back on its account — the status quo, not a guess at one.
      !pathsCollide(claim(t), busy),
  );
  if (runnable.length === 0) return undefined;
  const rank = new Map(runnable.map((t) => [t.id, leverage(tasks, t.id)]));
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  return runnable.sort(
    (a, b) =>
      Number(b.state === "READY") - Number(a.state === "READY") ||
      rank.get(b.id)! - rank.get(a.id)! ||
      order.get(a.id)! - order.get(b.id)!,
  )[0];
}
