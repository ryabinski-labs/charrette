import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import type { TaskRow } from "./store.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      { id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
      { id: "task-b", epicId: "epic-e", title: "B", spec: "s", acceptanceCriteria: ["x"], dependsOn: ["task-a"], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
    ],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-resume-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "harness@example.com");
  gitIn(dir, "config", "user.name", "harness");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

const noGithub = { enabled: false } as unknown as GitHubAdapter;

function gates(onTaskGate?: (g: { taskId: string; why: string }) => Promise<string | null>): GateHandler {
  return {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    ...(onTaskGate ? { resolveTaskGate: onTaskGate } : {}),
  };
}

/** Plans, worker commits, QA always FAILs — the doomed first run. */
function failingPool() {
  let planning = 0;
  let attempts = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
      else if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${++attempts}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") resultText = '{"verdict":"FAIL","reasons":["still wrong"],"mustFix":["fix it"]}';
      else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return pool as unknown as AgentPool;
}

/** The environment fixed: worker commits, QA passes, validator passes. */
function healedPool() {
  const workerPrompts: string[] = [];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "worker") {
        workerPrompts.push(spec.prompt);
        writeFileSync(path.join(spec.cwd, `fixed-${path.basename(spec.cwd)}.txt`), "done right\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "fixed");
        resultText = "worker done";
      } else if (spec.role === "qa") resultText = '{"verdict":"PASS"}';
      else resultText = '{"verdict":"PASS","summary":"all delivered"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts };
}

/** A run that ended PR_REVIEW with task-a parked and task-b cancelled as unreachable. */
async function parkedRun() {
  const repoPath = repo();
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const first = new RunController(store, bus, failingPool(), noGithub, gates(), repoPath);
  const runId = await first.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1 }));
  expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  expect(store.getTask(runId, "task-b")!.state).toBe("CANCELLED");
  return { repoPath, store, bus, runId };
}

describe("surviving agent crashes", () => {
  it("parks the task when the QA agent keeps crashing, and finishes the rest of the run", async () => {
    // The QA pool.run used to be the one agent call with no catch around it: a
    // dead QA process killed the whole harness and froze the run in EXECUTING.
    const repoPath = repo();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    let planning = 0;
    let attempts = 0;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "qa") throw new Error("Claude Code process exited with code 1");
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
        else if (spec.role === "worker") {
          writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${++attempts}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;
    const controller = new RunController(store, bus, pool, noGithub, gates(), repoPath);

    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [] }));

    // The run closed instead of crashing; the un-verifiable task parked with the
    // crash on record, and its dependent was cancelled as unreachable.
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    const taskA = store.getTask(runId, "task-a")!;
    expect(taskA.state).toBe("NEEDS_HUMAN");
    expect(taskA.errorSummary).toContain("exited with code 1");
    expect(store.getTask(runId, "task-b")!.state).toBe("CANCELLED");
  });
});

describe("resuming a finished run", () => {
  it("reopens parked tasks through the gate, and the answer carries the whole run to completion", async () => {
    // The reported experience, end to end: the run died parked, the operator knew
    // the one-sentence fix, and `resume` is where they finally get to say it.
    const { repoPath, store, bus, runId } = await parkedRun();

    const asked: string[] = [];
    const { pool, workerPrompts } = healedPool();
    const controller = new RunController(store, bus, pool, noGithub, gates(async (g) => {
      asked.push(g.why);
      return "the tests needed DynamoDB running — it is up now, re-run them";
    }), repoPath);

    expect(controller.hasRecoverableWork(runId)).toBe(true);
    await controller.resume(runId);

    // The gate asked about the parked task, the answer reached the worker, and
    // the previously-unreachable dependent came back and ran too.
    expect(asked).toHaveLength(1);
    expect(workerPrompts[0]).toContain("DynamoDB");
    expect(workerPrompts[0]).toContain("parked");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    // The reopened run is judged against the intent like any other.
    const events = store.eventsSince(runId, 0).map((e) => e.event);
    expect(events.some((e) => e.type === "run.intent_verdict")).toBe(true);
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });

  it("leaves everything parked when the operator declines, and the run closes again", async () => {
    const { repoPath, store, bus, runId } = await parkedRun();
    const { pool, workerPrompts } = healedPool();
    const controller = new RunController(store, bus, pool, noGithub, gates(async () => null), repoPath);

    await controller.resume(runId);

    expect(workerPrompts).toHaveLength(0);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(store.getTask(runId, "task-b")!.state).toBe("CANCELLED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("revives cancelled tasks whose blockers have since merged, no gate needed", async () => {
    // The marrymath shape: the parked dependency was revived and merged in an
    // earlier session, but its "unreachable" cancelled dependents stayed
    // cancelled forever — and the intent validator kept failing the run for
    // exactly the work they would have done.
    const { repoPath, store, bus, runId } = await parkedRun();
    for (const s of ["READY", "WORKING", "QA", "ACCEPTED", "MERGED"] as const) store.transitionTask(runId, "task-a", s);

    const asked: string[] = [];
    const { pool, workerPrompts } = healedPool();
    const controller = new RunController(store, bus, pool, noGithub, gates(async (g) => {
      asked.push(g.why);
      return "should not be asked";
    }), repoPath);

    expect(controller.hasRecoverableWork(runId)).toBe(true);
    await controller.resume(runId);

    expect(asked).toHaveLength(0); // nothing is parked; there is nothing to ask about
    expect(workerPrompts).toHaveLength(1); // only task-b ran
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });

  it("gives a revived cancelled task a fresh set of attempts, not the strikes from its last life", async () => {
    // Run bc691359: `cp-no-third-party-test` failed QA twice, was swept as
    // "unreachable" when its dependency parked, and came back four days later
    // when that dependency merged. It dispatched carrying both old strikes
    // against a cap of three, so its first honest failure in a world where the
    // work it needed finally existed would have parked it — for iterations
    // spent before any of that work was there to build on.
    //
    // The parked-task branch above this one has always reset these counters.
    // This branch is the same claim: the task is starting over.
    const { repoPath, store, bus, runId } = await parkedRun();
    for (const s of ["READY", "WORKING", "QA", "ACCEPTED", "MERGED"] as const) store.transitionTask(runId, "task-a", s);
    store.updateTask(runId, "task-b", {
      qaIterations: 2, respawns: 1, emptyDeliveries: 1, conflictFixes: 1, errorSummary: "failed in a previous life",
    });

    // The counters have to be read when the revived task is dispatched, not
    // when the run ends: `qaIterations` counts QA rounds rather than failures,
    // so a task that sails through still finishes on 1.
    let atDispatch: TaskRow | undefined;
    const inner = healedPool().pool;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "worker") atDispatch ??= store.getTask(runId, "task-b");
        return inner.run(spec);
      },
    } as unknown as AgentPool;
    const controller = new RunController(store, bus, pool, noGithub, gates(), repoPath);
    await controller.resume(runId);

    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    expect(atDispatch).toMatchObject({
      qaIterations: 0, respawns: 0, emptyDeliveries: 0, conflictFixes: 0, errorSummary: null,
    });
  });

  it("requeues tasks a dead harness process left mid-flight instead of cancelling them", async () => {
    // The sendant shape: the QA agent's process died mid-verdict, the whole
    // harness went down with it, and the run froze in EXECUTING with the task
    // in QA — where the scheduler used to cancel it as "unreachable" despite a
    // worktree full of finished, checks-green work.
    const { repoPath, store, bus, runId } = await parkedRun();
    for (const s of ["READY", "WORKING", "QA"] as const) store.transitionTask(runId, "task-a", s);
    store.transitionRun(runId, "EXECUTING", "simulating a process that died mid-task");

    const { pool, workerPrompts } = healedPool();
    const controller = new RunController(store, bus, pool, noGithub, gates(), repoPath);
    await controller.resume(runId);

    expect(workerPrompts).toHaveLength(1);
    expect(workerPrompts[0]).toContain("interrupted");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    // task-b was cancelled as unreachable back when task-a parked; now that
    // task-a is merged, the next resume can revive it.
    expect(controller.hasRecoverableWork(runId)).toBe(true);
  });

  it("is honest about runs with nothing to recover", async () => {
    const { repoPath, store, bus, runId } = await parkedRun();
    // Park resolved by cancellation: the operator gave up on the task for good.
    store.transitionTask(runId, "task-a", "CANCELLED", "operator abandoned it");
    const controller = new RunController(store, bus, healedPool().pool, noGithub, gates(), repoPath);
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });
});

describe("resuming a run whose planning phase failed", () => {
  /** A run that never got past planning: every planner attempt came back unusable. */
  async function failedPlanning() {
    const repoPath = repo();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const pool = {
      async run(): Promise<AgentResult> {
        return { sessionId: `s${Math.random()}`, resultText: "not a plan", costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;
    const controller = new RunController(store, bus, pool, noGithub, gates(), repoPath);
    await expect(controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [] }))).rejects.toThrow(/planner attempts rejected/);
    const runId = store.listRuns()[0]!.id;
    expect(store.getRun(runId)!.state).toBe("FAILED");
    return { repoPath, store, bus, runId };
  }

  it("plans again instead of making the operator start over", async () => {
    // Run f338b5c8: three planner attempts died on the account's usage limit,
    // the run ended `harness: fatal`, and `harness resume` said there was
    // nothing to resume — so the only way on was a new run and the whole intake
    // conversation a second time.
    const { repoPath, store, bus, runId } = await failedPlanning();
    expect(store.listTasks(runId)).toHaveLength(0);

    let planning = 0;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
        else if (spec.role === "worker") {
          writeFileSync(path.join(spec.cwd, `feature-${path.basename(spec.cwd)}.txt`), "work\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else if (spec.role === "qa") resultText = '{"verdict":"PASS"}';
        else resultText = '{"verdict":"PASS","summary":"all delivered"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;
    const controller = new RunController(store, bus, pool, noGithub, gates(), repoPath);
    expect(controller.replannable(runId)).toBe(true);

    await controller.resume(runId);

    // The same run, carried to the end — same id, same assignment, no second
    // intake — with the phase that failed simply done again.
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(controller.replannable(runId)).toBe(false);
  });

  it("leaves a run that failed with work already in flight closed", async () => {
    const { repoPath, store, bus, runId } = await parkedRun();
    // A run with tasks has state a re-plan would talk over; `resume` reaches it
    // through the escalation gate instead, and this door stays shut.
    store.db.prepare("UPDATE runs SET state = 'FAILED' WHERE id = ?").run(runId);
    const controller = new RunController(store, bus, healedPool().pool, noGithub, gates(), repoPath);
    expect(controller.replannable(runId)).toBe(false);
  });
});

/**
 * Run bc691359: a task passed QA, its merge into the integration branch was
 * refused by a dirty worktree rather than a conflict, and the harness process
 * ended while the operator was being asked about it — leaving the task ACCEPTED.
 *
 * Nothing dispatches an ACCEPTED task, so the resumed run found it neither
 * runnable nor in flight, swept it as "unreachable: dependencies parked", and
 * tried to cancel it. That is not a legal move from ACCEPTED, and the throw did
 * not park the task — it killed the run, sixty merged tasks and all:
 *
 *     harness: fatal — task m1-exit-evidence: ACCEPTED -> CANCELLED
 */
describe("a task left accepted by a harness process that died", () => {
  it("requeues it on resume instead of sweeping it away, and its work merges", async () => {
    const { repoPath, store, bus, runId } = await parkedRun();
    // Exactly the state the dead process left behind: QA had passed the work,
    // and the merge that was to follow never happened.
    store.transitionTask(runId, "task-a", "READY", "revived for the fixture");
    store.transitionTask(runId, "task-a", "WORKING", "revived for the fixture");
    store.transitionTask(runId, "task-a", "QA", "revived for the fixture");
    store.transitionTask(runId, "task-a", "ACCEPTED", "QA passed; the process died before the merge");
    // And the run itself is mid-execution, which is where a killed process
    // leaves it — `harness resume` reported exactly this: "[EXECUTING]".
    store.db.prepare("UPDATE runs SET state = 'EXECUTING' WHERE id = ?").run(runId);

    const { pool, workerPrompts } = healedPool();
    const controller = new RunController(store, bus, pool, noGithub, gates(async () => null), repoPath);
    await controller.resume(runId);

    // It ran, it merged, and the run reached its end rather than dying on the
    // illegal transition.
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    // The worker is told its work already passed QA, so it does not set about
    // rewriting a task it had in fact finished.
    expect(workerPrompts[0]).toContain("already passed QA");
    expect(workerPrompts[0]).toContain("do not rewrite it");
  });
});

describe("two harness processes on one run", () => {
  /**
   * Run bc691359 was found with two `harness resume bc691359` processes alive at
   * once, started an hour and fifty-four minutes apart. The second one's requeue
   * sweeper — which opens `execute` on the premise that "this controller is the
   * only runner, so nothing can actually be WORKING" — moved a task the first
   * was still running from WORKING to READY. Twelve minutes later the first
   * finished its checks and tried WORKING -> QA, found READY, and threw
   * InvalidTransition; the catch parked the task as NEEDS_HUMAN. The worker had
   * already committed the entire job and reported it clean.
   *
   * So the second one has to be turned away while the first still holds the run,
   * and the first has to be left driving.
   */
  it("refuses the second, and does not disturb the first", async () => {
    const repoPath = repo();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    let refusal: Error | null = null;
    let planning = 0;
    // The second harness arrives mid-task, which is the only moment the damage
    // is possible: the first controller is between WORKING and QA.
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
        else if (spec.role === "worker") {
          if (!refusal) {
            const second = new RunController(store, bus, pool as unknown as AgentPool, noGithub, gates(), repoPath);
            await second.resume(spec.runId).catch((e: Error) => {
              refusal = e;
            });
          }
          writeFileSync(path.join(spec.cwd, `feature-${path.basename(spec.cwd)}.txt`), "work\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else if (spec.role === "qa") resultText = '{"verdict":"PASS"}';
        else resultText = '{"verdict":"PASS","summary":"all delivered"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    };
    const first = new RunController(store, bus, pool as unknown as AgentPool, noGithub, gates(), repoPath);
    const runId = await first.startRun("do a thing", RunConfig.parse({ deterministicChecks: [] }));

    expect(refusal).not.toBeNull();
    expect(refusal!.name).toBe("RunLocked");
    expect(refusal!.message).toContain("already being driven by harness pid");
    // The first run is untouched: both tasks went the whole way, which is what
    // the second one's sweeper took away when nothing stopped it.
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
  });

  /** And the run is drivable again the moment the first process lets go. */
  it("lets the next process in once the first has finished", async () => {
    const repoPath = repo();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const first = new RunController(store, bus, failingPool(), noGithub, gates(), repoPath);
    const runId = await first.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1 }));
    const { pool } = healedPool();
    const second = new RunController(store, bus, pool, noGithub, gates(async () => "try again"), repoPath);
    await expect(second.resume(runId)).resolves.not.toThrow();
  });
});
