import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const demoJson = (artifacts: { file: string; shows: string }[]) =>
  "```json\n" +
  JSON.stringify({
    started: true,
    howStarted: "pnpm dev on :5173",
    summary: "sign-in works",
    journeys: [{ name: "Sign in", result: "worked", evidence: "302 to /home" }],
    couldNotReach: ["payments — no test keys"],
    artifacts,
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
      { id: "task-a", epicId: "epic-one", title: "Sign in", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], estimatedSize: "S" as const },
      { id: "task-b", epicId: "epic-two", title: "The map", spec: "s", acceptanceCriteria: ["x"], dependsOn: ["task-a"], touchedPaths: [], estimatedSize: "S" as const },
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
    expect(first.demo.started).toBe(true);
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
    // One session per configured lens, at each stop, all of them named. The
    // design lens is the fourth and last: the pit stop is the only place the
    // whole product is looked at once, and six screens that each passed their
    // own task's QA can still disagree with each other about every visual
    // decision. It became worth paying for when the demo agent got a browser —
    // before that it would have been reviewing a prose description of a screen.
    expect(specs.filter((s) => s.role === "reviewer").length).toBe(8);
    expect(first.reviews.map((r) => r.lens)).toEqual([
      "product-manager",
      "critical-challenger",
      "qa-agent",
      "ui-ux-cx-engineer",
    ]);
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

    expect(stops[0]!.demo.artifacts).toEqual([SIGNIN_EVIDENCE]);
    expect(stops[0]!.markdown).toContain(`- \`${SIGNIN_EVIDENCE.file}\` — ${SIGNIN_EVIDENCE.shows}`);
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

    expect(stops[0]!.demo.started).toBe(false);
    expect(stops[0]!.markdown).toContain("session died at the turn ceiling");
    expect(stops[0]!.markdown).toContain("there is no demo for this pit stop");
  });

  it("treats an answer that is not the JSON it asked for the same way", async () => {
    const dir = repo();
    const { pool } = rolePool({ ...ROLES, demo: () => "I had a look around and it seems fine" });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(stops[0]!.demo.started).toBe(false);
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
    // Resumed, not restarted: the expensive half of a demo is standing the
    // product up, and the second turn is only about the evidence.
    expect(demos[1]!.resume).toBeTruthy();
    expect(demos[1]!.prompt).toContain("signin.png");
    expect(demos[1]!.prompt).toContain("not written to the artifact directory");
    expect(demos[1]!.maxTurns).toBeLessThan(RunConfig.parse(BASE).pitStop.demoMaxTurns);
    // And what the operator finally sees is the file that exists.
    expect(stops[0]!.demo.artifacts).toEqual([SIGNIN_EVIDENCE]);
  });

  it("strikes what is still not evidence, and files it under what was not checked", async () => {
    const dir = repo();
    const { pool } = rolePool({ ...ROLES, demo: () => missing() });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    const stop = stops[0]!;
    expect(stop.demo.artifacts).toEqual([]);
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
    expect(stops[0]!.demo.started).toBe(true);
    expect(stops[0]!.demo.artifacts).toEqual([]);
    expect(stops[0]!.markdown).toContain("no statement of what it shows");
  });

  it("does not spend a second demo session on a report that has no evidence at all", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({ ...ROLES, demo: () => demoJson([]) });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    expect(specs.filter((s) => s.role === "demo").length).toBe(1);
    expect(stops[0]!.demo.started).toBe(true);
  });

  it("keeps the first report when the retake comes back as something else", async () => {
    const dir = repo();
    const { pool } = rolePool({ ...ROLES, demo: (spec, nth) => (nth === 1 ? missing() : "I had another look and it is fine") });
    const { controller, stops } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, pitStop: { every: { tasks: 2 } } }));

    // The journeys are real findings; losing them to a failed retake of one
    // screenshot would be a worse trade than the blank file was.
    expect(stops[0]!.demo.started).toBe(true);
    expect(stops[0]!.demo.journeys.map((j) => j.name)).toEqual(["Sign in"]);
    expect(stops[0]!.demo.artifacts).toEqual([]);
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
