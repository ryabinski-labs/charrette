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

/**
 * A task held to two criteria that cannot both be true: the suite has to be
 * green, and the one file that can make it green may not be touched. This is
 * run bc691359's `multipart-mediatype-and-flag-plumbing` with the incidentals
 * removed — its advisor found the cause exactly, named the commit and the two
 * lines, and then wrote "only the operator can resolve it", because that was
 * the only thing the contract let it say.
 */
const CRITERIA_DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      {
        id: "task-a",
        epicId: "epic-e",
        title: "A",
        spec: "s",
        acceptanceCriteria: ["the workspace suite is green", "no file outside crates/parser is modified"],
        dependsOn: [],
        touchedPaths: [],
        completionProbe: "",
        estimatedSize: "S",
      },
    ],
  }) +
  "\n```";

/** PROBE_DAG, a worker that writes `feature.txt`, and an advisor under test. */
function probePool(advisorJson: (round: number) => string, dag = PROBE_DAG) {
  const workerPrompts: string[] = [];
  const advisorPrompts: string[] = [];
  const advisorSystems: string[] = [];
  let planning = 0;
  let advising = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : dag;
      else if (spec.role === "worker") {
        workerPrompts.push(spec.prompt);
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${workerPrompts.length}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") resultText = '{"verdict":"FAIL","reasons":["QA has its own opinion"],"mustFix":["something else entirely"]}';
      else if (spec.role === "advisor") {
        advisorPrompts.push(spec.prompt);
        advisorSystems.push(spec.systemPrompt);
        resultText = advisorJson(advising++);
      } else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts, advisorPrompts, advisorSystems };
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

  it("hands them a withdrawal the same way, in the words that argued for it", async () => {
    // Withdrawing a probe is the amendment an operator is least likely to think
    // of and most likely to want: the probe is not wrong about the work, it is
    // about work this task no longer owns. `--clear` because "" is not something
    // you can type at a shell and mean on purpose.
    const { pool } = probePool(
      () =>
        '```json\n{"recommendation":"nothing here is this task\'s to satisfy","checked":[],"probe":"","why":"the file it names went to the task this one was split off from"}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool);

    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("test -f nope.txt");
    const hint = logs(store, runId).find((t) => t.includes("harness probe"));
    expect(hint).toContain("looks wrong — the file it names went to the task this one was split off from.");
    expect(hint).toContain(`harness probe task-a --clear --run ${runId}`);
  });

  it("is left exactly as it was when the advisor's best proposal is the probe itself", async () => {
    // The advisor is offered the probe on every amendable gate, so "this one is
    // right, the problem is elsewhere" is a normal answer and must cost nothing:
    // no event a postmortem has to explain, and none of the one amendment this
    // task gets, which the round that really needs it would then not have.
    const { pool } = probePool(
      () => '```json\n{"recommendation":"the probe is right — nothing writes the file because the work is not done","checked":[],"needsOperator":false,"probe":"test -f nope.txt"}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: { decidedBy: "product-manager" } });

    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("test -f nope.txt");
    expect(store.taskProbeAmendments(runId, "task-a")).toBe(0);
    // Not refused, either — the operator is handed a command only when there was
    // a change to make and the advisor lacked the authority to make it.
    expect(logs(store, runId).some((t) => t.includes("harness probe"))).toBe(false);
    expect(logs(store, runId).some((t) => t.includes("product-manager answered this task's escalation"))).toBe(true);
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

  it("is still the decider's to move after the decider has run out of answers", async () => {
    // Run 1e7d3df3, exactly: `autoAnswerRounds` retired the product-manager from
    // answering, and the probe amendment was hung off the same "is there a live
    // decider" test — so from that round on nothing could touch a probe that no
    // answer could ever satisfy, and the operator was asked eleven more times.
    // The two allowances bound different things and are counted separately;
    // running out of one must not spend the other.
    const { pool } = probePool(
      () =>
        '```json\n{"recommendation":"the probe demands an artifact this run\'s tooling forbids producing","checked":[],"needsOperator":true,"why":"the probe named the wrong artifact","probe":"test -f feature.txt"}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool, {
      taskGate: { decidedBy: "product-manager", autoAnswerRounds: 0, probeAmendments: 1 },
    });

    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("test -f feature.txt");
    const amended = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.probe_amended") as { by: string }[];
    expect(amended).toHaveLength(1);
    // Named for the authority it was made under, not for "" — an amendment
    // recorded as the operator's own would not count against the allowance, and
    // the bound this preserves is the one on agents rewriting their own bar.
    expect(amended[0]!.by).toBe("product-manager");
    expect(store.taskProbeAmendments(runId, "task-a")).toBe(1);
  });

  it("is the operator's alone on a run that never delegated the gate", async () => {
    // The other reading of "no decider", and it keeps the old answer: an
    // operator who set `decidedBy: "operator"` kept this gate for themselves,
    // and an advisor drafting for them has no authority over the bar.
    const { pool } = probePool(
      () => '```json\n{"recommendation":"the probe names a file nothing writes","checked":[],"probe":"test -f feature.txt"}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool, {
      taskGate: { decidedBy: "operator", autoAnswerRounds: 5, probeAmendments: 5 },
    });

    expect(store.getTask(runId, "task-a")!.completionProbe).toBe("test -f nope.txt");
    expect(store.taskProbeAmendments(runId, "task-a")).toBe(0);
    expect(logs(store, runId).some((t) => t.includes("harness probe"))).toBe(true);
  });
});

describe("a gate that keeps opening on the same task", () => {
  it("tells the operator they have been here before, and how to change the bar", async () => {
    // The fourteen questions run 1e7d3df3 asked about one task were, on their
    // own evidence, indistinguishable: answering a gate resets `qaIterations`,
    // so every one of them said "after 3 attempts". Nothing said "again".
    const { pool } = probePool(() => '```json\n{"recommendation":"try again","checked":[],"probe":null}\n```');
    const asked: string[] = [];
    const { store, runId } = await run(
      gates(async (why) => {
        asked.push(why);
        return asked.length === 1 ? "have another go" : null;
      }),
      pool,
      { taskGate: { decidedBy: "operator" } }
    );

    expect(asked).toHaveLength(2);
    // The first question is unchanged: a gate that has opened once is a normal
    // gate, and prefixing every escalation with its own history is noise.
    expect(asked[0]).not.toContain("stopped for the same gate");
    expect(asked[1]).toContain("This task has stopped for the same gate once before");
    expect(asked[1]).toContain("That answer did not settle it");
    // The way out, named rather than implied — and it was only ever in agent.log,
    // which is not where anyone answering a gate is looking.
    expect(asked[1]).toContain("test -f nope.txt");
    expect(asked[1]).toContain(`harness probe task-a 'test -f nope.txt' --run ${runId}`);
    expect(asked[1]).toContain(`harness probe task-a --clear --run ${runId}`);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });

  it("does not put the count in the answer the worker is sent", async () => {
    // `recommendation` goes to the worker verbatim when a decider answers it.
    // How many times a person was interrupted is the question's business, not
    // the worker's brief.
    const { pool, workerPrompts } = probePool(
      () => '```json\n{"recommendation":"carry on with the second half","checked":[],"needsOperator":false,"probe":null}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool, {
      taskGate: { decidedBy: "product-manager", autoAnswerRounds: 2 },
    });

    const guidance = store
      .eventsSince(runId, 0)
      .map((e) => e.event)
      .filter((e) => e.type === "task.gate_resolved") as { guidance: string }[];
    expect(guidance.length).toBeGreaterThan(1);
    expect(guidance[1]!.guidance).toContain("carry on with the second half");
    expect(guidance[1]!.guidance).not.toContain("stopped for the same gate");
    expect(workerPrompts.join("\n")).not.toContain("stopped for the same gate");
  });

  it("tells the advisor it is repeating itself, so it stops reaching the same conclusion", async () => {
    // The advisor investigated from scratch fourteen times because nothing in
    // its briefing said the previous thirteen had happened.
    const { pool, advisorPrompts } = probePool(() => '```json\n{"recommendation":"try again","checked":[],"probe":null}\n```');
    const asked: string[] = [];
    const { store, runId } = await run(
      gates(async () => {
        asked.push("x");
        return asked.length === 1 ? "have another go" : null;
      }),
      pool,
      { taskGate: { decidedBy: "operator" } }
    );

    expect(advisorPrompts).toHaveLength(2);
    expect(advisorPrompts[0]).not.toContain("This is not the first time");
    expect(advisorPrompts[1]).toContain("This gate has opened once before on this task");
    expect(store.getRun(runId)!.state).toBeTruthy();
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

  /**
   * The other half of handing a question back. "Only a person can answer this"
   * is where run 7ef8fb4d stopped, and the person was left to work out which
   * repository, which workflow and what evidence would count. The steps ride on
   * the gate so every channel that reaches them — dashboard, terminal, mail —
   * gets the same ones.
   */
  it("carries the operator's steps on the gate it hands back", async () => {
    const { pool } = decidingPool(
      () =>
        '```json\n{"recommendation":"After it is deployed, tell the worker to re-run the proof",' +
        '"checked":[],"needsOperator":true,"why":"nobody has deployed it",' +
        '"runbook":{"blocked":"the endpoints have to be deployed first","steps":[{"do":"Merge and let CD run","command":"gh pr merge 1631 --squash"}],"sendBack":"the HTTP status from step 1"}}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: {} });

    const opened = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.gate_opened") as {
      recommendation: string;
      runbook: { steps: { command?: string }[]; sendBack: string } | null;
    }[];
    expect(opened[0]!.runbook).toEqual({
      blocked: "the endpoints have to be deployed first",
      steps: [{ do: "Merge and let CD run", command: "gh pr merge 1631 --squash" }],
      sendBack: "the HTTP status from step 1",
    });
    // And rendered into what the operator reads, above the prose — the steps
    // are the half that gets done.
    const shown = opened[0]!.recommendation;
    expect(shown).toContain("1. Merge and let CD run");
    expect(shown).toContain("       gh pr merge 1631 --squash");
    expect(shown).toContain("Then answer this gate with: the HTTP status from step 1");
    expect(shown.indexOf("1. Merge and let CD run")).toBeLessThan(shown.indexOf("After it is deployed"));
  });

  it("never sends the operator's steps to a worker", async () => {
    // A decider answering its own escalation writes the worker's whole brief.
    // A worker told to open a console learns only that the brief was addressed
    // to somebody else.
    const { pool, workerPrompts } = decidingPool(
      () =>
        '```json\n{"recommendation":"the fixture moved to test/fixtures","checked":[],"needsOperator":false,' +
        '"runbook":{"blocked":"someone has to click deploy","steps":[{"do":"Click deploy in the console"}],"sendBack":"the deploy id"}}\n```'
    );
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: {} });

    expect(workerPrompts.join("\n")).not.toContain("Click deploy in the console");
    // Two rounds answered by the skill, then the third is the operator's. The
    // steps ride on that one and on neither of the first two.
    const opened = store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.gate_opened") as { runbook: unknown; recommendation: string }[];
    expect(opened).toHaveLength(3);
    expect(opened.slice(0, 2).map((e) => e.runbook)).toEqual([null, null]);
    expect(opened[2]!.runbook).not.toBeNull();
    expect(opened[2]!.recommendation).toContain("1. Click deploy in the console");
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

describe("acceptance criteria that cannot all be met", () => {
  const AMENDED = ["the workspace suite is green", "no file outside crates/parser is modified, except docs/passrate.md"];
  const advice = (extra: string) =>
    `\`\`\`json\n{"recommendation":"the two criteria contradict","checked":[],"needsOperator":false,"why":"one forbade the only file that satisfies the other"${extra}}\n\`\`\``;
  const criteriaOf = (store: Store, runId: string) => store.getTask(runId, "task-a")!.acceptanceCriteria;
  const amendments = (store: Store, runId: string) =>
    store.eventsSince(runId, 0).map((e) => e.event).filter((e) => e.type === "task.criteria_amended") as {
      from: string[];
      to: string[];
      by: string;
      why: string;
    }[];

  it("are amended by the decider, because the probe was never what QA reads", async () => {
    // The failure this exists for. Rewriting the probe cannot help — QA grades
    // against the criteria, and it is right to distrust a worker who says they
    // were withdrawn, so the only thing that ends the loop is moving them where
    // QA actually looks.
    const { pool, workerPrompts } = probePool(() => advice(`,"criteria":${JSON.stringify(AMENDED)}`), CRITERIA_DAG);
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: { decidedBy: "product-manager" } });

    expect(criteriaOf(store, runId)).toEqual(AMENDED);
    expect(amendments(store, runId)).toHaveLength(1);
    expect(amendments(store, runId)[0]).toMatchObject({ by: "product-manager", to: AMENDED });
    expect(amendments(store, runId)[0]!.from).toEqual(["the workspace suite is green", "no file outside crates/parser is modified"]);
    expect(amendments(store, runId)[0]!.why).toContain("forbade the only file");
    // And the worker was told what it is now held to, rather than being left to
    // infer it from a bar that moved underneath it.
    expect(workerPrompts[1]).toContain("except docs/passrate.md");
  });

  it("are offered at the wall clock, not only when a probe is what failed", async () => {
    // The bug behind the bug. `amendable` used to mean "the probe rejected this
    // attempt", so the gate run bc691359 actually opened — a wall-clock gate on
    // a task with no probe at all — was never offered the criteria it was stuck
    // on, and every fix downstream of that would have been dead code.
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    let planning = 0;
    const advisorSystems: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "planner") return { sessionId: "sp", resultText: planning++ === 0 ? DOCS : CRITERIA_DAG, costUsd: 0, turns: 1, outcome: "done" };
        if (spec.role === "worker") {
          writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${clock}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          return { sessionId: "sw", resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "qa") {
          // A slow iteration: the task is over its bound before the cap.
          clock += 50 * 60_000;
          return { sessionId: "sq", resultText: '{"verdict":"FAIL","reasons":["still red"],"mustFix":["x"]}', costUsd: 0, turns: 1, outcome: "done" };
        }
        if (spec.role === "advisor") advisorSystems.push(spec.systemPrompt);
        return { sessionId: "sa", resultText: advice(""), costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const asked: string[] = [];
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, gates(async (why) => { asked.push(why); return null; }), repo());
    // Two iterations allowed, so the clock is what stops it rather than the cap.
    await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 2, taskGate: { decidedBy: "operator" } }));

    expect(asked.some((w) => /wall clock/.test(w))).toBe(true);
    expect(advisorSystems[0]).toContain("`criteria` is this task's acceptance criteria, rewritten");
    expect(advisorSystems[0]).toContain("no file outside crates/parser is modified");
    // The probe is not widened with it: nothing rejected this task through a
    // probe, so there is nothing there for an advisor to repair.
    expect(advisorSystems[0]).not.toContain("is this task's completion probe, rewritten");
  });

  it("are left for a human, who is handed the command instead", async () => {
    // An advisor drafting for the operator has no authority over the bar. What
    // it does have is the exact command — the reason contradictory criteria
    // outlive three sessions was never that nobody could see the contradiction.
    const { pool } = probePool(() => advice(`,"criteria":${JSON.stringify(AMENDED)}`), CRITERIA_DAG);
    const { store, runId } = await run(gates(async () => null), pool);

    expect(amendments(store, runId)).toHaveLength(0);
    const hint = logs(store, runId).find((t) => t.includes("harness criteria"));
    expect(hint).toContain("look unsatisfiable — one forbade the only file that satisfies the other.");
    expect(hint).toContain(`harness criteria task-a 'the workspace suite is green' 'no file outside crates/parser is modified, except docs/passrate.md' --run ${runId}`);
  });

  it("hand the operator the command even when the advisor never says why", async () => {
    // `why` is what a run reviewing itself later reads to tell an honest repair
    // from a quiet capitulation, and an advisor is free to omit it. The command
    // is the part the operator cannot look up, so it goes out either way.
    const { pool } = probePool(
      () => `\`\`\`json\n{"recommendation":"the two criteria contradict","checked":[],"criteria":${JSON.stringify(AMENDED)}}\n\`\`\``,
      CRITERIA_DAG
    );
    const { store, runId } = await run(gates(async () => null), pool);

    const hint = logs(store, runId).find((t) => t.includes("harness criteria"));
    expect(hint).toContain("look unsatisfiable. QA grades against them");
    expect(hint).not.toContain(" — ");
    expect(amendments(store, runId)).toHaveLength(0);
  });

  it("are not the decider's to shorten", async () => {
    // Whether a rewritten criterion is weaker than the one it replaces is a
    // judgment. Whether one was deleted outright is not — and a deleted
    // criterion is a requirement nobody is ever graded on again.
    const { pool } = probePool(() => advice(`,"criteria":${JSON.stringify(["the workspace suite is green"])}`), CRITERIA_DAG);
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: { decidedBy: "product-manager" } });

    expect(criteriaOf(store, runId)).toHaveLength(2);
    expect(amendments(store, runId)).toHaveLength(0);
    const hint = logs(store, runId).find((t) => t.includes("harness criteria"));
    expect(hint).toContain("The product-manager proposed dropping 1 of them, which is not its to drop.");
  });

  it("stop moving once the run says they are not an agent's to move", async () => {
    const { pool } = probePool(() => advice(`,"criteria":${JSON.stringify(AMENDED)}`), CRITERIA_DAG);
    const { store, runId } = await run(gates(async () => null), pool, {
      taskGate: { decidedBy: "product-manager", criteriaAmendments: 0 },
    });

    expect(amendments(store, runId)).toHaveLength(0);
    expect(logs(store, runId).some((t) => t.includes("harness criteria"))).toBe(true);
  });

  it("are left exactly as they were when the advisor's best proposal is the list it was given", async () => {
    const given = ["the workspace suite is green", "no file outside crates/parser is modified"];
    const { pool } = probePool(() => advice(`,"criteria":${JSON.stringify(given)}`), CRITERIA_DAG);
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: { decidedBy: "product-manager" } });

    expect(amendments(store, runId)).toHaveLength(0);
    expect(logs(store, runId).some((t) => t.includes("harness criteria"))).toBe(false);
  });

  it("survive a list with nothing left in it", async () => {
    // `store.amendCriteria` throws on an empty list rather than leaving a task
    // nothing can judge. Getting there from a model's JSON should not be how
    // that is discovered.
    const { pool } = probePool(() => advice(`,"criteria":${JSON.stringify(["  ", ""])}`), CRITERIA_DAG);
    const { store, runId } = await run(gates(async () => null), pool, { taskGate: { decidedBy: "product-manager" } });

    expect(criteriaOf(store, runId)).toHaveLength(2);
    expect(amendments(store, runId)).toHaveLength(0);
  });

  it("are left alone when the advisor answers with something that is not a list of them", async () => {
    // A string, or a list with a number in it, is a malformed answer rather
    // than a partial one. Taking the strings out of it would be inventing a bar
    // nobody wrote.
    for (const bad of ['"criteria":"widen AC7"', '"criteria":["the workspace suite is green",7]']) {
      const { pool } = probePool(() => advice(`,${bad}`), CRITERIA_DAG);
      const { store, runId } = await run(gates(async () => null), pool, { taskGate: { decidedBy: "product-manager" } });
      expect(amendments(store, runId)).toHaveLength(0);
      expect(criteriaOf(store, runId)).toHaveLength(2);
    }
  });

  it("are offered when a deterministic check the criteria forbid satisfying keeps failing", async () => {
    // The shape run bc691359 actually hit: the run's own check demanded the
    // workspace suite be green, one criterion demanded the same, and another
    // forbade touching the only file that could make it so. The checks belong
    // to the run and no answer to this gate can move them, which leaves the
    // criteria as the only side of that disagreement an answer can reach.
    const { pool, advisorSystems } = probePool(() => advice(`,"criteria":${JSON.stringify(AMENDED)}`), CRITERIA_DAG);
    const asked: string[] = [];
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, gates(async (why) => { asked.push(why); return null; }), repo());
    const runId = await controller.startRun(
      "do a thing",
      RunConfig.parse({ deterministicChecks: ["! test -f feature.txt"], qaIterationCap: 1, taskGate: { decidedBy: "product-manager" } })
    );

    expect(asked.some((w) => /deterministic checks still failing/.test(w))).toBe(true);
    expect(advisorSystems[0]).toContain("`criteria` is this task's acceptance criteria, rewritten");
    expect(criteriaOf(store, runId)).toEqual(AMENDED);
  });

  it("are never offered when nothing about the bar is what rejected the task", async () => {
    // An empty branch says nothing about whether the criteria are fair — there
    // is no work to hold them against yet. Offering them there would be handing
    // an agent its own bar for no reason at all.
    let planning = 0;
    const advisorSystems: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "planner") return { sessionId: "sp", resultText: planning++ === 0 ? DOCS : CRITERIA_DAG, costUsd: 0, turns: 1, outcome: "done" };
        // A worker that commits nothing: the branch stays empty, which is its
        // own gate and one no criterion could have prevented.
        if (spec.role === "worker") return { sessionId: "sw", resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
        if (spec.role === "advisor") {
          advisorSystems.push(spec.systemPrompt);
          return { sessionId: "sa", resultText: advice(`,"criteria":${JSON.stringify(AMENDED)}`), costUsd: 0, turns: 1, outcome: "done" };
        }
        return { sessionId: "sq", resultText: '{"verdict":"PASS","summary":"n/a"}', costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool;

    const asked: string[] = [];
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, noGithub, gates(async (why) => { asked.push(why); return null; }), repo());
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1, taskGate: { decidedBy: "product-manager" } }));

    expect(asked.some((w) => /still empty/.test(w))).toBe(true);
    expect(advisorSystems[0]).not.toContain("acceptance criteria, rewritten");
    // And the advisor proposing one anyway changes nothing.
    expect(amendments(store, runId)).toHaveLength(0);
    expect(criteriaOf(store, runId)).toHaveLength(2);
  });
});
