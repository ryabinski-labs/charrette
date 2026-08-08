import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { PitStop, PitStopDecision } from "./pitstop.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * Pit stops end to end: the run stops between epics, starts what it has built,
 * shows the operator, and does what they say. See docs/PITSTOP.md.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-pit-"));
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
/** The artifact directory the demo agent's own system prompt tells it to use. */
const artifactsDir = (spec: AgentSpec) => spec.systemPrompt.match(/into (.+?) \(it already exists\)/)![1]!;

const demoJson = (artifacts: { file: string; shows: string }[], commands: { command: string; shows: string }[] = []) =>
  "```json\n" +
  JSON.stringify({
    started: true,
    howStarted: "pnpm dev on :5173",
    summary: "sign-in works",
    // Planned and delivered, so the default fixture is a demo that actually
    // established something — which is what lets the staged review skip its
    // second pass. `demoThin` below is the same demo without the plan.
    plannedJourneys: ["Sign in"],
    journeys: [{ name: "Sign in", result: "worked", evidence: "302 to /home" }],
    couldNotReach: ["payments — no test keys"],
    artifacts,
    commands,
  }) +
  "\n```";

const SIGNIN_EVIDENCE = { file: "signin.har", shows: "the sign-in POST and its 302, with the session cookie set" };

/** A demo agent that writes the evidence it claims to have captured. */
const demoOk = (spec: AgentSpec) => {
  writeFileSync(path.join(artifactsDir(spec), SIGNIN_EVIDENCE.file), '{"log":{"entries":[{"request":{}}]}}');
  return demoJson([SIGNIN_EVIDENCE]);
};
const REVIEW_OK = '```json\n{"verdict":"on-track","findings":[],"question":""}\n```';

/** Two epics, so the first can finish while the second still has work to do. */
const twoEpicPlan =
  "```json\n" +
  JSON.stringify({
    epics: [
      { id: "epic-one", title: "Sign-in", summary: "s" },
      { id: "epic-two", title: "The map", summary: "s" },
    ],
    tasks: [
      { id: "task-a", epicId: "epic-one", title: "Sign in", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const },
      { id: "task-b", epicId: "epic-two", title: "The map", spec: "s", acceptanceCriteria: ["x"], dependsOn: ["task-a"], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const },
    ],
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string | Partial<AgentResult> | Error);

function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      // Captured before the first await, not read after it. The reviewers are
      // dispatched concurrently, so all three suspend on budgetCheck before any
      // of them answers — a count read afterwards is the final count for every
      // one of them, and "the second reviewer failed" quietly became "none did".
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
const planner = (dag: string) => (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dag);

const BASE = { deterministicChecks: [] as string[], waitForChecks: false, maxParallelWorkers: 1 };

interface Built {
  controller: RunController;
  store: Store;
  events: HarnessEvent[];
  stops: PitStop[];
}

function build(opts: {
  repoPath: string;
  pool: AgentPool;
  decide?: (stop: PitStop) => PitStopDecision;
  omitHandler?: boolean;
}): Built {
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
  };
  if (!opts.omitHandler) {
    gates.resolvePitStop = async (stop) => {
      stops.push(stop);
      return opts.decide?.(stop) ?? { action: "continue", feedback: "" };
    };
  }
  const controller = new RunController(store, bus, opts.pool, new GitHubAdapter(undefined, undefined), gates, opts.repoPath);
  return { controller, store, events, stops };
}

const ROLES = { planner: planner(twoEpicPlan), worker, qa: () => QA_PASS, validator: () => INTENT_PASS, demo: demoOk, reviewer: () => REVIEW_OK };

describe("stopping at an epic boundary", () => {
  it("shows the operator the product running, and what it could not reach", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(ROLES);
    const { controller, stops, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    // Two epics, so two pit stops: one when sign-in lands, one at the end.
    expect(stops.length).toBe(2);
    const first = stops[0]!;
    expect(first.reason).toBe('the "Sign-in" epic is finished');
    expect(first.demo!.started).toBe(true);
    expect(first.markdown).toContain("**It runs.** pnpm dev on :5173");
    expect(first.markdown).toContain("payments — no test keys");
    // The point of the whole feature: at the first stop the map has not been
    // built, and the operator can see that before it is.
    expect(first.upcoming).toEqual(["The map (task-b)"]);
    expect(first.merged).toEqual(["Sign in (task-a)"]);

    // The demo ran against the integration worktree, not the operator's repo.
    const demoSpec = specs.find((s) => s.role === "demo")!;
    expect(demoSpec.cwd).not.toBe(dir);
    expect(demoSpec.cwd).toContain(runId);
    // Four lenses are configured, and on a stop this clean only the first two
    // are bought: a demonstrated demo, both reviewers on-track, no findings and
    // no questions is the boring case the staging exists to stop paying full
    // price for. Two lenses at each of two stops.
    //
    // The other two are still configured and still named — see the escalation
    // tests below, where anything at all interesting buys them. The design lens
    // in particular is worth its price when there is something to look at: the
    // pit stop is the only place the whole product is seen at once, and six
    // screens that each passed their own task's QA can still disagree with each
    // other about every visual decision.
    expect(specs.filter((s) => s.role === "reviewer").length).toBe(4);
    expect(first.reviews.map((r) => r.lens)).toEqual(["product-manager", "critical-challenger"]);
    expect(first.skippedReviewers).toEqual(["qa-agent", "ui-ux-cx-engineer"]);
    // And the operator is told, rather than shown two opinions where the config
    // promised four.
    expect(first.markdown).toContain("Not run: qa-agent, ui-ux-cx-engineer");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("writes the evidence and the report where the operator can go and read them", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    const { controller } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    const stopDir = path.join(dir, ".harness", runId, "pitstops", "1");
    expect(existsSync(path.join(stopDir, "REPORT.md"))).toBe(true);
    expect(readFileSync(path.join(stopDir, "REPORT.md"), "utf8")).toContain("# Pit stop 1");
    // .harness is already ignored, so none of this reaches the operator's diff.
    expect(existsSync(path.join(stopDir, "pitstop.json"))).toBe(true);
  });

  it("shows the operator what each file is for, and nothing it did not check", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(stops[0]!.demo!.artifacts).toEqual([SIGNIN_EVIDENCE]);
    expect(stops[0]!.markdown).toContain(`- \`${SIGNIN_EVIDENCE.file}\` — ${SIGNIN_EVIDENCE.shows}`);
  });

  /**
   * "I ran the suite and it is green" reached the operator as a fact on the
   * strength of an agent having typed it. What survives here is what a second
   * run agreed with; everything else moves to what the pit stop could not check,
   * with the command printed beside it so the operator can settle it themselves.
   */
  it("re-runs the commands a demo offers as proof, and files the rest under what it could not check", async () => {
    const dir = repo();
    const { pool } = rolePool({
      ...ROLES,
      demo: (spec: AgentSpec) => {
        writeFileSync(path.join(artifactsDir(spec), SIGNIN_EVIDENCE.file), '{"log":{"entries":[{"request":{}}]}}');
        return demoJson(
          [SIGNIN_EVIDENCE],
          [
            { command: "test -f README.md", shows: "the demo ran against the merged tree" },
            { command: "false", shows: "the suite is green" },
            // A second POST is a second booking, so this one is reported rather
            // than repeated.
            { command: "curl -X POST localhost:9/v1/bookings", shows: "a booking is created" },
          ]
        );
      },
    });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    const stop = stops[0]!;
    expect(stop.demo!.commands).toEqual([{ command: "test -f README.md", shows: "the demo ran against the merged tree" }]);
    expect(stop.markdown).toContain("Re-run by the harness and confirmed:");
    expect(stop.markdown).toContain("- `test -f README.md` — the demo ran against the merged tree");
    const unchecked = stop.demo!.couldNotReach.join("\n");
    expect(unchecked).toContain("the suite is green — not verified: `false` re-run by the harness and it failed");
    expect(unchecked).toContain("repeat the write");
    // The demo's own answer is not deleted, only moved: the operator still sees
    // every claim, under the heading that is true of it.
    expect(unchecked).toContain("payments — no test keys");
  });

  it("re-runs at most six of them, and says plainly that the rest were not checked", async () => {
    const dir = repo();
    const claims = Array.from({ length: 7 }, (_, i) => ({ command: `echo proof-${i + 1}`, shows: `claim ${i + 1}` }));
    const { pool } = rolePool({
      ...ROLES,
      demo: (spec: AgentSpec) => {
        writeFileSync(path.join(artifactsDir(spec), SIGNIN_EVIDENCE.file), '{"log":{"entries":[{"request":{}}]}}');
        return demoJson([SIGNIN_EVIDENCE], claims);
      },
    });
    const { controller, stops, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    // Six confirmed and the seventh named as unverified — a truncated list that
    // reads as a complete one is the failure this whole gate exists to stop.
    expect(stops[0]!.demo!.commands.map((c) => c.command)).toEqual(claims.slice(0, 6).map((c) => c.command));
    expect(stops[0]!.demo!.couldNotReach.join("\n")).toContain("claim 7 — not verified: `echo proof-7` the harness re-runs at most 6 commands per pit stop");
    expect(
      events.some((e) => e.type === "agent.log" && e.text === "the demo claimed 7 commands; the harness re-ran the first 6 and reported the rest as unverified")
    ).toBe(true);
  });

  it("records the stop so a resumed run does not demo the same epic twice", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    const { controller, events, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    const opened = events.filter((e) => e.type === "run.pitstop_opened");
    expect(opened.length).toBe(2);
    expect(store.pitStopHistory(runId, 0).demoedEpics).toEqual(["epic-one", "epic-two"]);
  });

  it("does not fire at all when they are switched off", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(ROLES);
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: "never" } }));

    expect(stops).toEqual([]);
    expect(specs.some((s) => s.role === "demo")).toBe(false);
  });

  it("does not spend a demo session on a gate handler that cannot ask anything", async () => {
    // Headless and test contexts have nowhere to put the question. A demo agent
    // and three reviewers cost real money; spending it to print a report nobody
    // will answer is worse than not stopping.
    const dir = repo();
    const { pool, specs } = rolePool(ROLES);
    const { controller } = build({ repoPath: dir, pool, omitHandler: true });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(specs.some((s) => s.role === "demo" || s.role === "reviewer")).toBe(false);
  });

  it("stops every N merged tasks when that is what the operator asked for", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    expect(stops.map((s) => s.reason)).toEqual(["2 more tasks merged"]);
  });
});

describe("a demo that goes wrong", () => {
  it("still opens the pit stop, and says there was no demo", async () => {
    const dir = repo();
    const { pool } = rolePool({ ...ROLES, demo: () => new Error("session died at the turn ceiling") });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(stops[0]!.demo!.started).toBe(false);
    expect(stops[0]!.markdown).toContain("session died at the turn ceiling");
    expect(stops[0]!.markdown).toContain("there is no demo for this pit stop");
  });

  it("treats an answer that is not the JSON it asked for the same way", async () => {
    const dir = repo();
    const { pool } = rolePool({ ...ROLES, demo: () => "I had a look around and it seems fine" });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(stops[0]!.demo!.started).toBe(false);
  });

  it("puts the worktree back however the demo left it", async () => {
    const dir = repo();
    const { pool } = rolePool({
      ...ROLES,
      // A demo agent is allowed to install and build; it is not allowed to
      // change the diff the operator will eventually review.
      demo: (spec) => {
        writeFileSync(path.join(spec.cwd, "README.md"), "the demo agent scribbled here\n");
        return demoOk(spec);
      },
    });
    const { controller } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    const wt = path.join(`${dir}-wt`, runId, "__integration__");
    expect(readFileSync(path.join(wt, "README.md"), "utf8")).toBe("start\n");
  });

  it("names a reviewer that did not finish instead of quietly showing three of four", async () => {
    const dir = repo();
    const { pool } = rolePool({
      ...ROLES,
      reviewer: (spec, nth) => (nth === 2 ? new Error("overloaded") : REVIEW_OK),
    });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    const reviews = stops[0]!.reviews;
    expect(reviews.length).toBe(RunConfig.parse(BASE).pitStop.reviewers.length);
    expect(reviews.filter((r) => r.findings.some((f) => f.includes("this reviewer did not finish"))).length).toBe(1);
  });

  /** Lenses actually dispatched, in order, across the whole run. */
  const lensesRun = (specs: AgentSpec[]) =>
    specs.filter((s) => s.role === "reviewer").map((s) => s.systemPrompt.match(/product-manager|critical-challenger|qa-agent|ui-ux-cx-engineer/)?.[0]);

  it("buys the remaining lenses when a first-pass reviewer is not on-track", async () => {
    const dir = repo();
    const drifting = '```json\n{"verdict":"drifting","findings":["the pack screen has nothing behind it"],"question":""}\n```';
    const { pool, specs } = rolePool({ ...ROLES, reviewer: (_s, nth) => (nth === 1 ? drifting : REVIEW_OK) });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    // The whole point of staging: the cheap path is only taken when there is
    // nothing to find. One lens saying "drifting" buys the other two.
    expect(stops[0]!.reviews.length).toBe(4);
    expect(stops[0]!.skippedReviewers).toEqual([]);
    expect(lensesRun(specs).slice(0, 4)).toEqual(["product-manager", "critical-challenger", "qa-agent", "ui-ux-cx-engineer"]);
  });

  it("buys them when a first-pass reviewer calls it on-track but still lists findings", async () => {
    const dir = repo();
    const niggle = '```json\n{"verdict":"on-track","findings":["the empty state is unstyled"],"question":""}\n```';
    const { pool } = rolePool({ ...ROLES, reviewer: (_s, nth) => (nth === 2 ? niggle : REVIEW_OK) });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    // A lens that says "on track" and then lists what is wrong has not settled
    // anything the other lenses might deepen.
    expect(stops[0]!.reviews.length).toBe(4);
  });

  it("buys them when the demo never established anything, however clean the first pass reads", async () => {
    const dir = repo();
    // Same demo, no declared plan — so coverage is inconclusive. This is the
    // condition that ties the cheap demo to the expensive reviewers: a thin demo
    // must not also buy a quieter review.
    const demoThin = (spec: AgentSpec) => {
      writeFileSync(path.join(artifactsDir(spec), SIGNIN_EVIDENCE.file), '{"log":{"entries":[{"request":{}}]}}');
      const json = JSON.parse(demoOk(spec).replace(/^```json\n|\n```$/g, ""));
      return `\`\`\`json\n${JSON.stringify({ ...json, plannedJourneys: [] })}\n\`\`\``;
    };
    const { pool } = rolePool({ ...ROLES, demo: demoThin });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(stops[0]!.demo!.coverage.status).toBe("inconclusive");
    expect(stops[0]!.reviews.length).toBe(4);
    expect(stops[0]!.skippedReviewers).toEqual([]);
    // And the report says so before it says anything the demo claimed.
    expect(stops[0]!.markdown).toContain("**INCONCLUSIVE**");
  });

  it("runs every lens every time when staging is switched off", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(ROLES);
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { reviewFirstPass: 0 } }));

    expect(specs.filter((s) => s.role === "reviewer").length).toBe(8);
    expect(stops[0]!.skippedReviewers).toEqual([]);
  });

  it("asks nobody when the operator configured no lenses", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(ROLES);
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { reviewers: [] } }));

    expect(specs.some((s) => s.role === "reviewer")).toBe(false);
    expect(stops[0]!.reviews).toEqual([]);
  });
});

/**
 * An operator was handed a pit stop whose evidence was a screenshot of one flat
 * white rectangle and a homepage nobody had attached a claim to. The demo agent
 * had even said, four paragraphs up, that the capture came back blank. Nothing
 * between it and the operator ever opened the files.
 */
describe("evidence that does not survive being looked at", () => {
  const missing = () => demoJson([{ file: "signin.png", shows: "the signed-in home page" }]);

  it("asks the demo agent again, with the product still up, before showing anybody", async () => {
    const dir = repo();
    // First answer offers a file it never wrote; the retake writes one.
    const { pool, specs } = rolePool({ ...ROLES, demo: (spec, nth) => (nth === 1 ? missing() : demoOk(spec)) });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    const demos = specs.filter((s) => s.role === "demo");
    expect(demos.length).toBe(2);
    // Resumed, and resumed onto *its own* first session: the expensive half of
    // a demo is standing the product up, and the second turn is only about the
    // evidence. The fake pool hands back `sdk<n>` for the nth session it runs.
    expect(demos[1]!.resume).toBe(`sdk${specs.indexOf(demos[0]!) + 1}`);
    expect(demos[1]!.cwd).toBe(demos[0]!.cwd);
    expect(demos[1]!.prompt).toContain("signin.png");
    expect(demos[1]!.prompt).toContain("not written to the artifact directory");
    expect(demos[1]!.maxTurns).toBeLessThan(RunConfig.parse(BASE).pitStop.demoMaxTurns);
    // And what the operator finally sees is the file that exists.
    expect(stops[0]!.demo!.artifacts).toEqual([SIGNIN_EVIDENCE]);
  });

  it("strikes what is still not evidence, and files it under what was not checked", async () => {
    const dir = repo();
    const { pool } = rolePool({ ...ROLES, demo: () => missing() });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    const stop = stops[0]!;
    expect(stop.demo!.artifacts).toEqual([]);
    expect(stop.markdown).not.toContain("## Evidence");
    // Struck, not deleted: an operator shown neither the file nor the failure
    // assumes the surface was covered.
    expect(stop.markdown).toContain("## What it could NOT check");
    expect(stop.markdown).toContain("the signed-in home page");
    expect(stop.markdown).toContain("struck from the evidence by the harness");
  });

  it("keeps a file the agent listed with no idea what it proves out of the evidence", async () => {
    const dir = repo();
    const { pool } = rolePool({
      ...ROLES,
      demo: (spec) => {
        writeFileSync(path.join(artifactsDir(spec), "shot.har"), "{}");
        // The shape the old prompt asked for: a bare filename.
        return demoJson(["shot.har" as unknown as { file: string; shows: string }]);
      },
    });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    // Lenient at the parser — the rest of the report survives — strict at the gate.
    expect(stops[0]!.demo!.started).toBe(true);
    expect(stops[0]!.demo!.artifacts).toEqual([]);
    expect(stops[0]!.markdown).toContain("no statement of what it shows");
  });

  it("does not accept a file the demo agent did not produce", async () => {
    const dir = repo();
    // Anything outside the pit stop's own directory is not evidence this demo
    // captured, whatever it says about it.
    const { pool } = rolePool({
      ...ROLES,
      demo: () => demoJson([{ file: "../../../../etc/hosts", shows: "the host is resolving the API" }]),
    });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    expect(stops[0]!.demo!.artifacts).toEqual([]);
    expect(stops[0]!.markdown).toContain("not written to the artifact directory");
  });

  it("does not spend a second demo session on a report that has no evidence at all", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({ ...ROLES, demo: () => demoJson([]) });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    expect(specs.filter((s) => s.role === "demo").length).toBe(1);
    expect(stops[0]!.demo!.started).toBe(true);
  });

  it("keeps the first report when the retake comes back as something else", async () => {
    const dir = repo();
    const { pool } = rolePool({ ...ROLES, demo: (spec, nth) => (nth === 1 ? missing() : "I had another look and it is fine") });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    // The journeys are real findings; losing them to a failed retake of one
    // screenshot would be a worse trade than the blank file was.
    expect(stops[0]!.demo!.started).toBe(true);
    expect(stops[0]!.demo!.journeys.map((j) => j.name)).toEqual(["Sign in"]);
    expect(stops[0]!.demo!.artifacts).toEqual([]);
  });
});

describe("what the operator decides", () => {
  it("attaches their words to every task that has not run yet", async () => {
    const dir = repo();
    const { pool, specs } = rolePool(ROLES);
    const { controller, events } = build({
      repoPath: dir,
      pool,
      decide: (stop) => (stop.number === 1 ? { action: "redirect", feedback: "drop the offline mode, it is not needed" } : { action: "continue", feedback: "" }),
    });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    // Queued, not just recorded: the next worker dispatched on the task has to
    // actually receive it, which is the whole of story S2.
    const mapWorker = specs.filter((s) => s.role === "worker").at(-1)!;
    expect(mapWorker.prompt).toContain("drop the offline mode");
    const resolved = events.find((e) => e.type === "run.pitstop_resolved")!;
    expect(resolved).toMatchObject({ action: "redirect", tasks: ["task-b"] });
  });

  it("records what they said in full, however long they said it", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    // Comfortably past the 2000-character cap this used to be cut at, with the
    // tail marked so a truncation shows up as a missing ending rather than as
    // a length that happens to look plausible. A reviewer's decision really can
    // run this long: the one that motivated this fix was three numbered
    // questions, and the cap severed the third.
    const long = `${"the third question matters. ".repeat(120)}AND HERE IS THE END OF IT`;
    const { controller, events } = build({
      repoPath: dir,
      pool,
      decide: (stop) => (stop.number === 1 ? { action: "redirect", feedback: long } : { action: "continue", feedback: "" }),
    });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    const resolved = events.flatMap((e) => (e.type === "run.pitstop_resolved" && e.action === "redirect" ? [e] : []))[0]!;
    expect(resolved.feedback).toBe(long);
    expect(resolved.feedback).toContain("AND HERE IS THE END OF IT");
  });

  it("parks the run when they want to think, and resume picks it up where it was", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    let thinking = true;
    const { controller, store, stops } = build({
      repoPath: dir,
      pool,
      decide: () => (thinking ? { action: "stop", feedback: "" } : { action: "continue", feedback: "" }),
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    // Nothing was thrown away: the merged task stays merged, the unbuilt one
    // stays queued, and no worktree or branch was discarded.
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-b")!.state).toBe("PENDING");

    thinking = false;
    await controller.resume(runId);

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    // The epic demoed before the pause is not demoed again after it — the
    // trigger's memory is the event log, so it survives the process.
    expect(stops.filter((s) => s.reason.includes("Sign-in")).length).toBe(1);
  });

  /**
   * The gap run 6fe4ba37 fell into. It parked at a pit stop with 3 tasks queued
   * and 39 cancelled at an earlier re-plan. `resume` used to go straight back to
   * dispatching, so the only thing it could do was build the 3 — the operator
   * had no point at which to say "those 39 are the work I actually want", short
   * of abandoning 167 commits of context and starting a new run.
   */
  describe("resuming a parked run", () => {
    it("asks before it dispatches anything, and shows what left the plan", async () => {
      const dir = repo();
      const { pool, specs } = rolePool(ROLES);
      let thinking = true;
      const seen: PitStop[] = [];
      let seenAt = () => {};
      const { controller, store } = build({
        repoPath: dir,
        pool,
        decide: (stop) => {
          seen.push(stop);
          seenAt();
          seenAt = () => {};
          return thinking ? { action: "stop", feedback: "" } : { action: "continue", feedback: "" };
        },
      });

      const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));
      expect(store.getRun(runId)!.state).toBe("PAUSED");

      thinking = false;
      const before = specs.length;
      // Everything the run spawned between `resume` and the question landing.
      // Read inside the callback, because the run carries on afterwards and
      // opens an ordinary demo-backed stop at the next epic boundary.
      let spawnedBeforeAsking: string[] = [];
      seen.length = 0;
      seenAt = () => (spawnedBeforeAsking = specs.slice(before).map((s) => s.role));
      await controller.resume(runId);

      // The stop that resume opens is the first thing that happens, and it is
      // the one with no demo behind it.
      const resumeStop = seen[0]!;
      expect(resumeStop.reason).toBe("you resumed a run that was parked at a pit stop");
      expect(resumeStop.demo).toBeNull();
      expect(resumeStop.reviews).toEqual([]);
      expect(resumeStop.markdown).toContain("**Nothing was run for this stop.**");
      // Free: no demo agent and no reviewer ran before the operator was asked,
      // which is what makes it safe to put in front of a run at its cap. Nor
      // did any worker — the queue is untouched at the moment they are asked.
      expect(spawnedBeforeAsking).toEqual([]);
      expect(resumeStop.stopCostUsd).toBe(0);
      // And the queue it shows is the real one — task-b never ran.
      expect(resumeStop.upcoming).toEqual(["The map (task-b)"]);
      expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    });

    it("re-plans the work back into the run when they ask it to", async () => {
      const dir = repo();
      // What the planner returns the second time it is asked: the queued task is
      // gone and a different one takes its place.
      const replanned =
        "```json\n" +
        JSON.stringify({
          epics: [{ id: "epic-two", title: "The map", summary: "s" }],
          tasks: [
            { id: "task-c", epicId: "epic-two", title: "The engine", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const },
          ],
        }) +
        "\n```";
      // The re-planner is handed Read/Glob/Grep just as the PRD pass is, so the
      // two are told apart by the operator's words being in the prompt.
      let replans = 0;
      const { pool } = rolePool({
        ...ROLES,
        planner: (s: AgentSpec) => {
          if (s.prompt.includes("forget the map")) return (replans++, replanned);
          return Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : twoEpicPlan;
        },
      });
      // stop at the first epic boundary; re-plan at the resume stop; continue
      // through everything after it.
      let answers: PitStopDecision[] = [{ action: "stop", feedback: "" }];
      const { controller, store, events } = build({
        repoPath: dir,
        pool,
        decide: () => answers.shift() ?? { action: "continue", feedback: "" },
      });

      const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));
      expect(store.getRun(runId)!.state).toBe("PAUSED");
      expect(store.getTask(runId, "task-b")!.state).toBe("PENDING");

      answers = [{ action: "replan", feedback: "forget the map — build the engine" }];
      await controller.resume(runId);

      // The words reached the planner, the new work was queued and built, and
      // the task it replaced is recorded as replaced rather than silently gone.
      expect(replans).toBe(1);
      expect(store.getTask(runId, "task-c")!.state).toBe("MERGED");
      expect(store.getTask(runId, "task-b")!.state).toBe("CANCELLED");
      const resolved = events.filter((e) => e.type === "run.pitstop_resolved");
      expect(resolved.some((e) => e.action === "replan")).toBe(true);
    });

    it("leaves the run exactly as it found it when they park it again", async () => {
      const dir = repo();
      const { pool } = rolePool(ROLES);
      const { controller, store, events } = build({
        repoPath: dir,
        pool,
        decide: () => ({ action: "stop", feedback: "" }),
      });

      const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));
      expect(store.getRun(runId)!.state).toBe("PAUSED");

      const before = events.length;
      await controller.resume(runId);

      // Still parked, and task-b still unbuilt — a second "stop" must not have
      // quietly dispatched anything on the way to asking.
      expect(store.getRun(runId)!.state).toBe("PAUSED");
      expect(store.getTask(runId, "task-b")!.state).toBe("PENDING");
      expect(events.slice(before).some((e) => e.type === "task.state_changed")).toBe(false);
    });

    it("just runs what is queued when the resume has nowhere to put the question", async () => {
      // A daemon, a cron, a CI job: something resumed the run without a
      // terminal to ask at. The stop this feature adds is worth a lot to an
      // operator sitting at a prompt and worth nothing to a process that would
      // print the report into a log and answer it with a default. Falling back
      // to what `resume` did before this existed — dispatch the queue — is the
      // only behaviour that finishes the work either way.
      const dir = repo();
      const { pool } = rolePool(ROLES);
      let thinking = true;
      const { controller, store } = build({
        repoPath: dir,
        pool,
        decide: () => (thinking ? { action: "stop", feedback: "" } : { action: "continue", feedback: "" }),
      });

      const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));
      expect(store.getRun(runId)!.state).toBe("PAUSED");

      // Same run, same store, resumed by something that cannot ask anything.
      thinking = false;
      const headless = new RunController(
        store,
        new Bus(store),
        pool,
        new GitHubAdapter(undefined, undefined),
        { async resolvePlanGate() { return { approved: true, feedback: "" }; }, async resolveBudgetGate() { return null; } },
        dir
      );
      await headless.resume(runId);

      // It got on with it rather than parking itself again waiting for an
      // answer that was never going to come.
      expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
      expect(store.getTask(runId, "task-b")!.state).toBe("MERGED");
    });
  });

  it("continues when they say it looks right", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(events.filter((e) => e.type === "run.pitstop_resolved").every((e) => e.action === "continue")).toBe(true);
  });

  it("does nothing with an empty redirect rather than queuing a blank note", async () => {
    const dir = repo();
    const { pool } = rolePool(ROLES);
    const { controller, events } = build({ repoPath: dir, pool, decide: () => ({ action: "redirect", feedback: "   " }) });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(events.some((e) => e.type === "task.feedback")).toBe(false);
    expect(events.find((e) => e.type === "run.pitstop_resolved")).toMatchObject({ tasks: [] });
  });
});

/**
 * A pit stop is the run's natural quiet moment, so it is where the machine gets
 * back what finished tasks stopped needing. Run 40da9337 ended with 37 orphaned
 * processes across five already-merged worktrees, two of them thirteen hours
 * old, all still writing to a database the live tasks were reading — and the
 * containers are worse, because they hold ports and volumes as well as memory.
 */
describe("giving the machine back at a pit stop", () => {
  /** What the sweep found, without needing a container runtime to find it. */
  const swept = async (stacks: string[], processes: { pid: number; command: string; signal: "SIGKILL" | "SIGTERM" }[]) => {
    const isolation = await import("./isolation.js");
    const reaper = await import("./reaper.js");
    vi.spyOn(isolation, "composeDown").mockResolvedValue(stacks);
    vi.spyOn(reaper, "reapUnder").mockResolvedValue(processes);
    const dir = repo();
    const { pool } = rolePool(ROLES);
    const { controller, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    return events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log" && e.text.startsWith("swept after"));
  };

  it("says what it took back, in the singular when there was one of each", async () => {
    const lines = await swept(["podman:harness-sign-in-0001"], [{ pid: 4131, command: "node server.js", signal: "SIGKILL" }]);

    expect(lines[0]!.text).toBe(
      "swept after pit stop 1: 1 container stack still up and brought down (podman:harness-sign-in-0001); 1 orphaned process killed"
    );
  });

  it("names the first few stacks and stops, rather than printing thirty", async () => {
    const lines = await swept(
      Array.from({ length: 7 }, (_, i) => `podman:harness-task-${i + 1}`),
      []
    );

    expect(lines[0]!.text).toBe(
      "swept after pit stop 1: 7 container stacks still up and brought down (podman:harness-task-1, podman:harness-task-2, podman:harness-task-3, podman:harness-task-4, podman:harness-task-5, …)"
    );
  });

  it("reports processes alone when no container was ever started", async () => {
    const lines = await swept([], [
      { pid: 1, command: "pnpm dev", signal: "SIGKILL" },
      { pid: 2, command: "postgres", signal: "SIGKILL" },
    ]);

    expect(lines[0]!.text).toBe("swept after pit stop 1: 2 orphaned processes killed");
  });

  it("says nothing at all when there was nothing to take back", async () => {
    expect(await swept([], [])).toEqual([]);
  });
});
