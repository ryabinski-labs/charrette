import { z } from "zod";

/** A single task emitted by the planner. IDs are planner-assigned slugs, unique per run. */
export const PlannedTask = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  epicId: z.string(),
  title: z.string().min(1),
  spec: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(z.string()).default([]),
  touchedPaths: z.array(z.string()).default([]),
  estimatedSize: z.enum(["S", "M", "L"]),
});
export type PlannedTask = z.infer<typeof PlannedTask>;

export const PlannedEpic = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
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
  z.object({ verdict: z.literal("PASS"), notes: z.string().default("") }),
  z.object({
    verdict: z.literal("FAIL"),
    reasons: z.array(z.string().min(1)).min(1),
    mustFix: z.array(z.string().min(1)).min(1),
  }),
]);
export type QaVerdict = z.infer<typeof QaVerdict>;
