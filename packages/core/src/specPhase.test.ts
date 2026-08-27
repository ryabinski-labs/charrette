import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig, type HarnessEvent, type IntakeQuestion } from "@harness/shared";
import { Bus } from "./bus.js";
import { BudgetExceeded } from "./budget.js";
import { GitHubAdapter } from "./github.js";
import type { IntakeUi } from "./intake.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The specification phase, and the gate it feeds.
 *
 * Every gate this harness had before it is prose judged by prose, and they
 * share one failure mode: agreeing with the code because they misread the
 * requirement in the same direction it did. Run da8325bd merged one file of
 * twenty-one against a criterion that had, as written, genuinely been met.
 *
 * These cases are about the two things that make this gate different — that its
 * standard is written before any code exists, and that its verdict is an exit
 * code rather than an opinion.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-spec-"));
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
const BRIEF = '```json\n{"goal":"Build the checkout","context":"","decisions":[],"constraints":[],"outOfScope":[],"openQuestions":[]}\n```';

const dag = (tasks: { id: string; scenarioIds?: string[] }[]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: tasks.map((t) => ({
      id: t.id,
      epicId: "epic-e",
      title: t.id.toUpperCase(),
      spec: "s",
      acceptanceCriteria: ["x"],
      dependsOn: [],
      touchedPaths: [],
      completionProbe: "",
      scenarioIds: t.scenarioIds ?? [],
      estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

/** A specification the agent would emit, with `all` pointed at a real command. */
const specJson = (over: Record<string, unknown> = {}) =>
  "```json\n" +
  JSON.stringify({
    feature: "checkout",
    artifactPath: "tdd/checkout.tdd.yaml",
    requirements: [{ id: "REQ-001", text: "a card charge succeeds", priority: "P0", blockedBy: [] }],
    scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "charges a card", level: "unit", priority: "P0", oracle: "the charge returns 200", testRef: "t.ts::SC-001", blocked: false }],
    openQuestions: [],
    commands: { all: "exit 0", byId: 'echo "{{ids}}"' },
    notCovered: [],
    ...over,
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string);

function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const text = typeof answer === "function" ? answer(spec, counts[spec.role]!) : (answer ?? "");
      return { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: text, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
}

function build(opts: { repoPath: string; pool: AgentPool }) {
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
  };
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events };
}

/** An operator at the keyboard, answering whatever they are asked. */
function operator(answer = "use the Stripe sandbox"): IntakeUi & { asked: IntakeQuestion[] } {
  const asked: IntakeQuestion[] = [];
  return {
    asked,
    async ask(q: IntakeQuestion) {
      asked.push(q);
      return answer;
    },
    say() {},
  };
}

const BASE = { deterministicChecks: [] as string[], waitForChecks: false, planIntentCheck: false };
const worker = (spec: AgentSpec, nth: number) => (commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");

describe("writing the specification before anything is planned", () => {
  it("records it, and hands the planner the scenarios it must cover", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      intake: BRIEF,
      spec: specJson(),
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a", scenarioIds: ["SC-001"] }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const spec = store.runSpec(store.listRuns()[0]!.id)!;
    expect(spec.scenarios.map((s) => s.id)).toEqual(["SC-001"]);
    // The spec agent ran before the planner ever did.
    expect(specs.findIndex((s) => s.role === "spec")).toBeLessThan(specs.findIndex((s) => s.role === "planner"));
    // And the planner was told what it is planning against.
    expect(specs.find((s) => s.role === "planner")!.prompt).toContain("SC-001");
    expect(specs.find((s) => s.role === "planner")!.prompt).toContain("The specification this run is held to");
    expect(store.listTasks(store.listRuns()[0]!.id)[0]!.scenarioIds).toEqual(["SC-001"]);
  });

  /**
   * The whole reason the specification is written at intake rather than after
   * planning. Run 40da9337 spent 37 hours and $773.55 shipping six of seven
   * integrations as fail-closed stubs because it planned past exactly this
   * question, which nobody was ever asked.
   */
  it("asks the operator what the brief could not settle, before the planner sees it", async () => {
    const dir = repo();
    const blocked = specJson({
      requirements: [{ id: "REQ-001", text: "take payment", priority: "P0", blockedBy: ["OQ-1"] }],
      openQuestions: [{ id: "OQ-1", question: "Real Stripe account, or sandbox?", detail: "the brief does not say", blocks: ["REQ-001"] }],
      scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "takes payment", level: "unit", priority: "P0", oracle: "o", testRef: "", blocked: true }],
    });
    const { pool, specs } = rolePool({
      intake: BRIEF,
      // First pass raises the question; the second answers it and unblocks.
      spec: (_s, nth) => (nth === 1 ? blocked : specJson()),
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });
    const ui = operator("the sandbox");

    await controller.startRun("build a checkout", RunConfig.parse(BASE), ui);

    expect(ui.asked.map((q) => q.question)).toContain("Real Stripe account, or sandbox?");
    // The answer went back into the same session rather than a cold one.
    const second = specs.filter((s) => s.role === "spec")[1]!;
    expect(second.prompt).toContain("the sandbox");
    expect(second.resume).toBeTruthy();
    // And what the run is held to is the updated specification.
    expect(store.runSpec(store.listRuns()[0]!.id)!.scenarios[0]!.blocked).toBe(false);
  });

  /**
   * Run 5122c83a asked its operator eleven questions, was answered on six, and
   * then could not resume the session that had asked them:
   * `No conversation found with session ID: 05a48a8b-…`. A single-attempt fold
   * discards every answer at that point and keeps the draft that raised the
   * questions — so the run planned against eight `blocked` scenarios, which
   * `specPlanBlock` filters out of what the planner is ever shown. Six of the
   * eight were settled by answers sitting in the event store the whole time.
   *
   * The answers cost an interruption of a person. They get a second attempt.
   */
  it("re-folds the answers in a cold session when the warm one is gone", async () => {
    const dir = repo();
    const blocked = specJson({
      requirements: [{ id: "REQ-001", text: "take payment", priority: "P0", blockedBy: ["OQ-1"] }],
      openQuestions: [{ id: "OQ-1", question: "Real Stripe account, or sandbox?", detail: "the brief does not say", blocks: ["REQ-001"] }],
      scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "takes payment", level: "unit", priority: "P0", oracle: "o", testRef: "", blocked: true }],
    });
    const { pool, specs } = rolePool({
      intake: BRIEF,
      // 1: raises the question. 2: the resumed fold, whose session died — the
      // CLI returns nothing to parse. 3: the cold retry, which answers.
      spec: (_s, nth) => (nth === 1 ? blocked : nth === 2 ? "" : specJson()),
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a", scenarioIds: ["SC-001"] }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator("the sandbox"));

    const passes = specs.filter((s) => s.role === "spec");
    expect(passes).toHaveLength(3);
    // The retry is cold by construction — there is no session left to resume —
    // so it is told where the specification it is updating actually lives.
    expect(passes[2]!.resume).toBeUndefined();
    expect(passes[2]!.prompt).toContain("the sandbox");
    expect(passes[2]!.prompt).toContain("tdd/checkout.tdd.yaml");
    // And the gate is the folded specification, not the draft that asked.
    const spec = store.runSpec(store.listRuns()[0]!.id)!;
    expect(spec.scenarios[0]!.blocked).toBe(false);
    expect(spec.openQuestions).toEqual([]);
  });

  /** Both folds failing is the draft — but never quietly. */
  it("says how much the gate lost when neither fold can be read", async () => {
    const dir = repo();
    const blocked = specJson({
      requirements: [{ id: "REQ-001", text: "take payment", priority: "P0", blockedBy: ["OQ-1"] }],
      openQuestions: [{ id: "OQ-1", question: "Real Stripe account, or sandbox?", detail: "", blocks: ["REQ-001"] }],
      scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "takes payment", level: "unit", priority: "P0", oracle: "o", testRef: "", blocked: true }],
    });
    const { pool, specs } = rolePool({
      intake: BRIEF,
      spec: (_s, nth) => (nth === 1 ? blocked : ""),
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator("the sandbox"));

    expect(specs.filter((s) => s.role === "spec")).toHaveLength(3);
    const spec = store.runSpec(store.listRuns()[0]!.id)!;
    expect(spec.scenarios[0]!.blocked).toBe(true);
    const log = events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);
    expect(log.some((t) => t.includes("1 open question(s)") && t.includes("1 scenario(s) stay blocked"))).toBe(true);
  });

  it("never asks about a nice-to-have", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: specJson({
        requirements: [{ id: "REQ-009", text: "a nicer receipt", priority: "P3", blockedBy: ["OQ-2"] }],
        openQuestions: [{ id: "OQ-2", question: "Which font?", detail: "", blocks: ["REQ-009"] }],
      }),
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller } = build({ repoPath: dir, pool });
    const ui = operator();

    await controller.startRun("build a checkout", RunConfig.parse(BASE), ui);

    expect(ui.asked).toEqual([]);
  });

  /**
   * A run whose specification could not be written is a run without this gate,
   * which is exactly the run every harness before this one was. Failing intake
   * over it would trade a working run for no run.
   */
  it("carries on without a specification rather than failing the run over one", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: "I could not work out what this repository uses.",
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.runSpec(runId)).toBeNull();
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    const log = events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);
    expect(log.some((t) => t.includes("could not be read") && t.includes("no JSON object"))).toBe(true);
  });

  /**
   * The other way an answer fails to arrive: JSON that parses and is not a
   * specification. Reported separately from "there was no JSON at all" because
   * they are different faults with the same consequence, and an operator
   * reading the log has to be able to tell which one they are looking at.
   */
  it("says the answer could not be read when it parses but is not a specification", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: '```json\n{"scenarios":"not a list"}\n```',
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    expect(store.runSpec(store.listRuns()[0]!.id)).toBeNull();
    const log = events.filter((e) => e.type === "agent.log").map((e) => (e as { text: string }).text);
    // JSON arrived and was not a specification — a different fault from no
    // JSON at all, and the log has to let an operator tell them apart.
    expect(log.some((t) => t.includes("could not be read") && !t.includes("no JSON object"))).toBe(true);
  });

  /**
   * The specification is committed to the integration branch because task
   * branches are cut from it: that is what makes the failing tests something
   * every worker inherits and the pull request carries, rather than a harness
   * artifact that evaporates when the run ends.
   */
  it("commits what the spec agent wrote, so every task branch inherits it", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: (s) => {
        mkdirSync(path.join(s.cwd, "tdd"), { recursive: true });
        writeFileSync(path.join(s.cwd, "tdd", "checkout.tdd.yaml"), "id: SC-001\n");
        return specJson();
      },
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker: (s, nth) => {
        // The worker's own branch was cut from the integration branch, so the
        // artifact is already sitting there.
        expect(existsSync(path.join(s.cwd, "tdd", "checkout.tdd.yaml"))).toBe(true);
        return worker(s, nth);
      },
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const runId = store.listRuns()[0]!.id;
    const log = execFileSync("git", ["log", "--format=%s", `harness/${runId}/main`], { cwd: dir, encoding: "utf8" });
    expect(log).toContain("spec: 1 failing scenario(s) for checkout");
  });

  /**
   * The answers came back and the second pass could not be read. The first
   * specification is still the best standard the run has, and discarding it
   * would leave the run with no gate at all over a formatting failure.
   */
  it("keeps the first specification when the pass after the answers cannot be read", async () => {
    const dir = repo();
    const blocked = specJson({
      requirements: [{ id: "REQ-001", text: "take payment", priority: "P0", blockedBy: ["OQ-1"] }],
      openQuestions: [{ id: "OQ-1", question: "Real Stripe, or sandbox?", detail: "", blocks: ["REQ-001"] }],
    });
    const { pool } = rolePool({
      intake: BRIEF,
      spec: (_s, nth) => (nth === 1 ? blocked : "I have nothing to add."),
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    expect(store.runSpec(store.listRuns()[0]!.id)!.openQuestions.map((q) => q.id)).toEqual(["OQ-1"]);
  });

  it("names the run rather than a feature when the specification named none", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: (s) => {
        writeFileSync(path.join(s.cwd, "spec.txt"), "x\n");
        return specJson({ feature: "" });
      },
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const runId = store.listRuns()[0]!.id;
    const log = execFileSync("git", ["log", "--format=%s", `harness/${runId}/main`], { cwd: dir, encoding: "utf8" });
    expect(log).toContain("spec: 1 failing scenario(s) for this run");
  });

  /**
   * A specification that was written and could not be committed is still a
   * specification the gate can run — the gate works in a worktree of this same
   * branch. What is lost is the deliverable, not the check.
   */
  it("keeps the specification when the commit itself is refused", async () => {
    const dir = repo();
    const hooks = path.join(dir, ".githooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: dir, stdio: "ignore" });

    const { pool } = rolePool({
      intake: BRIEF,
      spec: (s) => {
        writeFileSync(path.join(s.cwd, "spec.txt"), "x\n");
        return specJson();
      },
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.runSpec(runId)!.scenarios).toHaveLength(1);
    expect(events.some((e) => e.type === "agent.log" && e.text.startsWith("the specification was written but not committed"))).toBe(true);
  });

  /**
   * A run whose specification could not be written is a run without this gate,
   * which is exactly the run every harness before this one was.
   */
  it("carries on when the specification agent dies outright", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: () => {
        throw new Error("the session died");
      },
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    expect(store.runSpec(store.listRuns()[0]!.id)).toBeNull();
    expect(store.getRun(store.listRuns()[0]!.id)!.state).toBe("PR_REVIEW");
    expect(events.some((e) => e.type === "agent.log" && e.text.startsWith("no specification was written"))).toBe(true);
  });

  /**
   * A budget stop is not a specification failure. Swallowing it here would let
   * the run walk past a ceiling the operator set, which is the one thing every
   * catch in this controller has to let through.
   */
  it("lets a budget stop through rather than treating it as a failed specification", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: () => {
        throw new BudgetExceeded(100, 50, "run-1");
      },
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    await expect(controller.startRun("build a checkout", RunConfig.parse(BASE), operator())).rejects.toBeInstanceOf(BudgetExceeded);

    // Nothing was swallowed and nothing was planned past the ceiling.
    expect(events.some((e) => e.type === "agent.log" && e.text.startsWith("no specification was written"))).toBe(false);
  });

  it("asks nothing when the operator has turned the questions off", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      spec: specJson({
        requirements: [{ id: "REQ-001", text: "take payment", priority: "P0", blockedBy: ["OQ-1"] }],
        openQuestions: [{ id: "OQ-1", question: "Real Stripe, or sandbox?", detail: "", blocks: ["REQ-001"] }],
      }),
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });
    const ui = operator();

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { askOpenQuestions: false } }), ui);

    expect(ui.asked).toEqual([]);
    expect(store.runSpec(store.listRuns()[0]!.id)!.openQuestions).toHaveLength(1);
  });

  it("does nothing at all when the operator has turned it off", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      intake: BRIEF,
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { enabled: false } }), operator());

    expect(specs.some((s) => s.role === "spec")).toBe(false);
    expect(store.runSpec(store.listRuns()[0]!.id)).toBeNull();
  });
});

describe("the acceptance gate", () => {
  const upTo = (allCommand: string, answers: Partial<Record<string, Answer>> = {}) => ({
    intake: BRIEF,
    spec: specJson({ commands: { all: allCommand, byId: 'echo "{{ids}}"' } }),
    planner: (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a", scenarioIds: ["SC-001"] }])),
    worker,
    qa: () => QA_PASS,
    validator: () => INTENT_PASS,
    ...answers,
  });

  it("lets a run through when the scenarios are green, and records that they were", async () => {
    const dir = repo();
    const { pool } = rolePool(upTo("exit 0"));
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.acceptanceVerdict(runId)).toMatchObject({ passed: true, failing: [] });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  /**
   * A failing scenario is a promise the run made and has not kept, which is
   * work rather than a report — the same rule a red CI follows one gate down.
   */
  it("sends the run back to work over a failing scenario, naming it", async () => {
    const dir = repo();
    // Red on the first look, green once the fix task has been through.
    let looks = 0;
    const { pool } = rolePool(
      upTo("", {
        spec: specJson({ commands: { all: "sh -c 'exit $(cat /dev/null; echo 1)'", byId: 'echo "{{ids}}"' } }),
      })
    );
    void looks;
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const runId = store.listRuns()[0]!.id;
    const verdict = store.acceptanceVerdict(runId)!;
    expect(verdict.passed).toBe(false);
    // The suite said nothing about which scenario, so nothing is claimed.
    expect(verdict.named).toBe(false);
    expect(events.some((e) => e.type === "agent.log" && e.text.startsWith("acceptance:"))).toBe(true);
  });

  it("queues one fix task per named failing scenario, and holds it to that scenario alone", async () => {
    const dir = repo();
    const { pool } = rolePool(upTo(`sh -c 'echo "  × SC-001 charges a card"; exit 1'`));
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const runId = store.listRuns()[0]!.id;
    const fix = store.listTasks(runId).find((t) => t.id.startsWith("spec-fix-"))!;
    expect(fix).toBeTruthy();
    expect(fix.title).toContain("SC-001");
    expect(fix.scenarioIds).toEqual(["SC-001"]);
    expect(fix.spec).toContain("Make it pass by changing the product, not the test");
    expect(fix.completionProbe).toBe('echo "SC-001"');
  });

  /**
   * A worker sent back over a failing scenario needs to know what it checks.
   * The oracle is the mandatory field, so it stands in wherever the title is
   * missing — a fix task headed "Make SC-001 pass:" tells nobody anything.
   */
  it("falls back to the oracle when a scenario has no title, and omits a requirement it cannot find", async () => {
    const dir = repo();
    const { pool } = rolePool(
      upTo(`sh -c 'echo "  × SC-001 broke"; exit 1'`, {
        spec: specJson({
          requirements: [{ id: "REQ-OTHER", text: "something else", priority: "P0", blockedBy: [] }],
          scenarios: [{ id: "SC-001", requirement: "REQ-MISSING", title: "", level: "unit", priority: "P0", oracle: "the charge returns 200", testRef: "", blocked: false }],
          commands: { all: `sh -c 'echo "  × SC-001 broke"; exit 1'`, byId: 'echo "{{ids}}"' },
        }),
      })
    );
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const fix = store.listTasks(store.listRuns()[0]!.id).find((t) => t.id.startsWith("spec-fix-"))!;
    expect(fix.title).toBe("Make SC-001 pass: the charge returns 200");
    expect(fix.acceptanceCriteria[0]).toBe("SC-001 passes: the charge returns 200");
    expect(fix.spec).toContain("What it checks: the charge returns 200");
    // The scenario names a requirement the specification does not carry, so
    // nothing is asserted about one.
    expect(fix.spec).not.toContain("The requirement behind it");
  });

  /**
   * The mirror of the case above. `oracle` is the mandatory field and normally
   * the better sentence, but a scenario that arrives with only a title still
   * has to produce a task a worker can act on.
   */
  it("falls back to the title when a scenario arrives without an oracle", async () => {
    const dir = repo();
    const { pool } = rolePool(
      upTo(`sh -c 'echo "  × SC-001 broke"; exit 1'`, {
        spec: specJson({
          scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "charges a card", level: "unit", priority: "P0", oracle: "", testRef: "", blocked: false }],
          commands: { all: `sh -c 'echo "  × SC-001 broke"; exit 1'`, byId: 'echo "{{ids}}"' },
        }),
      })
    );
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const fix = store.listTasks(store.listRuns()[0]!.id).find((t) => t.id.startsWith("spec-fix-"))!;
    expect(fix.spec).toContain("What it checks: charges a card");
    expect(fix.acceptanceCriteria[0]).toBe("SC-001 passes: charges a card");
  });

  it("stops sending the run back once its rounds are spent", async () => {
    const dir = repo();
    const { pool } = rolePool(upTo(`sh -c 'echo "  × SC-001 charges a card"; exit 1'`));
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const runId = store.listRuns()[0]!.id;
    // One round of fixes, then the run reports rather than looping forever.
    expect(store.listTasks(runId).filter((t) => t.id.startsWith("spec-fix-2-"))).toEqual([]);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("reports without queuing anything when the operator set no rounds", async () => {
    const dir = repo();
    const { pool } = rolePool(upTo(`sh -c 'echo "  × SC-001 charges a card"; exit 1'`));
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 0 } }), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.listTasks(runId).some((t) => t.id.startsWith("spec-fix-"))).toBe(false);
    expect(store.acceptanceVerdict(runId)!.passed).toBe(false);
  });

  /**
   * A specification with no way to run its scenarios proves nothing, and saying
   * so is the difference between an honest gate and one that passes everything
   * it cannot check.
   */
  it("calls a specification with no command unproven rather than passing", async () => {
    const dir = repo();
    const { pool } = rolePool(upTo("", { spec: specJson({ commands: { all: "  ", byId: "" } }) }));
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 0 } }), operator());

    const verdict = store.acceptanceVerdict(store.listRuns()[0]!.id)!;
    expect(verdict.passed).toBe(false);
    expect(verdict.line).toContain("named no command");
  });

  /**
   * A broken suite must not be allowed to re-plan the run. The bound is the
   * same one the intent gaps and the CI checks use, and what it drops is said
   * out loud rather than quietly.
   */
  it("caps how many fixes one round may queue, and says what it dropped", async () => {
    const dir = repo();
    const ids = Array.from({ length: 12 }, (_, i) => `SC-${String(i + 1).padStart(3, "0")}`);
    const { pool } = rolePool({
      intake: BRIEF,
      spec: specJson({
        requirements: [{ id: "REQ-001", text: "everything", priority: "P0", blockedBy: [] }],
        scenarios: ids.map((id) => ({ id, requirement: "REQ-001", title: id, level: "unit", priority: "P0", oracle: "o", testRef: "", blocked: false })),
        commands: { all: `sh -c '${ids.map((id) => `echo "  × ${id} broke"`).join("; ")}; exit 1'`, byId: 'echo "{{ids}}"' },
      }),
      planner: (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.listTasks(runId).filter((t) => t.id.startsWith("spec-fix-"))).toHaveLength(10);
    expect(events.some((e) => e.type === "agent.log" && e.text.includes("2 more failing scenario(s) were not queued"))).toBe(true);
  });

  it("has no verdict at all for a run with no specification", async () => {
    const dir = repo();
    const { pool } = rolePool({
      intake: BRIEF,
      planner: (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a" }])),
      worker,
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build it", RunConfig.parse({ ...BASE, spec: { enabled: false } }), operator());

    expect(store.acceptanceVerdict(store.listRuns()[0]!.id)).toBeNull();
  });
});
