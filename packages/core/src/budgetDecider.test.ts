import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { budgetDeciderSystemPrompt } from "./prompts.js";
import { RunController, type BudgetGate, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * A cap answered by a skill instead of by whoever is awake.
 *
 * A task cap is a planner's guess at the size of a piece of work, made before
 * anyone read the code, and reaching one says the guess was wrong — not that
 * the work is not worth doing. The operator's half of that had already
 * collapsed into pressing enter on a suggested figure: run f338b5c8 did it
 * twice, unchanged both times, and the second one sat for **six hours and
 * forty-two minutes** with a worker paused mid-task and three tasks queued
 * behind it.
 *
 * The bounds are what these cases mostly pin, because the bounds are what makes
 * this safe. A skill may redistribute money the operator already agreed to
 * spend. It may not raise the number they agreed to — not without a second
 * number they typed in advance — and it may not do either forever.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-budgetpm-"));
  made.push(dir, `${dir}-wt`);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  return dir;
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"ok"}\n```';
const QA_FAIL = '```json\n{"verdict":"FAIL","reasons":["the assertion is missing"],"mustFix":["add the assertion"]}\n```';
const INTENT_PASS = '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```';

const call = (over: Partial<{ action: string; capUsd: number; why: string }> = {}) =>
  "```json\n" + JSON.stringify({ action: "raise", capUsd: 0, why: "", ...over }) + "\n```";

const dag = (ids: string[]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-one", title: "First", summary: "s" }],
    tasks: ids.map((id, i) => ({
      id, epicId: "epic-one", title: id, spec: "s", acceptanceCriteria: ["x"],
      dependsOn: i === 0 ? [] : [ids[0]!], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

type Answer = (spec: AgentSpec, nth: number) => string | Error;

/**
 * Bills every call, like the real pool, so caps trip on accumulated spend —
 * except the decider's own, which the harness deliberately does not meter
 * against the cap it is deciding about.
 */
function rolePool(answers: Partial<Record<string, Answer>>, perCallUsd: number) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const ref = { store: null as Store | null };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const nth = (counts[spec.role] = (counts[spec.role] ?? 0) + 1);
      ref.store?.recordUsage({
        runId: spec.runId, taskId: spec.taskId, sessionId: `s${specs.length}`, model: spec.model,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: perCallUsd,
      });
      await spec.budgetCheck?.();
      const out = answers[spec.role]?.(spec, nth) ?? "";
      if (out instanceof Error) throw out;
      return { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: out, costUsd: perCallUsd, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, ref };
}

const worker = (spec: AgentSpec, nth: number) => {
  writeFileSync(path.join(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "done\n");
  execFileSync("git", ["add", "-A"], { cwd: spec.cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", "w"], { cwd: spec.cwd, stdio: "ignore" });
  return "did the work";
};

function build(opts: { repoPath: string; pool: AgentPool; ref: { store: Store | null }; onBudget?: (g: BudgetGate) => number | null }) {
  const store = new Store(":memory:");
  opts.ref.store = store;
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
  const asked: BudgetGate[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate(gate) {
      asked.push(gate);
      return opts.onBudget?.(gate) ?? null;
    },
  };
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events, asked };
}

const config = (budget: Record<string, unknown>) =>
  RunConfig.parse({
    deterministicChecks: [],
    waitForChecks: false,
    maxParallelWorkers: 1,
    pitStop: { every: "never" },
    planGate: { decidedBy: "operator" },
    intentFixRounds: 0,
    budget,
  });

const budgetGates = (events: HarnessEvent[]) => events.filter((e) => e.type === "run.gate_resolved" && (e as { kind: string }).kind === "budget");
const logs = (events: HarnessEvent[]) => events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);

describe("a task cap answered by a skill", () => {
  it("raises it without asking anyone, and the run carries on", async () => {
    const dir = repo();
    const { pool, specs, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a", "task-b"])),
        validator: () => INTENT_PASS,
        worker,
        qa: () => QA_PASS,
        pm: () => call({ action: "raise", capUsd: 5, why: "the migration is written; it is the tests that are left" }),
      },
      // $2 a call against a $1 task cap: the first worker call trips it.
      2
    );
    const { controller, store, events, asked } = build({ repoPath: dir, pool, ref });

    const runId = await controller.startRun("build a thing", config({ runCapUsd: 1000, taskCapUsd: 1 }));

    expect(asked).toEqual([]);
    expect(specs.some((s) => s.role === "pm")).toBe(true);
    expect(store.getRun(runId)!.config.budget.taskCapUsd).toBe(5);
    expect(budgetGates(events)[0]).toMatchObject({ resolution: "approved", decidedBy: "product-manager" });
    expect(logs(events)).toContainEqual(expect.stringContaining("product-manager raised the task cap to $5.00"));
  });

  it("parks the run when the skill says no, exactly as the operator's decline did", async () => {
    const dir = repo();
    const { pool, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a"])),
        validator: () => INTENT_PASS,
        worker,
        qa: () => QA_PASS,
        pm: () => call({ action: "park", why: "it has failed QA three times on the same assertion" }),
      },
      2
    );
    const { controller, store, events, asked } = build({ repoPath: dir, pool, ref });

    const runId = await controller.startRun("build a thing", config({ runCapUsd: 1000, taskCapUsd: 1 })).catch(() => undefined);

    expect(asked).toEqual([]);
    expect(budgetGates(events)[0]).toMatchObject({ resolution: "rejected", decidedBy: "product-manager" });
    expect((budgetGates(events)[0] as { feedback: string }).feedback).toContain("failed QA three times");
    if (runId) expect(store.getRun(runId)!.state).toBe("BUDGET_HOLD");
  });

  it("is told what the task is, what is waiting on it, and what is still unbuilt", async () => {
    const dir = repo();
    const { pool, specs, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a", "task-b", "task-c"])),
        validator: () => INTENT_PASS,
        worker,
        qa: () => QA_PASS,
        pm: () => call({ action: "raise", capUsd: 50 }),
      },
      2
    );
    const { controller } = build({ repoPath: dir, pool, ref });

    await controller.startRun("build a thing", config({ runCapUsd: 1000, taskCapUsd: 1 }));

    const decider = specs.find((s) => s.role === "pm")!;
    expect(decider.prompt).toContain("The **task** cap has been reached by task `task-a`");
    // b and c both depend on a: parking it stops them, and that is the half of
    // the decision the terminal prompt never showed anyone.
    expect(decider.prompt).toContain("2 task(s) cannot start until it finishes: task-b, task-c");
    expect(decider.prompt).toContain("Still to build:");
    expect(decider.prompt).toContain("QA has failed it 0 time(s)");
  });
});

describe("the bounds that make it safe", () => {
  it("will not raise the run cap the operator set, with no ceiling to raise it to", async () => {
    const dir = repo();
    const { pool, specs, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a"])),
        validator: () => INTENT_PASS,
        worker,
        qa: () => QA_PASS,
        pm: () => call({ action: "raise", capUsd: 100000, why: "should never be read" }),
      },
      2
    );
    const { controller, events, asked } = build({ repoPath: dir, pool, ref, onBudget: () => null });

    await controller.startRun("build a thing", config({ runCapUsd: 1, taskCapUsd: 1000 })).catch(() => undefined);

    // The run cap is the agreed number itself. An agent that can raise its own
    // ceiling has none, so this one goes to the person who set it.
    expect(asked.map((g) => g.scope)).toContain("run");
    expect(specs.some((s) => s.role === "pm")).toBe(false);
    expect(budgetGates(events)[0]).toMatchObject({ decidedBy: "operator" });
  });

  it("raises the run cap when the operator named a ceiling in advance, and never past it", async () => {
    const dir = repo();
    const { pool, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a"])),
        validator: () => INTENT_PASS,
        worker,
        qa: () => QA_PASS,
        pm: () => call({ action: "raise", capUsd: 900, why: "the remaining tasks are small" }),
      },
      2
    );
    const { controller, store, events, asked } = build({ repoPath: dir, pool, ref });

    const runId = await controller.startRun("build a thing", config({ runCapUsd: 1, taskCapUsd: 1000, ceilingUsd: 40 }));

    expect(asked).toEqual([]);
    // It asked for 900 against a ceiling of 40. It gets 40, and the log says so
    // rather than reporting the figure it wanted.
    expect(store.getRun(runId)!.config.budget.runCapUsd).toBe(40);
    expect(logs(events)).toContainEqual(expect.stringContaining("(asked for $900.00, held at the ceiling)"));
  });

  it("hands the cap back once it has raised it as many times as it may", async () => {
    const dir = repo();
    const { pool, specs, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a"])),
        validator: () => INTENT_PASS,
        worker,
        // One failed QA round, so the task is long enough to reach its cap
        // three times — which is the whole point of the case.
        qa: (_s, nth) => (nth === 1 ? QA_FAIL : QA_PASS),
        // Each raise clears the cap by a hair, so the very next call trips it again.
        pm: (_s, nth) => call({ action: "raise", capUsd: 2 * nth + 1.5 }),
      },
      2
    );
    const { controller, events, asked } = build({ repoPath: dir, pool, ref, onBudget: () => null });

    await controller.startRun("build a thing", config({ runCapUsd: 1000, taskCapUsd: 1, autoRaiseRounds: 2 })).catch(() => undefined);

    // Two goes at a cap that keeps coming back, and then it is the operator's.
    // A task on its third raise is not a slightly wrong estimate.
    expect(specs.filter((s) => s.role === "pm")).toHaveLength(2);
    expect(asked).toHaveLength(1);
    expect(logs(events)).toContainEqual(expect.stringContaining("has already raised this task cap 2 time(s) — this one is yours"));
  });

  it("asks the operator when the ceiling itself is already spent", async () => {
    const dir = repo();
    const { pool, specs, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a"])),
        validator: () => INTENT_PASS,
        worker,
        qa: () => QA_PASS,
        pm: () => call({ action: "raise", capUsd: 5 }),
      },
      2
    );
    const { controller, events, asked } = build({ repoPath: dir, pool, ref, onBudget: () => null });

    // A ceiling under the first call's spend: there is no raise left to make.
    await controller.startRun("build a thing", config({ runCapUsd: 1, taskCapUsd: 1000, ceilingUsd: 1.5 })).catch(() => undefined);

    expect(specs.some((s) => s.role === "pm")).toBe(false);
    expect(asked).toHaveLength(1);
    expect(logs(events)).toContainEqual(expect.stringContaining("ceiling of $1.50 is already spent"));
    expect(budgetGates(events)[0]).toMatchObject({ decidedBy: "operator" });
  });

  it("never runs at all when the operator kept the gate", async () => {
    const dir = repo();
    const { pool, specs, ref } = rolePool(
      {
        planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a"])),
        validator: () => INTENT_PASS,
        worker,
        qa: () => QA_PASS,
        pm: () => call({ action: "raise", capUsd: 5 }),
      },
      2
    );
    const { controller, asked } = build({ repoPath: dir, pool, ref, onBudget: () => null });

    await controller
      .startRun("build a thing", config({ runCapUsd: 1000, taskCapUsd: 1, decidedBy: "operator" }))
      .catch(() => undefined);

    expect(specs.some((s) => s.role === "pm")).toBe(false);
    expect(asked).toHaveLength(1);
  });
});

describe("a decider that cannot decide", () => {
  it.each([
    ["answered with a cap at or below what is already spent", () => call({ action: "raise", capUsd: 0.5 })],
    ["answered with prose", () => "I think you should raise it a bit."],
    ["died", () => new Error("Claude Code process exited with code 1")],
  ])("hands the cap to the operator when it %s", async (_case, pm) => {
    const dir = repo();
    const { pool, ref } = rolePool(
      { planner: (_s, nth) => (nth === 1 ? DOCS : dag(["task-a"])), validator: () => INTENT_PASS, worker, qa: () => QA_PASS, pm },
      2
    );
    const { controller, store, events, asked } = build({ repoPath: dir, pool, ref, onBudget: () => 9 });

    const runId = await controller.startRun("build a thing", config({ runCapUsd: 1000, taskCapUsd: 1 }));

    // Asking is all this gate ever did, so every failure lands exactly where it
    // started — never on a guess about someone else's money.
    expect(asked).toHaveLength(1);
    expect(store.getRun(runId)!.config.budget.taskCapUsd).toBe(9);
    expect(budgetGates(events)[0]).toMatchObject({ decidedBy: "operator" });
  });
});

describe("what the budget decider is told", () => {
  const system = budgetDeciderSystemPrompt("product-manager", "You may set this cap as high as $40.00 and no higher.");

  it("knows an agent is paused on its answer, not cancelled by it", () => {
    expect(system).toContain("An agent is paused mid-work waiting for your answer");
    expect(system).toContain("it carries on from exactly where it stopped");
  });

  it("is told this is a question about an estimate rather than about money", () => {
    expect(system).toContain("**This is a question about an estimate, not about money.**");
    expect(system).toContain("Reaching it means the guess was wrong, which is ordinary");
  });

  it("separates a task that is nearly done from one that is stuck", () => {
    expect(system).toContain("is not one raise away from finishing");
    expect(system).toContain("funding it buys another round of the same");
  });

  it("weighs the raise against the work that has not started", () => {
    expect(system).toContain("Every dollar here is a dollar the tasks that have not started do not have");
    expect(system).toContain('Do not raise "to be safe"');
  });

  it("carries its ceiling, and says why a cap under the spend is not an answer", () => {
    expect(system).toContain("You may set this cap as high as $40.00 and no higher.");
    expect(system).toContain("which is a park with extra steps");
  });
});
