import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
import { PromptStream } from "./pool.js";
import { Store } from "./store.js";

/**
 * The turn ceiling was the most expensive thing in two production runs: QA
 * sessions died clustered at 91-112 turns against a cap of 90, workers at up to
 * 195 against 100, and each death threw away the whole session — no verdict, no
 * summary, and a re-dispatch that started over. The sessions that hit it are the
 * expensive ones precisely because they die having done the most work.
 *
 * These cover the two halves of not losing that work: the stream stays open long
 * enough to deliver a wrap-up message pushed mid-session, and a session that dies
 * without reaching endSession still books what it spent.
 */
describe("wrap-up before the ceiling", () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("delivers a message pushed mid-session, and the agent gets its last exchange", async () => {
    // The wrap-up is pushed from inside the message loop, between an assistant
    // message and the result that follows it. `settle()` must not close the
    // stream out from under it — otherwise the agent is cut off exactly where
    // it was about to answer.
    const stream = new PromptStream("verify this task");
    const seen: string[] = [];
    const consumed = (async () => {
      for await (const m of stream.stream()) seen.push(m.message.content as string);
    })();

    await tick();
    expect(seen).toEqual(["verify this task"]);

    expect(stream.push("[HARNESS] You are near this session's turn limit")).toBe(true);
    stream.settle(); // the result for the turn that triggered the push
    await tick();
    expect(seen[1]).toContain("near this session's turn limit");

    stream.settle(); // the answer to the wrap-up — nothing left, so it ends
    await consumed;
  });
});

describe("what a dead session cost", () => {
  function session(store: Store, id: string, state: string): void {
    store.db
      .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt) VALUES (?,?,?,?,?,?,?)")
      .run(id, "run-1", "task-a", "qa", "claude-sonnet-5", state, 1);
  }
  const bill = (store: Store, sessionId: string, costUsd: number) =>
    store.recordUsage({ runId: "run-1", taskId: "task-a", sessionId, model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });

  it("bills a session the previous process left running, from the ledger", () => {
    // sweepDeadSessions used to flip these to 'interrupted' and nothing else,
    // so the row claimed the session cost nothing. One run's sessions table
    // came out $49.08 against a ledger of $80.34 that way.
    const store = new Store(":memory:");
    session(store, "s-dead", "running");
    bill(store, "s-dead", 1.25);
    bill(store, "s-dead", 0.75);

    expect(store.sweepDeadSessions()).toBe(1);
    const row = store.db.prepare("SELECT state, costUsd FROM sessions WHERE id = 's-dead'").get() as { state: string; costUsd: number };
    expect(row.state).toBe("interrupted");
    expect(row.costUsd).toBeCloseTo(2.0);
  });

  it("leaves a finished session's own figure alone when it is the larger one", () => {
    // The ledger settles the bill; it does not get to revise a number the
    // session already reported for itself.
    const store = new Store(":memory:");
    session(store, "s-done", "running");
    store.db.prepare("UPDATE sessions SET costUsd = 5 WHERE id = 's-done'").run();
    bill(store, "s-done", 1.0);

    store.sweepDeadSessions();
    const row = store.db.prepare("SELECT costUsd FROM sessions WHERE id = 's-done'").get() as { costUsd: number };
    expect(row.costUsd).toBe(5);
  });

  it("costs nothing when nothing was spent", () => {
    const store = new Store(":memory:");
    session(store, "s-empty", "running");
    store.sweepDeadSessions();
    const row = store.db.prepare("SELECT costUsd FROM sessions WHERE id = 's-empty'").get() as { costUsd: number };
    expect(row.costUsd).toBe(0);
  });
});

/**
 * A ceiling that was too low for one task is too low for the next: the
 * repository is the same size for all of them. Until this, every task started
 * from the configured value and rediscovered that on its own — and the
 * discovery costs a session that ran to its limit having done the most work of
 * any session on that task. Run 40da9337 paid for it 27 times: $142 of the $206
 * it lost to errored sessions was `error_max_turns`.
 */
describe("a ceiling one task proved too low", () => {
  const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
  const dag = (chained: boolean) =>
    "```json\n" +
    JSON.stringify({
      epics: [{ id: "epic-e", title: "E", summary: "s" }],
      tasks: ["task-a", "task-b"].map((id, i) => ({
        id, epicId: "epic-e", title: id, spec: "s", acceptanceCriteria: ["x"],
        dependsOn: chained && i === 1 ? ["task-a"] : [], touchedPaths: [], estimatedSize: "S" as const,
      })),
    }) +
    "\n```";

  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "harness-ceiling-"));
    made.push(dir, `${dir}-wt`);
    writeFileSync(path.join(dir, "README.md"), "# fixture\n");
    gitIn(dir, "init", "-b", "main");
    gitIn(dir, "config", "user.email", "harness@example.com");
    gitIn(dir, "config", "user.name", "harness");
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-m", "init");
    return dir;
  }

  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    async resolveTaskGate() {
      return null;
    },
  };

  /** Runs a two-task plan; `truncate` decides which sessions die at the ceiling. */
  async function run(truncate: (spec: AgentSpec, nth: number) => boolean, together = false) {
    let planning = 0;
    const counts: Record<string, number> = {};
    const specs: AgentSpec[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        specs.push(spec);
        const nth = (counts[spec.role] = (counts[spec.role] ?? 0) + 1);
        const base = { sessionId: `s${specs.length}`, costUsd: 0, turns: 1 };
        if (spec.role === "planner") return { ...base, resultText: planning++ === 0 ? DOCS : dag(!together), outcome: "done" as const };
        if (truncate(spec, nth)) {
          if (spec.role === "qa") throw new Error("error_max_turns");
          return { ...base, resultText: "", outcome: "error" as const, errorDetail: "error_max_turns (hit the turn ceiling of 120)" };
        }
        if (spec.role === "worker") {
          // A distinct commit per dispatch: an empty one fails, and the failure
          // would read as the worker crashing rather than as the test's own bug.
          writeFileSync(path.join(spec.cwd, `w-${specs.length}.txt`), "work\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          return { ...base, resultText: "worker done", outcome: "done" as const };
        }
        return { ...base, resultText: '{"verdict":"PASS","notes":"ok"}', outcome: "done" as const };
      },
    } as unknown as AgentPool;

    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool, new GitHubAdapter(undefined, undefined), gates, repo());
    const runId = await controller.startRun(
      "do a thing",
      RunConfig.parse({ deterministicChecks: [], waitForChecks: false, maxParallelWorkers: together ? 2 : 1 })
    );
    return { store, runId, specs };
  }

  it("gives the next task the raised worker ceiling instead of making it find out too", async () => {
    // Only the very first worker session dies at the ceiling.
    const { store, runId, specs } = await run((spec, nth) => spec.role === "worker" && nth === 1);

    const workers = specs.filter((s) => s.role === "worker");
    expect(workers[0]!.taskId).toBe("task-a");
    expect(workers[0]!.maxTurns).toBe(120); // the configured default
    // task-b never pays a session to find out what task-a already established.
    expect(workers[1]!.taskId).toBe("task-b");
    expect(workers[1]!.maxTurns).toBe(180);
    expect(store.getRun(runId)!.config.workerMaxTurns).toBe(180);
  });

  it("does the same for QA, which dies at its ceiling without ever writing a verdict", async () => {
    const { store, runId, specs } = await run((spec, nth) => spec.role === "qa" && nth === 1);

    const qa = specs.filter((s) => s.role === "qa");
    expect(qa[0]!.maxTurns).toBe(90);
    expect(qa.at(-1)!.taskId).toBe("task-b");
    expect(qa.at(-1)!.maxTurns).toBe(135);
    expect(store.getRun(runId)!.config.qaMaxTurns).toBe(135);
  });

  it("never lowers a ceiling an earlier task proved too low", async () => {
    // Both tasks truncate once. The second raise is from the already-raised
    // value, and a later task must not write the configured default back.
    const { store, runId } = await run((spec) => spec.role === "worker");

    expect(store.getRun(runId)!.config.workerMaxTurns).toBe(270);
  });

  it("writes the raise once when two tasks discover the same ceiling at the same time", async () => {
    // Both start from 120 and both arrive at 180. The second is not a raise and
    // must not be written as one — a config that churns is a config nobody can
    // read a run's history out of.
    const { store, runId } = await run((spec, nth) => spec.role === "worker" && nth <= 2, true);

    expect(store.getRun(runId)!.config.workerMaxTurns).toBe(180);
  });
});
