import { z } from "zod";

/**
 * The shape every planner-assigned id has to have.
 *
 * The rule is not the interesting part — the message is. Zod's default for a
 * failed regex is the bare word "Invalid", which is what the planner is handed
 * when its plan is rejected, and it names neither the rule it broke nor the
 * value that broke it. Run 5122c83a lost a hundred-task plan to
 * `tasks.52.id: Invalid`: one segment of one id was camelCase, and nothing the
 * planner was told could have located it.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SLUG_RULE = "must be a lowercase kebab-case slug of 2-64 characters: a-z, 0-9 and hyphens only, starting with a letter or digit";

/** A single task emitted by the planner. IDs are planner-assigned slugs, unique per run. */
export const PlannedTask = z.object({
  id: z.string().regex(SLUG, SLUG_RULE),
  epicId: z.string(),
  title: z.string().min(1),
  spec: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).default([]),
  touchedPaths: z.array(z.string()).default([]),
  /**
   * One shell command that exits zero exactly when this task is finished, run
   * in the task's worktree. Empty when the task has no such command.
   *
   * Acceptance criteria are prose, adjudicated by an agent reading the diff,
   * and that works until a criterion is about *everywhere*: "the unenforced
   * claim is removed from the pricing surfaces" is satisfied, as written, by
   * removing it from one page. In run da8325bd that is exactly what shipped —
   * one page changed, twenty others left as they were, QA correctly passing it
   * because the criterion it was given had been met.
   *
   * A probe is the same criterion in a form that cannot be partially satisfied:
   * `! rg -q "Multi-agent priority" frontend/src`. It is not a substitute for
   * criteria and most tasks do not need one; it exists for the class of work
   * where "done" means a search comes back empty.
   */
  completionProbe: z.string().default(""),
  /**
   * The scenarios this task is the one to turn green, by id.
   *
   * The link that makes the specification a plan rather than a document. Without
   * it a task's "done" is still prose adjudicated by an agent; with it, the
   * worker is handed the exact checks it has to satisfy and QA runs them rather
   * than forming a view. Empty for a task no scenario covers — scaffolding,
   * refactors, a dependency bump — which is honest and common.
   */
  scenarioIds: z.array(z.string()).default([]),
  /**
   * Whether this task is part of the walking skeleton: the thinnest vertical
   * slice that makes the run's critical path run end to end, however crude.
   *
   * waf built 13 crates, an operator UI, a marketing site, a fuzz workspace, a
   * benchmark harness, a parity suite, a Helm chart and 56,491 lines of
   * documentation before anything installed it on a cluster and watched it
   * block a request — and then spent its closing budget on Dockerfile build
   * contexts and golden-file drift, which is what breadth costs once you own
   * it. There was never a moment, in $3,755, when one thread ran end to end.
   *
   * The flag is what lets dispatch hold everything else behind it. It is not a
   * priority and not a size: a task is in the skeleton when the critical path
   * cannot run without it, and out of it when the path can run — badly,
   * unstyled, single-tenant — while it is missing. Empty on every task is
   * legal and means the plan named no spine, which the plan gate says out loud
   * rather than silently ordering the run by leverage alone (issue #118).
   */
  skeleton: z.boolean().default(false),
  estimatedSize: z.enum(["S", "M", "L"]),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlannedEpic = z.object({
  id: z.string().regex(SLUG, SLUG_RULE),
  title: z.string().min(1),
  summary: z.string(),
});
export type PlannedEpic = z.infer<typeof PlannedEpic>;

/** The planner's complete output: PRD text plus the epic/task DAG and a conventions doc. */
export const Plan = z.object({
  prdMarkdown: z.string().min(1),
  conventionsMarkdown: z.string().min(1),
  epics: z.array(PlannedEpic).min(1),
  tasks: z.array(PlannedTask).min(1),
});
export type Plan = z.infer<typeof Plan>;

/**
 * The DAG half of a plan, emitted on its own.
 *
 * The prose and the DAG are produced by two separate planner calls because
 * together they do not fit in one message: a PRD is thousands of words, and
 * JSON-escaping it into the same object that carries every task spec is what
 * pushes the emission past the output-token ceiling. Split, each half is small.
 */
export const PlanBreakdown = Plan.pick({ epics: true, tasks: true });
export type PlanBreakdown = z.infer<typeof PlanBreakdown>;

/**
 * One message's worth of the DAG.
 *
 * Even split from the prose, the DAG has no bound on it: a task's JSON costs
 * around 500 tokens and a real plan runs to forty of them, against a per-message
 * ceiling the SDK sets by model and does not negotiate. The old rule told the
 * planner to emit "fewer, larger tasks" when it would not fit — which trades the
 * only thing the DAG is for, parallelism, against a channel limit.
 *
 * So the planner emits what fits and says whether there is more. `epics` is
 * empty on every message after the first, and `more` false ends the sequence.
 */
export const PlanBatch = z.object({
  epics: z.array(PlannedEpic).default([]),
  tasks: z.array(PlannedTask).default([]),
  more: z.boolean().default(false),
});
export type PlanBatch = z.infer<typeof PlanBatch>;

/** Validate DAG shape: unique ids, no dangling deps, no cycles. Returns error strings (empty = valid). */
export function validatePlanDag(plan: Plan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id: ${t.id}`);
    ids.add(t.id);
  }
  const epicIds = new Set(plan.epics.map((e) => e.id));
  for (const t of plan.tasks) {
    if (!epicIds.has(t.epicId)) errors.push(`task ${t.id} references unknown epic ${t.epicId}`);
    for (const d of t.dependsOn) {
      if (!ids.has(d)) errors.push(`task ${t.id} depends on unknown task ${d}`);
      if (d === t.id) errors.push(`task ${t.id} depends on itself`);
    }
  }
  // Kahn's algorithm for cycle detection
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of plan.tasks) {
    indegree.set(t.id, t.dependsOn.filter((d) => ids.has(d) && d !== t.id).length);
    for (const d of t.dependsOn) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d)!.push(t.id);
    }
  }
  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const dep of dependents.get(id) ?? []) {
      const n = indegree.get(dep)! - 1;
      indegree.set(dep, n);
      if (n === 0) queue.push(dep);
    }
  }
  if (visited < plan.tasks.length) errors.push("dependency cycle detected");
  return errors;
}

export const QaVerdict = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("PASS"),
    notes: z.string().default(""),
    /**
     * Criteria this PASS did not actually settle, in QA's own words.
     *
     * The QA prompt has always told the agent to disclose these — five separate
     * times, once per artifact kind — and until now the only place to put them
     * was `notes`, free prose that is written to the task's ACCEPTED reason and
     * read by nobody. So an honest QA agent doing exactly as instructed produced
     * something indistinguishable from a clean pass.
     *
     * That is not hypothetical. dns-project's `af60742` shipped with its own commit
     * message ending "NOT YET verified this session (turn budget ran out
     * first)", naming the live DynamoDB run it had skipped and the manifest
     * variable it had not added. Both were the outage. The disclosure was
     * perfect and it was written into a field nothing gates on.
     *
     * Empty is the honest default and the common case. A non-empty list does
     * NOT fail the task — an unverifiable criterion is a fact about the
     * environment, not a defect in the work, and parking the task would only
     * teach the agent to stop saying so. It holds the rollup PR as a draft
     * instead, the same one-click hold an intent FAIL gets.
     */
    unverified: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    verdict: z.literal("FAIL"),
    reasons: z.array(z.string().min(1)).min(1),
    mustFix: z.array(z.string().min(1)).min(1),
  }),
]);
export type QaVerdict = z.infer<typeof QaVerdict>;
