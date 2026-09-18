import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const task = (id: string, dependsOn: string[] = []) => ({
  id,
  epicId: "epic-e",
  title: `Task ${id}`,
  spec: `Do ${id}`,
  acceptanceCriteria: ["works"],
  dependsOn,
  touchedPaths: [],
  estimatedSize: "S",
});
const dag = (tasks: object[]) => "```json\n" + JSON.stringify({ epics: [{ id: "epic-e", title: "E", summary: "s" }], tasks }) + "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-sched-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "charrette@example.com");
  gitIn(dir, "config", "user.name", "charrette");
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

describe("parallel scheduler", () => {
  it("dispatches independent tasks concurrently up to maxParallelWorkers, dependents after", async () => {
    let planning = 0;
    let active = 0;
    let peak = 0;
    const workedOrder: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") {
          resultText = planning++ === 0 ? DOCS : dag([task("task-a"), task("task-b"), task("task-c"), task("task-d", ["task-a", "task-b", "task-c"])]);
        } else if (spec.role === "worker") {
          active++;
          peak = Math.max(peak, active);
          workedOrder.push(spec.taskId!);
          // Hold the three independent workers until all three are in flight,
          // rather than sleeping and hoping they overlap. A fixed sleep makes the
          // overlap a property of machine load: with a busy event loop the first
          // worker's timer fires and its git commands finish before the third is
          // even dispatched, and the scheduler fails a test about the scheduler
          // for reasons that have nothing to do with it. task-d depends on the
          // other three, so it runs alone and must not wait for company.
          if (spec.taskId !== "task-d") {
            // Comfortably under the test's own timeout, so a scheduler that fails
            // to parallelise fails on `peak` with a readable assertion rather than
            // as an inscrutable timeout.
            const deadline = Date.now() + 3_000;
            while (active < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
          }
          writeFileSync(path.join(spec.cwd, `${spec.taskId}.txt`), "done\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", `wip ${spec.taskId}`);
          active--;
          resultText = "worker done";
        } else if (spec.role === "qa") {
          resultText = '{"verdict":"PASS","notes":"fine"}';
        } else {
          resultText = '{"verdict":"PASS","summary":"n/a"}';
        }
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    };
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool as unknown as AgentPool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do things", RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 3 }));

    const summary = store.listTasks(runId).map((t) => `${t.id}=${t.state}${t.errorSummary ? `(${t.errorSummary})` : ""}`).join(" ");
    expect(summary).toBe("task-a=MERGED task-b=MERGED task-c=MERGED task-d=MERGED");
    // The three independent tasks really overlapped — all three at once, which is
    // the cap — and only the dependent one had to wait.
    expect(peak).toBe(3);
    expect(workedOrder[3]).toBe("task-d");
  });

  it("keeps one-at-a-time execution when maxParallelWorkers is 1", async () => {
    let planning = 0;
    let active = 0;
    let peak = 0;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : dag([task("task-a"), task("task-b")]);
        else if (spec.role === "worker") {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          writeFileSync(path.join(spec.cwd, `${spec.taskId}.txt`), "done\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          active--;
          resultText = "worker done";
        } else if (spec.role === "qa") resultText = '{"verdict":"PASS","notes":"fine"}';
        else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    };
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool as unknown as AgentPool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do things", RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 1 }));
    expect(store.listTasks(runId).every((t) => t.state === "MERGED")).toBe(true);
    expect(peak).toBe(1);
  });

  /**
   * Run 40da9337, 23:18: 21 merged, 12 pending, three worker slots — and two of
   * the three held by tasks that had been waiting on a human answer for half an
   * hour. One worker actually ran, at $13 per 29 minutes.
   */
  it("does not let a task waiting at a gate hold a worker slot", async () => {
    let planning = 0;
    let working = 0;
    let peakWorking = 0;
    let releaseGate: (() => void) | undefined;
    let gateReached: () => void;
    const gateIsOpen = new Promise<void>((r) => {
      gateReached = r;
    });

    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "planner") {
          return { sessionId: "sp", resultText: planning++ === 0 ? DOCS : dag([task("task-a"), task("task-b")]), costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "worker") {
          working++;
          peakWorking = Math.max(peakWorking, working);
          // task-a stalls: its QA rejects forever, so it reaches the gate and
          // stays there until the test lets it go.
          writeFileSync(path.join(spec.cwd, `${spec.taskId}.txt`), `w${working}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          working--;
          return { sessionId: "sw", resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "qa") {
          const verdict =
            spec.taskId === "task-a"
              ? '{"verdict":"FAIL","reasons":["nope"],"mustFix":["fix"]}'
              : '{"verdict":"PASS","notes":"fine"}';
          return { sessionId: "sq", resultText: verdict, costUsd: 0, turns: 1, outcome: "done" };
        }
        return { sessionId: "sa", resultText: '{"recommendation":"r","checked":[]}', costUsd: 0, turns: 1, outcome: "done" };
      },
    };

    const store = new Store(":memory:");
    const gates: GateHandler = {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
      async resolveTaskGate() {
        // task-a is now parked on a human with the only worker slot the run has.
        gateReached();
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        return null; // park it, so the run can finish
      },
    };
    const controller = new RunController(store, new Bus(store), pool as unknown as AgentPool, noGithub, gates, repo());

    // One slot. Before the fix, task-b could not start until task-a's gate was
    // answered, because the gate held the only slot.
    // The gate must reach the handler for this test to be about slots at all:
    // a decider would answer it before it ever blocked on anyone.
    const finished = controller.startRun(
      "do things",
      RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 1, qaIterationCap: 1, taskGate: { decidedBy: "operator" } })
    );
    await gateIsOpen;
    // task-b must reach MERGED while task-a is still sitting at its gate.
    const deadline = Date.now() + 10_000;
    while (store.getTask(store.listRuns()[0]!.id, "task-b")?.state !== "MERGED" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const runId = store.listRuns()[0]!.id;
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-a")!.state).not.toBe("MERGED");

    releaseGate!();
    await finished;
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    // The gate freed the slot; it did not create a second concurrent worker.
    expect(peakWorking).toBe(1);
  });

  /**
   * Four tasks revived at 20:32-20:34 sat READY for eighteen minutes with two of
   * three slots idle, because the scheduler only re-listed the ready set when a
   * task *finished* and the one task still running was mid worker→QA→worker.
   */
  it("picks up a task revived from outside the loop without waiting for an in-flight task", async () => {
    let planning = 0;
    let releaseSlowWorker: (() => void) | undefined;
    let slowWorkerStarted: () => void;
    const slowWorkerIsRunning = new Promise<void>((r) => {
      slowWorkerStarted = r;
    });
    const workedAt = new Map<string, number>();

    const workerRuns: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "planner") {
          return { sessionId: "sp", resultText: planning++ === 0 ? DOCS : dag([task("task-slow"), task("task-parked")]), costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "worker") {
          workerRuns.push(spec.taskId!);
          workedAt.set(spec.taskId!, Date.now());
          if (spec.taskId === "task-slow") {
            slowWorkerStarted();
            // Holds its slot for the whole test: this is the unrelated task the
            // revived one used to have to wait out.
            await new Promise<void>((resolve) => {
              releaseSlowWorker = resolve;
            });
          }
          writeFileSync(path.join(spec.cwd, `${spec.taskId}.txt`), `run ${workerRuns.length}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          return { sessionId: "sw", resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "qa") {
          // task-parked fails its first pass and is parked at the gate below;
          // the operator's feedback is what revives it, and the second pass
          // passes.
          const fail = spec.taskId === "task-parked" && workerRuns.filter((t) => t === "task-parked").length === 1;
          return {
            sessionId: "sq",
            resultText: fail ? '{"verdict":"FAIL","reasons":["nope"],"mustFix":["fix"]}' : '{"verdict":"PASS","notes":"fine"}',
            costUsd: 0,
            turns: 1,
            outcome: "done",
          };
        }
        return { sessionId: "sa", resultText: '{"recommendation":"r","checked":[]}', costUsd: 0, turns: 1, outcome: "done" };
      },
    };

    const store = new Store(":memory:");
    const controller = new RunController(
      store,
      new Bus(store),
      pool as unknown as AgentPool,
      noGithub,
      {
        ...approveAll,
        // Park it rather than answer: this is how a task ends up NEEDS_HUMAN
        // while the run is still executing.
        async resolveTaskGate() {
          return null;
        },
      },
      repo()
    );
    // Two slots, so once task-parked parks there is a free one — and nothing
    // runnable to put in it. That is exactly the state the loop used to sleep in.
    const finished = controller.startRun(
      "do things",
      // Parking is the state this test needs, so the gate is the operator's.
      RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 2, qaIterationCap: 1, taskGate: { decidedBy: "operator" } })
    );
    await slowWorkerIsRunning;

    const runId = store.listRuns()[0]!.id;
    const parkedBy = Date.now() + 10_000;
    while (store.getTask(runId, "task-parked")!.state !== "NEEDS_HUMAN" && Date.now() < parkedBy) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(store.getTask(runId, "task-parked")!.state).toBe("NEEDS_HUMAN");

    // The live path an operator takes when they answer a parked task mid-run.
    expect(controller.sendFeedback(runId, "task-parked", "here is what you were missing")).toBe("revived");

    // It must be worked again while task-slow is still holding its own slot —
    // without the wake, the loop is blocked on task-slow's promise and will not
    // look at the ready set until task-slow finishes.
    const revivedBy = Date.now() + 8_000;
    while (workerRuns.filter((t) => t === "task-parked").length < 2 && Date.now() < revivedBy) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(workerRuns.filter((t) => t === "task-parked").length).toBe(2);
    expect(workedAt.has("task-slow")).toBe(true);

    releaseSlowWorker!();
    await finished;
    expect(store.getTask(runId, "task-parked")!.state).toBe("MERGED");
  }, 30_000);

  it("resumes the worker's SDK session after a QA rejection, and only then", async () => {
    let planning = 0;
    let qaCalls = 0;
    const workerSpecs: AgentSpec[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        let sdkSessionId: string | undefined;
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : dag([task("task-a")]);
        else if (spec.role === "worker") {
          workerSpecs.push(spec);
          sdkSessionId = `sdk-${workerSpecs.length}`;
          writeFileSync(path.join(spec.cwd, "w.txt"), `iteration ${workerSpecs.length}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else if (spec.role === "qa") {
          resultText = ++qaCalls === 1 ? '{"verdict":"FAIL","reasons":["missing test"],"mustFix":["add a test"]}' : '{"verdict":"PASS","notes":"fine"}';
        } else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, sdkSessionId, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    };
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool as unknown as AgentPool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do things", RunConfig.parse({ deterministicChecks: [] }));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(workerSpecs).toHaveLength(2);
    // First dispatch is cold; the re-dispatch re-attaches to the first session
    // and carries only the rejection, not the whole task brief again.
    expect(workerSpecs[0]!.resume).toBeUndefined();
    expect(workerSpecs[1]!.resume).toBe("sdk-1");
    expect(workerSpecs[1]!.prompt).toContain("previous session on this task continues");
    expect(workerSpecs[1]!.prompt).toContain("missing test");
  });
});
