import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { PitStop } from "./pitstop.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The pit stop the operator asks for.
 *
 * Every other stop in this harness fires because the plan crossed a boundary —
 * an epic finished, a figure was passed — and none of those happen because the
 * product started looking wrong on screen. This is the one an operator watching
 * the log can call, and the three things that make it different from the
 * automatic stops are all tested here: it overrides the cadence (including
 * `"never"`), it buys every reviewer lens rather than staging them, and the
 * decision comes back to the operator with the PM's answer rather than being
 * taken on their behalf.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-summon-"));
  made.push(dir, `${dir}-wt`);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  git("add", "-A");
  git("commit", "-m", "first");
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
const REVIEW_OK = '```json\n{"verdict":"on-track","findings":[],"question":""}\n```';
const artifactsDir = (spec: AgentSpec) => spec.systemPrompt.match(/into (.+?) \(it already exists\)/)![1]!;

const EVIDENCE = { file: "signin.har", shows: "the sign-in POST and its 302, with the session cookie set" };

/**
 * A demo that planned one journey and delivered it, so its coverage reads
 * `demonstrated`.
 *
 * That matters here: a thin demo escalates the lenses on its own
 * (`worthMoreLenses`), and a test that bought four lenses off a thin demo would
 * prove nothing about the summon. This one would have been staged down to two.
 */
const demoOk = (spec: AgentSpec) => {
  writeFileSync(path.join(artifactsDir(spec), EVIDENCE.file), '{"log":{"entries":[{"request":{}}]}}');
  return (
    "```json\n" +
    JSON.stringify({
      started: true,
      howStarted: "pnpm dev on :5173",
      summary: "sign-in works",
      plannedJourneys: ["Sign in"],
      journeys: [{ name: "Sign in", result: "worked", evidence: "302 to /home" }],
      couldNotReach: [],
      artifacts: [EVIDENCE],
      commands: [],
    }) +
    "\n```"
  );
};

const PLAN =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-one", title: "Sign-in", summary: "s" }],
    tasks: [
      { id: "task-a", epicId: "epic-one", title: "Sign in", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const },
      { id: "task-b", epicId: "epic-one", title: "Sign out", spec: "s", acceptanceCriteria: ["x"], dependsOn: ["task-a"], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const },
    ],
  }) +
  "\n```";

type Answer = (spec: AgentSpec, nth: number) => string;

function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const nth = (counts[spec.role] = (counts[spec.role] ?? 0) + 1);
      await spec.budgetCheck?.();
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: 0, turns: 1, outcome: "done" };
      return { ...base, resultText: answers[spec.role]?.(spec, nth) ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
}

const planner = (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : PLAN);

/** `blockedOn` is omitted, not null: the schema takes the key optional, and a
 *  null there fails the parse and falls the whole decision through to `ask`. */
const PM_ANSWER =
  '```json\n{"action":"replan","feedback":"build the login page next","why":"there is no login page because nothing in the plan builds one"}\n```';

interface Built {
  controller: RunController;
  store: Store;
  events: HarnessEvent[];
  stops: PitStop[];
}

function build(repoPath: string, pool: AgentPool): Built {
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
    // The operator says "keep going" whatever the PM recommended, so a decision
    // that was silently taken by the PM would be visible as a `replan` here.
    async resolvePitStop(stop) {
      stops.push(stop);
      return { action: "continue", feedback: "" };
    },
  };
  const controller = new RunController(store, bus, pool, new GitHubAdapter(undefined, undefined), gates, repoPath);
  return { controller, store, events, stops };
}

const QUESTION = "why is there no login page?";

/**
 * Runs the two-task plan with `pitStop.every: "never"`, and asks for a stop from
 * inside the first worker — the only honest way to make the request arrive
 * mid-run rather than before one.
 */
async function summonedRun(pmAnswer: string = PM_ANSWER) {
  const dir = repo();
  const holder: { controller?: RunController; store?: Store; runId?: string; asked?: string } = {};
  const { pool, specs } = rolePool({
    planner,
    worker: (spec, nth) => {
      commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`);
      // Once, from the first worker: the operator is watching the log while a
      // task is in flight, which is the situation this feature is for. The id
      // is read from the store rather than closed over — `startRun` mints it,
      // so nothing outside has it until after the call this is running inside.
      if (!holder.asked && holder.controller) {
        holder.runId = holder.store!.listRuns()[0]!.id;
        holder.asked = holder.controller.requestPitStop(holder.runId, QUESTION);
      }
      return "did the work";
    },
    qa: () => QA_PASS,
    validator: () => INTENT_PASS,
    demo: demoOk,
    reviewer: () => REVIEW_OK,
    pm: () => pmAnswer,
  });
  const built = build(dir, pool);
  holder.controller = built.controller;
  holder.store = built.store;
  const runId = await built.controller.startRun(
    "build a thing",
    RunConfig.parse({ deterministicChecks: [], waitForChecks: false, maxParallelWorkers: 1, pitStop: { every: "never" } })
  );
  return { ...built, specs, runId, asked: holder.asked };
}

describe("asking for a pit stop", () => {
  it("opens one even though the cadence is switched off, and answers the question that was asked", async () => {
    const { stops, specs, events } = await summonedRun();

    // `{"every":"never"}` answers "stop me at every epic boundary". It was never
    // an answer to "I want to look at this now".
    expect(stops.length).toBe(1);
    expect(stops[0]!.reason).toBe("you asked for a look at the product");

    // The demo drives what the operator asked about, first, so a demo that runs
    // out of turns has done their part rather than someone else's.
    const demo = specs.find((s) => s.role === "demo")!;
    expect(demo.prompt).toContain(QUESTION);
    expect(demo.prompt).toMatch(/Put the journeys that bear on their question in `plannedJourneys` FIRST/);

    // Every lens, on a demo clean enough that the staging would have skipped
    // half of them. A person interrupting the run is a stronger reason to look
    // harder than anything the first pass could have reported.
    expect(specs.filter((s) => s.role === "reviewer").length).toBe(4);
    expect(stops[0]!.skippedReviewers).toEqual([]);

    const opened = events.filter((e) => e.type === "run.pitstop_opened");
    expect(opened.length).toBe(1);
    expect(opened[0]).toMatchObject({ summoned: true });
  });

  it("has the PM answer the operator and recommend, without taking the decision", async () => {
    const { stops, specs, events, store, runId } = await summonedRun();

    // The PM ran and was given the question to answer.
    const pm = specs.find((s) => s.role === "pm")!;
    expect(pm.prompt).toContain(QUESTION);
    expect(pm.prompt).toMatch(/Answer it in `why`/);

    // …and the operator was asked anyway, with the PM's answer in front of them.
    expect(stops.length).toBe(1);
    expect(stops[0]!.markdown).toContain("there is no login page because nothing in the plan builds one");
    expect(stops[0]!.markdown).toContain("It would replan");
    expect(stops[0]!.markdown).toContain("This is a recommendation. You asked for this stop, so the decision is yours.");

    // The PM said `replan`. The operator said continue, and the run continued —
    // a decision taken on the operator's behalf would show up here as a replan.
    const resolved = events.filter((e) => e.type === "run.pitstop_resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]).toMatchObject({ action: "continue", decidedBy: "operator, advised by product-manager" });
    // Both tasks still built: nothing was cancelled by a re-plan nobody approved.
    expect(store.listTasks(runId).filter((t) => t.state === "MERGED").length).toBe(2);
  });

  /**
   * The PM is allowed to have nothing to say. A stop the operator paid for still
   * has to read as a report — an answer of "stop, blocked on direction" with no
   * reasoning behind it must say so in words rather than leaving a blank where
   * the answer goes.
   */
  it("still reads as a report when the PM answers with nothing but a verdict", async () => {
    const { stops } = await summonedRun('```json\n{"action":"stop","blockedOn":"direction","feedback":"","why":""}\n```');

    expect(stops[0]!.markdown).toContain("(no answer given)");
    expect(stops[0]!.markdown).toContain("It would stop");
    expect(stops[0]!.markdown).toContain("blocked on direction");
    expect(stops[0]!.markdown).not.toContain("What it would tell the run");
  });

  it("consumes the request, so one click buys one stop", async () => {
    const { store, runId, asked } = await summonedRun();

    expect(asked).toMatch(/^pit stop requested/);
    expect(store.pendingPitStopRequest(runId)).toBeNull();
  });

  /**
   * The cadence bug this feature could have introduced, driven end to end: the
   * summoned stop must not become the mark the `{minutes}`/`{usd}`/`{tasks}`
   * intervals measure from, and must not claim the epic it happened to interrupt.
   */
  it("leaves the automatic cadence's marks exactly where it found them", async () => {
    const { store, runId } = await summonedRun();

    const history = store.pitStopHistory(runId, 0);
    expect(history.count).toBe(1);
    expect(history.demoedEpics).toEqual([]);
    expect(history.mergedAt).toBe(0);
    expect(history.spentAt).toBe(0);
    // Still owed its own stop: the epic this interrupted was never demoed.
    expect(store.lastUnsummonedPitStopSeq(runId)).toBe(0);
  });
});

/**
 * The window between a stop being picked up and that stop opening.
 *
 * A pit stop runs a demo and every reviewer lens before it publishes
 * `run.pitstop_opened` — ten or twenty minutes on a real run. Publishing that
 * event is also what retires the operator's pending request, and it used to
 * retire whatever was pending at publish time rather than the request the stop
 * was carrying. So a question typed while a cadence stop was mid-demo was
 * swallowed by a stop that never asked it, and no later stop asked it either:
 * `pendingPitStopRequest` was already null.
 *
 * Run bc691359, 2026-08-25: seq 69990 asked at 05:11:38 why nothing in the run
 * owned `.github/workflows/bench.yml`, seq 70000 opened the config-canon cadence
 * stop at 05:23:36 with `summoned: false`, and the question was gone. The two red
 * CI checks it was about were left with no owner and no channel to get one.
 */
describe("asking while a stop is already running", () => {
  async function askedMidDemo() {
    const dir = repo();
    const holder: { controller?: RunController; store?: Store; runId?: string; asked?: string } = {};
    const { pool, specs } = rolePool({
      planner,
      worker: (spec, nth) => {
        commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`);
        return "did the work";
      },
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
      // The cadence stop is already in flight. This is its demo — the request
      // arrives now, after the stop was picked up and before it opens.
      demo: (spec) => {
        if (!holder.asked && holder.controller) {
          holder.runId = holder.store!.listRuns()[0]!.id;
          holder.asked = holder.controller.requestPitStop(holder.runId, QUESTION);
        }
        return demoOk(spec);
      },
      reviewer: () => REVIEW_OK,
      pm: () => PM_ANSWER,
    });
    const built = build(dir, pool);
    holder.controller = built.controller;
    holder.store = built.store;
    const runId = await built.controller.startRun(
      "build a thing",
      RunConfig.parse({
        deterministicChecks: [],
        waitForChecks: false,
        maxParallelWorkers: 1,
        pitStop: { every: "epic" },
      })
    );
    return { ...built, specs, runId, asked: holder.asked };
  }

  it("does not let the stop that was already running swallow the question", async () => {
    const { events, store, runId, asked, specs, stops } = await askedMidDemo();

    expect(asked).toMatch(/^pit stop requested/);
    const opened = events.filter((e) => e.type === "run.pitstop_opened") as (HarnessEvent & {
      summoned: boolean;
      askedAt: number;
    })[];
    // The cadence stop opened, and it says plainly that it carried no question.
    // That is the field the retirement rule reads.
    const cadence = opened.find((e) => !e.summoned)!;
    expect(cadence).toBeTruthy();
    expect(cadence.askedAt).toBe(0);

    // Either the question got its own stop, or it is still standing and owed
    // one. What must never happen is the third case: retired unasked.
    const summoned = opened.find((e) => e.summoned);
    if (summoned) {
      expect(summoned.askedAt).toBeGreaterThan(0);
      // It bought a stop of its own — a second demo — and that demo was driven
      // by the question rather than by the epic the first one covered.
      const demos = specs.filter((sp) => sp.role === "demo");
      expect(demos.length).toBeGreaterThan(1);
      expect(demos.at(-1)!.prompt).toContain(QUESTION);
      expect(stops.some((st) => st.reason === "you asked for a look at the product")).toBe(true);
    } else {
      expect(store.pendingPitStopRequest(runId)).toMatchObject({ question: QUESTION });
    }
  });
});

describe("the guards on asking", () => {
  const bare = () => {
    const store = new Store(":memory:");
    const { pool } = rolePool({});
    const built = build(repo(), pool);
    return built;
  };

  it("refuses an empty question, because a stop that asks nothing costs the same as one that does", () => {
    const { controller, store } = bare();
    store.createRun({
      id: "r1", repoPath: "/repo", assignment: "a", state: "EXECUTING",
      prdPath: null, planHash: null, integrationBranch: "harness/r1", config: RunConfig.parse({}),
    });
    expect(controller.requestPitStop("r1", "   ")).toBe("write the question the pit stop should answer");
    expect(store.pendingPitStopRequest("r1")).toBeNull();
  });

  it("refuses a run that is not working", () => {
    const { controller, store } = bare();
    store.createRun({
      id: "r1", repoPath: "/repo", assignment: "a", state: "PR_REVIEW",
      prdPath: null, planHash: null, integrationBranch: "harness/r1", config: RunConfig.parse({}),
    });
    expect(controller.requestPitStop("r1", "how did it go?")).toContain("PR_REVIEW");
  });

  it("refuses a run it has never heard of", () => {
    expect(bare().controller.requestPitStop("nope", "hello")).toBe("no run nope");
  });

  /**
   * A run started without a pit stop gate — `harness run --no-dashboard` — has
   * nowhere to show the stop. Saying so is better than opening one into a void.
   */
  it("refuses when there is nowhere to show the stop", () => {
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const { pool } = rolePool({});
    const controller = new RunController(
      store,
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
      },
      repo()
    );
    store.createRun({
      id: "r1", repoPath: "/repo", assignment: "a", state: "EXECUTING",
      prdPath: null, planHash: null, integrationBranch: "harness/r1", config: RunConfig.parse({}),
    });
    expect(controller.requestPitStop("r1", "why is there no login page?")).toBe("this run has nobody to show a pit stop to");
  });

  it("replaces the waiting question instead of queueing a second stop", () => {
    const { controller, store } = bare();
    store.createRun({
      id: "r1", repoPath: "/repo", assignment: "a", state: "EXECUTING",
      prdPath: null, planHash: null, integrationBranch: "harness/r1", config: RunConfig.parse({}),
    });
    controller.requestPitStop("r1", "first");
    expect(controller.requestPitStop("r1", "second")).toMatch(/^your question replaced/);
    expect(store.pendingPitStopRequest("r1")).toMatchObject({ question: "second" });
  });

  it("cancels a request that has not opened, and says so when there is nothing to cancel", () => {
    const { controller, store } = bare();
    store.createRun({
      id: "r1", repoPath: "/repo", assignment: "a", state: "EXECUTING",
      prdPath: null, planHash: null, integrationBranch: "harness/r1", config: RunConfig.parse({}),
    });
    expect(controller.cancelPitStop("r1")).toBe("nothing to cancel — no pit stop is waiting to open");
    controller.requestPitStop("r1", "never mind in a moment");
    expect(controller.cancelPitStop("r1")).toMatch(/^pit stop cancelled/);
    expect(store.pendingPitStopRequest("r1")).toBeNull();
  });
});

describe("re-routing a role while the run is going", () => {
  const withRun = (models: Record<string, string> = {}) => {
    const { pool } = rolePool({});
    const built = build(repo(), pool);
    built.store.createRun({
      id: "r1", repoPath: "/repo", assignment: "a", state: "EXECUTING",
      prdPath: null, planHash: null, integrationBranch: "harness/r1", config: RunConfig.parse({ models }),
    });
    return built;
  };

  it("moves the role and says so, naming what the next agent will use", () => {
    const { controller, store } = withRun();
    expect(controller.rerouteModel("r1", "worker", "claude-haiku-4-5-20251001")).toBe(
      "worker re-routed: claude-sonnet-5 → claude-haiku-4-5-20251001. The next one to start uses it."
    );
    expect(store.getRun("r1")!.config.models.worker).toBe("claude-haiku-4-5-20251001");
  });

  /**
   * The judging floor holds here exactly as it does at `harness run`, and for
   * the same reason: `patchRunConfig` re-parses the whole config, so this door
   * is not a second, weaker door.
   */
  it("refuses to put a judge on a cheap model, and changes nothing when it does", () => {
    const { controller, store } = withRun();
    const said = controller.rerouteModel("r1", "qa", "claude-haiku-4-5-20251001");
    expect(said).toMatch(/qa/);
    expect(store.getRun("r1")!.config.models.qa).toBe("claude-sonnet-5");
  });

  it("refuses a role that does not exist rather than silently adding one", () => {
    const { controller, store } = withRun();
    expect(controller.rerouteModel("r1", "coder", "claude-opus-5")).toMatch(/^unknown role coder/);
    expect(Object.keys(store.getRun("r1")!.config.models)).not.toContain("coder");
  });

  it("says nothing changed when the role is already there", () => {
    const { controller } = withRun();
    expect(controller.rerouteModel("r1", "worker", "claude-sonnet-5")).toBe("worker is already on claude-sonnet-5");
  });

  it("refuses a run it has never heard of, and a blank model name", () => {
    const { controller } = withRun();
    expect(controller.rerouteModel("nope", "worker", "claude-opus-5")).toBe("no run nope");
    expect(controller.rerouteModel("r1", "worker", "   ")).toBe("name a model to route it to");
  });

  /**
   * A live session keeps the model it was spawned on — the harness re-routes by
   * spawning fresh, never by switching under a conversation whose prompt cache
   * is what makes it affordable. Saying which task keeps the old model is the
   * one sentence that teaches this without a paragraph.
   */
  it("names the running session that keeps the old model", () => {
    const { controller, store } = withRun();
    // Written the way the pool writes it, because that is the row `listSessions`
    // reads and the state it filters on.
    store.db
      .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt) VALUES (?,?,?,?,?,?,?)")
      .run("sess-1", "r1", "task-a", "worker", "claude-sonnet-5", "running", Date.now());
    expect(controller.rerouteModel("r1", "worker", "claude-haiku-4-5-20251001")).toContain(
      "1 worker session already running stays on claude-sonnet-5 until it finishes."
    );
  });

  it("counts more than one running session in the plural", () => {
    const { controller, store } = withRun();
    const insert = store.db.prepare(
      "INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt) VALUES (?,?,?,?,?,?,?)"
    );
    insert.run("sess-1", "r1", "task-a", "worker", "claude-sonnet-5", "running", Date.now());
    insert.run("sess-2", "r1", "task-b", "worker", "claude-sonnet-5", "running", Date.now());
    expect(controller.rerouteModel("r1", "worker", "claude-haiku-4-5-20251001")).toContain(
      "2 worker sessions already running stay on claude-sonnet-5 until they finish."
    );
  });

  /**
   * The key check runs *before* the config is touched, because a role routed to
   * a vendor whose key is not exported fails at the first spawn — minutes later,
   * in a log, a long way from the click that caused it.
   */
  it("refuses a vendor whose key is not exported, and leaves the routing alone", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const { controller, store } = withRun();
    expect(controller.rerouteModel("r1", "worker", "gpt-5.6-terra")).toContain("OPENAI_API_KEY is not set");
    expect(store.getRun("r1")!.config.models.worker).toBe("claude-sonnet-5");
    vi.unstubAllEnvs();
  });

  it("reports a non-validation failure to write the config rather than throwing at the operator", () => {
    const { controller, store } = withRun();
    store.patchRunConfig = () => {
      throw new Error("database is locked");
    };
    expect(controller.rerouteModel("r1", "worker", "claude-haiku-4-5-20251001")).toContain("database is locked");
  });
});
