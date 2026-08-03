import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { PitStop } from "./pitstop.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * What the harness does with a failing intent verdict.
 *
 * Run 40da9337 merged 36 tasks, spent $774, opened its pull requests and
 * reported success — carrying a validator verdict that said none of the workers
 * which actually move money were scheduled to run anywhere outside a test. Seven
 * gaps, every one of them a task the harness knew how to write, and the verdict
 * was a line in a log. These tests are that line becoming work.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-intentfix-"));
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
const PASS = '```json\n{"verdict":"PASS","gaps":[],"summary":"everything asked for is there"}\n```';
const DEMO_OK = '```json\n{"started":true,"howStarted":"pnpm dev","summary":"","journeys":[],"couldNotReach":[],"artifacts":[]}\n```';
const REVIEW_OK = '```json\n{"verdict":"on-track","findings":[],"question":""}\n```';

const GAPS = [
  "runDisbursementWorker() is implemented and tested but nothing schedules it — src/server.ts never starts it",
  "processWebhookOutbox() is never called outside its own test",
];
const failing = (gaps: string[] = GAPS) => "```json\n" + JSON.stringify({ verdict: "FAIL", gaps, summary: "the money never moves" }) + "\n```";

const dag = (ids: string[] = ["task-a"]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-one", title: "First", summary: "s" }],
    tasks: ids.map((id) => ({
      id, epicId: "epic-one", title: id, spec: "s", acceptanceCriteria: ["x"],
      dependsOn: [], touchedPaths: [], estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string);

function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const nth = (counts[spec.role] = (counts[spec.role] ?? 0) + 1);
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const text = typeof answer === "function" ? answer(spec, nth) : (answer ?? "");
      return { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: text, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
}

const worker = (spec: AgentSpec, nth: number) => (commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");
const planner = (_s: AgentSpec, nth: number) => (nth === 1 ? DOCS : dag());

const BASE = { deterministicChecks: [] as string[], waitForChecks: false, maxParallelWorkers: 1, pitStop: { every: "never" as const } };

function build(opts: { repoPath: string; pool: AgentPool }) {
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
      return { action: "continue", feedback: "" };
    },
  };
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events, stops };
}

const logs = (events: HarnessEvent[]) => events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log").map((e) => e.text);

describe("a failing intent verdict", () => {
  it("queues one task per gap and sends the run back to work", async () => {
    const dir = repo();
    // Fails once. The gap-closing round then merges and the second read passes.
    const { pool } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: (_s, nth) => (nth === 1 ? failing() : PASS),
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    const fixes = store.listTasks(runId).filter((t) => t.id.startsWith("intent-fix-"));
    expect(fixes.map((t) => t.id)).toEqual(["intent-fix-1-1", "intent-fix-1-2"]);
    expect(fixes.every((t) => t.state === "MERGED")).toBe(true);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("puts the gap itself in front of the worker, not a summary of it", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: (_s, nth) => (nth === 1 ? failing() : PASS),
    });
    const { controller } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    const prompt = specs.filter((s) => s.taskId === "intent-fix-1-1" && s.role === "worker")[0]!.prompt;
    expect(prompt).toContain("src/server.ts never starts it");
    expect(prompt).toContain("the money never moves");
  });

  it("chains the gaps rather than racing them into the same file", async () => {
    // Four of run 40da9337's seven gaps were "wire this into the entrypoint".
    // Run in parallel they are one merge conflict per gap, for no gain at all.
    const dir = repo();
    const { pool } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: (_s, nth) => (nth === 1 ? failing() : PASS),
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getTask(runId, "intent-fix-1-1")!.dependsOn).toEqual([]);
    expect(store.getTask(runId, "intent-fix-1-2")!.dependsOn).toEqual(["intent-fix-1-1"]);
  });

  it("stops after its rounds rather than chasing a verdict that keeps failing", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: () => failing(),
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    // One round, then the PRs open carrying the verdict — which is where a gap
    // the harness could not close belongs.
    expect(store.listTasks(runId).filter((t) => t.id.startsWith("intent-fix-")).length).toBe(2);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("does nothing at all when the operator has turned it off", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: () => failing(),
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    expect(store.listTasks(runId).some((t) => t.id.startsWith("intent-fix-"))).toBe(false);
  });

  it("queues nothing when the verdict passed", async () => {
    const dir = repo();
    const { pool } = rolePool({ planner, worker, qa: () => QA_PASS, validator: () => PASS });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.listTasks(runId).some((t) => t.id.startsWith("intent-fix-"))).toBe(false);
  });

  it("queues nothing when a FAIL names no gap to act on", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: () => '```json\n{"verdict":"FAIL","gaps":[],"summary":"it is wrong and I cannot say how"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.listTasks(runId).some((t) => t.id.startsWith("intent-fix-"))).toBe(false);
  });

  it("queues nothing when the validator never returned a verdict", async () => {
    const dir = repo();
    const { pool } = rolePool({ planner, worker, qa: () => QA_PASS, validator: () => "I could not parse the tree" });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.listTasks(runId).some((t) => t.id.startsWith("intent-fix-"))).toBe(false);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("says out loud which gaps it did not queue", async () => {
    // A cap that silently drops gaps reads as "there were only ten", which is
    // the failure this whole feature exists to stop.
    const dir = repo();
    const many = Array.from({ length: 12 }, (_, i) => `gap number ${i + 1}`);
    const { pool } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: (_s, nth) => (nth === 1 ? failing(many) : PASS),
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.listTasks(runId).filter((t) => t.id.startsWith("intent-fix-")).length).toBe(10);
    expect(logs(events).some((t) => /Not queued, and yours to judge: gap number 11 \| gap number 12/.test(t))).toBe(true);
  });

  it("groups the gap work under its own epic so a pit stop can show it together", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner, worker, qa: () => QA_PASS, demo: () => DEMO_OK, reviewer: () => REVIEW_OK,
      validator: (_s, nth) => (nth === 1 ? failing() : PASS),
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getTask(runId, "intent-fix-1-1")!.epicId).toBe("intent-gaps");
    // And the epics the plan already had keep their order rather than being
    // renumbered behind the new one.
    expect(store.listEpics(runId).map((e) => e.id)).toEqual(["epic-one", "intent-gaps"]);
  });
});
