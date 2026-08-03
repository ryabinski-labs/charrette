import { describe, expect, it } from "vitest";
import { DEFAULT_RATE, estimatePlan, planWeight, renderEstimate, type RunCost, type SizedTask } from "./estimate.js";

/**
 * The number the operator sees before they approve a plan. What matters is not
 * that it is accurate — it cannot be — but that it is honest about how accurate
 * it is: run 40da9337 approved a $61 cap against a run that cost $774, and the
 * only thing that would have changed that decision is being shown a range.
 */

const tasks = (...sizes: ("S" | "M" | "L")[]): SizedTask[] => sizes.map((estimatedSize) => ({ estimatedSize }));

describe("weighing a plan", () => {
  it("counts an L as four S and an M as two", () => {
    expect(planWeight(tasks("S", "M", "L"))).toBe(7);
  });

  it("weighs an empty plan at nothing", () => {
    expect(planWeight([])).toBe(0);
  });
});

describe("with nothing to learn from", () => {
  it("prices the plan across the whole spread the harness has seen", () => {
    const e = estimatePlan(tasks("M", "M"), []);

    expect(e.usd).toBe(4 * DEFAULT_RATE.usd);
    expect(e.low).toBe(4 * DEFAULT_RATE.low);
    expect(e.high).toBe(4 * DEFAULT_RATE.high);
    expect(e.basis).toContain("no finished run in this repository");
  });

  it("ignores a run that merged nothing, which says nothing about the rate", () => {
    const parked: RunCost[] = [{ weight: 0, spentUsd: 40 }];

    expect(estimatePlan(tasks("S"), parked).basis).toContain("no finished run");
  });

  it("ignores a run that cost nothing, which is a fixture rather than a run", () => {
    expect(estimatePlan(tasks("S"), [{ weight: 8, spentUsd: 0 }]).basis).toContain("no finished run");
  });
});

describe("with this repository's own history", () => {
  it("takes the rate from what previous runs actually cost", () => {
    // $60 for 20 weight is $3/weight; a 10-weight plan is $30.
    const e = estimatePlan(tasks("L", "L", "M"), [{ weight: 20, spentUsd: 60 }]);

    expect(e.usd).toBe(30);
    expect(e.basis).toBe("1 previous run in this repository");
  });

  it("widens a single run by hand, because one number has no spread of its own", () => {
    const e = estimatePlan(tasks("M"), [{ weight: 10, spentUsd: 50 }]);

    expect(e.usd).toBe(10);
    expect(e.low).toBe(5);
    expect(e.high).toBe(20);
  });

  it("bounds the range by the cheapest and dearest run once there are two", () => {
    // $1/weight and $9/weight: the mid is weighted by size, the band is not.
    const e = estimatePlan(tasks("M"), [
      { weight: 10, spentUsd: 10 },
      { weight: 10, spentUsd: 90 },
    ]);

    expect(e.usd).toBe(10); // $100 over 20 weight, times 2
    expect(e.low).toBe(2);
    expect(e.high).toBe(18);
    expect(e.basis).toBe("2 previous runs in this repository");
  });
});

describe("what the operator reads at the plan gate", () => {
  const e = { usd: 100, low: 40, high: 300, basis: "2 previous runs in this repository" };

  it("puts the estimate, the range and the cap in one sentence", () => {
    expect(renderEstimate(e, 500)).toContain("Estimated cost: $100 (likely $40.00–$300) against a cap of $500");
  });

  it("names where the rate came from, so a wrong number can be argued with", () => {
    expect(renderEstimate(e, 500)).toContain("Based on 2 previous runs in this repository.");
  });

  it("says plainly when the cap cannot cover the estimate", () => {
    expect(renderEstimate(e, 50)).toContain("The cap is below the estimate");
  });

  it("warns when the cap covers the estimate but not the range", () => {
    const md = renderEstimate(e, 150);

    expect(md).toContain("The cap is inside the range");
    expect(md).not.toContain("below the estimate");
  });

  it("says nothing more when the cap covers the worst case", () => {
    const md = renderEstimate(e, 400);

    expect(md).not.toContain("cap is");
  });
});
