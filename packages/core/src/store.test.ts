import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RunConfig, RunSpec, type TaskState } from "@harness/shared";
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
        qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "M",
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
    store.setRunBudget("run1", { ...before.budget, runCapUsd: 99 });
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
    expect(cost).toBeCloseTo(10);
  });
});

/**
 * `touchedPaths` and `estimatedSize` were emitted by the planner from the first
 * version of the harness and thrown away at the door. The scheduler needs the
 * first to keep two workers out of one file; the plan gate needs the second to
 * tell the operator what a run is likely to cost.
 */
describe("what a task remembers about the plan that made it", () => {
  const task = (id: string, over: Partial<{ touchedPaths: string[]; estimatedSize: "S" | "M" | "L"; state: TaskState }> = {}) => ({
    id, epicId: "e1", title: id, spec: "s", acceptanceCriteria: ["ok"], dependsOn: [],
    state: "PENDING" as TaskState, branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null,
    qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null,
    touchedPaths: [] as string[], completionProbe: "", estimatedSize: "M" as const, ...over,
  });

  it("keeps the files and the size the planner named", () => {
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [task("a", { touchedPaths: ["src/api/orders.ts", "src/db"], estimatedSize: "L" })]);

    const back = store.getTask("run1", "a")!;
    expect(back.touchedPaths).toEqual(["src/api/orders.ts", "src/db"]);
    expect(back.estimatedSize).toBe("L");
  });

  it("adds the columns to a database written before they existed", () => {
    // A run resumed across an upgrade is exactly the run that most needs to
    // resume, and `CREATE TABLE IF NOT EXISTS` would have left it short a column.
    const dir = mkdtempSync(path.join(tmpdir(), "harness-migrate-"));
    const dbPath = path.join(dir, "old.db");
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE tasks (
      id TEXT NOT NULL, runId TEXT NOT NULL, epicId TEXT NOT NULL,
      title TEXT NOT NULL, spec TEXT NOT NULL, acceptanceCriteria TEXT NOT NULL,
      dependsOn TEXT NOT NULL, state TEXT NOT NULL, branch TEXT,
      worktreePath TEXT, githubIssueNumber INTEGER, prNumber INTEGER,
      qaIterations INTEGER NOT NULL DEFAULT 0, respawns INTEGER NOT NULL DEFAULT 0,
      assignedSkills TEXT NOT NULL DEFAULT '[]', errorSummary TEXT,
      PRIMARY KEY (runId, id))`);
    old.exec("INSERT INTO tasks (id, runId, epicId, title, spec, acceptanceCriteria, dependsOn, state) VALUES ('a','run1','e1','A','s','[]','[]','PENDING')");
    old.close();

    const store = new Store(dbPath);

    // The old row survives with defaults; a new one round-trips as normal.
    expect(store.getTask("run1", "a")!.touchedPaths).toEqual([]);
    expect(store.getTask("run1", "a")!.estimatedSize).toBe("M");
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [task("b", { touchedPaths: ["x.ts"] })]);
    expect(store.getTask("run1", "b")!.touchedPaths).toEqual(["x.ts"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("rewriting a task's definition of done", () => {
  const probeTask = (probe: string) => ({
    id: "a", epicId: "e1", title: "A", spec: "s", acceptanceCriteria: ["ok"], dependsOn: [],
    state: "PENDING" as TaskState, branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null,
    qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null,
    touchedPaths: [] as string[], completionProbe: probe, estimatedSize: "M" as const,
  });

  const amendments = (store: Store) =>
    store.eventsSince("run1", 0).map((e) => e.event).filter((e) => e.type === "task.probe_amended");

  it("records who moved the bar and what it moved from", () => {
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [probeTask("test -f nope.txt")]);

    store.amendProbe("run1", "a", "  test -f feature.txt  ", "product-manager", "the probe named the wrong artifact");

    expect(store.getTask("run1", "a")!.completionProbe).toBe("test -f feature.txt");
    expect(amendments(store)).toMatchObject([
      { from: "test -f nope.txt", to: "test -f feature.txt", by: "product-manager", why: "the probe named the wrong artifact" },
    ]);
  });

  it("writes nothing when the new probe is the one already in force", () => {
    // The advisor is asked for a probe on every amendable gate, and the honest
    // answer is often the probe as it stands. That is not a judgment about the
    // work, so it must not reach the event log — a postmortem reading
    // `task.probe_amended` is asking what changed, and `probeAmendments` spends
    // a run's whole amendment allowance on whatever it counts.
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [probeTask("test -f nope.txt")]);

    store.amendProbe("run1", "a", "  test -f nope.txt  ", "product-manager", "still right");

    expect(amendments(store)).toEqual([]);
    expect(store.taskProbeAmendments("run1", "a")).toBe(0);
    expect(store.getTask("run1", "a")!.completionProbe).toBe("test -f nope.txt");
  });

  const criteriaAmendments = (store: Store) =>
    store.eventsSince("run1", 0).map((e) => e.event).filter((e) => e.type === "task.criteria_amended");

  it("records who moved the acceptance criteria and what they were before", () => {
    // The lever `amendProbe` could not pull. Run bc691359's
    // `tier1-three-arm-capture` was judged against a bundle only `terraform
    // apply` could produce, which this harness denies — so a rewritten probe
    // changed nothing, because QA reads the criteria.
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [probeTask("test -f nope.txt")]);

    store.amendCriteria("run1", "a", ["  the deferral is recorded honestly  ", "", " tests/not-run.sh exits 0 "], "operator", "no agent here can run terraform apply");

    expect(store.getTask("run1", "a")!.acceptanceCriteria).toEqual(["the deferral is recorded honestly", "tests/not-run.sh exits 0"]);
    expect(criteriaAmendments(store)).toMatchObject([
      { from: ["ok"], to: ["the deferral is recorded honestly", "tests/not-run.sh exits 0"], by: "operator", why: "no agent here can run terraform apply" },
    ]);
  });

  it("writes nothing when the criteria are the ones already in force", () => {
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [probeTask("test -f nope.txt")]);

    store.amendCriteria("run1", "a", ["  ok  "], "operator");

    expect(criteriaAmendments(store)).toEqual([]);
    expect(store.getTask("run1", "a")!.acceptanceCriteria).toEqual(["ok"]);
  });

  it("refuses to leave a task with no criteria at all", () => {
    // A probe can be withdrawn because QA still judges the task afterwards.
    // Withdrawing the criteria leaves QA nothing to judge it by, and a task
    // that cannot be failed is not a task that has been done.
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [probeTask("test -f nope.txt")]);

    expect(() => store.amendCriteria("run1", "a", ["   ", ""], "operator")).toThrow(/at least one/);
    expect(store.getTask("run1", "a")!.acceptanceCriteria).toEqual(["ok"]);
  });

  it("counts how many times a task has stopped for its gate, whoever answered", () => {
    // The one number no other counter keeps: answering a gate resets
    // `qaIterations`, and `taskGateAutoAnswers` deliberately skips the rounds a
    // person answered — so on run 1e7d3df3, where the operator answered eleven
    // of fourteen, every existing counter read the fourteenth as the first.
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [probeTask("test -f nope.txt")]);

    expect(store.taskGateOpenings("run1", "a")).toBe(0);

    for (const decidedBy of ["product-manager", "operator", "operator"]) {
      store.appendEvent({ type: "task.gate_opened", runId: "run1", taskId: "a", why: "w", recommendation: "", iterations: 3, ts: 1 });
      store.appendEvent({ type: "task.gate_resolved", runId: "run1", taskId: "a", parked: false, guidance: "g", decidedBy, ts: 2 });
    }

    expect(store.taskGateOpenings("run1", "a")).toBe(3);
    // Which is exactly what the auto-answer bound does not, and must not, count.
    // Zero here, not one: the skill's single answer was followed by two the
    // operator gave, and the bound is on answers in a row — see
    // taskGateStreak.test.ts for why it has to be.
    expect(store.taskGateAutoAnswers("run1", "a")).toBe(0);
    // Scoped to the task that was asked about, not to the run.
    expect(store.taskGateOpenings("run1", "b")).toBe(0);
  });
});

describe("what previous runs in this repository cost", () => {
  const merged = (id: string, size: "S" | "M" | "L") => ({
    id, epicId: "e1", title: id, spec: "s", acceptanceCriteria: ["ok"], dependsOn: [],
    state: "MERGED" as TaskState, branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null,
    qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [] as string[], completionProbe: "", estimatedSize: size,
  });
  const spend = (store: Store, runId: string, usd: number) =>
    store.recordUsage({ runId, sessionId: `s-${runId}-${usd}`, model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: usd });

  it("weighs what merged against what was spent, per run", () => {
    const store = makeStore();
    makeRun(store, "run1");
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [merged("a", "L"), merged("b", "S")]);
    spend(store, "run1", 20);
    spend(store, "run1", 5);

    expect(store.runCosts()).toEqual([{ weight: 5, spentUsd: 25 }]);
  });

  it("leaves out the run being estimated, so it cannot predict itself", () => {
    const store = makeStore();
    makeRun(store, "run1");
    makeRun(store, "run2");
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [merged("a", "M")]);
    store.insertTasks("run2", [{ id: "e1", title: "E" }], [merged("a", "M")]);
    spend(store, "run1", 10);
    spend(store, "run2", 99);

    expect(store.runCosts("run2")).toEqual([{ weight: 2, spentUsd: 10 }]);
  });

  it("counts a run that spent money and merged nothing, so it can be discarded upstream", () => {
    const store = makeStore();
    makeRun(store);
    spend(store, "run1", 40);

    expect(store.runCosts()).toEqual([{ weight: 0, spentUsd: 40 }]);
  });

  it("treats a size it does not recognise as the middle one", () => {
    // Rows written before `estimatedSize` existed default to 'M'; a row edited
    // by hand could be anything, and a NaN weight would poison every estimate.
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [merged("a", "XL" as "L")]);

    expect(store.runCosts()).toEqual([{ weight: 2, spentUsd: 0 }]);
  });
});

describe("the run's specification, read back", () => {
  const runWith = () => {
    const store = new Store(":memory:");
    const bus = new Bus(store);
    store.createRun({
      id: "run-1",
      repoPath: "/tmp/repo",
      assignment: "build it",
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-1/main",
      config: RunConfig.parse({}),
    });
    return { store, bus };
  };

  /**
   * Null is a first-class answer: "no scenario was ever derived" and "a
   * specification exists and proves nothing" are opposite facts.
   */
  it("is null for a run that was never specified", () => {
    const { store } = runWith();
    expect(store.runSpec("run-1")).toBeNull();
    expect(store.acceptanceVerdict("run-1")).toBeNull();
  });

  it("reads back the last specification written", () => {
    const { store, bus } = runWith();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: RunSpec.parse({ feature: "one", scenarios: [{ id: "SC-001" }] }), ts: 1 });
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: RunSpec.parse({ feature: "two", scenarios: [{ id: "SC-002" }] }), ts: 2 });
    expect(store.runSpec("run-1")!.feature).toBe("two");
  });

  /**
   * A row this build cannot read is not a specification. Returning a
   * half-parsed one would hand the acceptance gate a standard nobody wrote.
   */
  it("is null for a row written by a build whose shape this one cannot read", () => {
    const { store } = runWith();
    store.db
      .prepare("INSERT INTO events (runId, type, payload, ts) VALUES (?,?,?,?)")
      .run("run-1", "run.spec_ready", JSON.stringify({ spec: { scenarios: "not a list" } }), 1);
    expect(store.runSpec("run-1")).toBeNull();
  });

  it("reads the acceptance verdict back whole", () => {
    const { store, bus } = runWith();
    bus.publish({ type: "run.acceptance_verdict", runId: "run-1", passed: false, failing: ["SC-001"], named: true, blocked: ["SC-009"], line: "one failing", ts: 1 });
    expect(store.acceptanceVerdict("run-1")).toEqual({ verdict: "red", failing: ["SC-001"], named: true, blocked: ["SC-009"], line: "one failing" });
  });

  /** A row from before these fields existed reads as the absence they describe. */
  it("fills in what an older row does not carry", () => {
    const { store } = runWith();
    store.db.prepare("INSERT INTO events (runId, type, payload, ts) VALUES (?,?,?,?)").run("run-1", "run.acceptance_verdict", JSON.stringify({ passed: true }), 1);
    expect(store.acceptanceVerdict("run-1")).toEqual({ verdict: "green", failing: [], named: true, blocked: [], line: "" });
  });

  /**
   * The event that could say "no opinion" was written by a gate that used to
   * spell it `passed: true`. A row that carries the word is read by the word,
   * whatever the boolean beside it says.
   */
  it("reads the three-way verdict ahead of the boolean when a row carries both", () => {
    const { store } = runWith();
    store.db.prepare("INSERT INTO events (runId, type, payload, ts) VALUES (?,?,?,?)").run("run-1", "run.acceptance_verdict", JSON.stringify({ verdict: "no-opinion", passed: true }), 1);
    expect(store.acceptanceVerdict("run-1")!.verdict).toBe("no-opinion");
  });
});

/**
 * The two readers the intent meter needs. Both exist because the posture is a
 * statement about a moment: which verdict is the newest, and how much the tree
 * moved after it was taken.
 */
describe("what the intent check left behind", () => {
  it("has no plan verdict to report until the plan gate has judged one", () => {
    const store = makeStore();
    makeRun(store);
    expect(store.planIntentVerdict("run1")).toBeNull();
  });

  it("reports the newest plan verdict, not the one that was re-planned away", () => {
    const store = makeStore();
    makeRun(store);
    const bus = new Bus(store);
    bus.publish({ type: "run.plan_intent_verdict", runId: "run1", verdict: "FAIL", gaps: ["no controller"], summary: "", ts: 1 });
    bus.publish({ type: "run.plan_intent_verdict", runId: "run1", verdict: "PASS", gaps: [], summary: "", ts: 2 });
    expect(store.planIntentVerdict("run1")).toEqual({ verdict: "PASS", gaps: [] });
  });

  it("reads a verdict recorded by a build that wrote no gap list", () => {
    // Not hypothetical: the event schema defaults `gaps` today, so every verdict
    // this harness writes has one. A run resumed from a database written before
    // it did must still produce a posture rather than a crash.
    const store = makeStore();
    makeRun(store);
    store.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?, NULL, NULL, ?, ?, ?)")
      .run("run1", "run.plan_intent_verdict", JSON.stringify({ verdict: "FAIL" }), 1);
    expect(store.planIntentVerdict("run1")).toEqual({ verdict: "FAIL", gaps: [] });
  });

  it("reads the live verdict back whole, and fills in what a partial row does not carry", () => {
    const store = makeStore();
    makeRun(store);
    const bus = new Bus(store);
    bus.publish({
      type: "run.live_verdict",
      runId: "run1",
      verdict: "broken",
      path: "take a payment",
      steps: [{ step: "pay", result: "broken" }],
      howStarted: "pnpm dev",
      why: "500 on /pay",
      artifactsDir: "/r/.harness/run-1/live",
      proof: ["shot.png — the error"],
      couldNotReach: ["the receipt"],
      ts: 1,
    });
    expect(store.liveVerdict("run1")).toEqual({
      verdict: "broken",
      path: "take a payment",
      steps: [{ step: "pay", result: "broken" }],
      howStarted: "pnpm dev",
      why: "500 on /pay",
      artifactsDir: "/r/.harness/run-1/live",
      proof: ["shot.png — the error"],
      couldNotReach: ["the receipt"],
    });

    store.db.prepare("INSERT INTO events (runId, type, payload, ts) VALUES (?,?,?,?)").run("run1", "run.live_verdict", JSON.stringify({ verdict: "worked" }), 2);
    expect(store.liveVerdict("run1")).toEqual({ verdict: "worked", path: "", steps: [], howStarted: "", why: "", artifactsDir: "", proof: [], couldNotReach: [] });
    expect(store.liveVerdict("no-such-run")).toBeNull();
  });

  /** The prose one fix task is handed, kept apart from the judgment the run is held to. */
  it("reads back what the live agent observed at each step, and nothing when it never ran", () => {
    const store = makeStore();
    makeRun(store);
    const bus = new Bus(store);
    expect(store.liveSteps("run1")).toEqual([]);
    bus.publish({ type: "run.live_observed", runId: "run1", steps: [{ step: "pay", observed: "POST /pay returned 500" }], ts: 1 });
    expect(store.liveSteps("run1")).toEqual([{ step: "pay", observed: "POST /pay returned 500" }]);
    store.db.prepare("INSERT INTO events (runId, type, payload, ts) VALUES (?,?,?,?)").run("run1", "run.live_observed", JSON.stringify({}), 2);
    expect(store.liveSteps("run1")).toEqual([]);
  });

  it("reads an UNKNOWN verdict back with what it left unchecked, and defaults it on an older row", () => {
    const store = makeStore();
    makeRun(store);
    const bus = new Bus(store);
    bus.publish({ type: "run.intent_verdict", runId: "run1", verdict: "UNKNOWN", gaps: [], unchecked: ["the poller"], summary: "out of turns", ts: 1 });
    expect(store.intentVerdict("run1")).toEqual({ verdict: "UNKNOWN", gaps: [], unchecked: ["the poller"], summary: "out of turns" });
    store.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?, NULL, NULL, ?, ?, ?)")
      .run("run1", "run.intent_verdict", JSON.stringify({ verdict: "PASS" }), 2);
    expect(store.intentVerdict("run1")).toEqual({ verdict: "PASS", gaps: [], unchecked: [], summary: "" });
  });

  it("counts how far the tree moved after a point, which is what makes a verdict stale", () => {
    const store = makeStore();
    makeRun(store);
    const bus = new Bus(store);
    bus.publish({ type: "git.merged", runId: "run1", taskId: "t1", branch: "harness/run1/t1", sha: "a", ts: 1 });
    bus.publish({ type: "run.intent_verdict", runId: "run1", verdict: "FAIL", gaps: ["g"], unchecked: [], summary: "", ts: 2 });
    bus.publish({ type: "git.merged", runId: "run1", taskId: "t2", branch: "harness/run1/t2", sha: "b", ts: 3 });
    bus.publish({ type: "git.merged", runId: "run1", taskId: "t3", branch: "harness/run1/t3", sha: "c", ts: 4 });

    const at = store.lastEventSeq("run1", "run.intent_verdict");
    // The merge before the verdict is part of what it read; the two after it
    // are the tree it never saw.
    expect(store.eventCountSince("run1", "git.merged", at)).toBe(2);
    expect(store.eventCountSince("run1", "git.merged", 0)).toBe(3);
  });
});

/**
 * Which of a run's gates are still asking, computed from the open/resolve pair.
 *
 * Both cases below are rows an *older build* wrote. `gateId` and `kind` are
 * required by the event schema, so nothing this harness publishes today can be
 * missing either — but `openRunGates` is read on resume, against whatever
 * database the run already had, and a reader that mishandles an old row on the
 * resume path is a reader that mishandles it while somebody is waiting.
 */
describe("which of a run's gates are still asking", () => {
  it("ignores a gate event that names no gate", () => {
    const store = makeStore();
    makeRun(store);
    store.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?, NULL, NULL, ?, ?, ?)")
      .run("run1", "run.gate_opened", JSON.stringify({ kind: "subscription" }), 1);
    // An unidentified gate can never be matched to its resolution, so counting
    // it would leave the run reporting a gate that nothing is able to close.
    expect(store.openRunGates("run1")).toEqual([]);
  });

  it("reads a gate opened by a build that recorded no kind", () => {
    const store = makeStore();
    makeRun(store);
    store.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?, NULL, NULL, ?, ?, ?)")
      .run("run1", "run.gate_opened", JSON.stringify({ gateId: "e2f1" }), 1);
    // The empty string rather than `undefined`, and it matters which: every
    // caller decides what to do with a gate by comparing its kind, and a gate
    // whose kind was never recorded must fail that comparison rather than be
    // treated as one of them.
    expect(store.openRunGates("run1")).toEqual([{ gateId: "e2f1", kind: "" }]);
  });
});

/**
 * How many budget raises a *skill* made, which is the number the auto-raise
 * bound is spent against.
 *
 * The distinction is the whole point: a run gets three automatic raises before
 * the next one goes to a person, and anything a person did must not come out of
 * that allowance. Two words mean a person — `operator`, who answered, and
 * `resume`, which is `closeAbandonedGates` shutting a gate the process died
 * holding. Neither is a decider deciding.
 */
describe("which budget raises came from a decider", () => {
  function raise(store: Store, bus: Bus, gateId: string, decidedBy: string): void {
    bus.publish({ type: "run.gate_opened", runId: "run1", gateId, kind: "budget", payload: {}, ts: 1 });
    bus.publish({ type: "run.gate_resolved", runId: "run1", gateId, kind: "budget", resolution: "approved", feedback: "", decidedBy, ts: 2 });
  }

  it("counts a skill's approval and neither of the two words that mean a person", () => {
    const store = makeStore();
    makeRun(store);
    const bus = new Bus(store);

    raise(store, bus, "g1", "product-manager");
    raise(store, bus, "g2", "operator");
    // A resume closing a gate nobody was left to answer. Counting it would
    // spend an auto-raise round on a raise no decider ever made.
    raise(store, bus, "g3", "resume");

    expect(store.budgetAutoRaises("run1")).toBe(1);
  });

  it("does not count a gate a decider refused", () => {
    const store = makeStore();
    makeRun(store);
    const bus = new Bus(store);
    bus.publish({ type: "run.gate_opened", runId: "run1", gateId: "g4", kind: "budget", payload: {}, ts: 1 });
    bus.publish({ type: "run.gate_resolved", runId: "run1", gateId: "g4", kind: "budget", resolution: "rejected", feedback: "", decidedBy: "product-manager", ts: 2 });

    expect(store.budgetAutoRaises("run1")).toBe(0);
  });
});

describe("a gate the task outlived", () => {
  const task = (id: string) => ({
    id, epicId: "e1", title: id.toUpperCase(), spec: "s", acceptanceCriteria: ["ok"], dependsOn: [],
    state: "PENDING" as const, branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null,
    qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "M" as const,
  });
  const gated = (id: string) => {
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "Epic" }], [task(id)]);
    return store;
  };
  const resolutions = (store: Store) =>
    store.eventsSince("run1", 0).map((e) => e.event).filter((e) => e.type === "task.gate_resolved") as { decidedBy: string; parked: boolean }[];

  it("is closed when the work it was asking about merges", () => {
    // Run bc691359's `intent-fix-1-6`: it gated on merge conflicts, was requeued
    // 37 minutes later without anyone answering, went round the loop again and
    // merged. The gate stood open for 7.8 days afterwards, and every reader that
    // computes open gates from the event log kept telling the operator that a
    // shipped task was blocking them.
    const store = gated("a");
    store.appendEvent({ type: "task.gate_opened", runId: "run1", taskId: "a", why: "merge conflicts", recommendation: "", iterations: 3, ts: Date.now() });
    for (const to of ["READY", "WORKING", "ACCEPTED", "MERGED"] as const) store.transitionTask("run1", "a", to);

    expect(resolutions(store)).toHaveLength(1);
    expect(resolutions(store)[0]).toMatchObject({ decidedBy: "merged", parked: false, guidance: "" });
  });

  it("says what actually ended it, rather than crediting a person who never saw it", () => {
    const store = gated("a");
    store.appendEvent({ type: "task.gate_opened", runId: "run1", taskId: "a", why: "stuck", recommendation: "", iterations: 3, ts: Date.now() });
    store.transitionTask("run1", "a", "CANCELLED");

    expect(resolutions(store)[0]!.decidedBy).toBe("cancelled");
  });

  it("is not closed twice when somebody did answer it", () => {
    const store = gated("a");
    store.appendEvent({ type: "task.gate_opened", runId: "run1", taskId: "a", why: "stuck", recommendation: "", iterations: 3, ts: Date.now() });
    store.appendEvent({ type: "task.gate_resolved", runId: "run1", taskId: "a", parked: false, guidance: "do X", decidedBy: "operator", ts: Date.now() });
    for (const to of ["READY", "WORKING", "ACCEPTED", "MERGED"] as const) store.transitionTask("run1", "a", to);

    expect(resolutions(store).map((r) => r.decidedBy)).toEqual(["operator"]);
  });

  it("closes only the gate that is still open, when a task gated more than once", () => {
    // A task can gate, be answered, and gate again. Only the last exchange is
    // unfinished, and only it is the one to close.
    const store = gated("a");
    store.appendEvent({ type: "task.gate_opened", runId: "run1", taskId: "a", why: "first", recommendation: "", iterations: 3, ts: Date.now() });
    store.appendEvent({ type: "task.gate_resolved", runId: "run1", taskId: "a", parked: false, guidance: "do X", decidedBy: "operator", ts: Date.now() });
    store.appendEvent({ type: "task.gate_opened", runId: "run1", taskId: "a", why: "second", recommendation: "", iterations: 3, ts: Date.now() });
    for (const to of ["READY", "WORKING", "ACCEPTED", "MERGED"] as const) store.transitionTask("run1", "a", to);

    expect(resolutions(store).map((r) => r.decidedBy)).toEqual(["operator", "merged"]);
  });

  it("writes nothing for a task that never escalated at all", () => {
    const store = gated("a");
    for (const to of ["READY", "WORKING", "ACCEPTED", "MERGED"] as const) store.transitionTask("run1", "a", to);

    expect(resolutions(store)).toHaveLength(0);
  });

  it("leaves another task's open gate alone", () => {
    const store = makeStore();
    makeRun(store);
    store.insertTasks("run1", [{ id: "e1", title: "Epic" }], [task("a"), task("b")]);
    store.appendEvent({ type: "task.gate_opened", runId: "run1", taskId: "b", why: "stuck", recommendation: "", iterations: 3, ts: Date.now() });
    for (const to of ["READY", "WORKING", "ACCEPTED", "MERGED"] as const) store.transitionTask("run1", "a", to);

    expect(resolutions(store)).toHaveLength(0);
  });
});

describe("what paused a run, read back", () => {
  it("answers null for a run that has never changed state", () => {
    const store = new Store(":memory:");
    expect(store.lastRunStateChange("never")).toBeNull();
  });
});
