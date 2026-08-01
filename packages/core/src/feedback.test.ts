import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { PromptStream } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], estimatedSize: "S" }],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-feedback-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "harness@example.com");
  gitIn(dir, "config", "user.name", "harness");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

const noGithub = { enabled: false } as unknown as GitHubAdapter;
const approveAll: GateHandler = {
  async resolvePlanGate() {
    return { approved: true, feedback: "" };
  },
  async resolveBudgetGate() {
    return null;
  },
};

/**
 * A pool whose sessions the test can watch, with a hook that fires inside a
 * chosen role's session — the only moment mid-flight feedback can exist.
 */
function watchedPool(hooks: { during?: (spec: AgentSpec) => void; qaVerdicts?: string[] }) {
  let planning = 0;
  const workerPrompts: string[] = [];
  const qaPrompts: string[] = [];
  const verdicts = [...(hooks.qaVerdicts ?? [])];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
      else if (spec.role === "worker") {
        workerPrompts.push(spec.prompt);
        hooks.during?.(spec);
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") {
        qaPrompts.push(spec.prompt);
        hooks.during?.(spec);
        resultText = verdicts.shift() ?? '{"verdict":"PASS","summary":"fine"}';
      } else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts, qaPrompts };
}

function controllerWith(pool: AgentPool) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const controller = new RunController(store, bus, pool, noGithub, approveAll, repo());
  return { store, controller };
}

describe("mid-flight operator feedback", () => {
  it("queues when nothing is live, and the next worker starts with the operator's words", async () => {
    // Feedback lands during QA (a pool without inject() can never deliver live),
    // QA rejects, and the re-dispatched worker is briefed with it.
    let controller!: RunController;
    const sent: string[] = [];
    const { pool, workerPrompts } = watchedPool({
      qaVerdicts: ['{"verdict":"FAIL","reasons":["missing test"],"mustFix":["add one"]}'],
      during: (spec) => {
        if (spec.role === "qa" && sent.length === 0) {
          sent.push(controller.sendFeedback(spec.runId, spec.taskId!, "use the fake clock helper, not sleeps"));
        }
      },
    });
    const { store, controller: c } = controllerWith(pool);
    controller = c;
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    expect(sent).toEqual(["queued"]);
    expect(workerPrompts).toHaveLength(2);
    expect(workerPrompts[1]).toContain("use the fake clock helper");
    expect(workerPrompts[1]).toContain("follow it over anything that contradicts it");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    const fb = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.feedback") as { delivery: string }[];
    expect(fb).toHaveLength(1);
    expect(fb[0]!.delivery).toBe("queued");
  });

  it("feedback arriving after a PASS is not merged away — it buys one more worker iteration", async () => {
    let controller!: RunController;
    let spoke = false;
    const { pool, workerPrompts } = watchedPool({
      during: (spec) => {
        if (spec.role === "qa" && !spoke) {
          spoke = true;
          controller.sendFeedback(spec.runId, spec.taskId!, "also bump the changelog before this ships");
        }
      },
    });
    const { store, controller: c } = controllerWith(pool);
    controller = c;
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    expect(workerPrompts).toHaveLength(2);
    expect(workerPrompts[1]).toContain("bump the changelog");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    const reasons = store
      .eventsSince(runId, 0)
      .map((e) => e.event)
      .filter((e) => e.type === "task.state_changed")
      .map((e) => (e as { reason: string }).reason);
    expect(reasons).toContain("operator feedback arrived after the PASS");
  });

  it("delivers straight into a live session when the pool has one, framed for the agent", async () => {
    let controller!: RunController;
    const injected: string[] = [];
    const sent: string[] = [];
    const { pool, workerPrompts } = watchedPool({
      during: (spec) => {
        if (spec.role === "worker" && sent.length === 0) {
          sent.push(controller.sendFeedback(spec.runId, spec.taskId!, "the flaky e2e suite is out of scope"));
        }
      },
    });
    (pool as unknown as { inject: unknown }).inject = (_runId: string, _taskId: string, text: string) => {
      injected.push(text);
      return { sessionId: "s-live", role: "worker" };
    };
    const { store, controller: c } = controllerWith(pool);
    controller = c;
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    expect(sent).toEqual(["live"]);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("[OPERATOR FEEDBACK");
    expect(injected[0]).toContain("out of scope");
    expect(injected[0]).toContain("output format");
    // Delivered live means NOT queued: one worker session, nothing re-dispatched.
    expect(workerPrompts).toHaveLength(1);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("reaches run-level agents by @role handle while they are live, and refuses once they are gone", async () => {
    // The planner has no task and no next dispatch — @planner feedback is
    // live-or-nothing.
    let controller!: RunController;
    const injected: string[] = [];
    const sent: string[] = [];
    const { pool } = watchedPool({});
    (pool as unknown as { inject: unknown }).inject = (_runId: string, target: string, text: string) => {
      if (target !== "@planner") return null;
      injected.push(text);
      return { sessionId: "s-planner", role: "planner" };
    };
    const { store, controller: c } = controllerWith(pool);
    controller = c;
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    sent.push(controller.sendFeedback(runId, "@planner", "focus on why CSS is not loading"));
    expect(sent).toEqual(["live"]);
    expect(injected[0]).toContain("[OPERATOR FEEDBACK");
    expect(injected[0]).toContain("CSS");
    expect(() => controller.sendFeedback(runId, "@intake", "hello?")).toThrow(/isn't running right now/);
    const fb = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.feedback") as { taskId: string }[];
    expect(fb.map((e) => e.taskId)).toEqual(["@planner"]);
  });

  it("rejects feedback no agent will ever read", async () => {
    const { pool } = watchedPool({});
    const { controller } = controllerWith(pool);
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    expect(() => controller.sendFeedback(runId, "task-a", "too late")).toThrow(/MERGED/);
    expect(() => controller.sendFeedback(runId, "no-such-task", "hello")).toThrow(/no task/);
    expect(() => controller.sendFeedback(runId, "task-a", "   ")).toThrow();
  });
});

describe("feedback that outlives the process", () => {
  /** A run parked on one task, built directly — the states sendFeedback branches on. */
  function parkedRun(store: Store): string {
    const runId = "run-1";
    store.createRun({ id: runId, repoPath: "/tmp/x", assignment: "do a thing", state: "PLANNING", prdPath: null, planHash: null, integrationBranch: "harness/run-1/main", config: RunConfig.parse({ deterministicChecks: [] }) });
    store.insertTasks(runId, [{ id: "epic-e", title: "E" }], [
      { id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], state: "PENDING", branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null },
    ]);
    store.transitionRun(runId, "PLAN_REVIEW");
    store.transitionRun(runId, "EXECUTING");
    store.transitionTask(runId, "task-a", "READY");
    store.transitionTask(runId, "task-a", "NEEDS_HUMAN", "QA rejected it 3 times");
    store.updateTask(runId, "task-a", { qaIterations: 3, errorSummary: "QA rejected it 3 times" });
    return runId;
  }

  it("survives a restart — the queue is a table, not a Map on the controller", () => {
    // The billing-app case: a note queued for a parked task is only read on a
    // later resume, in a later process. In memory it never got there.
    const dir = mkdtempSync(path.join(tmpdir(), "harness-fbdb-"));
    const file = path.join(dir, "harness.db");
    const first = new Store(file);
    first.queueFeedback("run-1", "task-a", "the failing check needs the service running");
    first.db.close();

    const second = new Store(file);
    expect(second.pendingFeedbackCount("run-1", "task-a")).toBe(1);
    expect(second.drainFeedback("run-1", "task-a")).toContain("needs the service running");
    // Consumed exactly once: a note replayed into every later prompt is noise.
    expect(second.drainFeedback("run-1", "task-a")).toBe("");
  });

  it("queues the same issue comment once however often the issue is polled", () => {
    const store = new Store(":memory:");
    expect(store.queueFeedback("run-1", "task-a", "AC5 is right, fix the IPv6 case", "issue", "9001")).toBe(true);
    expect(store.queueFeedback("run-1", "task-a", "AC5 is right, fix the IPv6 case", "issue", "9001")).toBe(false);
    // Operator notes carry no source id, so identical ones still both land.
    expect(store.queueFeedback("run-1", "task-a", "same words twice")).toBe(true);
    expect(store.queueFeedback("run-1", "task-a", "same words twice")).toBe(true);
    expect(store.pendingFeedbackCount("run-1", "task-a")).toBe(3);
  });

  it("answering a parked task reopens it while the run is still executing", () => {
    const { pool } = watchedPool({});
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, approveAll, repo());
    const runId = parkedRun(store);

    expect(controller.sendFeedback(runId, "task-a", "the suite was red before the run — skip it")).toBe("revived");
    const task = store.getTask(runId, "task-a")!;
    // Revived on the operator's terms: the scheduler takes READY tasks first,
    // and the answer buys a fresh set of iterations rather than one more try.
    expect(task.state).toBe("READY");
    expect(task.qaIterations).toBe(0);
    expect(task.errorSummary).toBeNull();
    expect(store.drainFeedback(runId, "task-a")).toContain("skip it");
  });

  it("still only queues once the scheduler has stopped watching", () => {
    const { pool } = watchedPool({});
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, approveAll, repo());
    const runId = parkedRun(store);
    store.transitionRun(runId, "INTEGRATING");
    store.transitionRun(runId, "PR_REVIEW");

    // Nothing is dispatching, so flipping the task to READY would strand it.
    // The note waits for `reopen` on the next resume — and now it gets there.
    expect(controller.sendFeedback(runId, "task-a", "answered after the run finished")).toBe("queued");
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(store.pendingFeedbackCount(runId, "task-a")).toBe(1);
  });

  it("reads comments on the task's issue into the worker's briefing", async () => {
    const polls: number[] = [];
    const comments = [{ id: 9001, author: "cigan", body: "the IPv6 gap QA found is real — fix isSafeWebhookUrl" }];
    const github = {
      enabled: true,
      async ensureIssue() {
        return { number: 52, url: "https://example.invalid/52" };
      },
      async ensurePR() {
        return null;
      },
      async issueComments(n: number) {
        polls.push(n);
        return comments;
      },
    } as unknown as GitHubAdapter;

    const { pool, workerPrompts } = watchedPool({ qaVerdicts: ['{"verdict":"FAIL","reasons":["still broken"],"mustFix":["fix it"]}'] });
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, github, approveAll, repo());
    await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    expect(polls).toEqual([52, 52]); // polled per iteration, cheaply
    expect(workerPrompts[0]).toContain("isSafeWebhookUrl");
    expect(workerPrompts[0]).toContain("cigan commented on issue #52");
    // Read twice, said once: the second dispatch must not repeat it.
    expect(workerPrompts[1]).not.toContain("isSafeWebhookUrl");
  });
});

describe("PromptStream", () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("stays open while a message waits to be delivered, then closes itself", async () => {
    const stream = new PromptStream("first");
    const seen: string[] = [];
    const consumed = (async () => {
      for await (const m of stream.stream()) seen.push(m.message.content as string);
    })();

    await tick();
    expect(seen).toEqual(["first"]);
    expect(stream.push("second")).toBe(true);
    stream.settle(); // result for "first" — "second" not yet delivered, stream stays open
    await tick();
    expect(seen).toEqual(["first", "second"]);
    stream.settle(); // result with nothing left to deliver — stream ends
    await consumed;
    expect(stream.push("too late")).toBe(false);
  });

  it("two messages folded into one answer still close the stream", async () => {
    // The wedged-QA incident: feedback pushed mid-turn gets answered together
    // with the message before it, so results arrive one short of messages.
    // Counting replies left the stream open forever; delivery-based closing
    // ends it on the first result that finds the queue empty.
    const stream = new PromptStream("first");
    const seen: string[] = [];
    const consumed = (async () => {
      for await (const m of stream.stream()) seen.push(m.message.content as string);
    })();

    await tick();
    stream.push("second");
    await tick(); // delivered — the CLI folds both into a single answer
    expect(seen).toEqual(["first", "second"]);
    stream.settle(); // the one and only result
    await consumed;
    expect(stream.push("too late")).toBe(false);
  });

  it("a session nobody talks to closes on its first result, like the old one-shot prompt", async () => {
    const stream = new PromptStream("only");
    const seen: string[] = [];
    const consumed = (async () => {
      for await (const m of stream.stream()) seen.push(m.message.content as string);
    })();
    await tick();
    stream.settle();
    await consumed;
    expect(seen).toEqual(["only"]);
  });
});
