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
