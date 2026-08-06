import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { advisorAnswer } from "./prompts.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" }],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-gate-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "harness@example.com");
  gitIn(dir, "config", "user.name", "harness");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

/** Planner plans; the worker commits; QA rejects every iteration, forever. */
function rejectingPool() {
  let planning = 0;
  const workerPrompts: string[] = [];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
      else if (spec.role === "worker") {
        workerPrompts.push(spec.prompt);
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") resultText = '{"verdict":"FAIL","reasons":["still wrong"],"mustFix":["fix it"]}';
      else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts };
}

/** Planner plans; the worker commits; every QA session dies at its turn ceiling. */
function truncatingQaPool() {
  let planning = 0;
  const workerPrompts: string[] = [];
  const qaSpecs: AgentSpec[] = [];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "planner") {
        return { sessionId: "sp", resultText: planning++ === 0 ? DOCS : DAG, costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "worker") {
        workerPrompts.push(spec.prompt);
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        return { sessionId: "sw", resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "qa") {
        qaSpecs.push(spec);
        // What the SDK actually hands back: a result message, no verdict in it.
        return { sessionId: "sq", resultText: "Let me check the audio session…", costUsd: 0, turns: spec.maxTurns ?? 0, outcome: "error", errorDetail: "error_max_turns" };
      }
      return { sessionId: "sx", resultText: '{"verdict":"PASS","summary":"n/a"}', costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts, qaSpecs };
}

const noGithub = { enabled: false } as unknown as GitHubAdapter;

function gates(onTaskGate?: (why: string) => Promise<string | null>): GateHandler {
  return {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    ...(onTaskGate ? { resolveTaskGate: (g: { why: string }) => onTaskGate(g.why) } : {}),
  };
}

/**
 * `decidedBy: "operator"` unless a test says otherwise: most of these are about
 * the gate a person answers, and the default (`product-manager`) would answer
 * it before they saw it. The tests that exercise the decider set it back.
 */
async function run(handler: GateHandler, pool: AgentPool, over: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const controller = new RunController(store, bus, pool, noGithub, handler, repo());
  const runId = await controller.startRun(
    "do a thing",
    RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1, taskGate: { decidedBy: "operator" }, ...over })
  );
  return { store, runId, controller };
}

afterEach(() => vi.restoreAllMocks());

describe("the task-escalation gate", () => {
  it("asks the operator at the cap, and their answer buys the worker a fresh set of iterations", async () => {
    // The reported experience: three tasks parked, the operator knew exactly what
    // was wrong, and had no way to say so — the run was already over.
    const asked: string[] = [];
    let answers: (string | null)[] = ["the tests need DynamoDB running — start it with podman compose", null];
    const { pool, workerPrompts } = rejectingPool();
    const { store, runId } = await run(
      gates(async (why) => {
        asked.push(why);
        return answers.shift() ?? null;
      }),
      pool
    );

    // Asked twice: once answered (worker re-ran with the guidance), once parked.
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/QA rejected it 1 times/);
    expect(workerPrompts).toHaveLength(2);
    expect(workerPrompts[1]).toContain("the tests need DynamoDB running");
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");

    const events = store.eventsSince(runId, 0).map((e) => e.event);
    const opened = events.filter((e) => e.type === "task.gate_opened");
    const resolved = events.filter((e) => e.type === "task.gate_resolved") as { parked: boolean; guidance: string }[];
    expect(opened).toHaveLength(2);
    expect(resolved.map((r) => r.parked)).toEqual([false, true]);
    expect(resolved[0]!.guidance).toContain("DynamoDB");
  });

  it("attaches the advisor's draft answer to the gate, so the operator can approve instead of investigate", async () => {
    let planning = 0;
    const workerPrompts: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
        else if (spec.role === "worker") {
          workerPrompts.push(spec.prompt);
          writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else if (spec.role === "qa") resultText = '{"verdict":"FAIL","reasons":["still wrong"],"mustFix":["fix it"]}';
        else if (spec.role === "advisor") resultText = '```json\n{"recommendation":"the suite needs DynamoDB \\u2014 start it with podman compose, then re-run"}\n```';
        else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const seen: string[] = [];
    const handler: GateHandler = {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
      // The one-click accept: the operator sends the suggestion back verbatim.
      async resolveTaskGate(g) {
        seen.push(g.recommendation);
        return seen.length === 1 ? g.recommendation : null;
      },
    };
    const { store, runId } = await run(handler, pool);

    expect(seen[0]).toContain("DynamoDB");
    // Accepting the suggestion is real guidance: the worker re-ran with it.
    expect(workerPrompts).toHaveLength(2);
    expect(workerPrompts[1]).toContain("DynamoDB");
    const opened = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.gate_opened") as { recommendation: string }[];
    expect(opened[0]!.recommendation).toContain("podman compose");
  });

  it("carries the advisor's checked claims into the answer, so a one-click accept reaches the worker with them", async () => {
    // The failure this fixes: QA's rejection named three findings, one of them a
    // real key mismatch. The draft compressed it to the headline gap, the
    // operator accepted in one click, and the worker was re-dispatched never
    // having heard about the defect — which then merged.
    let planning = 0;
    const workerPrompts: string[] = [];
    const advisorPrompts: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
        else if (spec.role === "worker") {
          workerPrompts.push(spec.prompt);
          writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else if (spec.role === "qa") resultText = '{"verdict":"FAIL","reasons":["still wrong"],"mustFix":["fix it"]}';
        else if (spec.role === "advisor") {
          advisorPrompts.push(spec.prompt);
          resultText =
            "```json\n" +
            JSON.stringify({
              recommendation: "Fix the key first, then write the integration test.",
              checked: [
                { claim: "keys.cogs PK does not match the route's order PK", status: "confirmed", evidence: "keys.ts:214 vs orders.ts:60" },
                { claim: "the suite is red before the run", status: "refuted", evidence: "290/290 green on a clean checkout" },
                { claim: "the /complete route double-posts on replay", status: "unverified", evidence: "no test exercises it" },
              ],
            }) +
            "\n```";
        } else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const seen: string[] = [];
    const handler: GateHandler = {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
      async resolveTaskGate(g) {
        seen.push(g.recommendation);
        return seen.length === 1 ? g.recommendation : null;
      },
    };
    await run(handler, pool);

    // Every claim reaches the operator, labelled with what the advisor did about
    // it — a refuted one loudest, since that is the worker's only way to learn
    // not to chase something QA asserted.
    const draft = seen[0]!;
    expect(draft).toContain("Fix the key first");
    expect(draft).toContain("CONFIRMED — keys.cogs PK does not match");
    expect(draft).toContain("keys.ts:214 vs orders.ts:60");
    expect(draft).toContain("REFUTED — the suite is red before the run");
    expect(draft).toContain("UNVERIFIED — the /complete route double-posts on replay");

    // And it survives the accept: the worker's next attempt is briefed on all of it.
    expect(workerPrompts).toHaveLength(2);
    expect(workerPrompts[1]).toContain("CONFIRMED — keys.cogs PK does not match");
    expect(workerPrompts[1]).toContain("REFUTED");
  });

  it("leaves the answer alone when the advisor checked nothing", async () => {
    // No bare "What the advisor checked" heading over an empty list: the draft
    // is what the operator sends, and a heading with nothing under it reads as
    // a verification that happened and found nothing.
    expect(advisorAnswer("just restart the service", [])).toBe("just restart the service");
    expect(advisorAnswer("just restart the service", [{ claim: "" } as never])).toBe("just restart the service");
    expect(advisorAnswer("do the thing", [{ claim: "X is wrong" }])).toContain("UNVERIFIED — X is wrong");
  });

  it("spends its length budget on the checks, not the prose", () => {
    // The advisor answer is capped before it reaches the operator. A rambling
    // recommendation must not push the refutations off the end — those are the
    // half the worker cannot work out for itself.
    const answer = advisorAnswer("x".repeat(5000), [{ claim: "the key is wrong", status: "refuted", evidence: "keys.ts:12" }], 4000);
    expect(answer.length).toBeLessThanOrEqual(4000);
    expect(answer).toContain("REFUTED — the key is wrong (keys.ts:12)");
    // And a bare recommendation is still bounded.
    expect(advisorAnswer("y".repeat(5000), [], 4000)).toHaveLength(4000);
  });

  it("parks immediately under a handler that cannot ask, exactly as before the gate existed", async () => {
    const { pool, workerPrompts } = rejectingPool();
    const { store, runId } = await run(gates(), pool);

    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(workerPrompts).toHaveLength(1);
    const events = store.eventsSince(runId, 0).map((e) => e.event);
    expect(events.some((e) => e.type === "task.gate_opened")).toBe(false);
    // Nothing merged, so the validator has nothing to judge and spends nothing.
    expect(events.some((e) => e.type === "run.intent_verdict")).toBe(false);
  });

  it("does not blame the worker for a QA session that never returned a verdict", async () => {
    // The failure this fixes: three QA sessions died at their turn ceiling, each
    // was booked as a FAIL ("QA output unparseable"), and the task parked after
    // sending the worker back three times to fix code nobody had judged.
    const { pool, workerPrompts, qaSpecs } = truncatingQaPool();
    const asked: string[] = [];
    const { store, runId } = await run(gates(async (why) => { asked.push(why); return null; }), pool);

    // The verdict counter never moves: a truncated session judged nothing.
    expect(store.getTask(runId, "task-a")!.qaIterations).toBe(0);
    expect(store.eventsSince(runId, 0).map((e) => e.event).some((e) => e.type === "task.qa_verdict")).toBe(false);
    // It is still bounded — by the respawn cap, which is what it is for.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/QA ended without a verdict 3 times/);
    expect(asked[0]).not.toMatch(/rejected/);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");

    // And the worker is told the truth: nothing was found wrong with its work.
    expect(workerPrompts).toHaveLength(3);
    expect(workerPrompts[1]).toContain("ended without a verdict");
    expect(workerPrompts[1]).toContain("never judged");

    // Replaying a truncated verification at the same ceiling truncates it again.
    expect(qaSpecs.map((s) => s.maxTurns)).toEqual([90, 135, 203]);
  });

  it("still counts a QA session that finished and wrote something that is not a verdict", async () => {
    // The other half: an agent that ignored its output contract is a real finding
    // about the run, and must keep costing an iteration rather than looping free.
    let planning = 0;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
        else if (spec.role === "worker") {
          writeFileSync(path.join(spec.cwd, "feature.txt"), "work\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else if (spec.role === "qa") resultText = "Looks good to me!";
        else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const asked: string[] = [];
    const { store, runId } = await run(gates(async (why) => { asked.push(why); return null; }), pool);
    expect(store.getTask(runId, "task-a")!.qaIterations).toBe(1);
    expect(asked[0]).toMatch(/QA rejected it 1 times \(the cap\): QA finished but wrote no valid verdict JSON/);
  });

  it("does not charge the task for the hours the operator spent deciding", async () => {
    // Run 40da9337: three tasks waited overnight at a gate. The operator answered
    // all three at 06:17 and all three re-gated at 06:18 — the 45-minute wall
    // clock had been running the whole time they were blocked on a human, so the
    // answer was spent the instant it arrived. Answer, re-ask, forever.
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const asked: string[] = [];
    const { pool } = rejectingPool();
    const { store, runId } = await run(
      gates(async (why) => {
        asked.push(why);
        // The operator goes to bed. Two hours, against a 45-minute bound.
        clock += 2 * 60 * 60_000;
        return asked.length === 1 ? "the suite was red before you started — ignore it" : null;
      }),
      pool
    );

    // The second question is the next real one, not the clock complaining about
    // time the task did not spend.
    expect(asked).toHaveLength(2);
    expect(asked.map((w) => /wall clock/.test(w))).toEqual([false, false]);
    expect(asked[1]).toMatch(/QA rejected it 1 times/);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });

  it("re-arms the clock when a gate is answered, rather than only crediting the wait", async () => {
    /**
     * The stronger half of the same bug, and the one giving back thinking time
     * did not fix: the hours *before* the question still counted. A task that
     * gated on failing checks at minute 44 of a 45-minute bound came back with
     * an answer and one minute of credit, and re-gated inside the next
     * iteration — asking the operator about the answer they had just given.
     *
     * 19 of the 77 gates in run 40da9337 are this: a wall-clock gate opening
     * immediately after a different gate on the same task.
     */
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    let planning = 0;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "planner") return { sessionId: "sp", resultText: planning++ === 0 ? DOCS : DAG, costUsd: 0, turns: 1, outcome: "done" };
        if (spec.role === "worker") {
          writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${clock}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          return { sessionId: "sw", resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "qa") {
          // A slow iteration — the bound is blown by the time QA answers.
          clock += 50 * 60_000;
          return { sessionId: "sq", resultText: '{"verdict":"FAIL","reasons":["still wrong"],"mustFix":["fix it"]}', costUsd: 0, turns: 1, outcome: "done" };
        }
        return { sessionId: "sa", resultText: '{"recommendation":"try again","checked":[]}', costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const asked: string[] = [];
    const store = new Store(":memory:");
    const controller = new RunController(
      store,
      new Bus(store),
      pool,
      noGithub,
      // Answer the first question instantly — no thinking time to credit, so
      // only a real re-arming of the clock can keep the next gate off it.
      gates(async (why) => {
        asked.push(why);
        return asked.length === 1 ? "the partition key is the one to look at" : null;
      }),
      repo()
    );
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1 }));

    expect(asked).toHaveLength(2);
    expect(asked.every((w) => /QA rejected it 1 times/.test(w))).toBe(true);
    expect(asked.some((w) => /wall clock/.test(w))).toBe(false);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });

  /**
   * The wall-clock gate is the one gate that does not know its own cause: it
   * fires because time passed, and it used to say only that. The advisor then
   * drafted the operator's answer with no failure in front of it — on
   * cost-and-risk-reporting it read the worktree line by line, confirmed five
   * acceptance criteria and left the two that mattered UNVERIFIED, while the
   * rejection that pointed straight at them was one frame up the stack.
   */
  it("tells the advisor why the last iteration was sent back when a task gates on the clock", async () => {
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    let planning = 0;
    const advisorPrompts: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "planner") {
          return { sessionId: "sp", resultText: planning++ === 0 ? DOCS : DAG, costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "worker") {
          writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${clock}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          return { sessionId: "sw", resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "qa") {
          // A slow iteration: QA judges, and the task is now over its bound.
          clock += 50 * 60_000;
          return {
            sessionId: "sq",
            resultText: '{"verdict":"FAIL","reasons":["the returns ledger writes under the wrong partition key"],"mustFix":["use keys.returnRateCounter"]}',
            costUsd: 0,
            turns: 1,
            outcome: "done",
          };
        }
        advisorPrompts.push(spec.prompt);
        return { sessionId: "sa", resultText: '{"recommendation":"look at the key","checked":[]}', costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const asked: string[] = [];
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const controller = new RunController(
      store,
      bus,
      pool,
      noGithub,
      gates(async (why) => {
        asked.push(why);
        return null;
      }),
      repo()
    );
    // Two iterations allowed, so the first rejection does not gate on the cap and
    // the clock is what stops the task.
    const runId = await controller.startRun(
      "do a thing",
      RunConfig.parse({ deterministicChecks: [], qaIterationCap: 2, taskGate: { decidedBy: "operator" } })
    );

    const clockGate = asked.find((w) => /wall clock/.test(w));
    expect(clockGate).toBeDefined();
    expect(clockGate).toContain("Why the last iteration was sent back");
    expect(clockGate).toContain("the returns ledger writes under the wrong partition key");
    expect(clockGate).toContain("use keys.returnRateCounter");
    // The whole point: it reaches the agent drafting the operator's answer.
    expect(advisorPrompts.some((p) => p.includes("the returns ledger writes under the wrong partition key"))).toBe(true);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });

  it("treats a blank answer as parking, not as guidance", async () => {
    // An empty string handed to the worker as "the operator's guidance" would be
    // worse than parking: another full iteration set spent on no new information.
    const { pool, workerPrompts } = rejectingPool();
    const { store, runId } = await run(gates(async () => "   "), pool);

    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(workerPrompts).toHaveLength(1);
  });
});

/** rejectingPool, plus an advisor that answers with whatever JSON is passed. */
function decidingPool(advisorJson: () => string) {
  const workerPrompts: string[] = [];
  const advisorSystems: string[] = [];
  let planning = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
      else if (spec.role === "worker") {
        workerPrompts.push(spec.prompt);
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") resultText = '{"verdict":"FAIL","reasons":["still wrong"],"mustFix":["fix it"]}';
      else if (spec.role === "advisor") {
        advisorSystems.push(spec.systemPrompt);
        resultText = advisorJson();
      } else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts, advisorSystems };
}

/**
 * A task whose definition of done cannot be met: `nope.txt` is not a file any
 * worker in this fixture writes, so the probe fails on every iteration however
 * good the work is. This is run f338b5c8's `! rg -qi 'passkey|webauthn' src`
 * with the incidentals removed.
 */
const PROBE_DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "test -f nope.txt", estimatedSize: "S" }],
  }) +
  "\n```";

/** PROBE_DAG, a worker that writes `feature.txt`, and an advisor under test. */
function probePool(advisorJson: (round: number) => string) {
  const workerPrompts: string[] = [];
  let planning = 0;
  let advising = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : PROBE_DAG;
      else if (spec.role === "worker") {
        workerPrompts.push(spec.prompt);
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") resultText = '{"verdict":"FAIL","reasons":["QA has its own opinion"],"mustFix":["something else entirely"]}';
      else if (spec.role === "advisor") resultText = advisorJson(advising++);
      else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts };
}

const logs = (store: Store, runId: string) =>
  store
    .eventsSince(runId, 0)
    .map((e) => e.event)
    .filter((e) => e.type === "agent.log")
    .map((e) => (e as { text: string }).text);

describe("a completion probe that cannot pass", () => {
  it("is rewritten by the decider rather than agreed with forever", async () => {
    // The reported experience, nine times over: the probe's last clause matched
    // a generated file, every answer said so correctly, and every answer led
    // back to the same gate — because the worker is forbidden to touch the probe
    // and the probe is checked before QA, so agreeing with the escalation was
    // the one thing that could not end it.
    const { pool, workerPrompts } = probePool(
      () =>
        '```json\n{"recommendation":"the probe was looking for a file this task was never scoped to write","checked":[],"needsOperator":false,"why":"the probe named the wrong artifact","probe":"test -f feature.txt"}\n```'
    );
    const asked: string[] = [];
    const { store, runId } = await run(gates(async (why) => { asked.push(why); return null; }), pool, { taskGate: { decidedBy: "product-manager" } });

    // The bar moved, on the record, with a name against it.
    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("test -f feature.txt");
    const amended = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.probe_amended") as { from: string; to: string; by: string; why: string }[];
    expect(amended).toHaveLength(1);
    expect(amended[0]).toMatchObject({ from: "test -f nope.txt", to: "test -f feature.txt", by: "product-manager" });
    expect(amended[0]!.why).toContain("wrong artifact");

    // And the task went on with its life: the amended probe was tried on the
    // spot rather than costing a worker round, so what stopped it next was QA
    // having an opinion — not the probe, again, for the second time.
    expect(logs(store, runId).some((t) => t.includes("completion probe passes as amended"))).toBe(true);
    expect(workerPrompts[1]).toContain("QA has its own opinion");
    expect(workerPrompts[1]).not.toContain("completion probe");
    expect(asked).toHaveLength(1);
  });

  it("is withdrawn when there is nothing in it worth keeping", async () => {
    const { pool } = probePool(
      () => '```json\n{"recommendation":"this probe belonged to a different task","checked":[],"needsOperator":false,"probe":""}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: { decidedBy: "product-manager" } });

    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("");
    expect(logs(store, runId).some((t) => t.includes("completion probe withdrawn"))).toBe(true);
  });

  it("is left alone for a human, who is handed the command instead", async () => {
    // An advisor drafting for the operator has no authority over what the task
    // is judged by. What it does have is the exact command they were missing —
    // the reason a probe was unfixable was never that nobody knew what it should
    // say, it was that saying it meant hand-editing SQLite.
    const { pool } = probePool(
      () => '```json\n{"recommendation":"the probe names a file nothing writes","checked":[],"probe":"test -f feature.txt"}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool);

    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("test -f nope.txt");
    expect(store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.probe_amended")).toHaveLength(0);
    const hint = logs(store, runId).find((t) => t.includes("harness probe"));
    expect(hint).toContain(`harness probe task-a 'test -f feature.txt' --run ${runId}`);
  });

  it("stops moving once the decider has moved it as often as it may", async () => {
    // A skill that keeps rewriting the bar until the work clears it has stopped
    // being a check on the work. One rewrite per task, then the probe is settled
    // as far as any agent is concerned — even a rewrite that would have passed.
    const { pool } = probePool((round) =>
      round === 0
        ? '```json\n{"recommendation":"try this one","checked":[],"needsOperator":false,"probe":"test -f still-nope.txt"}\n```'
        : '```json\n{"recommendation":"no, this one","checked":[],"needsOperator":false,"probe":"test -f feature.txt"}\n```'
    );
    const asked: string[] = [];
    const { store, runId } = await run(gates(async (why) => { asked.push(why); return null; }), pool, { taskGate: { decidedBy: "product-manager" } });

    expect(store.taskProbeAmendments(runId, "task-a")).toBe(1);
    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("test -f still-nope.txt");
    // The second rewrite is not silently swallowed: it becomes the operator's
    // command, and the escalation becomes theirs to answer.
    expect(logs(store, runId).some((t) => t.includes(`harness probe task-a 'test -f feature.txt'`))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });
});

describe("the task-escalation gate, answered by a skill", () => {
  it("sends the skill's answer to the worker without waiting for the operator", async () => {
    // The reported experience: a task hit its cap at 3pm with a verified,
    // correct answer already drafted on screen — and stopped there, holding a
    // worker slot, until somebody clicked a button.
    const { pool, workerPrompts, advisorSystems } = decidingPool(
      () => '```json\n{"recommendation":"types.gen.ts is generated \\u2014 do not hand-edit it; the probe is a false positive","checked":[],"needsOperator":false,"why":"the probe greps a generated enum"}\n```'
    );
    const asked: string[] = [];
    const { store, runId } = await run(gates(async (why) => { asked.push(why); return null; }), pool, { taskGate: { decidedBy: "product-manager", autoAnswerRounds: 1 } });

    // Nobody was asked for the first escalation; the worker simply carried on.
    expect(workerPrompts[1]).toContain("do not hand-edit it");
    // It wears the named hat, and says so in its own system prompt.
    expect(advisorSystems[0]).toContain("**product-manager**");
    expect(advisorSystems[0]).toContain("needsOperator");

    const events = store.eventsSince(runId, 0).map((e) => e.event);
    const resolved = events.filter((e) => e.type === "task.gate_resolved") as { parked: boolean; guidance: string; decidedBy: string }[];
    expect(resolved[0]).toMatchObject({ parked: false, decidedBy: "product-manager" });
    expect(resolved[0]!.guidance).toContain("false positive");
    // The escalation is still on the record: a run that answers its own
    // questions must not look like a run that never had one.
    expect(events.filter((e) => e.type === "task.gate_opened")).not.toHaveLength(0);
    // One round only, so the second escalation is the operator's, and they
    // parked it.
    expect(asked).toHaveLength(1);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });

  it("hands the question back when only a person can answer it", async () => {
    // The skill's one power over the run is to stop it. A missing credential or
    // an unmade product decision is not something a worker can be instructed
    // around, and guessing at it costs a whole iteration to learn nothing.
    const { pool, workerPrompts } = decidingPool(
      () => '```json\n{"recommendation":"After you start DynamoDB locally, tell the worker to re-run the suite","checked":[],"needsOperator":true,"why":"the suite needs a service nobody started"}\n```'
    );
    const seen: string[] = [];
    const { store, runId } = await run(
      gates(async () => {
        seen.push("asked");
        return null;
      }),
      pool,
      { taskGate: {} }
    );

    expect(seen).toHaveLength(1);
    expect(workerPrompts).toHaveLength(1);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    const resolved = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.gate_resolved") as { decidedBy: string }[];
    expect(resolved[0]!.decidedBy).toBe("operator");
    // Handing it back does not cost the operator the investigation: the draft
    // they are shown is the one the skill wrote.
    const opened = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.gate_opened") as { recommendation: string }[];
    expect(opened[0]!.recommendation).toContain("start DynamoDB");
  });

  it("stops answering the same task once its rounds are spent", async () => {
    // Every answer resets the task's iteration counters, so a skill answering
    // its own escalations is a loop bounded only by the task's budget. Twice is
    // the point at which the thing standing between this task and finishing is
    // no longer something an agent has to say.
    const { pool, workerPrompts } = decidingPool(() => '```json\n{"recommendation":"try it again but harder","checked":[],"needsOperator":false}\n```');
    const asked: string[] = [];
    const { store, runId } = await run(gates(async (why) => { asked.push(why); return null; }), pool, { taskGate: {} });

    // Two answers, then the third escalation is a person's.
    expect(store.taskGateAutoAnswers(runId, "task-a")).toBe(2);
    expect(asked).toHaveLength(1);
    expect(workerPrompts).toHaveLength(3);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });

  it("answers a headless run, where there was never anyone to ask", async () => {
    // `harness run` in CI has no gate handler at all: every escalation parked on
    // the spot. The decider needs no terminal and no dashboard.
    const { pool, workerPrompts } = decidingPool(() => '```json\n{"recommendation":"the fixture path moved to test/fixtures","checked":[],"needsOperator":false}\n```');
    const { store, runId } = await run(gates(), pool, { taskGate: { decidedBy: "product-manager", autoAnswerRounds: 1 } });

    expect(workerPrompts[1]).toContain("test/fixtures");
    // And with its round spent and nobody to ask, it parks — as it always did.
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(workerPrompts).toHaveLength(2);
  });

  it("asks rather than guesses when the decider's session returns nothing usable", async () => {
    // A crashed or rambling decider has decided nothing. Reading silence as
    // "carry on" would hand the worker an empty brief and buy it a fresh set of
    // iterations to fail the same way.
    const { pool, workerPrompts } = decidingPool(() => "I had a good look around and, honestly, it is hard to say.");
    const asked: string[] = [];
    const { store, runId } = await run(gates(async (why) => { asked.push(why); return null; }), pool, { taskGate: {} });

    expect(asked).toHaveLength(1);
    expect(workerPrompts).toHaveLength(1);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(store.taskGateAutoAnswers(runId, "task-a")).toBe(0);
  });
});
