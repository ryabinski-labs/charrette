import { type RunSpec, type SpecRequirement, type TaskState } from "@charrette/shared";

/**
 * Which of the promises the brief made are still standing at the end of a run.
 *
 * rust-service cancelled 177 tasks against 377 merged — 32% of everything it ever
 * planned. 138 were replaced at a pit-stop re-plan, 47 died as `unreachable:
 * dependencies parked`, 35 were superseded when the plan was rewritten. Every
 * one of those transitions is legitimate and none of them leaves anything
 * behind: a cancelled task's requirement is not carried anywhere, not
 * re-derived, and not put to the operator. It stops existing, and reappears
 * months later as a section in `KNOWN-GAPS.md`.
 *
 * The closing report counts merged and cancelled *tasks*, which is a fact about
 * the plan rather than about the product. This counts *requirements*, which is
 * what the operator asked for, and sorts them into the only three answers that
 * matter: it shipped, it was written off and here is the answer that wrote it
 * off, or it just stopped. The third bucket is the one issue #120 is about, and
 * the closing gate holds a run whose third bucket is not empty.
 *
 * Pure, like `acceptance` and `skeleton`: the caller supplies the specification,
 * the tasks and the write-offs, so the rule is testable without a run.
 */

/** Just enough of a task row to attribute a requirement to it. */
export interface ScopedTask {
  id: string;
  title: string;
  state: TaskState;
  /** The scenarios this task was the one to turn green. */
  scenarioIds: string[];
  /** Why it is in the state it is in, for a cancelled or parked task. */
  why: string;
}

/** An answer the operator gave about a requirement that will not ship. */
export interface WriteOff {
  requirementId: string;
  /** What they said. Kept verbatim: it is the record that this was a decision. */
  answer: string;
  decidedBy: string;
}

export type ScopeStatus =
  /** Every required scenario has a merged owner. */
  | "shipped"
  | "in-progress"
  /** Nothing live claims it, and the operator said so. */
  | "written-off"
  /** Nothing live claims it, and nobody was asked. */
  | "dropped"
  /** No task ever claimed it, in any state. */
  | "unclaimed";

export interface ScopeEntry {
  id: string;
  text: string;
  priority: SpecRequirement["priority"];
  status: ScopeStatus;
  /** Tasks that claimed a scenario of this requirement, whatever became of them. */
  claimants: { id: string; title: string; state: TaskState; why: string }[];
  /** The operator's answer, for a written-off requirement. */
  answer: string;
}

export interface ScopeLedger {
  entries: ScopeEntry[];
  shipped: number;
  writtenOff: number;
  /** Requirements nothing is building and nobody decided about. The bucket that must be empty. */
  dropped: ScopeEntry[];
  /** Requirements no task ever claimed. Also nobody's decision, and visible at the plan gate too. */
  unclaimed: ScopeEntry[];
}

const LIVE: TaskState[] = ["PENDING", "READY", "WORKING", "QA", "QA_FAILED", "ACCEPTED"];

/**
 * Reconcile the specification's requirements against what the run did with
 * them.
 *
 * A requirement is `shipped` when merged tasks claim all its required scenarios —
 * not when the scenario passed, which is `specCoverage`'s question and a
 * different one. This asks whether anyone ever delivered the work; that asks
 * whether the work is proven. A run can ship a requirement whose scenario is
 * red, and the operator needs both readings.
 *
 * Priority is carried through rather than filtered on, because the caller
 * decides what to hold a run over: the closing gate reads P0 and P1, the
 * completion report prints all of them.
 */
export function scopeLedger(spec: RunSpec, tasks: ScopedTask[], writeOffs: WriteOff[] = []): ScopeLedger {
  const requirementOf = new Map(spec.scenarios.map((s) => [s.id, s.requirement]));
  const claims = new Map<string, ScopedTask[]>();
  for (const t of tasks) {
    // A task claims a requirement by claiming one of its scenarios. Deduped:
    // a task carrying three scenarios of one requirement claims it once.
    for (const req of new Set(t.scenarioIds.map((id) => requirementOf.get(id)).filter((r): r is string => Boolean(r)))) {
      claims.set(req, [...(claims.get(req) ?? []), t]);
    }
  }
  const answered = new Map(writeOffs.map((w) => [w.requirementId, w]));

  const entries: ScopeEntry[] = spec.requirements.map((r) => {
    const mine = claims.get(r.id) ?? [];
    const scenarios = spec.scenarios.filter((s) => s.requirement === r.id);
    const needed = scenarios.some(gatingRequirement) ? scenarios.filter(gatingRequirement) : scenarios;
    const covered = (s: { id: string }, states: TaskState[]) => mine.some((t) => states.includes(t.state) && t.scenarioIds.includes(s.id));
    // An answer settles a requirement whichever way it was lost. Both buckets
    // are put to the operator at the closing stop, and one that could be
    // accepted but not recorded would hold the run for ever however many times
    // it was answered.
    const status: ScopeStatus = !mine.length
      ? answered.has(r.id)
        ? "written-off"
        : "unclaimed"
      : needed.length > 0 && needed.every((s) => covered(s, ["MERGED"]))
        ? "shipped"
        : needed.length > 0 && needed.every((s) => covered(s, ["MERGED", ...LIVE]))
          ? "in-progress"
          : answered.has(r.id)
            ? "written-off"
            : "dropped";
    return {
      id: r.id,
      text: r.text,
      priority: r.priority,
      status,
      claimants: mine.map((t) => ({ id: t.id, title: t.title, state: t.state, why: t.why })),
      answer: answered.get(r.id)?.answer ?? "",
    };
  });

  return {
    entries,
    shipped: entries.filter((e) => e.status === "shipped").length,
    writtenOff: entries.filter((e) => e.status === "written-off").length,
    dropped: entries.filter((e) => e.status === "dropped"),
    unclaimed: entries.filter((e) => e.status === "unclaimed"),
  };
}

/** Whether this requirement is one the run is held to. P2 and P3 are reported and never block. */
export const gatingRequirement = (e: { priority: SpecRequirement["priority"] }): boolean => e.priority === "P0" || e.priority === "P1";

/**
 * What the closing gate must say about scope, if anything.
 *
 * One sentence per bucket rather than per requirement: an operator reading why
 * a run stopped needs the count and the worst few ids, and the completion
 * report has the rest. Empty when every gating requirement either shipped or
 * was written off with an answer on the record — which is the difference
 * between a decision and an omission, and the whole of what issue #120 asks for.
 */
export function scopeUnmet(ledger: ScopeLedger): string[] {
  const unmet: string[] = [];
  const name = (e: ScopeEntry) => `${e.id} (${e.text.slice(0, 60)})`;
  const dropped = ledger.dropped.filter(gatingRequirement);
  const unclaimed = ledger.unclaimed.filter(gatingRequirement);
  const unfinished = ledger.entries.filter((e) => e.status === "in-progress" && gatingRequirement(e));
  if (unfinished.length) unmet.push(`required work is still in progress: ${unfinished.map(name).join(", ")}`);
  if (dropped.length) {
    unmet.push(
      `${dropped.length} requirement(s) the brief named were dropped without a decision: ${dropped.slice(0, 4).map(name).join(", ")}${dropped.length > 4 ? `, +${dropped.length - 4} more` : ""} — at least one required scenario has no delivered or active owner, and nobody was asked whether that was acceptable`
    );
  }
  if (unclaimed.length) {
    unmet.push(
      `${unclaimed.length} requirement(s) the brief named were never claimed by any task: ${unclaimed.slice(0, 4).map(name).join(", ")}${unclaimed.length > 4 ? `, +${unclaimed.length - 4} more` : ""}`
    );
  }
  return unmet;
}

/**
 * What a re-plan would stop building.
 *
 * Run 6fe4ba37 voided 39 tasks as one at a pit stop, and the next run rebuilt
 * much of it from scratch — including `seclang ast types` twice under two ids,
 * and the multipart, JSON and XML body parsers each twice, which the run then
 * paid a third task to consolidate. The operator approving that re-plan was
 * never shown what coverage it dropped, because nothing computed it.
 *
 * Compares the requirement coverage of the plan that stands against the plan
 * proposed, and names what the second one stops claiming.
 */
export function replanDrops(spec: RunSpec, before: ScopedTask[], after: { id: string; scenarioIds: string[] }[]): string[] {
  const requirementOf = new Map(spec.scenarios.map((s) => [s.id, s.requirement]));
  const covered = (list: { scenarioIds: string[] }[]) => new Set(list.flatMap((t) => t.scenarioIds));
  // Only what the *live* plan covers can be dropped by replacing it: a
  // requirement whose task already merged is delivered, and a re-plan that
  // does not mention it is not dropping anything.
  const now = covered(before.filter((t) => LIVE.includes(t.state)));
  const next = covered([...after, ...before.filter((t) => t.state === "MERGED")]);
  const byId = new Map(spec.requirements.map((r) => [r.id, r]));
  return [...new Set([...now].filter((id) => !next.has(id)).map((id) => requirementOf.get(id)))]
    .map((id) => id ? byId.get(id) : undefined)
    .filter((r): r is SpecRequirement => Boolean(r))
    .filter(gatingRequirement)
    .map((r) => `${r.id} (${r.text.slice(0, 80)}) — the plan that stands has a task for it and the re-plan does not`);
}
