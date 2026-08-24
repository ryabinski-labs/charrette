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

const opened = (
  s: Store,
  over: Partial<{
    stop: number;
    epicIds: string[];
    mergedCount: number;
    spentUsd: number;
    ts: number;
    summoned: boolean;
    askedAt: number;
  }>
) =>
  s.appendEvent({
    type: "run.pitstop_opened",
    runId: "run1",
    stop: over.stop ?? 1,
    reason: over.summoned ? "you asked for a look at the product" : "an epic finished",
    epicIds: over.epicIds ?? [],
    mergedCount: over.mergedCount ?? 0,
    spentUsd: over.spentUsd ?? 0,
    artifactsDir: "/repo/.harness/run1/pitstops/1",
    demoStarted: true,
    summoned: over.summoned ?? false,
    askedAt: over.askedAt ?? 0,
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

  /**
   * The bug this guards is silent and only shows up an hour later: an operator
   * asks a question at minute 40 of a `{minutes: 90}` run, and the automatic pit
   * stop they configured slides to minute 130 with nothing anywhere saying so.
   */
  it("does not let a stop the operator asked for move the cadence's marks", () => {
    const s = store();
    opened(s, { stop: 1, epicIds: ["epic-a"], mergedCount: 3, spentUsd: 20, ts: 5_000 });
    opened(s, { stop: 2, mergedCount: 9, spentUsd: 90, ts: 9_000, summoned: true });

    const h = s.pitStopHistory("run1", 1_234);
    // Every mark the interval triggers measure from still reads the automatic
    // stop…
    expect(h).toMatchObject({ demoedEpics: ["epic-a"], mergedAt: 3, spentAt: 20, atMs: 5_000 });
    // …but the summoned one is still a stop that happened: the count numbers the
    // artifact directories and bounds the container sweep, and one missing from
    // it is a compose stack left holding ports.
    expect(h.count).toBe(2);
  });
});

describe("pendingPitStopRequest", () => {
  const asked = (s: Store, question: string) => s.appendEvent({ type: "run.pitstop_requested", runId: "run1", question, ts: 1 });

  it("is null until somebody asks", () => {
    expect(store().pendingPitStopRequest("run1")).toBeNull();
  });

  it("returns what the operator typed", () => {
    const s = store();
    asked(s, "is the checkout still broken?");
    expect(s.pendingPitStopRequest("run1")).toMatchObject({ question: "is the checkout still broken?" });
  });

  /**
   * Asking twice must not buy two demos. An operator who clicks again because
   * nothing visibly happened is correcting their question, not queueing a
   * second stop, and the bill has to agree with them.
   */
  it("keeps only the latest question when asked twice", () => {
    const s = store();
    asked(s, "first");
    asked(s, "second");
    expect(s.pendingPitStopRequest("run1")).toMatchObject({ question: "second" });
  });

  it("is cleared by the stop that answers it", () => {
    const s = store();
    asked(s, "why is there no login page?");
    opened(s, { stop: 1, summoned: true });
    expect(s.pendingPitStopRequest("run1")).toBeNull();
  });

  it("is cleared by the operator calling it off", () => {
    const s = store();
    asked(s, "never mind");
    s.appendEvent({ type: "run.pitstop_cancelled", runId: "run1", question: "never mind", ts: 2 });
    expect(s.pendingPitStopRequest("run1")).toBeNull();
  });

  it("comes back when they ask again after a stop", () => {
    const s = store();
    asked(s, "first");
    opened(s, { stop: 1, summoned: true });
    asked(s, "and another thing");
    expect(s.pendingPitStopRequest("run1")).toMatchObject({ question: "and another thing" });
  });

  /**
   * The stop that opens is not always the stop that was asked for.
   *
   * A pit stop is picked up, runs a demo and every reviewer lens, and publishes
   * `run.pitstop_opened` ten or twenty minutes later. A cadence stop already in
   * that window when the operator asks a question used to swallow the request on
   * the way past: the stop carried the epic's framing, asked nothing about what
   * the operator typed, and left `pendingPitStopRequest` null so no later stop
   * would ask it either. Nothing in the run said the question had been dropped.
   *
   * Run bc691359: seq 69990 asked at 05:11:38 why nothing owned bench.yml, seq
   * 70000 opened the config-canon cadence stop at 05:23:36, and the question was
   * gone. The two red CI checks it was about had no owner and no channel left.
   */
  it("survives a cadence stop that opened without carrying it", () => {
    const s = store();
    asked(s, "nothing owns bench.yml and two checks stay red");
    opened(s, { stop: 30, epicIds: ["config-canon"], summoned: false, ts: 9_000 });
    expect(s.pendingPitStopRequest("run1")).toMatchObject({
      question: "nothing owns bench.yml and two checks stay red",
    });
  });

  /**
   * The same window, but the stop in flight *was* summoned — by an earlier
   * question. It answers that one and retires that one; the question typed
   * while its demo ran is owed a stop of its own.
   */
  it("survives a summoned stop that was carrying an older question", () => {
    const s = store();
    s.appendEvent({ type: "run.pitstop_requested", runId: "run1", question: "the first thing", ts: 1_000 });
    s.appendEvent({ type: "run.pitstop_requested", runId: "run1", question: "the second thing", ts: 2_000 });
    // Picked up at 1_000 — before the second question existed.
    opened(s, { stop: 2, summoned: true, askedAt: 1_000, ts: 3_000 });
    expect(s.pendingPitStopRequest("run1")).toMatchObject({ question: "the second thing" });
  });

  it("is retired by the summoned stop that was carrying it", () => {
    const s = store();
    s.appendEvent({ type: "run.pitstop_requested", runId: "run1", question: "why no login page?", ts: 1_000 });
    opened(s, { stop: 2, summoned: true, askedAt: 1_000, ts: 3_000 });
    expect(s.pendingPitStopRequest("run1")).toBeNull();
  });
});

describe("lastUnsummonedPitStopSeq", () => {
  it("is zero on a run that has never stopped", () => {
    expect(store().lastUnsummonedPitStopSeq("run1")).toBe(0);
  });

  /**
   * `closingPitStop` skips itself when a stop has already shown the operator the
   * current intent verdict. A summoned stop shows them the answer to their own
   * question, which is a different thing — and letting it count would suppress
   * the one pit stop PITSTOP.md promises unconditionally (S6).
   */
  it("ignores stops the operator asked for", () => {
    const s = store();
    const auto = opened(s, { stop: 1, ts: 5_000 });
    opened(s, { stop: 2, ts: 9_000, summoned: true });
    expect(s.lastUnsummonedPitStopSeq("run1")).toBe(auto);
  });

  it("reads a stop recorded before the field existed as automatic", () => {
    const s = store();
    // Written the way the old code wrote it: no `summoned` key at all.
    s.appendEvent({
      type: "run.pitstop_opened",
      runId: "run1",
      stop: 1,
      reason: "an epic finished",
      epicIds: [],
      mergedCount: 0,
      spentUsd: 0,
      artifactsDir: "",
      demoStarted: true,
      ts: 5_000,
      // Through `unknown` on purpose: the field is required on the current type,
      // and the whole point of this test is a row written before it existed.
    } as unknown as Parameters<Store["appendEvent"]>[0]);
    expect(s.lastUnsummonedPitStopSeq("run1")).toBeGreaterThan(0);
  });
});
