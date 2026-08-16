import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { RunConfig, type TaskState } from "@harness/shared";
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
    expect(cost).toBeCloseTo(5);
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
    expect(store.taskGateAutoAnswers("run1", "a")).toBe(1);
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
