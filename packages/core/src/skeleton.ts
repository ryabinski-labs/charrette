import type { RunSpec } from "@harness/shared";

/**
 * Whether a plan builds a spine before it builds breadth.
 *
 * waf's plan bought 13 Rust crates, a React operator UI, an Astro marketing
 * site, a fuzzing workspace, a benchmark harness, a parity suite, a Helm chart
 * and 56,491 lines of documentation, and the first time anyone installed it on
 * a cluster and watched it block a request was after the last run declared
 * itself in review. Every piece was real and most were good. What never
 * happened, in $3,755 and 1,610 commits, was one thread running end to end —
 * and the breadth then had to be maintained with the budget that would
 * otherwise have finished the product: its closing pit stops went on Dockerfile
 * build contexts, golden-file drift, coverage floors and a missing PyYAML.
 *
 * So this module answers two questions about a plan, before a worker is paid.
 * Does it name a walking skeleton at all — the thinnest vertical slice that
 * makes the critical path run, however crude? And how much of what it plans is
 * breadth the skeleton does not need? Neither answer blocks the plan. Both go
 * to the operator at the gate, which is the last moment where changing the
 * answer costs a re-plan rather than a run.
 *
 * Pure, like `acceptance` and `deployCapability`: the caller supplies the plan
 * and the specification, so the rule is testable without a repository.
 */

/** Just enough of a planned task to weigh it. `PlannedTask` satisfies this. */
export interface WeighableTask {
  id: string;
  title: string;
  spec: string;
  skeleton: boolean;
  estimatedSize: "S" | "M" | "L";
  touchedPaths: string[];
}

/**
 * What a task is worth, in the only unit the planner gives us.
 *
 * Sizes rather than money: an estimate in dollars would be a second opinion
 * about a number `estimate.ts` already produces from measured spend, and what
 * this needs is a ratio, which the sizes carry as well as the money would.
 */
const WEIGHT: Record<WeighableTask["estimatedSize"], number> = { S: 1, M: 2, L: 4 };

/**
 * Work that is not the product: the scaffolding around it, the ways of
 * shipping it, and the ways of talking about it.
 *
 * Deliberately a list of markers rather than a judgment. Every one of these is
 * work a real product needs, and none of them makes the critical path run —
 * which is the whole distinction. The false positives that matter are a
 * product whose *point* is one of these (a CI tool's own CI, a documentation
 * generator's docs), and for exactly that reason a task the planner marked
 * `skeleton` is never counted here whatever it is named.
 */
const BREADTH = new RegExp(
  "\\b(" +
    [
      "ci", "cd", "pipeline", "workflow", "github actions?", "dockerfile", "docker", "containeri[sz]e?d?", "helm", "chart",
      "kubernetes", "k8s", "terraform", "iac", "infra", "infrastructure", "deploy(ment)?", "release", "packaging",
      "benchmark", "bench", "fuzz(ing)?", "load test", "perf(ormance)? (suite|harness)", "parity suite", "coverage",
      "lint(ing|er)?", "formatter", "pre-commit",
      "docs?", "documentation", "readme", "changelog", "handover", "runbook", "adr", "marketing", "landing page",
      "website", "blog", "screenshots?",
      "dashboard", "admin (ui|panel|console)", "telemetry", "analytics", "observability", "monitoring", "alerting", "metrics",
    ].join("|") +
    ")\\b",
  "i"
);

export interface PlanWeight {
  /** Size-weighted total of every task in the plan. */
  total: number;
  /** Of that, what the planner marked as the walking skeleton. */
  skeleton: number;
  /** Of that, what is breadth the skeleton does not need. */
  breadth: number;
  /** Breadth as a share of the whole, 0-1. */
  breadthShare: number;
  /** The breadth tasks, worst first, for the sentence the operator reads. */
  breadthTasks: { id: string; title: string }[];
}

/**
 * Is this task named for scaffolding?
 *
 * Only asked of tasks outside the spine — see `planWeight` — which is what
 * keeps the false positive that matters from mattering: a product whose point
 * is one of these words ("build a CI tool", "generate the docs") has those
 * tasks in its skeleton, and a skeleton task is never weighed here at all.
 */
function isBreadth(t: WeighableTask): boolean {
  return BREADTH.test(t.title) || t.touchedPaths.some((p) => BREADTH.test(p));
}

export function planWeight(tasks: WeighableTask[]): PlanWeight {
  let total = 0;
  let skeleton = 0;
  let breadth = 0;
  const breadthTasks: { id: string; title: string }[] = [];
  for (const t of tasks) {
    const w = WEIGHT[t.estimatedSize];
    total += w;
    if (t.skeleton) skeleton += w;
    else if (isBreadth(t)) {
      breadth += w;
      breadthTasks.push({ id: t.id, title: t.title });
    }
  }
  return { total, skeleton, breadth, breadthShare: total ? breadth / total : 0, breadthTasks };
}

/**
 * The share of a plan that may be breadth before the operator is shown the
 * split.
 *
 * Not a rule about good plans — a mature product is mostly breadth, and so is
 * a run whose brief is "add CI to this repository". It is a threshold on when
 * the split is worth a sentence at the gate, and it is set where waf's plan
 * would have crossed it long before anyone noticed.
 */
const BREADTH_LIMIT = 0.4;

/**
 * What to tell the operator about this plan's shape, at the gate.
 *
 * Empty for a plan that names a spine and spends most of itself on it. Each
 * string is one thing the operator can act on by rejecting, and every one of
 * them is cheaper to fix here than anywhere later: a plan is a re-plan, and a
 * run is a run.
 */
export function skeletonShortfall(spec: RunSpec | null, tasks: WeighableTask[]): string[] {
  const gaps: string[] = [];
  if (!tasks.length) return gaps;
  const weight = planWeight(tasks);
  const path = spec?.criticalPath;

  if (path?.steps.length && !weight.skeleton) {
    gaps.push(
      `No task in this plan is marked as part of the walking skeleton, and the specification names a critical path (${path.name || "unnamed"}: ${path.steps.join(" → ")}). ` +
        `Nothing will therefore run end to end until the whole plan does, and the live-exercise gate at the end of the run drives exactly that path. ` +
        `Mark the smallest set of tasks that makes it run — real entry point, real storage, real external call, real output, however crude — as \`skeleton\`, and the run will build them before anything else.`
    );
  }
  if (weight.breadthShare > BREADTH_LIMIT) {
    const worst = weight.breadthTasks.slice(0, 6).map((t) => `${t.id} (${t.title})`);
    gaps.push(
      `${Math.round(weight.breadthShare * 100)}% of this plan, by estimated size, is infrastructure, CI, benchmarking, documentation, dashboards or marketing rather than the product's own critical path: ${worst.join(", ")}${weight.breadthTasks.length > worst.length ? `, +${weight.breadthTasks.length - worst.length} more` : ""}. ` +
        `All of it may be work you want. What it is not is work that makes the product run, and once it exists the run has to maintain it — waf spent its closing budget on Dockerfile build contexts and golden-file drift while its own WAF had never blocked a request. If this split is what you want, approve; if not, reject and say which of these should wait.`
    );
  }
  return gaps;
}
