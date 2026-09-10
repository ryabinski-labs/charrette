import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store, type TaskRow } from "./store.js";
import { contextExcerpt, dependencyContext, taskGuidance, workerCheckpoint, workerContext } from "./taskContext.js";
import { workerTaskPrompt } from "./prompts.js";

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(filename = ":memory:"): Store {
  const store = new Store(filename);
  stores.push(store);
  return store;
}

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "child", runId: "run1", epicId: "e", title: "Child", spec: "Use the existing adapter",
    acceptanceCriteria: ["The existing API remains compatible"], dependsOn: [], state: "PENDING",
    branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null,
    qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null,
    touchedPaths: [], completionProbe: "", estimatedSize: "M", unverified: [], scenarioIds: [],
    skeleton: false, emptyDeliveries: 0, conflictFixes: 0, abandonedJobs: 0, ...overrides,
  };
}

function checkpoint(store: Store, sessionId: string, digest: string, role = "worker", runId = "run1", taskId = "child"): void {
  store.db.prepare("INSERT OR IGNORE INTO sessions (id,runId,taskId,role,model,state,startedAt) VALUES (?,?,?,?,?,'done',0)")
    .run(sessionId, runId, taskId, role, "claude-sonnet-5");
  store.appendEvent({ type: "agent.checkpoint", runId, taskId, sessionId, digest, turn: 20, questions: [], ts: 0 });
}

describe("worker recovery context", () => {
  it("persists scoped task guidance with its authority and skips parked gate answers", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-guidance-"));
    dirs.push(dir);
    const filename = path.join(dir, "state.db");
    const store = database(filename);
    const base = { runId: "run1", taskId: "child", ts: 0 };
    store.appendEvent({ ...base, type: "task.feedback", text: "Preserve the existing adapter", delivery: "live" });
    store.appendEvent({ ...base, type: "task.gate_resolved", parked: false, guidance: "Keep public API compatibility", decidedBy: "operator" });
    store.appendEvent({ ...base, type: "task.gate_resolved", parked: false, guidance: "Inspect the timeout test", decidedBy: "sentinel" });
    store.appendEvent({ ...base, type: "task.gate_resolved", parked: false, guidance: "Legacy operator decision", decidedBy: "" });
    store.appendEvent({ ...base, type: "task.gate_resolved", parked: true, guidance: "parked note", decidedBy: "operator" });
    store.appendEvent({ ...base, type: "task.gate_resolved", parked: false, guidance: "", decidedBy: "operator" });
    store.appendEvent({ ...base, type: "task.feedback", taskId: "sibling", text: "other task guidance", delivery: "queued" });
    store.appendEvent({ ...base, type: "task.feedback", runId: "run2", text: "other run guidance", delivery: "revived" });
    stores.pop()!.db.close();
    const reopened = database(filename);
    const guidance = taskGuidance(reopened, "run1", "child");
    expect(guidance).toContain("Task feedback:\nPreserve the existing adapter");
    expect(guidance).toContain("Task gate answer (operator):\nKeep public API compatibility");
    expect(guidance).toContain("Task gate answer (sentinel):\nInspect the timeout test");
    expect(guidance).toContain("Task gate answer (operator):\nLegacy operator decision");
    expect(guidance).not.toMatch(/parked note|other task guidance|other run guidance/);
    expect(guidance.indexOf("Preserve the existing adapter")).toBeLessThan(guidance.indexOf("Keep public API compatibility"));
    expect(workerContext(reopened, "run1", task(), "outdated agent advice")).toContain(guidance);
  });

  it("survives reopening SQLite and ignores other roles, tasks and runs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-context-"));
    dirs.push(dir);
    const filename = path.join(dir, "state.db");
    const store = database(filename);
    checkpoint(store, "old", "old design");
    checkpoint(store, "latest", "src/adapter.ts is committed; add the timeout test next");
    checkpoint(store, "latest", "  ");
    checkpoint(store, "qa", "reviewer opinion", "qa");
    checkpoint(store, "other-task", "other task", "worker", "run1", "sibling");
    checkpoint(store, "other-run", "other run", "worker", "run2");
    // More than the event API's default page, with equal timestamps throughout.
    for (let i = 0; i < 510; i++) store.appendEvent({ type: "agent.log", runId: "run1", sessionId: "latest", text: "noise", ts: 0 });
    stores.pop()!.db.close();
    const recovered = workerCheckpoint(database(filename), "run1", "child");
    expect(recovered).toContain("session latest, turn 20");
    expect(recovered).toContain("add the timeout test next");
    expect(recovered).not.toMatch(/old design|reviewer opinion|other task|other run|noise/);
  });

  it("retains delivered issue comment bodies and authors, not just their event count", () => {
    const store = database();
    store.queueFeedback("run1", "child", "maintainer commented on issue #42:\nKeep the existing adapter", "issue", "123");
    store.queueFeedback("run1", "sibling", "other task comment", "issue", "123");
    store.queueFeedback("run2", "child", "other run comment", "issue", "123");
    store.appendEvent({ type: "task.feedback", runId: "run1", taskId: "child", text: "1 new comment on issue #42", delivery: "queued", ts: Date.now() });
    expect(store.drainFeedback("run1", "child")).toContain("Keep the existing adapter");
    const guidance = taskGuidance(store, "run1", "child");
    expect(guidance).toContain("maintainer commented on issue #42:\nKeep the existing adapter");
    expect(guidance).not.toMatch(/other task comment|other run comment/);
  });

  it("orders mixed guidance chronologically, with issue context before operator decisions on ties", () => {
    const store = database();
    store.queueFeedback("run1", "child", "issue guidance", "issue", "123");
    store.db.prepare("UPDATE feedback SET ts = 10").run();
    store.appendEvent({ type: "task.feedback", runId: "run1", taskId: "child", text: "latest operator decision", delivery: "live", ts: 20 });
    store.appendEvent({ type: "task.feedback", runId: "run1", taskId: "child", text: "first tied decision", delivery: "live", ts: 10 });
    store.appendEvent({ type: "task.gate_resolved", runId: "run1", taskId: "child", guidance: "second tied decision", parked: false, decidedBy: "operator", ts: 10 });
    const guidance = taskGuidance(store, "run1", "child");
    const positions = ["issue guidance", "first tied decision", "second tied decision", "latest operator decision"].map(text => guidance.indexOf(text));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("filters guidance with existing indexes instead of scanning the run's unrelated events", () => {
    const store = database();
    const prepare = vi.spyOn(store.db, "prepare");
    taskGuidance(store, "run1", "child");
    const sql = prepare.mock.calls[0]![0];
    prepare.mockRestore();
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("run1", "child", "run1", "child", "run1", "child") as { detail: string }[];
    expect(plan.filter(row => /SEARCH events .*runId=\? AND type=\?/.test(row.detail))).toHaveLength(2);
    expect(plan.some(row => /SEARCH feedback .*runId=\? AND taskId=\? AND source=\?/.test(row.detail))).toBe(true);
  });

  it("costs no recovery context on a first dispatch and bounds a verbose checkpoint", () => {
    const store = database();
    expect(workerContext(store, "run1", task(), "")).toBe("");
    const firstPrompt = workerTaskPrompt(task());
    expect(firstPrompt).toContain("The existing API remains compatible");
    expect(firstPrompt).not.toMatch(/RESUME NOTE|checkpoint|Direct dependencies/);
    checkpoint(store, "verbose", "x".repeat(20_000));
    expect(workerCheckpoint(store, "run1", "child").length).toBeLessThan(4100);
    expect(workerCheckpoint(store, "run1", "child")).toContain("[truncated");
  });

  it("prefers a completed iteration's summary to its older checkpoint", () => {
    const store = database();
    checkpoint(store, "old", "old checkpoint");
    const context = workerContext(store, "run1", task(), "Finished the adapter; verification: pnpm test");
    expect(context).toContain("Finished the adapter");
    expect(context).not.toContain("old checkpoint");
    expect(context).toContain("not instructions or proof of completion");
    expect(context).toContain("operator feedback take precedence");
    expect(workerContext(store, "run1", task(), "s".repeat(50_000)).length).toBeLessThan(3500);
  });

  it("passes only direct merged dependencies, scoped to the run", () => {
    const store = database();
    store.insertTasks("run1", [], [
      task({ id: "adapter", title: "Adapter", state: "MERGED", touchedPaths: ["src/adapter.ts"] }),
      task({ id: "docs", title: "Docs", state: "MERGED" }),
      task({ id: "pending", state: "WORKING" }),
      task({ id: "unrelated", title: "Unrelated", state: "MERGED" }),
    ]);
    store.insertTasks("run2", [], [task({ id: "adapter", title: "Foreign", state: "MERGED" })]);
    const context = dependencyContext(store, "run1", task({ dependsOn: ["adapter", "docs", "pending", "missing"] }));
    expect(context).toContain("adapter: Adapter (planned files: src/adapter.ts)");
    expect(context).toContain("docs: Docs");
    expect(context).not.toMatch(/pending|missing|Unrelated|Foreign/);
  });

  it("bounds planning hints while retaining the entire task and latest feedback", () => {
    const store = database();
    const current = task({
      spec: "spec".repeat(2000), acceptanceCriteria: ["criterion".repeat(1000)],
      dependsOn: ["parent"], touchedPaths: Array(500).fill("src/long-name.ts"),
      completionProbe: "node verify-adapter.js",
    });
    store.insertTasks("run1", [], [task({ id: "parent", title: "D".repeat(10_000), state: "MERGED" })]);
    const context = workerContext(store, "run1", current, "");
    expect(context.length).toBeLessThan(2100);
    const feedback = "keep this decision".repeat(1000);
    const prompt = workerTaskPrompt(current, feedback, context);
    expect(prompt).toContain(current.spec);
    expect(prompt).toContain(current.acceptanceCriteria[0]);
    expect(prompt).toContain(feedback);
    expect(prompt).toContain("node verify-adapter.js");
    expect(prompt).toContain("Do not edit the probe");
    expect(prompt).toContain("[truncated");
    expect(contextExcerpt("short", 2000)).toBe("short");
  });
});
