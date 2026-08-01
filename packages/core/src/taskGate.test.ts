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

async function run(handler: GateHandler, pool: AgentPool) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const controller = new RunController(store, bus, pool, noGithub, handler, repo());
  const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 1 }));
  return { store, runId, controller };
}

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

  it("treats a blank answer as parking, not as guidance", async () => {
    // An empty string handed to the worker as "the operator's guidance" would be
    // worse than parking: another full iteration set spent on no new information.
    const { pool, workerPrompts } = rejectingPool();
    const { store, runId } = await run(gates(async () => "   "), pool);

    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(workerPrompts).toHaveLength(1);
  });
});
