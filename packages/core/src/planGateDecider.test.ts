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
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { planGateDeciderPrompt, planGateDeciderSystemPrompt } from "./prompts.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The plan gate, adjudicated.
 *
 * The intent check has worked since it shipped. Run f338b5c8's fired before a
 * worker was dispatched and named four things its plan would not deliver — one
 * of them the missing mechanism that made M0's gates unmeasurable, which is
 * what ended the run 51 tasks and $475.07 later with no pull request at all.
 * The gap list was approved two and a half minutes after it appeared, because
 * the operator's alternative to `y` was writing re-planning feedback out of a
 * list of absences at nine in the evening.
 *
 * So the finding gets a name against it before they see it. What these cases
 * pin is the shape of that: the adjudicator can send a plan back on its own
 * authority, it cannot approve one, it is bounded so a planner and it cannot
 * argue forever, and every way it can fail leaves the operator exactly the gate
 * they had before.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-plangate-"));
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
const INTENT_PASS = '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```';
const GAP = "no task owns the endpoint that ingests the runner's results";
const INTENT_FAIL = `\`\`\`json\n${JSON.stringify({ verdict: "FAIL", gaps: [GAP], summary: "no" })}\n\`\`\``;

const verdict = (over: Partial<{ action: string; why: string; feedback: string }> = {}) =>
  "```json\n" + JSON.stringify({ action: "accept", why: "", feedback: "", ...over }) + "\n```";

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

type Answer = (spec: AgentSpec, nth: number) => string | Error;

function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const nth = (counts[spec.role] = (counts[spec.role] ?? 0) + 1);
      await spec.budgetCheck?.();
      const out = answers[spec.role]?.(spec, nth) ?? "";
      if (out instanceof Error) throw out;
      return { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: out, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
}

const worker = (spec: AgentSpec, nth: number) => {
  writeFileSync(path.join(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "done\n");
  execFileSync("git", ["add", "-A"], { cwd: spec.cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", "w"], { cwd: spec.cwd, stdio: "ignore" });
  return "did the work";
};

function build(opts: { repoPath: string; pool: AgentPool; approve?: boolean }) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
  const shown: string[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate(_prd, summary) {
      shown.push(summary);
      return { approved: opts.approve ?? true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
  };
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events, shown };
}

/** No pit stops: this file is about the gate before anything is built. */
const config = (over: Record<string, unknown> = {}) =>
  RunConfig.parse({
    deterministicChecks: [],
    waitForChecks: false,
    maxParallelWorkers: 1,
    pitStop: { every: "never" },
    intentFixRounds: 0,
    budget: { runCapUsd: 1000, taskCapUsd: 1000 },
    ...over,
  });

const planGates = (events: HarnessEvent[]) => events.filter((e) => e.type === "run.gate_resolved" && (e as { kind: string }).kind === "plan");
const logs = (events: HarnessEvent[]) => events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);

describe("a plan gate that weighs its own intent check", () => {
  it("sends the plan back on the skill's authority, without asking anyone", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      // Every plan is two planner calls — the documents, then the DAG — and a
      // rejected gate starts a whole fresh plan, documents and all.
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : nth === 2 ? dag(["task-a"]) : dag(["task-a", "task-ingest"])),
      // FAIL first, and the re-planned DAG passes.
      validator: (_s, nth) => (nth === 1 ? INTENT_FAIL : INTENT_PASS),
      pm: () => verdict({ action: "replan", why: "the ingest seam has no owner", feedback: "Add a task that ingests the runner's results." }),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, store, events, shown } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", config());

    // The operator saw one gate, not two: the failing plan never reached them.
    expect(shown).toHaveLength(1);
    expect(shown[0]).not.toContain(GAP);
    expect(planGates(events).map((e) => [(e as { resolution: string }).resolution, (e as { decidedBy: string }).decidedBy])).toEqual([
      ["rejected", "product-manager"],
      ["approved", "operator"],
    ]);
    // And the planner was told what to add, with the gap list behind it.
    const replan = specs.filter((s) => s.role === "planner")[3]!;
    expect(replan.prompt).toContain("Add a task that ingests the runner's results.");
    expect(replan.prompt).toContain(GAP);
    expect(store.getTask(runId, "task-ingest")).toBeDefined();
  });

  it("cannot approve — an accepted gap still goes to the operator, with the reasoning attached", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_FAIL,
      pm: () => verdict({ action: "accept", why: "it is M5 work", feedback: "The ingest endpoint is out of scope for M0; the assignment scopes it to M5." }),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, events, shown } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", config());

    // One planner DAG: nothing was sent back.
    expect(specs.filter((s) => s.role === "planner")).toHaveLength(2);
    expect(shown).toHaveLength(1);
    // The gap list is still there — accepting does not hide it — and now it has
    // a name and a reason underneath, which is a much harder thing to press `y`
    // past than a bullet list of absences.
    expect(shown[0]).toContain(GAP);
    expect(shown[0]).toContain("product-manager weighed these gaps and accepted them:");
    expect(shown[0]).toContain("out of scope for M0");
    expect(planGates(events)).toHaveLength(1);
    expect(planGates(events)[0]).toMatchObject({ resolution: "approved", decidedBy: "operator" });
  });

  it("spends its veto once and then the gaps are the operator's, however it answers", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      // A gap the planner never closes, which is exactly the loop the bound exists for.
      validator: () => INTENT_FAIL,
      pm: () => verdict({ action: "replan", why: "still unowned", feedback: "Add the ingest task." }),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, events, shown } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", config());

    // One veto, then the second gate is theirs — and it says why it is theirs.
    expect(specs.filter((s) => s.role === "pm")).toHaveLength(1);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("product-manager already sent this plan back over these gaps, and they are still here");
    expect(planGates(events).map((e) => (e as { decidedBy: string }).decidedBy)).toEqual(["product-manager", "operator"]);
  });

  it("tells the second look what the first one already asked for", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_FAIL,
      pm: () => verdict({ action: "replan", why: "unowned", feedback: "Add the ingest task." }),
      worker,
      qa: () => QA_PASS,
    });
    // Two vetoes, so there is a second adjudication to inspect.
    const { controller } = build({ repoPath: dir, pool });
    await controller.startRun("build a thing", config({ planGate: { replanRounds: 2 } }));

    const second = specs.filter((s) => s.role === "pm")[1]!;
    expect(second.prompt).toContain("You already sent this plan back once, saying");
    expect(second.prompt).toContain("Add the ingest task.");
  });

  it("never runs when the check passes — there is nothing to weigh", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_PASS,
      pm: () => verdict({ action: "replan", feedback: "should never be read" }),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, events, shown } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", config());

    expect(specs.some((s) => s.role === "pm")).toBe(false);
    expect(shown).toHaveLength(1);
    // The gate is still recorded. Until now nothing said who approved a plan.
    expect(planGates(events)).toHaveLength(1);
    expect(planGates(events)[0]).toMatchObject({ decidedBy: "operator", resolution: "approved" });
  });

  it("never runs when the operator kept the gate", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_FAIL,
      pm: () => verdict({ action: "replan", feedback: "should never be read" }),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, shown } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", config({ planGate: { decidedBy: "operator" } }));

    expect(specs.some((s) => s.role === "pm")).toBe(false);
    expect(shown[0]).toContain(GAP);
  });

  it.each([
    ["answered with something that is not one of its two actions", () => verdict({ action: "approve-it" })],
    ["answered with prose", () => "Looks fine to me, ship it."],
    ["died", () => new Error("Claude Code process exited with code 1")],
  ])("hands the gaps to the operator unchanged when it %s", async (_case, pm) => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_FAIL,
      pm,
      worker,
      qa: () => QA_PASS,
    });
    const { controller, events, shown } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", config());

    // A plan nobody could weigh is still a plan the operator may approve. What
    // it must never be is a plan that looks weighed.
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain(GAP);
    expect(shown[0]).toContain("Nothing weighed these gaps");
    expect(logs(events)).toContainEqual(expect.stringContaining("did not weigh the plan-intent gaps"));
    expect(planGates(events)[0]).toMatchObject({ decidedBy: "operator" });
  });

  it("shows the operator the reasoning when the accept came with nothing else", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_FAIL,
      // `feedback` is the field aimed at the operator and `why` at the log. An
      // adjudicator that fills in only the second one has still weighed the
      // gaps, and its reasoning is the whole reason the accept is worth more
      // than the bare gap list — so it goes to them rather than being dropped.
      pm: () => verdict({ action: "accept", why: "the ingest endpoint is M5 work", feedback: "" }),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, shown } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", config());

    expect(shown[0]).toContain("product-manager weighed these gaps and accepted them:\nthe ingest endpoint is M5 work");
  });

  it("narrates an accept that gave no reason without trailing an empty dash", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_FAIL,
      pm: () => verdict({ action: "accept", why: "", feedback: "The ingest endpoint is out of scope for M0." }),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, events, shown } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", config());

    expect(logs(events)).toContainEqual("product-manager on the plan-intent gaps: accept");
    expect(shown[0]).toContain("The ingest endpoint is out of scope for M0.");
  });

  it("lets a budget failure stop the run rather than dressing it up as an unweighed gate", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (_s, nth) => (nth % 2 === 1 ? DOCS : dag(["task-a"])),
      validator: () => INTENT_FAIL,
      // The adjudicator is metered like anything else, so it can be the call
      // that runs the run out of money. That is not "the skill had nothing to
      // say" — swallowing it would show the operator a gate to approve on a run
      // that has already stopped paying for the work behind it.
      pm: () => new BudgetExceeded("run", 10, 1, "run-x"),
      worker,
      qa: () => QA_PASS,
    });
    const { controller, events, shown } = build({ repoPath: dir, pool });

    await expect(controller.startRun("build a thing", config())).rejects.toThrow(BudgetExceeded);

    expect(shown).toEqual([]);
    expect(logs(events)).not.toContainEqual(expect.stringContaining("did not weigh the plan-intent gaps"));
    expect(planGates(events)).toEqual([]);
  });

  it("records the operator's own rejection against them, not against the skill", async () => {
    const dir = repo();
    const { pool } = rolePool({
      // One good plan, rejected — and then a planner that cannot produce a
      // second, which is what ends the loop here rather than a real run's
      // operator eventually approving something.
      planner: (_s, nth) => (nth === 1 ? DOCS : nth === 2 ? dag(["task-a"]) : "no documents here"),
      validator: () => INTENT_PASS,
      worker,
      qa: () => QA_PASS,
    });
    const { controller, events } = build({ repoPath: dir, pool, approve: false });

    await controller.startRun("build a thing", config()).catch(() => undefined);

    expect(planGates(events).length).toBeGreaterThan(0);
    for (const g of planGates(events)) expect(g).toMatchObject({ resolution: "rejected", decidedBy: "operator" });
  });
});

describe("what the adjudicator is told", () => {
  const system = planGateDeciderSystemPrompt("product-manager", "You may send this plan back 1 more time.");

  it("wears the hat it was named as and is given the two actions it has", () => {
    expect(system).toContain("**product-manager**");
    expect(system).toContain("**replan**");
    expect(system).toContain("**accept**");
  });

  it("is told outright that approving is not one of them", () => {
    expect(system).toContain("You cannot approve the plan");
    expect(system).toContain("they started this run a few minutes ago");
  });

  it("checks the gap before acting on it, because the validator reads prose", () => {
    expect(system).toContain("**Check each gap before you act on it.**");
    expect(system).toContain("It can read a requirement into the assignment that nobody wrote");
  });

  it("separates a gap nobody owns from a gap somebody owns badly", () => {
    expect(system).toContain("A gap nobody owns is a planning gap");
  });

  it("asks what the run delivers without the gap, not whether a task is missing", () => {
    expect(system).toContain('Not "is this task missing" but "what does the run deliver at the end without it"');
  });

  it("carries the bound it was given, so it knows what it is spending", () => {
    expect(system).toContain("You may send this plan back 1 more time.");
  });

  it("carries the PRD when there is one, and reads straight through when there is not", () => {
    const withPrd = planGateDeciderPrompt("build a thing", "# PRD — Build the thing", "task-a: does a", [GAP]);
    const without = planGateDeciderPrompt("build a thing", "", "task-a: does a", [GAP]);

    expect(withPrd).toContain("The PRD the plan was written from:\n# PRD — Build the thing");
    // A run started from a sentence has no PRD, and the heading must not appear
    // over nothing — the assignment is then the only statement of intent there
    // is, and the gaps have to be read against it.
    expect(without).not.toContain("The PRD the plan was written from");
    expect(without).toContain("What the operator asked for:\nbuild a thing");
    for (const p of [withPrd, without]) {
      expect(p).toContain(GAP);
      expect(p).toContain("task-a: does a");
    }
  });

  it("aims the two kinds of feedback at the two different readers", () => {
    expect(system).toContain("for **replan** is read by the planner, not by the operator");
    expect(system).toContain("for **accept** is read by the operator, immediately before they approve or reject");
    expect(system).toContain("Do not sell them the plan");
  });
});
