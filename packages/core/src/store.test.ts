import { describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import { Bus } from "./bus.js";
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

describe("live event delivery", () => {
  it("emits state transitions to subscribers, not only to the events table", () => {
    // Transitions go straight through the store rather than through Bus.publish.
    // Until the store notified listeners, nothing live ever saw a state change:
    // no `▶ state` lines in the terminal, no dashboard update between polls.
    const store = makeStore();
    const seen: string[] = [];
    const bus = new Bus(store);
    bus.subscribe(({ event }) => seen.push(event.type));
    makeRun(store);
    store.transitionRun("run1", "PLANNING");
    expect(seen).toEqual(["run.created", "run.state_changed"]);
  });

  it("delivers a seq that matches the persisted row, so an SSE cursor is not skewed", () => {
    const store = makeStore();
    const bus = new Bus(store);
    const seqs: number[] = [];
    bus.subscribe(({ seq }) => seqs.push(seq));
    makeRun(store);
    store.transitionRun("run1", "PLANNING");
    expect(seqs).toEqual(store.eventsSince("run1", 0, 10).map((e) => e.seq));
  });

  it("does not let a throwing subscriber roll back the transition it is reporting", () => {
    const store = makeStore();
    const bus = new Bus(store);
    bus.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    makeRun(store);
    expect(() => store.transitionRun("run1", "PLANNING")).not.toThrow();
    expect(store.getRun("run1")!.state).toBe("PLANNING");
  });

  it("drops a finished run from the dashboard's list but keeps one still verifying", () => {
    // The dashboard drives itself from listOpenRuns, so "open" has to mean "still
    // wants the operator". VERIFYING does — a red deploy or a production that
    // disagrees is waiting on them. DONE does not: it shipped, and a run that
    // never leaves the board buries the ones that still need something.
    const store = makeStore();
    const seed = (id: string, state: string) =>
      store.db
        .prepare("INSERT INTO runs (id, repoPath, assignment, state, integrationBranch, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, "/tmp/repo", "a", state, `harness/${id}/main`, JSON.stringify(RunConfig.parse({})), 0, 0);
    for (const [id, state] of [["r-exec", "EXECUTING"], ["r-verify", "VERIFYING"], ["r-done", "DONE"], ["r-pr", "PR_REVIEW"], ["r-abort", "ABORTED"]]) {
      seed(id!, state!);
    }
    expect(store.listOpenRuns().map((r) => r.id).sort()).toEqual(["r-exec", "r-verify"]);
    // …and none of them are lost: `harness status --all` still reaches every one.
    expect(store.listRuns()).toHaveLength(5);
  });

  it("backfills config fields that did not exist when the run was recorded", () => {
    // Every long-lived run carries a config frozen at `harness run` time, and a
    // resume reads it back months and several releases later. A field added
    // since then must arrive as its default, not as undefined: `qaMaxTurns`
    // reaches arithmetic (the retry raises it), where undefined becomes NaN and
    // hands the SDK a nonsense turn ceiling instead of a low one.
    const store = makeStore();
    const legacy = RunConfig.parse({}) as Record<string, unknown>;
    delete legacy.qaMaxTurns;
    delete legacy.prodUrl;
    delete legacy.waitForChecks;
    store.db
      .prepare("INSERT INTO runs (id, repoPath, assignment, state, integrationBranch, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)")
      .run("old", "/tmp/repo", "a", "CREATED", "harness/old/main", JSON.stringify(legacy), 0, 0);

    const config = store.getRun("old")!.config;
    expect(config.qaMaxTurns).toBe(90);
    expect(Number.isFinite(Math.round(config.qaMaxTurns * 1.5))).toBe(true);
    expect(config.prodUrl).toBe("");
    expect(config.waitForChecks).toBe(true);
  });

  it("raises a cap in place without disturbing the rest of the run config", () => {
    const store = makeStore();
    makeRun(store);
    const before = store.getRun("run1")!.config;
    store.setRunBudget("run1", { runCapUsd: 99, taskCapUsd: before.budget.taskCapUsd });
    const after = store.getRun("run1")!.config;
    expect(after.budget.runCapUsd).toBe(99);
    expect({ ...after, budget: undefined }).toEqual({ ...before, budget: undefined });
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
