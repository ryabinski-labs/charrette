import type { TaskState } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { leverage, nextDispatch, pathsCollide, type Dispatchable } from "./dispatchOrder.js";

const t = (id: string, state: TaskState, dependsOn: string[] = [], touchedPaths: string[] = []): Dispatchable => ({ id, state, dependsOn, touchedPaths });
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

/**
 * 23 merge conflicts across 36 tasks in run 40da9337, each one two workers who
 * branched from the same commit and edited the same file. The planner had said
 * which files each task would touch since the first version of the charrette; the
 * scheduler had never read it.
 */
describe("two tasks reaching for the same file", () => {
  it("holds one back while the other is in flight", () => {
    const tasks = [t("api", "WORKING", [], ["src/api/orders.ts"]), t("also-api", "PENDING", [], ["src/api/orders.ts"])];

    expect(nextDispatch(tasks, new Set(["api"]))).toBeUndefined();
  });

  it("starts it the moment the other one is out of flight", () => {
    const tasks = [t("api", "MERGED", [], ["src/api/orders.ts"]), t("also-api", "PENDING", [], ["src/api/orders.ts"])];

    expect(nextDispatch(tasks, none)!.id).toBe("also-api");
  });

  it("passes over the collision and dispatches something else that can run", () => {
    const tasks = [
      t("api", "WORKING", [], ["src/api"]),
      t("also-api", "PENDING", [], ["src/api/orders.ts"]),
      t("docs", "PENDING", [], ["README.md"]),
    ];

    expect(nextDispatch(tasks, new Set(["api"]))!.id).toBe("docs");
  });

  it("does not hold back a task the planner said nothing about", () => {
    // Empty paths are an absence of information, not a claim of independence.
    // Treating them as a collision would serialize every plan that omits them.
    const tasks = [t("api", "WORKING", [], ["src/api/orders.ts"]), t("unknown", "PENDING", [], [])];

    expect(nextDispatch(tasks, new Set(["api"]))!.id).toBe("unknown");
  });

  it("holds them apart on a file neither task named, when the repo always ships it alongside", () => {
    // The measured gap: the planner names four or five files out of a dozen, so
    // the two tasks below look independent and are not. `src/api.test.ts` is
    // what this repository has always committed with `src/api/orders.ts`.
    const tasks = [t("api", "WORKING", [], ["src/api/orders.ts"]), t("tests", "PENDING", [], ["src/api.test.ts"])];
    const nearby = (paths: string[]) => (paths.includes("src/api/orders.ts") ? ["src/api.test.ts"] : []);

    expect(nextDispatch(tasks, new Set(["api"]))!.id).toBe("tests");
    expect(nextDispatch(tasks, new Set(["api"]), nearby)).toBeUndefined();
  });

  it("widens the task waiting as well as the one in flight", () => {
    // The shared file may be the one neither named; whichever side history
    // attaches it to, the pair has to be held apart.
    const tasks = [t("api", "WORKING", [], ["src/api/orders.ts"]), t("tests", "PENDING", [], ["src/checkout.ts"])];
    const nearby = (paths: string[]) => (paths.includes("src/checkout.ts") ? ["src/api/orders.ts"] : []);

    expect(nextDispatch(tasks, new Set(["api"]), nearby)).toBeUndefined();
  });

  it("still dispatches a task history has nothing to say about", () => {
    const tasks = [
      t("api", "WORKING", [], ["src/api/orders.ts"]),
      t("tests", "PENDING", [], ["src/api.test.ts"]),
      t("docs", "PENDING", [], ["README.md"]),
    ];
    const nearby = (paths: string[]) => (paths.includes("src/api/orders.ts") ? ["src/api.test.ts"] : []);

    expect(nextDispatch(tasks, new Set(["api"]), nearby)!.id).toBe("docs");
  });

  it("behaves exactly as before when it is given no history", () => {
    // Every other test in this file passes no `nearby`, which is the point: a
    // repository with no usable history gets the scheduler it had.
    const tasks = [t("api", "WORKING", [], ["src/api/orders.ts"]), t("tests", "PENDING", [], ["src/api.test.ts"])];

    expect(nextDispatch(tasks, new Set(["api"]), () => [])!.id).toBe("tests");
  });

  it("counts a directory as containing the files under it", () => {
    expect(pathsCollide(["src/api"], ["src/api/orders.ts"])).toBe(true);
    expect(pathsCollide(["src/api/orders.ts"], ["src/api"])).toBe(true);
  });

  it("does not mistake a shared prefix for a shared directory", () => {
    // `src/apiary.ts` starts with `src/api` and has nothing to do with it.
    expect(pathsCollide(["src/api"], ["src/apiary.ts"])).toBe(false);
  });

  it("reads the spellings of one path as one path", () => {
    expect(pathsCollide(["./src/api/"], ["src/api"])).toBe(true);
  });

  it("ignores blank entries rather than colliding everything with them", () => {
    expect(pathsCollide([""], ["src/api"])).toBe(false);
    expect(pathsCollide([], ["src/api"])).toBe(false);
  });
});
