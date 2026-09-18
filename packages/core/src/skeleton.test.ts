import { describe, expect, it } from "vitest";
import { RunSpec } from "@charrette/shared";
import { planWeight, skeletonShortfall, type WeighableTask } from "./skeleton.js";
import { nextDispatch, type Dispatchable } from "./dispatchOrder.js";

/**
 * Whether a plan builds a spine before it builds breadth, and whether dispatch
 * holds it to that.
 *
 * rust-service's plan bought thirteen crates, an operator UI, a marketing site, a fuzzing
 * workspace and 56,491 lines of documentation, and nothing ran end to end in
 * $3,755 — then its closing budget went on Dockerfile build contexts and
 * golden-file drift, which is what breadth costs once you own it (issue #118).
 */

const task = (over: Partial<WeighableTask> & { id: string }): WeighableTask => ({
  title: over.id,
  spec: "",
  skeleton: false,
  estimatedSize: "M",
  touchedPaths: [],
  ...over,
});

const spec = (steps: string[], name = "take a payment") => RunSpec.parse({ feature: "f", criticalPath: { name, steps } });

describe("weighing what a plan spends itself on", () => {
  it("counts by estimated size, not by task count", () => {
    const w = planWeight([task({ id: "spine", skeleton: true, estimatedSize: "L" }), task({ id: "add-ci", estimatedSize: "S" })]);
    expect(w).toMatchObject({ total: 5, skeleton: 4, breadth: 1 });
    expect(w.breadthShare).toBeCloseTo(0.2);
  });

  it("reads scaffolding out of a title or a path", () => {
    const w = planWeight([
      task({ id: "a", title: "Add the GitHub Actions workflow" }),
      task({ id: "b", title: "Write the handover" }),
      task({ id: "c", title: "Ship the operator screen", touchedPaths: ["deploy/helm/values.yaml"] }),
      task({ id: "d", title: "Charge a card" }),
    ]);
    expect(w.breadthTasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  /**
   * The false positive that matters: a product whose point is one of these. A
   * task the planner put in the spine is never weighed as breadth, whatever it
   * is named — which is what makes "build a CI tool" plannable at all.
   */
  it("never counts a task the planner put in the spine, however it is named", () => {
    const w = planWeight([task({ id: "a", title: "Run the pipeline end to end", skeleton: true }), task({ id: "b", title: "Charge a card", skeleton: true })]);
    expect(w.breadth).toBe(0);
    expect(w.breadthTasks).toEqual([]);
  });

  it("has nothing to say about an empty plan", () => {
    expect(planWeight([])).toMatchObject({ total: 0, breadthShare: 0 });
    expect(skeletonShortfall(spec(["pay"]), [])).toEqual([]);
  });
});

describe("what the operator is told at the plan gate", () => {
  it("says when a plan names no spine and the specification names a path", () => {
    const [gap] = skeletonShortfall(spec(["open the checkout", "pay"]), [task({ id: "a", title: "Charge a card" })]);
    expect(gap).toContain("No task in this plan is marked as part of the walking skeleton");
    expect(gap).toContain("take a payment: open the checkout → pay");
    expect(gap).toContain("the live-exercise gate at the end of the run drives exactly that path");
  });

  it("calls an unnamed path unnamed rather than printing nothing", () => {
    expect(skeletonShortfall(spec(["pay"], ""), [task({ id: "a" })])[0]).toContain("(unnamed: pay)");
  });

  /** No path to hold it to, so nothing to say about a missing spine. */
  it("says nothing about a spine when the run has no specification or no path", () => {
    expect(skeletonShortfall(null, [task({ id: "a" })])).toEqual([]);
    expect(skeletonShortfall(RunSpec.parse({ feature: "f" }), [task({ id: "a" })])).toEqual([]);
  });

  it("shows the split when most of a plan is scaffolding, and names the worst of it", () => {
    const tasks = [
      task({ id: "spine", title: "Charge a card", skeleton: true }),
      task({ id: "ci", title: "Add CI" }),
      task({ id: "helm", title: "Helm chart" }),
      task({ id: "docs", title: "Write the docs" }),
    ];
    const gaps = skeletonShortfall(spec(["pay"]), tasks);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("75% of this plan");
    expect(gaps[0]).toContain("ci (Add CI)");
    expect(gaps[0]).toContain("If this split is what you want, approve");
  });

  it("caps the list it names and says how much it left out", () => {
    const tasks = [
      task({ id: "spine", title: "Charge a card", skeleton: true, estimatedSize: "S" }),
      ...Array.from({ length: 8 }, (_, i) => task({ id: `ci-${i + 1}`, title: `Add CI ${i + 1}` })),
    ];
    expect(skeletonShortfall(spec(["pay"]), tasks)[0]).toContain("+2 more");
  });

  it("says nothing about a plan that is mostly its own product", () => {
    const tasks = [
      task({ id: "spine", title: "Charge a card", skeleton: true, estimatedSize: "L" }),
      task({ id: "refunds", title: "Refund a charge", estimatedSize: "L" }),
      task({ id: "ci", title: "Add CI", estimatedSize: "S" }),
    ];
    expect(skeletonShortfall(spec(["pay"]), tasks)).toEqual([]);
  });
});

describe("dispatching the spine before anything else", () => {
  const d = (over: Partial<Dispatchable> & { id: string }): Dispatchable => ({ state: "PENDING", dependsOn: [], touchedPaths: [], ...over });

  it("starts a skeleton task ahead of higher-leverage breadth", () => {
    // The Helm chart has leverage — two tasks wait on it — and it is still not
    // the thing that makes the product run.
    const tasks = [
      d({ id: "helm" }),
      d({ id: "chart-a", dependsOn: ["helm"] }),
      d({ id: "chart-b", dependsOn: ["helm"] }),
      d({ id: "charge", skeleton: true }),
    ];
    expect(nextDispatch(tasks, new Set())!.id).toBe("charge");
  });

  it("holds breadth back while any skeleton task is still live", () => {
    const tasks = [d({ id: "charge", skeleton: true, state: "WORKING" }), d({ id: "docs" })];
    expect(nextDispatch(tasks, new Set(["charge"]))).toBeUndefined();
  });

  it("lets everything else go once the spine is finished", () => {
    const tasks = [d({ id: "charge", skeleton: true, state: "MERGED" }), d({ id: "docs" })];
    expect(nextDispatch(tasks, new Set())!.id).toBe("docs");
  });

  /**
   * A hold, not a filter. A spine nobody can finish should not take the run
   * with it — the alternative is a run that stops dead on one parked task.
   */
  it("does not strand the run when the spine parks", () => {
    const tasks = [d({ id: "charge", skeleton: true, state: "NEEDS_HUMAN" }), d({ id: "docs" })];
    expect(nextDispatch(tasks, new Set())!.id).toBe("docs");
  });

  /**
   * The spine can depend on work the planner did not mark — the schema it
   * writes through, the client it calls — and holding those back would leave
   * nothing runnable at all, which the scheduler reads as a plan whose every
   * remaining task is unreachable.
   */
  it("lets through what the spine is waiting on, and nothing else", () => {
    const tasks = [d({ id: "schema" }), d({ id: "charge", skeleton: true, dependsOn: ["schema"] }), d({ id: "docs" })];
    expect(nextDispatch(tasks, new Set())!.id).toBe("schema");
    // Only that: the docs still wait, even with a free slot and the spine's
    // own blocker already in flight.
    expect(nextDispatch(tasks, new Set(["schema"]))).toBeUndefined();
  });

  it("follows the chain of blockers rather than only the first hop", () => {
    const tasks = [
      d({ id: "migrations" }),
      d({ id: "schema", dependsOn: ["migrations"] }),
      d({ id: "charge", skeleton: true, dependsOn: ["schema"] }),
      d({ id: "docs" }),
    ];
    expect(nextDispatch(tasks, new Set())!.id).toBe("migrations");
  });

  it("does not hold a slot for a blocker that already merged", () => {
    const tasks = [d({ id: "schema", state: "MERGED" }), d({ id: "charge", skeleton: true, dependsOn: ["schema"] }), d({ id: "docs" })];
    expect(nextDispatch(tasks, new Set())!.id).toBe("charge");
  });

  it("orders the spine among itself by leverage, exactly as everything else is ordered", () => {
    const tasks = [
      d({ id: "receipt", skeleton: true }),
      d({ id: "schema", skeleton: true }),
      d({ id: "charge", skeleton: true, dependsOn: ["schema"] }),
    ];
    expect(nextDispatch(tasks, new Set())!.id).toBe("schema");
  });

  it("behaves exactly as it always did for a plan that marked nothing", () => {
    const tasks = [d({ id: "docs" }), d({ id: "schema" }), d({ id: "charge", dependsOn: ["schema"] })];
    expect(nextDispatch(tasks, new Set())!.id).toBe("schema");
  });
});
