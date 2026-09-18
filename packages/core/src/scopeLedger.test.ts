import { describe, expect, it } from "vitest";
import { RunSpec, type TaskState } from "@charrette/shared";
import { replanDrops, scopeLedger, scopeUnmet, type ScopedTask } from "./scopeLedger.js";

/**
 * What became of the promises the brief made.
 *
 * rust-service cancelled 177 tasks against 377 merged — 138 replaced at a re-plan, 47
 * dead as `unreachable: dependencies parked`, 35 superseded. Every one of those
 * transitions is legitimate and none of them left anything behind: the
 * requirement stopped existing and came back as a section in a 118 KB gaps
 * file (issue #120). These cases are about the difference between a decision
 * and an omission.
 */

const spec = (over: Record<string, unknown> = {}) =>
  RunSpec.parse({
    feature: "checkout",
    requirements: [
      { id: "REQ-1", text: "take payment", priority: "P0" },
      { id: "REQ-2", text: "email a receipt", priority: "P1" },
      { id: "REQ-3", text: "a nicer button", priority: "P3" },
    ],
    scenarios: [
      { id: "SC-1", requirement: "REQ-1", priority: "P0", level: "unit", oracle: "o" },
      { id: "SC-2", requirement: "REQ-2", priority: "P1", level: "unit", oracle: "o" },
      { id: "SC-3", requirement: "REQ-3", priority: "P3", level: "unit", oracle: "o" },
    ],
    ...over,
  });

const task = (id: string, state: TaskState, scenarioIds: string[], why = ""): ScopedTask => ({ id, title: id, state, scenarioIds, why });
const statuses = (l: ReturnType<typeof scopeLedger>) => Object.fromEntries(l.entries.map((e) => [e.id, e.status]));

describe("reconciling requirements rather than tasks", () => {
  it("calls a requirement shipped when a task that claimed it merged", () => {
    const l = scopeLedger(spec(), [task("a", "MERGED", ["SC-1"])]);
    expect(statuses(l)).toMatchObject({ "REQ-1": "shipped" });
    expect(l.shipped).toBe(1);
  });

  /**
   * Shipped is not proven. `specCoverage` asks whether the scenario passed;
   * this asks whether anyone ever delivered the work, and a run can ship a
   * requirement whose scenario is red.
   */
  it("counts a requirement whose only task is still being built as shipping, not as lost", () => {
    expect(statuses(scopeLedger(spec(), [task("a", "WORKING", ["SC-1"])]))).toMatchObject({ "REQ-1": "in-progress" });
  });

  it("calls it dropped when every task that claimed it was cancelled or parked", () => {
    const l = scopeLedger(spec(), [
      task("a", "CANCELLED", ["SC-1"], "unreachable: dependencies parked"),
      task("b", "NEEDS_HUMAN", ["SC-2"], "crashed"),
    ]);
    expect(statuses(l)).toMatchObject({ "REQ-1": "dropped", "REQ-2": "dropped" });
    expect(l.dropped.map((e) => e.id)).toEqual(["REQ-1", "REQ-2"]);
    expect(l.dropped[0]!.claimants).toEqual([{ id: "a", title: "a", state: "CANCELLED", why: "unreachable: dependencies parked" }]);
  });

  it("calls it written off once an answer is on the record, and keeps the answer", () => {
    const l = scopeLedger(spec(), [task("a", "CANCELLED", ["SC-1"])], [{ requirementId: "REQ-1", answer: "ship without it", decidedBy: "operator" }]);
    expect(statuses(l)).toMatchObject({ "REQ-1": "written-off" });
    expect(l.writtenOff).toBe(1);
    expect(l.dropped).toEqual([]);
    expect(l.entries.find((e) => e.id === "REQ-1")!.answer).toBe("ship without it");
  });

  it("calls a requirement no task ever claimed unclaimed, which is a different failure", () => {
    const l = scopeLedger(spec(), [task("a", "MERGED", ["SC-1"])]);
    expect(l.unclaimed.map((e) => e.id)).toEqual(["REQ-2", "REQ-3"]);
  });

  /**
   * An answer settles a requirement whichever way it was lost. Both buckets are
   * put to the operator at the closing stop, and one that could be accepted but
   * never recorded would hold the run for ever however many times it was
   * answered.
   */
  it("writes off a requirement nobody ever claimed, once somebody answers for it", () => {
    const l = scopeLedger(spec(), [task("a", "MERGED", ["SC-1"])], [{ requirementId: "REQ-2", answer: "next run", decidedBy: "operator" }]);
    expect(statuses(l)).toMatchObject({ "REQ-2": "written-off", "REQ-3": "unclaimed" });
    expect(l.unclaimed.map((e) => e.id)).toEqual(["REQ-3"]);
  });

  it("counts a task claiming three scenarios of one requirement once", () => {
    const s = spec({
      scenarios: [
        { id: "SC-1", requirement: "REQ-1", priority: "P0", level: "unit", oracle: "o" },
        { id: "SC-1b", requirement: "REQ-1", priority: "P0", level: "unit", oracle: "o" },
      ],
    });
    const l = scopeLedger(s, [task("a", "CANCELLED", ["SC-1", "SC-1b"])]);
    expect(l.dropped[0]!.claimants).toHaveLength(1);
  });

  it("ignores a scenario id the specification does not declare", () => {
    expect(scopeLedger(spec(), [task("a", "MERGED", ["SC-nope"])]).shipped).toBe(0);
  });

  it("has an empty ledger for a specification with no requirements", () => {
    const l = scopeLedger(RunSpec.parse({ feature: "f" }), [task("a", "MERGED", [])]);
    expect(l).toMatchObject({ entries: [], shipped: 0, writtenOff: 0, dropped: [], unclaimed: [] });
  });
});

describe("what the closing gate says about scope", () => {
  it("holds a run over a requirement that was dropped without a decision", () => {
    const [line] = scopeUnmet(scopeLedger(spec(), [task("a", "CANCELLED", ["SC-1"])]));
    expect(line).toContain("1 requirement(s) the brief named were dropped without a decision");
    expect(line).toContain("REQ-1 (take payment)");
    expect(line).toContain("nobody was asked whether that was acceptable");
  });

  it("holds a run over a requirement no task ever claimed", () => {
    const lines = scopeUnmet(scopeLedger(spec(), [task("a", "MERGED", ["SC-1"])]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("never claimed by any task");
    expect(lines[0]).toContain("REQ-2");
    // The nice-to-have is reported in the completion report and never blocks.
    expect(lines[0]).not.toContain("REQ-3");
  });

  it("says nothing once every gating requirement shipped or was written off", () => {
    const l = scopeLedger(
      spec(),
      [task("a", "MERGED", ["SC-1"]), task("b", "CANCELLED", ["SC-2"]), task("c", "CANCELLED", ["SC-3"])],
      [{ requirementId: "REQ-2", answer: "next run", decidedBy: "operator" }]
    );
    expect(scopeUnmet(l)).toEqual([]);
  });

  it("caps the unclaimed list the same way", () => {
    const many = RunSpec.parse({
      feature: "f",
      requirements: Array.from({ length: 6 }, (_, i) => ({ id: `REQ-${i + 1}`, text: `thing ${i + 1}`, priority: "P0" })),
      scenarios: [],
    });
    expect(scopeUnmet(scopeLedger(many, []))[0]).toContain("+2 more");
  });

  it("names the worst few and says how many it left out", () => {
    const many = RunSpec.parse({
      feature: "f",
      requirements: Array.from({ length: 6 }, (_, i) => ({ id: `REQ-${i + 1}`, text: `thing ${i + 1}`, priority: "P0" })),
      scenarios: Array.from({ length: 6 }, (_, i) => ({ id: `SC-${i + 1}`, requirement: `REQ-${i + 1}`, priority: "P0", level: "unit", oracle: "o" })),
    });
    const tasks = Array.from({ length: 6 }, (_, i) => task(`t${i}`, "CANCELLED", [`SC-${i + 1}`]));
    expect(scopeUnmet(scopeLedger(many, tasks))[0]).toContain("+2 more");
  });
});

describe("what a re-plan would stop building", () => {
  const before = [task("pay", "PENDING", ["SC-1"]), task("receipt", "PENDING", ["SC-2"]), task("shipped", "MERGED", ["SC-3"])];

  it("names a gating requirement the proposed plan no longer covers", () => {
    const lost = replanDrops(spec(), before, [{ id: "pay", scenarioIds: ["SC-1"] }]);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("REQ-2 (email a receipt)");
    expect(lost[0]).toContain("the plan that stands has a task for it and the re-plan does not");
  });

  it("says nothing about work that already merged", () => {
    // REQ-3 is delivered; a re-plan that does not mention it drops nothing.
    expect(replanDrops(spec(), before, [{ id: "pay", scenarioIds: ["SC-1"] }, { id: "receipt", scenarioIds: ["SC-2"] }])).toEqual([]);
  });

  it("says nothing when the re-plan covers everything the live plan did", () => {
    expect(replanDrops(spec(), before, [{ id: "new", scenarioIds: ["SC-1", "SC-2"] }])).toEqual([]);
  });

  it("does not report a nice-to-have as lost coverage", () => {
    const live = [task("nice", "PENDING", ["SC-3"])];
    expect(replanDrops(spec(), live, [])).toEqual([]);
  });
});
