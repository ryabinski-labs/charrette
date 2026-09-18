import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent } from "@charrette/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { PitStop, PitStopDecision } from "./pitstop.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The two pit stops that change what gets built: the one the intent verdict's
 * FAIL opens before any pull request exists (PITSTOP.md S6), and re-planning
 * the work that has not started yet (S3).
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-replan-"));
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
const INTENT_FAIL =
  '```json\n{"verdict":"FAIL","gaps":["the pack endpoint is singular on one side and plural on the other"],"summary":"the seam is broken"}\n```';
const DEMO_OK = '```json\n{"started":true,"howStarted":"pnpm dev","summary":"","journeys":[],"couldNotReach":[],"artifacts":[]}\n```';
const REVIEW_OK = '```json\n{"verdict":"drifting","findings":["nothing calls the new route"],"question":"is the map still in scope?"}\n```';

const dag = (tasks: { id: string; epicId?: string; dependsOn?: string[]; spec?: string }[], epics = [{ id: "epic-one", title: "First", summary: "s" }]) =>
  "```json\n" +
  JSON.stringify({
    epics,
    tasks: tasks.map((t) => ({
      id: t.id,
      epicId: t.epicId ?? "epic-one",
      title: t.id,
      spec: t.spec ?? "s",
      acceptanceCriteria: ["x"],
      dependsOn: t.dependsOn ?? [],
      touchedPaths: [],
      estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string | Partial<AgentResult> | Error);

function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const nth = (counts[spec.role] = (counts[spec.role] ?? 0) + 1);
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: 0, turns: 1, outcome: "done" };
      if (typeof answer === "function") {
        const out = answer(spec, nth);
        if (out instanceof Error) throw out;
        return typeof out === "string" ? { ...base, resultText: out } : { ...base, ...out };
      }
      return { ...base, resultText: answer ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
}

const worker = (spec: AgentSpec, nth: number) => (commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");

/** Docs, then the DAG, then whatever later planner calls (re-plans) answer. */
const plannerSaying = (...later: string[]) => (_s: AgentSpec, nth: number) => (nth === 1 ? DOCS : (later[nth - 2] ?? dag([{ id: "task-a" }])));

/** The mid-run trigger effectively off, so only the closing pit stop fires. */
// The plan-intent check is off in this file: it spawns a validator at the plan
// gate, and these fixtures sequence the validator by call number to drive the
// END-of-run verdict, which is what they are actually about.
const BASE = { deterministicChecks: [] as string[], waitForChecks: false, maxParallelWorkers: 1, pitStop: { every: { tasks: 99 } }, planIntentCheck: false };

function build(opts: { repoPath: string; pool: AgentPool; decide?: (stop: PitStop) => PitStopDecision }) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: CharretteEvent[] = [];
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

/**
 * `intentFixRounds: 0` throughout: these are about what the operator is *shown*
 * when the intent check fails, and a run that also queues work to close the gaps
 * goes round again, which is a different subject with its own tests below.
 */
describe("the pit stop a FAIL verdict opens", () => {
  it("shows the operator the verdict before any pull request exists", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_FAIL,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store, stops } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    // Run ec40b527 printed exactly this verdict once, at the end, to a terminal
    // that had scrolled. Now it is a gate.
    expect(stops.length).toBe(1);
    expect(stops[0]!.reason).toMatch(/^the run cannot prove itself: the intent check found \d+ gaps?$/);
    expect(stops[0]!.intent).toMatchObject({ verdict: "FAIL" });
    expect(stops[0]!.markdown).toContain("the pack endpoint is singular on one side");
    // Shown, answered "continue" — and still not proven. The run holds on the
    // verdict rather than opening a pull request over it.
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
  });

  it("does not open when the verdict passed", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(stops).toEqual([]);
  });

  it("is not re-opened by a resume that re-enters integration", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_FAIL,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, stops } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));
    await controller.resume(runId);

    // The verdict has already been shown and answered; re-asking would be the
    // charrette nagging about a decision the operator already made.
    expect(stops.length).toBe(1);
  });

  it("parks the run when the operator wants to think about the gap", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_FAIL,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store } = build({ repoPath: dir, pool, decide: () => ({ action: "stop", feedback: "" }) });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    // No pull request over a tree the operator has just been told is wrong.
    expect(store.listTasks(runId).every((t) => t.prNumber === null)).toBe(true);
  });
});

describe("re-planning what has not been built", () => {
  it("replaces the queued tasks and leaves the merged ones alone", async () => {
    const dir = repo();
    let replanned = false;
    const { pool } = rolePool({
      planner: plannerSaying(dag([{ id: "task-a" }, { id: "task-b" }, { id: "task-c" }]), dag([{ id: "task-fix", dependsOn: ["task-a"] }])),
      worker,
      qa: () => QA_PASS,
      // Second time round the seam is fixed, so the run can finish.
      validator: (_s, nth) => (nth === 1 ? INTENT_FAIL : '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```'),
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store } = build({
      repoPath: dir,
      pool,
      decide: () => {
        if (replanned) return { action: "continue", feedback: "" };
        replanned = true;
        return { action: "replan", feedback: "the two sides disagree about the route name — make them agree" };
      },
    });

    // maxParallelWorkers 1 and a mid-run trigger of 2 tasks: the pit stop fires
    // with task-c still queued, which is the one that gets replaced.
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    // Replaced, not silently forgotten — and the reason is on the record.
    expect(store.getTask(runId, "task-c")!.state).toBe("CANCELLED");
    expect(store.taskStateReason(runId, "task-c")).toContain("re-planned at a pit stop");
    expect(store.getTask(runId, "task-fix")!.state).toBe("MERGED");
  });

  it("hands the planner the operator's words and what is immovable", async () => {
    const dir = repo();
    let replanned = false;
    const { pool, specs } = rolePool({
      planner: plannerSaying(dag([{ id: "task-a" }, { id: "task-b" }]), dag([{ id: "task-new" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller } = build({
      repoPath: dir,
      pool,
      decide: () => (replanned ? { action: "continue", feedback: "" } : ((replanned = true), { action: "replan", feedback: "drop the offline mode" })),
    });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 1 } } }));

    const replanCall = specs.filter((s) => s.role === "planner").at(-1)!;
    expect(replanCall.prompt).toContain("drop the offline mode");
    expect(replanCall.prompt).toContain("IMMOVABLE");
    expect(replanCall.prompt).toContain("task-a");
  });

  it("keeps the operator's words when the planner cannot be parsed", async () => {
    const dir = repo();
    let replanned = false;
    const { pool, specs } = rolePool({
      planner: plannerSaying(dag([{ id: "task-a" }, { id: "task-b" }]), "I could not work out what you wanted"),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store, events } = build({
      repoPath: dir,
      pool,
      decide: () => (replanned ? { action: "continue", feedback: "" } : ((replanned = true), { action: "replan", feedback: "make the two sides agree" })),
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 1 } } }));

    // Losing what the operator said is the one outcome worse than an unchanged
    // plan, so it falls back to attaching their words to the queued task.
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    expect(events.some((e) => e.type === "agent.log" && /could not re-plan/.test(e.text))).toBe(true);
    expect(specs.filter((s) => s.role === "worker").at(-1)!.prompt).toContain("make the two sides agree");
  });

  /**
   * A cancelled task's `dependsOn` is history, not a constraint. Cancelling a
   * task does not rewrite the graph around it, so its edges go on pointing at
   * whatever was queued at the time — and a re-plan drops queued tasks by
   * design. Validating the two together refuses a perfectly good plan for a
   * reference that only a task nobody will ever run still holds, and it gets
   * worse the more the run has been re-planned, because that is where the
   * cancellations come from. Run bc691359's third re-plan attempt in a row
   * died this way: `task ci-e2e-operator-journey depends on unknown task
   * cp-embed-spa`, both of them already out of the picture.
   */
  it("re-plans past the dangling edges of a task that was already cancelled", async () => {
    const dir = repo();
    let stops = 0;
    const { pool } = rolePool({
      planner: plannerSaying(
        // `task-gate` keeps the two below it queued rather than running, so
        // what the re-plans see is deterministic.
        dag([
          { id: "task-a" },
          { id: "task-gate", dependsOn: ["task-a"] },
          { id: "task-b", dependsOn: ["task-gate"] },
          { id: "task-cancelled", dependsOn: ["task-b"] },
        ]),
        // First re-plan: `task-cancelled` is dropped and cancelled, still
        // holding its edge to `task-b`, which the planner re-states — so the
        // run now looks like every re-planned run does.
        dag([{ id: "task-d" }, { id: "task-b", dependsOn: ["task-d"] }]),
        // Second: `task-b` goes too, and a stale edge out of a cancelled task
        // is the only thing that still names it.
        dag([{ id: "task-e" }])
      ),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store, events } = build({
      repoPath: dir,
      pool,
      decide: () => (stops++ < 2 ? { action: "replan", feedback: "change it" } : { action: "continue", feedback: "" }),
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 1 } } }));

    expect(events.filter((e) => e.type === "agent.log" && /could not re-plan/.test(e.text)).map((e) => (e as { text: string }).text)).toEqual([]);
    expect(store.getTask(runId, "task-cancelled")!.state).toBe("CANCELLED");
    expect(store.getTask(runId, "task-b")!.state).toBe("CANCELLED");
    expect(store.getTask(runId, "task-e")!.state).toBe("MERGED");
  });

  it("refuses a re-plan that would collide with work already merged", async () => {
    const dir = repo();
    let replanned = false;
    const { pool } = rolePool({
      // The planner re-uses a merged task's id, which would take its branch, its
      // issue and its place in the DAG away from work that is already in.
      planner: plannerSaying(dag([{ id: "task-a" }, { id: "task-b" }]), dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store, events } = build({
      repoPath: dir,
      pool,
      decide: () => (replanned ? { action: "continue", feedback: "" } : ((replanned = true), { action: "replan", feedback: "change it" })),
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 1 } } }));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(events.some((e) => e.type === "agent.log" && /duplicate task id/.test(e.text))).toBe(true);
  });

  /**
   * The first plan is checked for this and the re-plan has to be too: a pit stop
   * is a planner writing tasks from the same brief, and it can reach for the
   * same sibling repository run 7ef8fb4d's first plan did. There is no retry
   * loop here to absorb it, so the re-plan is refused whole and the queued work
   * stands — which is worse than a fixed plan and much better than tasks nothing
   * in this run can build.
   */
  it("refuses a re-plan whose task is written against a repository the run does not own", async () => {
    const dir = repo();
    const sibling = path.join(path.dirname(dir), "other-repo");
    let replanned = false;
    const { pool } = rolePool({
      planner: plannerSaying(dag([{ id: "task-a" }, { id: "task-b" }]), dag([{ id: "task-new", spec: `In ${sibling}/, add the table.` }])),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store, events } = build({
      repoPath: dir,
      pool,
      decide: () => (replanned ? { action: "continue", feedback: "" } : ((replanned = true), { action: "replan", feedback: "change it" })),
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 1 } } }));

    expect(events.some((e) => e.type === "agent.log" && /reach outside this run's repository: task task-new is written against other-repo/.test(e.text))).toBe(true);
    // The out-of-scope task was never created, and the plan that was already
    // running is still the plan.
    expect(store.getTask(runId, "task-new")).toBeUndefined();
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
  });

  it("reads a redirect with nothing queued as the re-plan it can only be", async () => {
    const dir = repo();
    let asked = false;
    const { pool, specs } = rolePool({
      planner: plannerSaying(dag([{ id: "task-a" }]), dag([{ id: "task-fix" }])),
      worker,
      qa: () => QA_PASS,
      validator: (_s, nth) => (nth === 1 ? INTENT_FAIL : '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```'),
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
    });
    const { controller, store } = build({
      repoPath: dir,
      pool,
      // At the closing pit stop every task is terminal, so there is nothing for
      // a redirect to attach to. Swallowing their words would be the worst of
      // the three options.
      decide: () => (asked ? { action: "continue", feedback: "" } : ((asked = true), { action: "redirect", feedback: "fix the route name" })),
    });

    // Nothing queued is the whole premise: gap-closing tasks would be somewhere
    // for the redirect to land, and then it is a redirect and not a re-plan.
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    expect(specs.filter((s) => s.role === "planner").length).toBe(3);
    expect(store.getTask(runId, "task-fix")!.state).toBe("MERGED");
  });
});
