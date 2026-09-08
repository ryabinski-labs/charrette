import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig, type HarnessEvent, type IntakeQuestion } from "@harness/shared";
import { Bus } from "./bus.js";
import { BudgetExceeded } from "./budget.js";
import { GitHubAdapter } from "./github.js";
import type { IntakeUi } from "./intake.js";
import type { PitStop } from "./pitstop.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * A run ends when the product is proven, not when the scheduler runs dry.
 *
 * waf de2cb7aa and ledger-app a8df0107 (issue #115) both reached PR_REVIEW
 * within the hour of their own acceptance gate saying "27 gating scenario(s)
 * are unproven" and "9 gating scenario(s) are unproven". Every gate that could
 * have said otherwise was advisory, and every one of them was overridden,
 * unread, or spelled the same way as a pass. These cases are the closing gate
 * that now sits between the last task and the first pull request — the three
 * answers the acceptance gate can give (#117), the third answer the intent
 * check can give (#121), and the state a run lands in when it cannot prove
 * itself (#122).
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(remote = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-proof-"));
  made.push(dir, `${dir}-wt`);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  if (remote) {
    const bare = mkdtempSync(path.join(tmpdir(), "harness-proof-remote-"));
    made.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
    run("remote", "add", "origin", bare);
    run("push", "-q", "origin", "main");
  }
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
const DEMO_OK = '```json\n{"started":true,"howStarted":"pnpm dev","summary":"","journeys":[],"couldNotReach":[],"artifacts":[]}\n```';
const REVIEW_OK = '```json\n{"verdict":"on-track","findings":[],"question":""}\n```';
const fence = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";

const dag = (tasks: { id: string; scenarioIds?: string[] }[] = [{ id: "task-a" }]) =>
  fence({
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
  });

/** A specification the agent would emit, with `all` pointed at a real command. */
const specJson = (over: Record<string, unknown> = {}) =>
  fence({
    feature: "checkout",
    artifactPath: "tdd/checkout.tdd.yaml",
    requirements: [{ id: "REQ-001", text: "a card charge succeeds", priority: "P0", blockedBy: [] }],
    scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "charges a card", level: "unit", priority: "P0", oracle: "the charge returns 200", testRef: "t.ts::SC-001", blocked: false }],
    openQuestions: [],
    commands: { all: "exit 0", byId: 'echo "{{ids}}"' },
    notCovered: [],
    ...over,
  });

type Answer = string | ((spec: AgentSpec, nth: number) => string | Partial<AgentResult> | Error);

function rolePool(answers: Partial<Record<string, Answer>>, bill = 0) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const ref = { store: null as Store | null };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      if (bill && ref.store) {
        ref.store.recordUsage({
          runId: spec.runId, taskId: spec.taskId, sessionId: `s${specs.length}`, model: spec.model,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: bill,
        });
      }
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: bill, turns: 1, outcome: "done" };
      if (typeof answer === "function") {
        const out = answer(spec, counts[spec.role]!);
        if (out instanceof Error) throw out;
        return typeof out === "string" ? { ...base, resultText: out } : { ...base, ...out };
      }
      return { ...base, resultText: answer ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, ref };
}

function build(opts: { repoPath: string; pool: AgentPool; github?: GitHubAdapter; gates?: Partial<GateHandler> }) {
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

const worker = (spec: AgentSpec, nth: number) => (commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");
const planner = (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag([{ id: "task-a", scenarioIds: ["SC-001"] }]));
const logs = (events: HarnessEvent[]) => events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log").map((e) => e.text);
const proofs = (events: HarnessEvent[]) => events.filter((e): e is Extract<HarnessEvent, { type: "run.closing_proof" }> => e.type === "run.closing_proof");
const verdicts = (events: HarnessEvent[]) => events.filter((e): e is Extract<HarnessEvent, { type: "run.intent_verdict" }> => e.type === "run.intent_verdict");
const transitions = (events: HarnessEvent[]) =>
  events.filter((e): e is Extract<HarnessEvent, { type: "run.state_changed" }> => e.type === "run.state_changed").map((e) => `${e.from}->${e.to}`);

/** Everything a specified run needs answered, with `all` pointed at `allCommand`. */
const specified = (allCommand: string, answers: Partial<Record<string, Answer>> = {}) => ({
  intake: BRIEF,
  spec: specJson({ commands: { all: allCommand, byId: 'echo "{{ids}}"' } }),
  planner,
  worker,
  qa: () => QA_PASS,
  validator: () => INTENT_PASS,
  ...answers,
});

const BASE = { deterministicChecks: [] as string[], waitForChecks: false, planIntentCheck: false, maxParallelWorkers: 1 };

describe("the acceptance gate's three answers", () => {
  /**
   * `queueScenarioFixes` used to return nothing for a red suite whose output
   * named no scenario, and INTEGRATING read nothing as a green suite. Both
   * runs in issue #115 closed through exactly that. There is one honest piece
   * of work here, and it is queued as such.
   */
  it("queues one task to make the suite readable when it is red and names no scenario", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(specified(`sh -c 'echo "SyntaxError: unexpected token in checkout.test.ts"; exit 1'`));
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const runId = store.listRuns()[0]!.id;
    const fix = store.getTask(runId, "spec-fix-1-suite")!;
    expect(fix.title).toBe("Make the acceptance suite runnable and readable");
    expect(fix.spec).toContain("SyntaxError: unexpected token in checkout.test.ts");
    expect(fix.spec).toContain("sh -c 'echo");
    expect(fix.spec).toContain("not the assertions");
    expect(fix.state).toBe("MERGED");
    // One round, then the suite is still red: the run holds rather than
    // reporting itself in review, and no validator was bought over it.
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
    expect(store.lastRunStateChange(runId)!.reason).toContain("the acceptance gate is red");
    expect(specs.filter((s) => s.role === "validator")).toHaveLength(0);
    expect(logs(events)).toContainEqual(expect.stringContaining("the intent check is not bought over a tree the specification rejects"));
    expect(proofs(events).at(-1)).toMatchObject({ proven: false, held: true });
    expect(store.acceptanceVerdict(runId)).toMatchObject({ verdict: "red", named: false });
  });

  it("still queues the suite task when the specification named no command at all", async () => {
    const dir = repo();
    const { pool } = rolePool(specified("", { spec: specJson({ artifactPath: "", commands: { all: "  ", byId: "" } }) }));
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 1 } }), operator());

    const runId = store.listRuns()[0]!.id;
    const fix = store.getTask(runId, "spec-fix-1-suite")!;
    expect(fix.spec).toContain("(none — the specification named no command)");
    expect(fix.spec).toContain("(no output)");
    expect(fix.spec).toContain("a wrong command in `the specification`");
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
  });

  /**
   * `acceptance.ts` returned `passed: true` here, with a comment saying the
   * caller must be able to tell it apart from a green suite. The caller read
   * `passed`. Now it reads a word that is not "green".
   */
  it("holds a run whose specification declares no gating scenario, and buys no intent check for it", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(
      specified("exit 0", {
        spec: specJson({
          scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "nice to have", level: "unit", priority: "P2", oracle: "o", testRef: "", blocked: false }],
        }),
      })
    );
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.acceptanceVerdict(runId)!.verdict).toBe("no-opinion");
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
    expect(store.lastRunStateChange(runId)!.reason).toContain("the acceptance gate is without an opinion: the specification declares no gating scenario");
    expect(store.listTasks(runId).some((t) => t.id.startsWith("spec-fix-"))).toBe(false);
    expect(specs.filter((s) => s.role === "validator")).toHaveLength(0);
    expect(controller.outcome(runId).line).toContain("acceptance has no opinion");
    expect(controller.outcome(runId).acceptance).toMatchObject({ verdict: "no-opinion" });
  });

  /**
   * waf carried four blocked P0 scenarios — the staged-promotion requirement,
   * a PRD Must-have — through the gate as a pass. A gating scenario blocked on
   * an unanswered question is the harness's question to the operator, and it
   * is asked in the operator's terms rather than by scenario id.
   */
  it("names the question behind a gating scenario nobody could run", async () => {
    const dir = repo();
    const { pool } = rolePool(
      specified("exit 0", {
        spec: specJson({
          requirements: [{ id: "REQ-001", text: "take payment", priority: "P0", blockedBy: ["OQ-1"] }],
          openQuestions: [{ id: "OQ-1", question: "Real Stripe account, or sandbox?", detail: "", blocks: ["REQ-001"] }],
          scenarios: [{ id: "SC-001", requirement: "REQ-001", title: "takes payment", level: "unit", priority: "P0", oracle: "o", testRef: "", blocked: true }],
        }),
      })
    );
    const { controller, store, events } = build({ repoPath: dir, pool });

    // Not asked at intake, so the scenario stays blocked all the way to the gate.
    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { askOpenQuestions: false } }), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
    expect(store.lastRunStateChange(runId)!.reason).toContain("all 1 gating scenario(s) are blocked on an unanswered question");
    expect(logs(events)).toContainEqual("the acceptance gate cannot run: SC-001 waits on: Real Stripe account, or sandbox?");
  });

  it("reports in review over a red suite when the hold is off, and says so in the line", async () => {
    const dir = repo();
    const { pool } = rolePool(specified(`sh -c 'echo "  × SC-001 charges a card"; exit 1'`));
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 0 }, holdUntilProven: false }), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(controller.outcome(runId).line).toContain("acceptance RED (1 of 1 gating scenario(s) failing: SC-001)");
    expect(proofs(events).at(-1)).toMatchObject({ proven: false, held: false });
  });

  it("does not follow a deploy it cannot see, however proven the run is", async () => {
    // A production URL with no GitHub to read the merge from: the run ends in
    // review, proven, and verification is simply not on offer.
    const dir = repo();
    const { pool } = rolePool(specified("exit 0"));
    const { controller, store } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com" }), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.prodVerdict(runId)).toBeNull();
    expect(controller.awaitingVerification(runId)).toBe(false);
  });

  it("says acceptance green in the closing line once the gate is", async () => {
    const dir = repo();
    const { pool } = rolePool(specified("exit 0"));
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse(BASE), operator());

    const runId = store.listRuns()[0]!.id;
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(controller.outcome(runId).line).toContain("acceptance green");
    expect(proofs(events).at(-1)).toMatchObject({ proven: true, unmet: [] });
  });

  /**
   * BLOCKED is not a dead end. The operator fixes what it names and resumes;
   * the run goes back to INTEGRATING, where the gates are, and reports in
   * review only once they pass.
   */
  it("re-enters the gates when a blocked run is resumed, and reports in review once they pass", async () => {
    const dir = repo();
    const flag = path.join(mkdtempSync(path.join(tmpdir(), "harness-proof-flag-")), "green");
    made.push(path.dirname(flag));
    const { pool } = rolePool(specified(`sh -c 'test -f "${flag}"'`));
    const { controller, store, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 0 } }), operator());
    const runId = store.listRuns()[0]!.id;
    expect(store.getRun(runId)!.state).toBe("BLOCKED");

    // The operator fixed the suite.
    writeFileSync(flag, "");
    await controller.resume(runId);

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(transitions(events).slice(-2)).toEqual(["BLOCKED->INTEGRATING", "INTEGRATING->PR_REVIEW"]);
    expect(store.acceptanceVerdict(runId)!.verdict).toBe("green");
  });
});

describe("the intent check's third answer", () => {
  const INTENT = { ...BASE, spec: { enabled: false } };
  const passWithGaps = (gaps: string[]) => fence({ verdict: "PASS", summary: "mostly there", gaps });
  const fail = (gaps: string[]) => fence({ verdict: "FAIL", summary: "not there", gaps });
  const unknown = (unchecked: string[], summary = "") => fence({ verdict: "UNKNOWN", summary, unchecked });
  const roles = (validator: Answer) => ({ planner: (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag()), worker, qa: () => QA_PASS, validator });

  /**
   * waf de2cb7aa's closing verdict: PASS, with gaps reading "Not independently
   * verified given turn budget". Two verdicts in one object, and the harness
   * kept the one that opens pull requests. Now the session is asked to choose.
   */
  it("sends a PASS that lists gaps back to the session, and keeps the FAIL it chooses", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(roles((_s, nth) => (nth === 1 ? passWithGaps(["the poller is never scheduled"]) : nth === 2 ? fail(["the poller is never scheduled"]) : INTENT_PASS)));
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(INTENT));

    const asks = specs.filter((s) => s.role === "validator");
    expect(asks[1]!.resume).toBe(asks[0] && "sdk" + (specs.indexOf(asks[0]) + 1));
    expect(asks[1]!.prompt).toContain("That is two verdicts, and the harness cannot keep both");
    expect(asks[1]!.prompt).toContain("- the poller is never scheduled");
    expect(logs(events)).toContainEqual(expect.stringContaining("answered PASS and listed 1 gap(s) — two verdicts"));
    // The FAIL became work, the work merged, and the third read passed.
    expect(store.getTask(runId, "intent-fix-1-1")!.state).toBe("MERGED");
    expect(verdicts(events).map((v) => v.verdict)).toEqual(["FAIL", "PASS"]);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  /**
   * A session that answers the same two verdicts again has said all it will
   * say. The cautious reading — UNKNOWN, with the gaps as what was not
   * settled — is the only one that cannot be the wrong one, and it buys one
   * narrowed pass over exactly those items.
   */
  it("keeps the cautious reading when the session will not choose, and narrows the next pass to it", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(roles((_s, nth) => (nth <= 2 ? passWithGaps(["whether the poller runs"]) : INTENT_PASS)));
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(INTENT));

    expect(verdicts(events).map((v) => [v.verdict, v.unchecked])).toEqual([
      ["UNKNOWN", ["whether the poller runs"]],
      ["PASS", []],
    ]);
    const narrowed = specs.filter((s) => s.role === "validator")[2]!;
    expect(narrowed.resume).toBeUndefined();
    expect(narrowed.prompt).toContain("What it did NOT check — this is your whole job:");
    expect(narrowed.prompt).toContain("- whether the poller runs");
    expect(narrowed.maxTurns).toBe(60);
    expect(logs(events)).toContainEqual(expect.stringContaining("could not reach 1 item(s) inside its turn budget; asking once more about only those"));
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("keeps the cautious reading when the re-ask dies", async () => {
    const dir = repo();
    const { pool } = rolePool(roles((_s, nth) => (nth === 1 ? passWithGaps(["a gap"]) : nth === 2 ? new Error("socket closed") : INTENT_PASS)));
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(INTENT));

    expect(verdicts(events).map((v) => v.verdict)).toEqual(["UNKNOWN", "PASS"]);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("does not re-ask a session it cannot resume", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(roles((_s, nth) => (nth === 1 ? { resultText: passWithGaps(["a gap"]), sdkSessionId: undefined } : INTENT_PASS)));
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(INTENT));

    // Two sessions: the one that could not be resumed, and the narrowed pass.
    expect(specs.filter((s) => s.role === "validator")).toHaveLength(2);
    expect(specs.filter((s) => s.role === "validator")[1]!.prompt).toContain("this is your whole job");
    expect(verdicts(events).map((v) => v.verdict)).toEqual(["UNKNOWN", "PASS"]);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("holds the run when the narrowed pass abstains too", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(roles((_s, nth) => (nth === 1 ? unknown(["a", "b"]) : unknown(["b"], "still short"))));
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(INTENT));

    // The first pass said nothing beyond its list, and the narrowed pass is told so.
    expect(specs.filter((s) => s.role === "validator")[1]!.prompt).toContain("(no summary)");

    expect(verdicts(events).map((v) => v.unchecked)).toEqual([["a", "b"], ["b"]]);
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("the intent check could not finish: 1 item unchecked");
    expect(controller.outcome(runId).line).toContain("intent check could not finish (1 unchecked)");
    expect(store.listTasks(runId).some((t) => t.id.startsWith("intent-fix-"))).toBe(false);
  });

  it("does not buy a second pass for an UNKNOWN that names nothing", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(roles(() => unknown([])));
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(INTENT));

    expect(specs.filter((s) => s.role === "validator")).toHaveLength(1);
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("the intent check could not finish: 0 items unchecked");
  });

  /**
   * The re-ask catches so that a dead session cannot cost the run its first
   * answer. A budget stop is not a dead session; it must come out.
   */
  it("lets a budget stop out of the re-ask rather than reading it as an abstention", async () => {
    const dir = repo();
    const { pool } = rolePool(roles((_s, nth) => (nth === 1 ? passWithGaps(["a gap"]) : new BudgetExceeded(30, 27))));
    const { controller } = build({ repoPath: dir, pool });

    await expect(controller.startRun("build a thing", RunConfig.parse(INTENT))).rejects.toThrow(/budget exceeded/);
  });
});

describe("the closing pit stop", () => {
  it("opens for a run that cannot prove itself, and names what is unmet", async () => {
    const dir = repo();
    const stops: PitStop[] = [];
    const { pool } = rolePool(specified(`sh -c 'echo "  × SC-001 charges a card"; exit 1'`, { demo: () => DEMO_OK, reviewer: () => REVIEW_OK }));
    const { controller, store } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolvePitStop(stop) {
          stops.push(stop);
          return { action: "continue", feedback: "" };
        },
      },
    });

    await controller.startRun("build a checkout", RunConfig.parse({ ...BASE, spec: { gateRounds: 0 }, pitStop: { every: { usd: 1000 } } }), operator());

    const runId = store.listRuns()[0]!.id;
    expect(stops.map((s) => s.reason)).toEqual(["the run cannot prove itself: the acceptance gate is red: 1 of 1 gating scenario(s) failing: SC-001"]);
    // "continue" ends the conversation; it does not make the suite green.
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
  });
});

describe("resuming a blocked run", () => {
  /**
   * A run whose one task parked merged nothing, and a run with nothing merged
   * has nothing to review — it holds. Resuming it is the operator arriving to
   * answer the escalation; the answer carries the task through, and the run
   * reports in review with the pull request it can now have.
   */
  it("puts parked tasks back through the gate, and reports in review once they merge", async () => {
    const dir = repo();
    let asked = 0;
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag()),
      worker: (spec, nth) => (nth === 1 ? new Error("boom") : worker(spec, nth)),
      qa: () => QA_PASS,
      advisor: () => "",
      validator: () => INTENT_PASS,
    });
    const { controller, store, events } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolveTaskGate() {
          return ++asked === 1 ? null : "try again, the network is back";
        },
      },
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, spec: { enabled: false }, workerRespawnCap: 1 }));
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("nothing merged, so there is nothing to review");
    expect(logs(events)).toContainEqual(expect.stringMatching(/no pull request opened: no task reached MERGED.*1 task parked, 0 never started/));

    await controller.resume(runId);

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(transitions(events)).toContain("BLOCKED->EXECUTING");
  });
});

describe("what the pull request says with the hold off", () => {
  /** A GitHub that records what was opened. */
  function gh() {
    const adapter = new GitHubAdapter("token", "acme/widgets");
    const created: { title: string; body: string; draft?: boolean }[] = [];
    let issueNo = 100;
    (adapter as unknown as { octokit: unknown }).octokit = {
      rest: {
        issues: {
          listForRepo: async () => ({ data: [] }),
          create: async () => ({ data: { number: ++issueNo, html_url: `https://x.invalid/issues/${issueNo}` } }),
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: {} }),
          get: async () => ({ data: { state: "open" } }),
          update: async () => ({ data: {} }),
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async (a: { title: string; body: string; draft?: boolean }) => (created.push(a), { data: { number: 51, html_url: "https://x.invalid/pull/51" } }),
          get: async () => ({ data: { state: "open", draft: true, merged_at: null, head: { sha: "abc" } } }),
          update: async () => ({ data: {} }),
        },
        checks: { listForRef: async () => ({ data: [] }) },
        repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
      },
      graphql: async () => ({}),
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
    };
    return { adapter, created };
  }

  it("holds the rollup as a draft when the intent check abstained, and says what went unchecked", async () => {
    const dir = repo(true);
    const { adapter, created } = gh();
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag()),
      worker,
      qa: () => QA_PASS,
      validator: () => fence({ verdict: "UNKNOWN", summary: "ran out of turns", unchecked: ["whether the poller runs", "the Stripe client"] }),
    });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, spec: { enabled: false }, holdUntilProven: false }));

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(created).toHaveLength(1);
    expect(created[0]!.draft).toBe(true);
    expect(created[0]!.body).toContain("Intent check: **UNKNOWN** — the validator ran out of turns; 2 item(s) unchecked:");
    expect(created[0]!.body).toContain("- whether the poller runs");
    expect(created[0]!.body).toContain("- the Stripe client");
    expect(created[0]!.body).toContain("a verdict that abstained is not a pass");
  });
});
