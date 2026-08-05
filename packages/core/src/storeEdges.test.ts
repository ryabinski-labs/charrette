import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import { Bus } from "./bus.js";
import { InvalidTransition, Store } from "./store.js";

/**
 * The store's refusals and its defaults: what it does when asked about a run
 * that does not exist, and what it reports when an event it is reading back
 * was written without every optional field. Both matter because the readers
 * are the dashboard and the closing report, which have to render *something*.
 */

function store(): Store {
  return new Store(":memory:");
}

function withRun(id = "run1"): { store: Store; bus: Bus } {
  const s = store();
  s.createRun({
    id,
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: `harness/${id}/main`,
    config: RunConfig.parse({}),
  });
  return { store: s, bus: new Bus(s) };
}

const TASK = {
  id: "t1", epicId: "e1", title: "T", spec: "", acceptanceCriteria: [], dependsOn: [], state: "PENDING" as const,
  branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0,
  assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "M" as const,
};

describe("opening the database a run actually uses", () => {
  /**
   * Every other test here uses `:memory:`, which skips the pragmas entirely —
   * so the configuration a real run depends on had never been executed. A live
   * run holds this file open for hours while `status`, `regroup` and the
   * dashboard read and write it from their own processes.
   */
  it("puts a file-backed database into WAL mode so other processes can read it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-store-"));
    const s = new Store(path.join(dir, "harness.db"));

    const mode = s.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("refusing what it cannot do", () => {
  it("says which run it does not know", () => {
    const s = store();

    expect(() => s.transitionRun("nope", "PLANNING")).toThrow("unknown run nope");
    expect(() => s.setRunBudget("nope", { runCapUsd: 10, taskCapUsd: 5 })).toThrow("unknown run nope");
    expect(() => s.patchRunConfig("nope", { prMode: "single" })).toThrow("unknown run nope");
    expect(s.getRun("nope")).toBeUndefined();
  });

  it("says which task it does not know", () => {
    const { store: s } = withRun();

    expect(() => s.transitionTask("run1", "ghost", "READY")).toThrow("unknown task ghost");
  });

  it("refuses a transition the state machine does not allow", () => {
    const { store: s } = withRun();

    expect(() => s.transitionRun("run1", "DONE")).toThrow(InvalidTransition);
  });

  it("leaves the row alone when a patch has nothing in it", () => {
    const { store: s } = withRun();
    s.insertTasks("run1", [{ id: "e1", title: "E" }], [TASK]);

    expect(() => s.updateTask("run1", "t1", {})).not.toThrow();
    expect(s.getTask("run1", "t1")!.branch).toBeNull();
  });
});

describe("a write that fails part-way", () => {
  /**
   * `insertTasks` writes the epics and the tasks together. A plan whose second
   * task is malformed must leave none of it behind, or a resume finds half a
   * DAG and builds against it.
   */
  it("rolls back the whole batch rather than leaving half a plan", () => {
    const { store: s } = withRun();

    expect(() =>
      s.insertTasks("run1", [{ id: "e1", title: "E" }], [TASK, { ...TASK, id: null as unknown as string }])
    ).toThrow();

    expect(s.listTasks("run1")).toEqual([]);
  });
});

describe("reading back a row an older harness wrote", () => {
  /**
   * Writes straight to the events table, bypassing `appendEvent`.
   *
   * That matters: `appendEvent` parses through the event schema, whose
   * `.default([])`/`.default("")` mean every row *this* version writes carries
   * every field. The readers' fallbacks exist only for rows already in a
   * database from before those fields existed — and going through the schema is
   * exactly what makes that case impossible to reach from a test.
   */
  function legacyEvent(s: Store, type: string, payload: Record<string, unknown>): void {
    s.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?,?,?,?,?,?)")
      .run("run1", null, null, type, JSON.stringify({ runId: "run1", type, ...payload }), 1);
  }

  it("survives an intent verdict recorded before gaps and summary existed", () => {
    const { store: s } = withRun();
    legacyEvent(s, "run.intent_verdict", { verdict: "PASS" });

    expect(s.intentVerdict("run1")).toEqual({ verdict: "PASS", gaps: [], summary: "" });
  });

  it("survives a CI status recorded before the failing list existed", () => {
    const { store: s } = withRun();
    legacyEvent(s, "run.ci_status", { prNumber: 7, state: "passing" });

    expect(s.ciStatus("run1")).toEqual({ prNumber: 7, state: "passing", failing: [], total: 0 });
  });

  it("survives a deploy status recorded before the failing list existed", () => {
    const { store: s } = withRun();
    legacyEvent(s, "run.deploy_status", { sha: "abc123", state: "pending" });

    expect(s.deployStatus("run1")).toEqual({ sha: "abc123", state: "pending", failing: [], total: 0 });
  });

  it("survives a production verdict recorded before findings existed", () => {
    const { store: s } = withRun();
    legacyEvent(s, "run.prod_verdict", { url: "https://app.example.com", verdict: "PASS" });

    expect(s.prodVerdict("run1")).toEqual({ url: "https://app.example.com", verdict: "PASS", findings: [], summary: "" });
  });

  it("survives a task transition recorded before reasons were kept", () => {
    const { store: s } = withRun();
    s.insertTasks("run1", [{ id: "e1", title: "E" }], [TASK]);
    s.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?,?,?,?,?,?)")
      .run("run1", "t1", null, "task.state_changed", JSON.stringify({ runId: "run1", taskId: "t1", type: "task.state_changed", from: "WORKING", to: "NEEDS_HUMAN" }), 1);

    expect(s.taskStateReason("run1", "t1")).toBe("");
  });
});

describe("reading back an event that was written without every field", () => {
  it("reports no reason when the transition event carried none", () => {
    const { store: s } = withRun();
    s.insertTasks("run1", [{ id: "e1", title: "E" }], [TASK]);
    s.transitionTask("run1", "t1", "READY");

    expect(s.taskStateReason("run1", "t1")).toBe("");
  });

  it("reports no reason at all for a task that never transitioned", () => {
    const { store: s } = withRun();
    s.insertTasks("run1", [{ id: "e1", title: "E" }], [TASK]);

    expect(s.taskStateReason("run1", "t1")).toBe("");
  });

  it("fills in an intent verdict with no gaps and no summary", () => {
    const { store: s, bus } = withRun();
    bus.publish({ type: "run.intent_verdict", runId: "run1", verdict: "PASS", ts: 1 } as never);

    expect(s.intentVerdict("run1")).toEqual({ verdict: "PASS", gaps: [], summary: "" });
  });

  it("fills in a CI status with nothing failing and no total", () => {
    const { store: s, bus } = withRun();
    bus.publish({ type: "run.ci_status", runId: "run1", prNumber: 7, state: "passing", ts: 1 } as never);

    expect(s.ciStatus("run1")).toEqual({ prNumber: 7, state: "passing", failing: [], total: 0 });
  });

  it("fills in a deploy status the same way", () => {
    const { store: s, bus } = withRun();
    bus.publish({ type: "run.deploy_status", runId: "run1", sha: "abc123", state: "pending", ts: 1 } as never);

    expect(s.deployStatus("run1")).toEqual({ sha: "abc123", state: "pending", failing: [], total: 0 });
  });

  it("fills in a production verdict with no findings and no summary", () => {
    const { store: s, bus } = withRun();
    bus.publish({ type: "run.prod_verdict", runId: "run1", url: "https://app.example.com", verdict: "PASS", ts: 1 } as never);

    expect(s.prodVerdict("run1")).toEqual({ url: "https://app.example.com", verdict: "PASS", findings: [], summary: "" });
  });

  it("reports nothing for a run that never reached any of those points", () => {
    const { store: s } = withRun();

    expect(s.intentVerdict("run1")).toBeNull();
    expect(s.ciStatus("run1")).toBeNull();
    expect(s.deployStatus("run1")).toBeNull();
    expect(s.prodVerdict("run1")).toBeNull();
    expect(s.lastEventSeq("run1", "run.ci_status")).toBe(0);
  });
});

describe("reading back an event that carried everything", () => {
  it("keeps the reason a transition was given", () => {
    const { store: s } = withRun();
    s.insertTasks("run1", [{ id: "e1", title: "E" }], [TASK]);
    s.transitionTask("run1", "t1", "READY", "its dependency merged");

    expect(s.taskStateReason("run1", "t1")).toBe("its dependency merged");
  });

  it("keeps the gaps and the summary of a failed intent check", () => {
    const { store: s, bus } = withRun();
    bus.publish({
      type: "run.intent_verdict", runId: "run1", verdict: "FAIL",
      gaps: ["no offline mode"], summary: "two thirds delivered", ts: 1,
    } as never);

    expect(s.intentVerdict("run1")).toEqual({ verdict: "FAIL", gaps: ["no offline mode"], summary: "two thirds delivered" });
  });

  it("keeps the names of the checks that failed", () => {
    const { store: s, bus } = withRun();
    bus.publish({ type: "run.ci_status", runId: "run1", prNumber: 7, state: "failing", failing: ["build"], total: 3, ts: 1 } as never);
    bus.publish({ type: "run.deploy_status", runId: "run1", sha: "abc", state: "failing", failing: ["deploy"], total: 1, ts: 2 } as never);

    expect(s.ciStatus("run1")).toEqual({ prNumber: 7, state: "failing", failing: ["build"], total: 3 });
    expect(s.deployStatus("run1")).toEqual({ sha: "abc", state: "failing", failing: ["deploy"], total: 1 });
  });

  it("keeps what production disagreed about", () => {
    const { store: s, bus } = withRun();
    bus.publish({
      type: "run.prod_verdict", runId: "run1", url: "https://app.example.com", verdict: "FAIL",
      findings: ["/login 500s"], summary: "live but broken", ts: 1,
    } as never);

    expect(s.prodVerdict("run1")).toEqual({
      url: "https://app.example.com", verdict: "FAIL", findings: ["/login 500s"], summary: "live but broken",
    });
  });

  it("reports the seq of the newest event of a type", () => {
    const { store: s, bus } = withRun();
    bus.publish({ type: "run.ci_status", runId: "run1", prNumber: 7, state: "pending", ts: 1 } as never);
    const first = s.lastEventSeq("run1", "run.ci_status");
    bus.publish({ type: "run.ci_status", runId: "run1", prNumber: 7, state: "passing", ts: 2 } as never);

    expect(s.lastEventSeq("run1", "run.ci_status")).toBeGreaterThan(first);
  });
});

describe("what intake writes back", () => {
  it("replaces the seed with the brief it produced", () => {
    const { store: s } = withRun();

    s.setRunAssignment("run1", "# add rate limiting\n\nkeyed on the API key");

    expect(s.getRun("run1")!.assignment).toContain("keyed on the API key");
  });

  it("lists the sessions a run has opened", () => {
    const { store: s } = withRun();
    s.db
      .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt) VALUES (?,?,?,?,?,?,?)")
      .run("sess-1", "run1", null, "planner", "claude-opus-5", "running", 1);

    expect(s.listSessions("run1")).toMatchObject([{ id: "sess-1", role: "planner", state: "running" }]);
  });
});
