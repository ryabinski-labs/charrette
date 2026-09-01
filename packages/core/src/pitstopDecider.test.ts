import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * The pit stop deciding for itself.
 *
 * A pit stop buys four opinions and then blocked until a human typed a letter,
 * which meant the checkpoint only worked while someone was watching — a run
 * that stops at 2am for a decision its own reviewers have already made is a run
 * that has stopped. `pitStop.decidedBy` names the skill that answers instead.
 * What these cases pin is that it really is the decision — nobody is asked, the
 * four actions do what they always did — and that it hands back to the operator
 * the moment it cannot answer, because a pit stop resolved by a guess is worse
 * than one that waits.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-pmdecide-"));
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
const INTENT_PASS = '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```';
const INTENT_FAIL = '```json\n{"verdict":"FAIL","gaps":["the seam is broken"],"summary":"no"}\n```';
const DEMO_OK = '```json\n{"started":true,"howStarted":"pnpm dev","summary":"","journeys":[],"couldNotReach":[],"artifacts":[]}\n```';
const REVIEW_OK = '```json\n{"verdict":"on-track","findings":[],"question":""}\n```';

const decision = (over: Partial<{ action: string; why: string; feedback: string; blockedOn: string }> = {}) =>
  "```json\n" + JSON.stringify({ action: "continue", why: "", feedback: "", ...over }) + "\n```";

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

type Answer = string | ((spec: AgentSpec, nth: number) => string | Error);

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
        return { ...base, resultText: out };
      }
      return { ...base, resultText: answer ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, ref };
}

const worker = (spec: AgentSpec, nth: number) => (commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");
const plannerSaying = (...later: string[]) => (_s: AgentSpec, nth: number) => (nth === 1 ? DOCS : (later[nth - 2] ?? dag(["task-a", "task-b"])));

// `planGate.decidedBy` is off throughout this file on purpose. Several cases
// here fail the plan-intent check deliberately — it is how they reach the
// closing pit stop that repeats — and the plan-gate adjudicator would answer
// that FAIL first, out of the same `pm` role, before any pit stop existed. Its
// own behaviour is pinned in planGateDecider.test.ts.
const BASE = { deterministicChecks: [] as string[], waitForChecks: false, maxParallelWorkers: 1, planGate: { decidedBy: "operator" } };

function build(opts: { repoPath: string; pool: AgentPool; decide?: (stop: PitStop) => PitStopDecision }) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
  const asked: PitStop[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    async resolvePitStop(stop) {
      asked.push(stop);
      return opts.decide?.(stop) ?? { action: "continue", feedback: "" };
    },
  };
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events, asked };
}

/** A run that pit-stops after its first task, with `decidedBy` set. */
const config = (decidedBy?: string) =>
  RunConfig.parse({
    ...BASE,
    pitStop: { every: { tasks: 1 }, ...(decidedBy === undefined ? {} : { decidedBy }) },
    budget: { runCapUsd: 1000 },
  });

const resolved = (events: HarnessEvent[]) => events.filter((e) => e.type === "run.pitstop_resolved");
const logs = (events: HarnessEvent[]) => events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);

describe("a pit stop that decides for itself", () => {
  it("asks the named skill instead of the operator, and records that it did", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
      pm: () => decision({ why: "both lenses agree the checkout flow is the thing that was asked for" }),
    });
    const { controller, store, events, asked } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", config());

    // Nobody was interrupted, and the run went on to finish.
    expect(asked).toEqual([]);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(resolved(events)[0]).toMatchObject({
      action: "continue",
      decidedBy: "product-manager",
      why: "both lenses agree the checkout flow is the thing that was asked for",
    });
    // Wearing the hat it was told to wear, on the model that decides.
    const pm = specs.find((s) => s.role === "pm")!;
    expect(pm.model).toBe("claude-fable-5-1");
    expect(pm.systemPrompt).toContain("**product-manager**");
    expect(pm.disallowedTools).toContain("Write");
    // It reads the same report the operator would have.
    expect(pm.prompt).toContain("# Pit stop 1");
    expect(pm.prompt).toMatch(/spent \$0\.00 of its \$1000\.00 cap/);
    expect(logs(events)).toContainEqual(expect.stringMatching(/^product-manager decided: continue — both lenses agree/));
  });

  it("writes what it decided into the report the pit stop leaves behind", async () => {
    const dir = repo();
    const { pool } = rolePool(
      {
        planner: plannerSaying(),
        worker,
        qa: () => QA_PASS,
        validator: () => INTENT_PASS,
        demo: () => DEMO_OK,
        reviewer: () => REVIEW_OK,
        pm: () => decision({ action: "redirect", why: "the empty states are missing everywhere", feedback: "Give every list an empty state before you add features to it." }),
      },
      0.5,
      ["pm"]
    );
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", config());

    const report = readFileSync(path.join(dir, ".harness", runId, "pitstops", "1", "REPORT.md"), "utf8");
    expect(report).toContain("## Decision — redirect");
    expect(report).toContain("Decided by: product-manager");
    expect(report).toContain("the empty states are missing everywhere");
    expect(report).toContain("Give every list an empty state");
    // The redirect reached the task that had not run yet.
    expect(resolved(events)[0]).toMatchObject({ action: "redirect", tasks: ["task-b"] });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("records the price of the decision next to it", async () => {
    const dir = repo();
    const { pool, ref } = rolePool(
      {
        planner: plannerSaying(),
        worker,
        qa: () => QA_PASS,
        validator: () => INTENT_PASS,
        demo: () => DEMO_OK,
        reviewer: () => REVIEW_OK,
        pm: () => decision(),
      },
      0.25,
      ["pm"]
    );
    const { controller, store } = build({ repoPath: dir, pool });
    ref.store = store;

    const runId = await controller.startRun("build a thing", config());

    // A checkpoint that decides on its own is still spending the run's money,
    // and the operator can only turn off a cost they can see.
    expect(readFileSync(path.join(dir, ".harness", runId, "pitstops", "1", "REPORT.md"), "utf8")).toContain("Decided by: product-manager ($0.25)");
  });

  it("stops the run when the decider says to, without asking anyone", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
      pm: () =>
        decision({
          action: "stop",
          blockedOn: "direction",
          feedback: "Nobody has decided whether this stores card numbers. Answer that before it builds the billing screens.",
        }),
    });
    const { controller, store, events, asked } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", config());

    expect(asked).toEqual([]);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(resolved(events)[0]).toMatchObject({ action: "stop", decidedBy: "product-manager", blockedOn: "direction" });
    // Only the first task ran: the second never went out.
    expect(store.getTask(runId, "task-b")!.state).toBe("PENDING");
  });
});

describe("a decider that cannot decide", () => {
  it.each([
    ["said something that is not one of the four actions", () => decision({ action: "carry-on-i-suppose" })],
    ["answered with prose", () => "I think you should probably keep going, it looks fine to me."],
    ["died", () => new Error("Claude Code process exited with code 1")],
  ])("hands the pit stop back to the operator when it %s", async (_case, pm) => {
    const dir = repo();
    const { pool } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
      pm,
    });
    const { controller, store, events, asked } = build({
      repoPath: dir,
      pool,
      decide: () => ({ action: "continue", feedback: "" }),
    });

    const runId = await controller.startRun("build a thing", config());

    // A pit stop is never resolved by a guess: the four actions are far too
    // consequential to infer one from a session that did not answer.
    expect(asked.length).toBeGreaterThan(0);
    expect(resolved(events)[0]).toMatchObject({ action: "continue", decidedBy: "operator", why: "" });
    expect(logs(events)).toContainEqual(expect.stringContaining("product-manager did not return a decision"));
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("lets the run's cap through rather than treating it as an undecided pit stop", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
      pm: () => {
        throw new BudgetExceeded(41, 40, "run1");
      },
    });
    const { controller, events, asked } = build({ repoPath: dir, pool });

    // The cap is the operator's own answer to "how much may this spend", and
    // asking them to resolve a pit stop instead would be asking the wrong
    // question at the moment the run ran out of money.
    await expect(controller.startRun("build a thing", config())).rejects.toThrow(BudgetExceeded);
    expect(asked).toEqual([]);
    expect(resolved(events)).toEqual([]);
  });
});

describe("the closing pit stop, which is the one that repeats", () => {
  it("stops sending itself back to work and hands the loop to the operator", async () => {
    const dir = repo();
    let replans = 0;
    const { pool, specs } = rolePool({
      // The first plan, then a fresh single task for every re-plan.
      planner: (_s, nth) => (nth === 1 ? DOCS : nth === 2 ? dag(["task-a"]) : dag([`task-fix-${++replans}`])),
      worker,
      qa: () => QA_PASS,
      // A verdict that never comes good: every integration pass returns to the
      // same closing pit stop over a tree it has already judged.
      validator: () => INTENT_FAIL,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
      pm: () => decision({ action: "replan", why: "the gaps the intent check found are real", feedback: "Close the gaps." }),
    });
    const { controller, store, events, asked } = build({
      repoPath: dir,
      pool,
      // The operator, once they are finally asked, ends it.
      decide: () => ({ action: "continue", feedback: "" }),
    });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({
        ...BASE,
        // Only the closing pit stop fires: nothing else should be in this.
        pitStop: { every: { usd: 1000 }, backToWorkRounds: 2 },
        intentFixRounds: 0,
        budget: { runCapUsd: 1000 },
      })
    );

    // Two goes at deciding for itself, and then the third is the operator's —
    // a loop a person ends by losing patience needs another way to end when
    // the thing answering it cannot get tired.
    expect(specs.filter((s) => s.role === "pm")).toHaveLength(2);
    expect(asked).toHaveLength(1);
    expect(resolved(events).map((e) => (e as { decidedBy: string }).decidedBy)).toEqual(["product-manager", "product-manager", "operator"]);
    expect(logs(events)).toContainEqual(expect.stringMatching(/come back FAIL 3 times[\s\S]*this one is yours to answer/));
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    // The second decider was shown what the first one already tried — a fresh
    // session with no memory is free to give the same answer forever.
    const second = specs.filter((s) => s.role === "pm")[1]!;
    expect(second.prompt).toContain("What was decided at this run's earlier pit stops");
    expect(second.prompt).toContain("the gaps the intent check found are real");
  });

  it("says the pit stop sent the run back, rather than telling the operator they did", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (_s, nth) => (nth === 1 ? DOCS : nth === 2 ? dag(["task-a"]) : dag(["task-fix"])),
      worker,
      qa: () => QA_PASS,
      // The first call is the plan-intent check; the second is the first
      // closing check, and it is the one that opens the pit stop.
      validator: (_s, nth) => (nth <= 2 ? INTENT_FAIL : INTENT_PASS),
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
      pm: (_s, nth) => decision(nth === 1 ? { action: "replan", feedback: "Close the gaps." } : {}),
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, pitStop: { every: { usd: 1000 } }, intentFixRounds: 0, budget: { runCapUsd: 1000 } })
    );

    // A run history that tells the operator they stopped their own run at 3am
    // is worse than one that says only that it was stopped. Who decided is on
    // the resolved event, one event earlier.
    const reasons = events.filter((e) => e.type === "run.state_changed").map((e) => (e as { reason: string }).reason);
    expect(reasons).toContain("the pit stop sent the run back to work");
    expect(reasons.join(" ")).not.toMatch(/you sent the run back/);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });
});

describe("a pit stop the operator kept for themselves", () => {
  it("asks them, and never spawns a decider", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: plannerSaying(),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
      demo: () => DEMO_OK,
      reviewer: () => REVIEW_OK,
      pm: () => decision({ action: "stop" }),
    });
    const { controller, store, events, asked } = build({
      repoPath: dir,
      pool,
      decide: () => ({ action: "continue", feedback: "" }),
    });

    const runId = await controller.startRun("build a thing", config("operator"));

    expect(asked.length).toBeGreaterThan(0);
    expect(specs.some((s) => s.role === "pm")).toBe(false);
    expect(resolved(events)[0]).toMatchObject({ action: "continue", decidedBy: "operator" });
    expect(readFileSync(path.join(dir, ".harness", runId, "pitstops", "1", "REPORT.md"), "utf8")).toContain("Decided by: operator\n");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });
});
