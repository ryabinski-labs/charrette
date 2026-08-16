import { describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import { Store } from "./store.js";

/**
 * `taskGate.autoAnswerRounds` bounds a skill answering its own escalation in a
 * circle. The count that bound reads used to be over the task's whole life, so
 * two auto-answers retired the decider from that task permanently: every later
 * escalation went to the operator for the rest of the run, however unrelated,
 * and `taskGate.decidedBy` became a no-op task by task with nothing saying so.
 *
 * It is a streak. An operator answer ends it, because that answer *is* the
 * circle being broken by a person.
 */

function store(): Store {
  const s = new Store(":memory:");
  s.createRun({
    id: "run1",
    repoPath: "/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run1",
    config: RunConfig.parse({}),
  });
  return s;
}

const resolved = (s: Store, over: Partial<{ taskId: string; parked: boolean; guidance: string; decidedBy: string }>) =>
  s.appendEvent({
    type: "task.gate_resolved",
    runId: "run1",
    taskId: "task-a",
    parked: false,
    guidance: "do it this way",
    decidedBy: "product-manager",
    ts: 1,
    ...over,
  });

describe("taskGateAutoAnswers", () => {
  it("is zero for a task no gate has ever resolved", () => {
    expect(store().taskGateAutoAnswers("run1", "task-a")).toBe(0);
  });

  it("counts consecutive answers by a skill", () => {
    const s = store();
    resolved(s, {});
    resolved(s, {});
    expect(s.taskGateAutoAnswers("run1", "task-a")).toBe(2);
  });

  it("starts over once a person has answered", () => {
    const s = store();
    resolved(s, {});
    resolved(s, {});
    // The escalation the operator took because the decider was out of rounds.
    resolved(s, { decidedBy: "operator" });
    expect(s.taskGateAutoAnswers("run1", "task-a")).toBe(0);
    // ...and the decider is eligible again for whatever goes wrong next.
    resolved(s, {});
    expect(s.taskGateAutoAnswers("run1", "task-a")).toBe(1);
  });

  it("treats an unnamed decider as the operator, the way the old rows read back", () => {
    const s = store();
    resolved(s, {});
    resolved(s, { decidedBy: "" });
    expect(s.taskGateAutoAnswers("run1", "task-a")).toBe(0);
  });

  it("does not let a park reset the streak — nobody decided anything to go on with", () => {
    const s = store();
    resolved(s, {});
    resolved(s, { parked: true, guidance: "", decidedBy: "operator" });
    resolved(s, {});
    expect(s.taskGateAutoAnswers("run1", "task-a")).toBe(2);
  });

  it("counts each task separately", () => {
    const s = store();
    resolved(s, {});
    resolved(s, {});
    resolved(s, { taskId: "task-b" });
    expect(s.taskGateAutoAnswers("run1", "task-a")).toBe(2);
    expect(s.taskGateAutoAnswers("run1", "task-b")).toBe(1);
  });
});
