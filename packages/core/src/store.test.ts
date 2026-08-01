import { describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import { InvalidTransition, Store } from "./store.js";
import { costUsd } from "./budget.js";

function makeStore(): Store {
  return new Store(":memory:");
}

function makeRun(store: Store, id = "run1"): void {
  store.createRun({
    id,
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: `harness/${id}/main`,
    config: RunConfig.parse({}),
  });
}

describe("Store run lifecycle", () => {
  it("creates and transitions a run through legal states", () => {
    const store = makeStore();
    makeRun(store);
    store.transitionRun("run1", "PLANNING");
    store.transitionRun("run1", "PLAN_REVIEW");
    store.transitionRun("run1", "EXECUTING");
    expect(store.getRun("run1")!.state).toBe("EXECUTING");
  });

  it("rejects illegal transitions", () => {
    const store = makeStore();
    makeRun(store);
    expect(() => store.transitionRun("run1", "EXECUTING")).toThrow(InvalidTransition);
  });

  it("event log records every transition with monotonic seq", () => {
    const store = makeStore();
    makeRun(store);
    store.transitionRun("run1", "PLANNING");
    const events = store.eventsSince("run1", 0);
    expect(events.map((e) => e.event.type)).toEqual(["run.created", "run.state_changed"]);
    expect(events[1]!.seq).toBeGreaterThan(events[0]!.seq);
  });

  it("task transitions enforce the sub-machine and QA loop path", () => {
    const store = makeStore();
    makeRun(store);
    store.insertTasks(
      "run1",
      [{ id: "e1", title: "Epic" }],
      [{
        id: "a", epicId: "e1", title: "A", spec: "s", acceptanceCriteria: ["ok"], dependsOn: [],
        state: "PENDING", branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null,
        qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null,
      }]
    );
    store.transitionTask("run1", "a", "READY");
    store.transitionTask("run1", "a", "WORKING");
    store.transitionTask("run1", "a", "QA");
    store.transitionTask("run1", "a", "QA_FAILED");
    store.transitionTask("run1", "a", "WORKING");
    store.transitionTask("run1", "a", "QA");
    store.transitionTask("run1", "a", "ACCEPTED");
    store.transitionTask("run1", "a", "MERGED");
    expect(() => store.transitionTask("run1", "a", "WORKING")).toThrow(InvalidTransition);
  });

  it("ledger sums drive budget checks", () => {
    const store = makeStore();
    makeRun(store);
    store.recordUsage({ runId: "run1", taskId: "a", sessionId: "s1", model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5 });
    store.recordUsage({ runId: "run1", sessionId: "s2", model: "claude-opus-5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2.5 });
    expect(store.spentUsd("run1")).toBeCloseTo(4.0);
    expect(store.spentUsd("run1", "a")).toBeCloseTo(1.5);
  });
});

describe("costUsd", () => {
  it("prices sonnet with cache discounts", () => {
    const cost = costUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(3 + 0.3);
  });

  it("prices unknown models at the top tier, never under", () => {
    const cost = costUsd("mystery-model", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(5);
  });
});
