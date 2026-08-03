import { describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import { Store } from "./store.js";

/**
 * The pit stop trigger keeps no state of its own: everything it remembers is
 * read back out of the event log, which is what makes a resumed run pick its
 * cadence up where the last process left it.
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

const opened = (s: Store, over: Partial<{ stop: number; epicIds: string[]; mergedCount: number; spentUsd: number; ts: number }>) =>
  s.appendEvent({
    type: "run.pitstop_opened",
    runId: "run1",
    stop: over.stop ?? 1,
    reason: "an epic finished",
    epicIds: over.epicIds ?? [],
    mergedCount: over.mergedCount ?? 0,
    spentUsd: over.spentUsd ?? 0,
    artifactsDir: "/repo/.harness/run1/pitstops/1",
    demoStarted: true,
    ts: over.ts ?? 5_000,
  });

describe("listEpics", () => {
  it("returns them in plan order, not insertion order", () => {
    const s = store();
    s.insertTasks("run1", [{ id: "epic-b", title: "Second" }, { id: "epic-a", title: "First" }], []);

    expect(s.listEpics("run1")).toEqual([
      { id: "epic-b", title: "Second" },
      { id: "epic-a", title: "First" },
    ]);
  });
});

describe("mergedTaskIds", () => {
  it("lists what landed, in the order it landed", () => {
    const s = store();
    for (const taskId of ["task-b", "task-a"]) {
      s.appendEvent({ type: "git.merged", runId: "run1", taskId, branch: `harness/${taskId}`, sha: "abc", ts: 1 });
    }

    expect(s.mergedTaskIds("run1")).toEqual(["task-b", "task-a"]);
  });

  it("is empty for a run that has merged nothing", () => {
    expect(store().mergedTaskIds("run1")).toEqual([]);
  });
});

describe("pitStopHistory", () => {
  it("measures from the run's start until the first stop happens", () => {
    expect(store().pitStopHistory("run1", 1_234)).toEqual({
      count: 0,
      demoedEpics: [],
      mergedAt: 0,
      spentAt: 0,
      atMs: 1_234,
    });
  });

  it("accumulates every demoed epic but keeps only the latest counters", () => {
    const s = store();
    opened(s, { stop: 1, epicIds: ["epic-a"], mergedCount: 3, spentUsd: 20, ts: 5_000 });
    opened(s, { stop: 2, epicIds: ["epic-b"], mergedCount: 7, spentUsd: 55, ts: 9_000 });

    // The epics are cumulative — an epic demoed at stop 1 must not be demoed
    // again at stop 5 — while the counters are a watermark, so a `{tasks: 3}`
    // interval counts from the last stop rather than from the run's start.
    expect(s.pitStopHistory("run1", 1_234)).toEqual({
      count: 2,
      demoedEpics: ["epic-a", "epic-b"],
      mergedAt: 7,
      spentAt: 55,
      atMs: 9_000,
    });
  });
});
