import type { PlannedTask } from "@harness/shared";

/**
 * Which worker model a task is dispatched on.
 *
 * The saving that matters in this harness is the worker: it writes every line
 * of code, it runs at the highest turn ceiling of any role, and one recorded run
 * spent $65 across seventeen worker sessions against $14 across eight QA ones.
 * A third of the worker bill is the largest number on the table.
 *
 * The obvious way to collect it is to ask the planner which tasks are simple.
 * That is the one design this module deliberately refuses. The planner is the
 * same actor that produced run 40da9337's plan — seven vendor categories whose
 * acceptance criteria a deterministic mock satisfies, against an assignment
 * that said "including all the integrations" — and run f338b5c8's, which
 * promised less than the brief in four ways that were named at the gate and
 * built anyway. An actor that under-recognises work will call that work simple,
 * and it will do so *precisely* on the tasks where being wrong costs the most,
 * because not seeing the difficulty is what generated both failures. Handing it
 * a `tier` field makes its optimism an execution authority.
 *
 * So the planner nominates and the code authorises. Every input below is a
 * field the planner already emits for other reasons — it has no idea it is
 * being read as a cost signal, which is what makes the signal worth reading —
 * and the rule over them is deterministic, local to one task, and refuses on
 * ambiguity rather than resolving it. There is no threshold to tune and no
 * model in the loop.
 *
 * Expect this to admit a minority of any real plan. That is the intended shape:
 * a rule that admitted most tasks would not be describing the tasks a cheap
 * model can finish.
 */

/**
 * How many files a light-tier task may name.
 *
 * `touchedPaths` is the planner's estimate of blast radius, and the number is
 * low on purpose. The point is not that four files are easy — it is that a task
 * which cannot say in advance where it lands is a task nobody has scoped, and
 * an unscoped task is the last one to send down the cheap road.
 */
export const LIGHT_TIER_MAX_PATHS = 4;

/**
 * Work whose failures are quiet, expensive, or both — refused whatever else the
 * task looks like.
 *
 * The test QA applies is "does the diff satisfy the criteria", and for most work
 * that is the same question as "is this correct". These are the domains where it
 * is not: an auth check that passes the happy path, a migration that is right
 * about the schema and wrong about the rollback, a payment path that reconciles
 * in the test and not in production, a race that reproduces one run in twenty.
 * Each of those merges green. None of them is caught by the mechanism that is
 * supposed to make a cheap worker safe, which is the entire reason this list
 * exists rather than trusting the retry.
 *
 * Matched against the task's title, spec, criteria and paths together, so a
 * task that mentions none of it in the title and all of it in the spec is still
 * refused.
 */
const RISKY =
  "\\b(" +
  // Identity and access. A weak check here is invisible until it is exploited.
  "auth\\w*|login|logout|sign-?(in|up|out)|password|passkey|webauthn|credential\\w*|" +
  "session\\w*|cookie\\w*|jwt|oauth|saml|sso|token\\w*|permission\\w*|access control|rbac|" +
  "authoriz\\w+|authentic\\w+|tenant\\w*|impersonat\\w+|" +
  // Money. Reconciliation errors survive every test that uses round numbers.
  "payment\\w*|billing|invoic\\w+|charge\\w*|refund\\w*|payout\\w*|stripe|checkout|" +
  "subscription\\w*|pricing|price|ledger|balance|currency|tax|dunning|proration|" +
  // Data that outlives the code. A bad migration is not fixed by the next task.
  "migrat\\w+|schema|database|db (schema|index|table)|sql|backfill|" +
  "data (model|loss|retention)|delet(e|ion) (user|account|data)|" +
  // Ordering and time. These fail one run in twenty and pass every review.
  "concurren\\w+|race condition|deadlock|mutex|lock(ing)?|transaction\\w*|atomic\\w*|" +
  "idempoten\\w+|queue|worker pool|scheduler|cron|retry (logic|policy)|backoff|" +
  // Anything that reaches outside the process, where a mistake reaches users.
  "webhook\\w*|rate limit\\w*|quota|throttl\\w+|secret\\w*|encrypt\\w+|decrypt\\w+|" +
  "crypto\\w*|signing|signature|certificate|tls|ssl|cors|csrf|xss|injection|" +
  "security|vulnerab\\w+|pii|gdpr|hipaa|pci|compliance|audit log|" +
  // Infrastructure. The harness will not apply it anyway (infraGuard.ts), and a
  // cheap model writing IaC it cannot run is the worst of both.
  // `infra` bare as well as spelled out, and the Terraform file extensions:
  // the vocabulary that gives this away is usually in the *path* rather than
  // the prose, and `infra/main.tf` named neither "terraform" nor
  // "infrastructure" until it was pointed out by a test.
  "terraform|tfvars?|cloudformation|kubernetes|k8s|helm|dockerfile|deploy\\w*|infra(structur\\w+)?|" +
  "dns|route ?53|load balanc\\w+|autoscal\\w+" +
  ")\\b";

const RISKY_RE = new RegExp(RISKY, "i");

export type Tier = "light" | "standard";

export interface TierDecision {
  tier: Tier;
  /**
   * One sentence, always populated, for both outcomes. It is written into the
   * ledger and the run log: a tier decision nobody can explain afterwards is
   * indistinguishable from a bug, and the whole point of this module is that
   * the operator can audit why a task went cheap.
   */
  why: string;
}

/** The fields the rule reads. Narrower than PlannedTask so tests can be honest. */
type Nominee = Pick<
  PlannedTask,
  "title" | "spec" | "acceptanceCriteria" | "touchedPaths" | "completionProbe" | "estimatedSize"
>;

/**
 * Decide a task's worker tier.
 *
 * Every condition is a reason to refuse. There is no scoring and no tie-break:
 * a task reaches the light tier by failing to trip any of them, and anything the
 * rule cannot answer resolves to `standard`. That asymmetry is the design — the
 * cost of wrongly refusing a task is that it runs on the model it runs on today,
 * and the cost of wrongly admitting one is a merge nobody caught.
 */
export function taskTier(task: Nominee, maxPaths = LIGHT_TIER_MAX_PATHS): TierDecision {
  const std = (why: string): TierDecision => ({ tier: "standard", why });

  if (task.estimatedSize !== "S") {
    return std(`the planner sized it ${task.estimatedSize}, and only S is eligible`);
  }
  // Empty is not "touches nothing", it is "the planner did not say" — the two
  // are indistinguishable in the data and only one of them is safe.
  if (task.touchedPaths.length === 0) {
    return std("the planner named no files it would touch, so its blast radius is unknown");
  }
  if (task.touchedPaths.length > maxPaths) {
    return std(`it touches ${task.touchedPaths.length} paths, over the light-tier limit of ${maxPaths}`);
  }
  // A probe is a shell command that exits zero exactly when the task is done,
  // and the worker is forbidden to edit it. It is the only check in the harness
  // that a cheap model cannot talk its way past.
  if (!task.completionProbe.trim()) {
    return std("it has no completion probe, so nothing but an agent's opinion would judge it done");
  }
  const haystack = [task.title, task.spec, task.acceptanceCriteria.join("\n"), task.touchedPaths.join("\n")].join("\n");
  const hit = RISKY_RE.exec(haystack);
  if (hit) {
    return std(`it involves ${hit[0].toLowerCase()}, where a plausible-looking mistake passes QA`);
  }
  return {
    tier: "light",
    why: `sized S, ${task.touchedPaths.length} path(s), probe-checked, and no risky-domain match`,
  };
}

/**
 * The model a task's worker session runs on.
 *
 * Returns `models.worker` unless the rule admits the task *and* the operator has
 * actually pointed the light tier somewhere cheaper. Those are two separate
 * conditions on purpose: the rule runs on every task from the day it ships, so
 * the ledger records which tasks it would have moved long before any of them
 * move, and the operator can price the experiment before running it.
 */
export function workerModelFor(
  task: Nominee,
  models: { worker: string; workerLight: string },
  maxPaths = LIGHT_TIER_MAX_PATHS
): { model: string; decision: TierDecision } {
  const decision = taskTier(task, maxPaths);
  const model = decision.tier === "light" ? models.workerLight : models.worker;
  return { model, decision };
}
