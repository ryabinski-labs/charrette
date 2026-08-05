import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { BudgetExceeded } from "./budget.js";
import { GitHubAdapter } from "./github.js";
import type { PitStop, PitStopDecision } from "./pitstop.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The pit stops nobody plans for: one that fires before anything has been
 * built, a cap reached inside the demo, and a re-plan whose new work parks.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-pitedge-"));
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

const commit = (cwd: string, file: string) => {
  writeFileSync(path.join(cwd, file), "done\n");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", `add ${file}`], { cwd, stdio: "ignore" });
};

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"ok"}\n```';
const INTENT_FAIL = '```json\n{"verdict":"FAIL","gaps":["the seam is broken"],"summary":"no"}\n```';
const DEMO_OK = '```json\n{"started":true,"howStarted":"pnpm dev","summary":"","journeys":[],"couldNotReach":[],"artifacts":[]}\n```';
const REVIEW_OK = '```json\n{"verdict":"on-track","findings":[],"question":""}\n```';

const dag = (ids: string[]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-one", title: "First", summary: "s" }],
    tasks: ids.map((id) => ({
      id, epicId: "epic-one", title: id, spec: "s", acceptanceCriteria: ["x"],
      dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string | Partial<AgentResult> | Error);

function rolePool(answers: Partial<Record<string, Answer>>, bill = 0, billOnly?: string[]) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const ref = { store: null as Store | null };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const nth = (counts[spec.role] = (counts[spec.role] ?? 0) + 1);
      if (bill && ref.store && (!billOnly || billOnly.includes(spec.role))) {
        ref.store.recordUsage({
          runId: spec.runId, taskId: spec.taskId, sessionId: `s${specs.length}`, model: spec.model,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: bill,
        });
      }
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: bill, turns: 1, outcome: "done" };
      if (typeof answer === "function") {
        const out = answer(spec, nth);
        if (out instanceof Error) throw out;
        return typeof out === "string" ? { ...base, resultText: out } : { ...base, ...out };
      }
      return { ...base, resultText: answer ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, ref };
}

const worker = (spec: AgentSpec, nth: number) => (commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");
const plannerSaying = (...later: string[]) => (_s: AgentSpec, nth: number) => (nth === 1 ? DOCS : (later[nth - 2] ?? dag(["task-a"])));

const BASE = { deterministicChecks: [] as string[], waitForChecks: false, maxParallelWorkers: 1 };

function build(opts: { repoPath: string; pool: AgentPool; decide?: (stop: PitStop) => PitStopDecision }) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
  const stops: PitStop[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    async resolvePitStop(stop) {
      stops.push(stop);
      return opts.decide?.(stop) ?? { action: "continue", feedback: "" };
    },
  };
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events, stops };
}

describe("a pit stop before anything has been built", () => {
  it("says so rather than projecting a cost from no evidence", async () => {
    const dir = repo();
    // A spend interval trips on the planning sessions alone, so the stop opens
    // with an empty tree — the honest short pit stop the design allows for.
    const { pool, ref } = rolePool(
      { planner: plannerSaying(), worker, qa: () => QA_PASS, validator: () => INTENT_FAIL, demo: () => DEMO_OK, reviewer: () => REVIEW_OK },
      1,
      ["planner"]
    );
    const { controller, store, stops } = build({ repoPath: dir, pool });
    ref.store = store;

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { usd: 1 } }, budget: { runCapUsd: 1000, taskCapUsd: 1000 } }));

    expect(stops[0]!.merged).toEqual([]);
    expect(stops[0]!.projectedUsd).toBe(stops[0]!.spentUsd);
    expect(stops[0]!.markdown).not.toContain("projects to");
  });

  it("re-plans from an empty tree without pretending something is immovable", async () => {
    const dir = repo();
    let replanned = false;
    const { pool, specs, ref } = rolePool(
      {
        planner: plannerSaying(dag(["task-a"]), dag(["task-new"])),
        worker,
        qa: () => QA_PASS,
        validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
        demo: () => DEMO_OK,
        reviewer: () => REVIEW_OK,
      },
      1,
      ["planner"]
    );
    const { controller, store } = build({
      repoPath: dir,
      pool,
      decide: () => (replanned ? { action: "continue", feedback: "" } : ((replanned = true), { action: "replan", feedback: "build the other thing instead" })),
    });
    ref.store = store;

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { usd: 1 } }, budget: { runCapUsd: 1000, taskCapUsd: 1000 } }));

    expect(specs.filter((s) => s.role === "planner").at(-1)!.prompt).toContain("(nothing yet)");
    expect(store.getTask(runId, "task-new")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-a")!.state).toBe("CANCELLED");
  });
});

describe("a demo with nowhere to run", () => {
  it("reports the missing worktree instead of taking the run down with it", async () => {
    const dir = repo();
    // The worktree root is a file, so no worktree can be created under it —
    // the shape of a disk that filled up or a path the operator took over.
    writeFileSync(`${dir}-wt`, "not a directory\n");
    const { pool, ref } = rolePool(
      { planner: plannerSaying(), worker, qa: () => QA_PASS, validator: () => INTENT_FAIL, demo: () => DEMO_OK, reviewer: () => REVIEW_OK },
      1,
      ["planner"]
    );
    const { controller, store, stops } = build({ repoPath: dir, pool });
    ref.store = store;

    await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, pitStop: { every: { usd: 1 } }, budget: { runCapUsd: 1000, taskCapUsd: 1000 } })
    );

    // The pit stop still happens, and says why there is nothing to look at. A
    // checkpoint that quietly does not happen is the failure being fixed here.
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]!.demo.started).toBe(false);
    expect(stops[0]!.markdown).toContain("there is no demo for this pit stop");
  });
});

describe("a cap reached inside a pit stop", () => {
  const cases: { role: "demo" | "reviewer" | "planner"; decide?: (stop: PitStop) => PitStopDecision }[] = [
    { role: "demo" },
    { role: "reviewer" },
    { role: "planner", decide: () => ({ action: "replan", feedback: "change it" }) },
  ];

  for (const { role, decide } of cases) {
    it(`comes back out of the ${role} session rather than being swallowed as a failure`, async () => {
      const dir = repo();
      const { pool } = rolePool({
        planner: (s: AgentSpec, nth: number) =>
          nth === 1 ? DOCS : nth === 2 ? dag(["task-a"]) : (void s, new BudgetExceeded("run", 99, 50, "run1")),
        worker,
        qa: () => QA_PASS,
        validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
        demo: () => (role === "demo" ? new BudgetExceeded("run", 99, 50, "run1") : DEMO_OK),
        reviewer: () => (role === "reviewer" ? new BudgetExceeded("run", 99, 50, "run1") : REVIEW_OK),
      });
      const { controller } = build({ repoPath: dir, pool, decide });

      // A budget stop is not "the demo did not finish" — it is the run being
      // out of money, and it has to reach the operator as that.
      await expect(controller.startRun("build a thing", RunConfig.parse(BASE))).rejects.toThrow(/budget exceeded/);
    });
  }
});

describe("a FAIL the operator has already answered", () => {
  it("is not re-opened when the re-planned work parks and nothing new merges", async () => {
    const dir = repo();
    let failing = false;
    const { pool } = rolePool({
      planner: plannerSaying(dag(["task-a"]), dag(["task-fix"])),
      // The replacement task's worker dies every time, so it parks: the run
      // comes back to integration with nothing merged since the verdict.
      worker: (spec, nth) => (failing ? new Error("the worker died") : worker(spec, nth)),
      qa: () => QA_PASS,
      validator: () => INTENT_FAIL,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, stops, store } = build({
      repoPath: dir,
      pool,
      decide: () => {
        if (failing) return { action: "continue", feedback: "" };
        failing = true;
        return { action: "replan", feedback: "fix the seam" };
      },
    });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 99 } }, workerRespawnCap: 1 })
    );

    // The FAIL opens a pit stop whatever the interval says — once. Asking again
    // about a verdict they have already acted on is the harness nagging.
    expect(stops.length).toBe(1);
    expect(store.getTask(runId, "task-fix")!.state).toBe("NEEDS_HUMAN");
  });
});
