import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { postmortem, renderPostmortem } from "./postmortem.js";
import { Store, type TaskRow } from "./store.js";

/**
 * Working out why run 40da9337 delivered a product that could not move money
 * took an hour of ad-hoc SQL against its `.harness/harness.db`. Every query was
 * fixed; none was reachable from the CLI. The answer — a question the operator
 * was asked and never answered — was two lines of it.
 *
 * The fixture below is that run in miniature, with its real question, its real
 * verdict and two of its real acceptance criteria.
 */
const OPEN_QUESTION =
  'For "all the integrations" — do you want real vendor accounts wired up, or production-shaped adapters running against sandboxes with no real money movement?';

function run(id = "run-1") {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  store.createRun({
    id,
    repoPath: "/tmp/repo",
    assignment: "fully implement this product, including all the integrations",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: `harness/${id}/main`,
    config: RunConfig.parse({}),
  });
  return { store, bus };
}

const task = (store: Store, over: Partial<TaskRow>) =>
  store.insertTasks("run-1", [{ id: "e", title: "E" }], [
    {
      id: "t",
      epicId: "e",
      title: "T",
      spec: "s",
      acceptanceCriteria: ["it works"],
      dependsOn: [],
      touchedPaths: [],
      estimatedSize: "M",
      state: "PENDING",
      qaIterations: 0,
      branch: null,
      worktreePath: null,
      githubIssueNumber: null,
      prNumber: null,
      respawns: 0,
      assignedSkills: [],
      errorSummary: null,
      ...over,
    } as unknown as Omit<TaskRow, "runId">,
  ]);

const session = (store: Store, id: string, state: string, costUsd: number) =>
  store.db
    .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt, costUsd) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, "run-1", null, "worker", "claude-sonnet-5", state, 1, costUsd);

describe("why a run produced what it produced", () => {
  it("names the intake question nobody answered", () => {
    const { store, bus } = run();
    bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s", question: "Which backlog?", options: [], ts: 1 });
    bus.publish({ type: "intake.answered", runId: "run-1", sessionId: "s", question: "Which backlog?", answer: "gh", ts: 2 });
    bus.publish({ type: "intake.question", runId: "run-1", sessionId: "s", question: OPEN_QUESTION, options: [], ts: 3 });

    const p = postmortem(store, "run-1");
    expect(p.unanswered).toEqual([OPEN_QUESTION]);
    expect(renderPostmortem(p)).toContain("1 intake question(s) went unanswered");
  });

  it("finds the tasks that could pass without anything leaving the process", () => {
    const { store } = run();
    task(store, { id: "provider-layer", title: "Provider layer", acceptanceCriteria: ["All seven vendor categories have an interface and a deterministic mock"] });
    task(store, { id: "plaid-integration", title: "Plaid", acceptanceCriteria: ["The suite makes no outbound HTTP call"] });
    // Reaches a sandbox, so it is not one of these however many mocks it also has.
    task(store, { id: "stripe", title: "Stripe", acceptanceCriteria: ["A charge against the Stripe sandbox returns an id", "Unit tests use a mock"] });
    task(store, { id: "ledger", title: "Ledger", acceptanceCriteria: ["The trial balance nets to zero"] });

    const p = postmortem(store, "run-1");
    expect(p.selfContained.map((t) => t.id)).toEqual(["provider-layer", "plaid-integration"]);
    expect(renderPostmortem(p)).toContain("A task is finished when its criteria are met");
  });

  it("says how many of the end verdict's gaps became work", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.intent_verdict", runId: "run-1", verdict: "FAIL", gaps: ["nothing schedules the workers", "the budget is never enforced"], summary: "s", ts: 1 });
    task(store, { id: "intent-fix-1-1", title: "gap 1" });

    const p = postmortem(store, "run-1");
    expect(p.intent).toEqual({ verdict: "FAIL", gaps: ["nothing schedules the workers", "the budget is never enforced"], queued: 1 });
    expect(renderPostmortem(p)).toContain("2 gap(s), 1 queued as work");
  });

  it("says so plainly when the finished run did match", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.intent_verdict", runId: "run-1", verdict: "PASS", gaps: [], summary: "ok", ts: 1 });

    expect(renderPostmortem(postmortem(store, "run-1"))).toContain("The finished run matched the assignment.");
  });

  it("distinguishes a plan warning that was heeded from one that was approved anyway", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.plan_intent_verdict", runId: "run-1", verdict: "FAIL", gaps: ["no task reaches a vendor"], summary: "s", ts: 1 });

    expect(postmortem(store, "run-1").planIntent!.heeded).toBe(false);
    expect(renderPostmortem(postmortem(store, "run-1"))).toContain("and it was approved anyway");

    store.transitionRun("run-1", "PLANNING");
    store.transitionRun("run-1", "PLAN_REVIEW");
    store.transitionRun("run-1", "PLANNING", "plan rejected");

    expect(postmortem(store, "run-1").planIntent!.heeded).toBe(true);
    expect(renderPostmortem(postmortem(store, "run-1"))).toContain("sent back to the planner");
  });

  it("groups spend by how the session ended, worst first", () => {
    const { store } = run();
    session(store, "s1", "done", 500);
    session(store, "s2", "error", 300);
    session(store, "s3", "interrupted", 200);
    session(store, "s4", "done", 0); // never charged, so it is not a spend line

    const p = postmortem(store, "run-1");
    expect(p.spend).toEqual([
      { cause: "done", sessions: 2, usd: 500 },
      { cause: "error", sessions: 1, usd: 300 },
      { cause: "interrupted", sessions: 1, usd: 200 },
    ]);
    const text = renderPostmortem(p);
    expect(text).toContain("$  500.00");
    expect(text).toContain("50%");
  });

  it("counts the hours the run spent waiting, and ignores a gate still open", () => {
    const { store, bus } = run();
    task(store, { id: "task-a" });
    bus.publish({ type: "task.gate_opened", runId: "run-1", taskId: "task-a", why: "qa rejected it twice", iterations: 2, recommendation: "", ts: 0 });
    bus.publish({ type: "task.gate_resolved", runId: "run-1", taskId: "task-a", parked: false, guidance: "go", ts: 7_200_000 });
    bus.publish({ type: "run.gate_opened", runId: "run-1", gateId: "g1", kind: "budget", payload: {}, ts: 8_000_000 });

    const p = postmortem(store, "run-1");
    expect(p.gates).toBe(2);
    expect(p.blockedHours).toBe(2); // the unresolved one adds nothing
    expect(renderPostmortem(p)).toContain("2 gate(s), 2h waiting on you.");
  });

  it("reports a clean run without inventing sections", () => {
    const { store } = run();
    const text = renderPostmortem(postmortem(store, "run-1"));

    expect(text).toContain("Run run-1 [CREATED]");
    expect(text).not.toContain("went unanswered");
    expect(text).not.toContain("could pass without");
    expect(text).not.toContain("Spend by how");
    expect(text).not.toContain("The finished run");
    expect(text).toContain("0 gate(s), 0h waiting on you.");
  });

  it("shows only the first line of a multi-line assignment", () => {
    const store = new Store(":memory:");
    store.createRun({
      id: "run-1",
      repoPath: "/tmp/repo",
      assignment: "build the thing\n\nwith all this detail nobody needs in a heading",
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run-1/main",
      config: RunConfig.parse({}),
    });

    const text = renderPostmortem(postmortem(store, "run-1"));
    expect(text).toContain("Run run-1 [CREATED] — build the thing");
    expect(text).not.toContain("nobody needs");
  });

  it("says nothing about a plan verdict that passed", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.plan_intent_verdict", runId: "run-1", verdict: "PASS", gaps: [], summary: "ok", ts: 1 });

    expect(renderPostmortem(postmortem(store, "run-1"))).not.toContain("would not deliver");
  });
});
