/**
 * What this plan is likely to cost, shown to the operator before they approve it.
 *
 * The budget cap was the only cost signal a run had, and a cap is not an
 * estimate: it says where the run stops, not what it needs. Run 40da9337 started
 * with a $61 cap and finished at $774, having interrupted the operator nine
 * times to double it — each of those gates a surprise, and each answered blind,
 * because nobody had ever been shown a number to compare the cap against.
 *
 * The estimate is deliberately a range. The harness's own recorded runs span
 * $1.96 to $21.49 per task depending on how large and how brownfield the repo
 * is, and a single confident number across that spread would be worse than no
 * number at all — it would make the surprise feel like a broken promise instead
 * of an open question. A range with its basis named lets the operator see which
 * side of that spread they might be on, and set a cap on purpose.
 */

/** Relative effort per planner size. A task is not four times a task, but an L is roughly four S. */
const WEIGHT: Record<"S" | "M" | "L", number> = { S: 1, M: 2, L: 4 };

/**
 * Dollars per weight unit when this repository has no finished run to learn
 * from, taken from the harness's own field history: marrymath merged 17 tasks
 * for $33 and billing-app merged 36 for $774. Those bound the band; the point
 * estimate sits low inside it because most repositories are not billing-app, and
 * an estimate that reads high gets the cap set high and the run never questioned.
 */
export const DEFAULT_RATE = { usd: 3, low: 1, high: 11 };

export interface SizedTask {
  estimatedSize: "S" | "M" | "L";
}

/** One finished run's contribution to the rate: what it merged, and what it cost to get there. */
export interface RunCost {
  /** Summed weight of the tasks that actually merged. */
  weight: number;
  spentUsd: number;
}

export interface Estimate {
  /** The mid estimate, and the band around it. All in USD. */
  usd: number;
  low: number;
  high: number;
  /** Where the rate came from, in the operator's language. */
  basis: string;
}

export function planWeight(tasks: SizedTask[]): number {
  return tasks.reduce((n, t) => n + WEIGHT[t.estimatedSize], 0);
}

/**
 * Estimate a plan against whatever this repository's history supports.
 *
 * History is per-repository because that is the variable that actually moves the
 * number: the same harness on the same models costs an order of magnitude more
 * per task on a large brownfield service than on a small greenfield one, and the
 * repository is what decides which of those a run is.
 *
 * Runs that merged nothing are dropped rather than counted as infinitely
 * expensive — a run that parked on its first task says nothing about the rate.
 */
export function estimatePlan(tasks: SizedTask[], history: RunCost[]): Estimate {
  const weight = planWeight(tasks);
  const useful = history.filter((h) => h.weight > 0 && h.spentUsd > 0);
  if (!useful.length) {
    return {
      usd: weight * DEFAULT_RATE.usd,
      low: weight * DEFAULT_RATE.low,
      high: weight * DEFAULT_RATE.high,
      basis: "no finished run in this repository yet — this is the spread across every repository the harness has run",
    };
  }
  const rates = useful.map((h) => h.spentUsd / h.weight).sort((a, b) => a - b);
  const totalWeight = useful.reduce((n, h) => n + h.weight, 0);
  const totalSpent = useful.reduce((n, h) => n + h.spentUsd, 0);
  const mid = totalSpent / totalWeight;
  // One prior run gives a rate and no spread, so widen it by hand rather than
  // reporting a band of zero. Two runs of the same repo already disagree by
  // enough that their own min and max are the more honest bound.
  const low = rates.length > 1 ? rates[0]! : mid * 0.5;
  const high = rates.length > 1 ? rates[rates.length - 1]! : mid * 2;
  return {
    usd: weight * mid,
    low: weight * low,
    high: weight * high,
    basis: `${useful.length} previous run${useful.length === 1 ? "" : "s"} in this repository`,
  };
}

/**
 * The estimate as the operator reads it at the plan gate, next to the cap they
 * are about to approve.
 *
 * The comparison is against the top of the band, not the mid: a cap under the
 * mid will certainly interrupt, and a cap between the mid and the high is the
 * case worth naming, because that is the one where the run looks affordable and
 * then stops halfway.
 */
export function renderEstimate(estimate: Estimate, capUsd: number): string {
  const money = (n: number) => `$${n.toFixed(n < 100 ? 2 : 0)}`;
  const lines = [
    `Estimated cost: ${money(estimate.usd)} (likely ${money(estimate.low)}–${money(estimate.high)}) against a cap of ${money(capUsd)}.`,
    `Based on ${estimate.basis}.`,
  ];
  if (capUsd < estimate.usd) {
    lines.push(`The cap is below the estimate: expect this run to stop and ask you to raise it. Raising it now costs nothing and interrupts you less.`);
  } else if (capUsd < estimate.high) {
    lines.push(`The cap is inside the range, so a more expensive-than-typical run will stop and ask you to raise it.`);
  }
  return lines.join("\n");
}
