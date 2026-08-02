import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import type { BudgetGate } from "./runController.js";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The budget gate, and reopening a finished run.
 *
 * Both are the operator's own controls: one decides whether a run that has hit
 * its cap keeps going, the other decides whether work that parked gets another
 * go. Neither is reachable from a run that simply succeeds.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-budget-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  return dir;
}

function commitInWorktree(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), "done\n");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", `add ${file}`], { cwd, stdio: "ignore" });
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"ok"}\n```';

const dagJson = (ids: string[] = ["task-a"]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: ids.map((id) => ({
      id, epicId: "epic-e", title: id.toUpperCase(), spec: "s", acceptanceCriteria: ["x"],
      dependsOn: [], touchedPaths: [], estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string | Partial<AgentResult> | Error);

/** A pool that bills `costUsd` per session, so a cap can actually be reached. */
function billingPool(answers: Partial<Record<string, Answer>>, costPerSession = 0) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const store = { current: null as Store | null, runId: "" };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      // Bill first, then check — the real pool books usage as it streams and
      // checks the budget on every message.
      if (costPerSession && store.current) {
        store.current.recordUsage({
          runId: spec.runId, taskId: spec.taskId, sessionId: `s${specs.length}`, model: spec.model,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: costPerSession,
        });
      }
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: costPerSession, turns: 1, outcome: "done" };
      if (typeof answer === "function") {
        const out = answer(spec, counts[spec.role]!);
        if (out instanceof Error) throw out;
        return typeof out === "string" ? { ...base, resultText: out } : { ...base, ...out };
      }
      return { ...base, resultText: answer ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, store };
}

function build(opts: {
  repoPath: string;
  pool: AgentPool;
  gates?: Partial<GateHandler>;
  github?: GitHubAdapter;
}) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    ...opts.gates,
  };
  const controller = new RunController(store, bus, opts.pool, opts.github ?? new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events };
}

const worker = (spec: AgentSpec, nth: number) => (commitInWorktree(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");

describe("reaching the run's cap", () => {
  it("stops the run when the operator declines to raise it, and says how to pick it up", async () => {
    const dir = repo();
    const { pool, store: poolStore } = billingPool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker,
      qa: () => QA_PASS,
    }, 40);
    const asked: BudgetGate[] = [];
    const { controller, store, events } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolveBudgetGate(gate) {
          asked.push(gate);
          return null;
        },
      },
    });
    poolStore.current = store;

    await expect(
      controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], budget: { runCapUsd: 30, taskCapUsd: 1000 } }))
    ).rejects.toThrow(/run budget exceeded[\s\S]*harness resume/);

    expect(asked[0]).toMatchObject({ scope: "run", capUsd: 30 });
    const resolutions = events.filter((e): e is HarnessEvent & { resolution?: string } => e.type === "run.gate_resolved");
    expect(resolutions[0]!.resolution).toBe("rejected");
  });

  it("carries on with the new cap when the operator raises it", async () => {
    const dir = repo();
    const { pool, store: poolStore } = billingPool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker,
      qa: () => QA_PASS,
    }, 20);
    const { controller, store, events } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolveBudgetGate(gate) {
          return gate.spentUsd + 500;
        },
      },
    });
    poolStore.current = store;

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ deterministicChecks: [], budget: { runCapUsd: 30, taskCapUsd: 1000 } })
    );

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getRun(runId)!.config.budget.runCapUsd).toBeGreaterThan(30);
    expect(events.some((e) => e.type === "run.budget_updated")).toBe(true);
    const resolutions = events.filter((e): e is HarnessEvent & { resolution?: string } => e.type === "run.gate_resolved");
    expect(resolutions[0]!.resolution).toBe("approved");
  });

  it("refuses a new cap at or below what is already spent", async () => {
    const dir = repo();
    const { pool, store: poolStore } = billingPool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
    }, 40);
    const { controller, store } = build({
      repoPath: dir,
      pool,
      // A cap that would trip again on the very next check is a stop dressed up
      // as a raise.
      gates: { async resolveBudgetGate(gate) { return gate.spentUsd; } },
    });
    poolStore.current = store;

    await expect(
      controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], budget: { runCapUsd: 30, taskCapUsd: 1000 } }))
    ).rejects.toThrow(/run budget exceeded/);
  });

  it("raises the task cap rather than the run's when it is the task that tripped", async () => {
    const dir = repo();
    const asked: BudgetGate[] = [];
    const { pool, store: poolStore } = billingPool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker,
      qa: () => QA_PASS,
    }, 15);
    const { controller, store } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolveBudgetGate(gate) {
          asked.push(gate);
          return gate.spentUsd + 500;
        },
      },
    });
    poolStore.current = store;

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ deterministicChecks: [], budget: { runCapUsd: 10_000, taskCapUsd: 10 } })
    );

    expect(asked[0]).toMatchObject({ scope: "task", taskId: "task-a" });
    expect(store.getRun(runId)!.config.budget.taskCapUsd).toBeGreaterThan(10);
    expect(store.getRun(runId)!.config.budget.runCapUsd).toBe(10_000);
  });
});

describe("reopening a run the operator parked", () => {
  /** A run driven to PR_REVIEW with one task parked and one merged. */
  async function withAParkedTask(guidance: string | null) {
    const dir = repo();
    // Flipped before the reopen in the case where the operator's answer is
    // supposed to work: a task that fails identically after being revived would
    // park, be revived, and fail again for as long as the operator kept saying
    // the same thing.
    const failing = { taskB: true };
    const { pool, specs } = billingPool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson(["task-a", "task-b"]) : DOCS),
      worker: (spec, nth) => (spec.taskId === "task-b" && failing.taskB ? new Error("boom") : worker(spec, nth)),
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const first = build({ repoPath: dir, pool, gates: { async resolveTaskGate() { return null; } } });
    const runId = await first.controller.startRun(
      "build a thing",
      RunConfig.parse({ deterministicChecks: [], workerRespawnCap: 1, maxParallelWorkers: 1 })
    );
    expect(first.store.getTask(runId, "task-b")!.state).toBe("NEEDS_HUMAN");

    // A second controller over the same store: the operator has come back.
    const bus = new Bus(first.store);
    const events: HarnessEvent[] = [];
    bus.subscribe(({ event }) => void events.push(event));
    const controller = new RunController(
      first.store,
      bus,
      pool,
      new GitHubAdapter(undefined, undefined),
      {
        async resolvePlanGate() {
          return { approved: true, feedback: "" };
        },
        async resolveBudgetGate() {
          return null;
        },
        async resolveTaskGate() {
          return guidance;
        },
      },
      dir
    );
    return { controller, store: first.store, runId, specs, events, failing };
  }

  it("hands the operator's answer to the task and starts it over with fresh iterations", async () => {
    const { controller, store, runId, specs, failing } = await withAParkedTask("the port was taken — use 8030");
    failing.taskB = false;

    await controller.resume(runId);

    const prompts = specs.filter((s) => s.role === "worker" && s.taskId === "task-b").map((s) => s.prompt);
    expect(prompts.at(-1)).toMatch(/parked \([\s\S]*\) and the operator reopened it[\s\S]*8030/);
    expect(store.getTask(runId, "task-b")!.respawns).toBe(0);
  });

  it("leaves it parked when the operator still has nothing to add", async () => {
    const { controller, store, runId } = await withAParkedTask(null);

    await controller.resume(runId);

    expect(store.getTask(runId, "task-b")!.state).toBe("NEEDS_HUMAN");
  });

  it("counts one waiting task in the singular", async () => {
    const { controller, runId } = await withAParkedTask(null);
    await controller.resume(runId);

    expect(controller.outcome(runId).line).toContain("1 task needs you");
  });

  it("counts two in the plural", async () => {
    const dir = repo();
    const { pool } = billingPool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson(["task-a", "task-b"]) : DOCS),
      // Neither task can finish, so both end up waiting on the operator.
      worker: () => new Error("boom"),
      advisor: () => "",
    });
    const { controller, store } = build({ repoPath: dir, pool, gates: { async resolveTaskGate() { return null; } } });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ deterministicChecks: [], workerRespawnCap: 1, maxParallelWorkers: 2 })
    );

    expect(store.listTasks(runId).filter((t) => t.state === "NEEDS_HUMAN")).toHaveLength(2);
    expect(controller.outcome(runId).line).toContain("2 tasks need you");
  });
});

describe("a run that has nothing left to reopen", () => {
  it("is left exactly where it is", async () => {
    const dir = repo();
    const { pool } = billingPool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    await controller.resume(runId);

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });
});
