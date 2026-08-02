import type { TaskState } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { leverage, nextDispatch, type Dispatchable } from "./dispatchOrder.js";

const t = (id: string, state: TaskState, dependsOn: string[] = []): Dispatchable => ({ id, state, dependsOn });
const none = new Set<string>();

/**
 * Dispatch order is only ever visible when a run does not finish. While the
 * budget holds, every task starts eventually and the order is a detail; when
 * the cap lands mid-run, the order *is* the decision about what got built. So
 * these tests are written against the shape that produced the bug: run
 * 40da9337, 70% of its cap spent, three runnable leaves in front of the two
 * tasks gating everything else.
 */
describe("what the scheduler starts next", () => {
  it("counts the work a task is standing in front of, through the chain", () => {
    const tasks = [
      t("returns", "PENDING"),
      t("ops-console", "PENDING", ["returns"]),
      t("cost-report", "PENDING", ["returns"]),
      t("audit", "PENDING", ["ops-console"]),
      t("docs", "PENDING"),
    ];
    // Two direct dependents, three tasks actually released.
    expect(leverage(tasks, "returns")).toBe(3);
    expect(leverage(tasks, "ops-console")).toBe(1);
    expect(leverage(tasks, "docs")).toBe(0);
  });

  it("does not count dependents that are parked or cancelled", () => {
    // Clearing the path to a task nobody will build is not leverage, and
    // ranking it as such spends the tail of the budget on a dead branch.
    const tasks = [t("gate", "PENDING"), t("parked", "NEEDS_HUMAN", ["gate"]), t("dropped", "CANCELLED", ["gate"])];
    expect(leverage(tasks, "gate")).toBe(0);
  });

  it("starts the task that unblocks the most, not the one the planner listed first", () => {
    const tasks = [
      t("docs", "PENDING"), // listed first, blocks nothing
      t("dashboard", "PENDING"),
      t("returns", "PENDING"),
      t("ops-console", "PENDING", ["returns"]),
      t("cost-report", "PENDING", ["returns"]),
    ];
    expect(nextDispatch(tasks, none)!.id).toBe("returns");
  });

  it("keeps the planner's order between tasks that unblock the same amount", () => {
    const tasks = [t("first", "PENDING"), t("second", "PENDING"), t("third", "PENDING")];
    expect(nextDispatch(tasks, none)!.id).toBe("first");
  });

  it("takes a READY task first however little it unblocks", () => {
    // READY means an operator revived it or a dead process left it mid-flight.
    // Both want it picked up now rather than ranked against the plan.
    const tasks = [t("revived", "READY"), t("returns", "PENDING"), t("ops-console", "PENDING", ["returns"])];
    expect(nextDispatch(tasks, none)!.id).toBe("revived");
  });

  it("will not start a task whose dependencies have not merged", () => {
    const tasks = [t("dependent", "PENDING", ["blocker"]), t("blocker", "WORKING")];
    expect(nextDispatch(tasks, none)).toBeUndefined();
  });

  it("skips what is already in flight and returns nothing when the graph is exhausted", () => {
    const tasks = [t("returns", "PENDING"), t("docs", "PENDING")];
    expect(nextDispatch(tasks, new Set(["returns"]))!.id).toBe("docs");
    expect(nextDispatch(tasks, new Set(["returns", "docs"]))).toBeUndefined();
  });

  it("releases dependents as their blockers merge", () => {
    const tasks = [t("blocker", "MERGED"), t("dependent", "PENDING", ["blocker"])];
    expect(nextDispatch(tasks, none)!.id).toBe("dependent");
  });

  it("terminates on a cyclic graph instead of hanging the run", () => {
    // The plan DAG is validated before it reaches here, so this cannot happen
    // through the planner — but a scheduler that spins forever on bad data
    // takes the whole run with it, and the guard costs one Set.
    const tasks = [t("a", "PENDING", ["b"]), t("b", "PENDING", ["a"])];
    expect(leverage(tasks, "a")).toBe(1);
    expect(nextDispatch(tasks, none)).toBeUndefined();
  });
});
