import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import type { PitStopDecision } from "./pitstop.js";
import { RunController } from "./runController.js";
import { Store } from "./store.js";

/**
 * The run against its own repo's CI.
 *
 * `waitForChecks` made the run *see* a red branch and then walk on: run
 * 5743ce85's follow-up pushed a coverage floor nobody had measured and an E2E
 * job its runner could not start, CI failed both, and the run reported "in
 * review" over a branch the repo itself had rejected. These tests pin what
 * replaced that — re-run once for flake, queue a fix task per failing check
 * with the job's own log, escalate to a person when the rounds are spent, and
 * count a red branch as work `resume` picks back up.
 */

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" }],
  }) +
  "\n```";
const PASS = '{"verdict":"PASS","gaps":[],"summary":"delivers the assignment"}';

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repoWithOrigin(): string {
  const origin = mkdtempSync(path.join(tmpdir(), "harness-ci-origin-"));
  gitIn(origin, "init", "--bare", "-b", "release");
  const repo = mkdtempSync(path.join(tmpdir(), "harness-ci-"));
  writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  gitIn(repo, "init", "-b", "release");
  gitIn(repo, "config", "user.email", "harness@example.com");
  gitIn(repo, "config", "user.name", "harness");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "init");
  gitIn(repo, "remote", "add", "origin", origin);
  gitIn(repo, "push", "-u", "origin", "release");
  return repo;
}

type Checks = { state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number; names?: string[]; sha?: string } | null;

/**
 * A GitHub whose CI answers from a script, one entry per read, last entry
 * sticky — so "failing, then passing after the fix round" is a two-line story.
 */
function fakeGitHub(script: Checks[], opts: { rerun?: boolean; logs?: { name: string; log: string }[]; prState?: "open" | "merged" | "closed" } = {}) {
  let reads: Checks[] = [...script];
  let rerunAsked = 0;
  const adapter = {
    enabled: true,
    async ensureIssue() {
      return null;
    },
    async ensurePR() {
      return { number: 7, url: "https://example.test/pull/7", fresh: true };
    },
    async markPrReady() {
      return true;
    },
    async prChecks(): Promise<Checks> {
      return reads.length > 1 ? reads.shift()! : reads[0]!;
    },
    async prMergeable() {
      return { state: "mergeable" as const, mergeStateStatus: "clean" };
    },
    async rerunFailedChecks() {
      rerunAsked++;
      return opts.rerun ?? true;
    },
    async failingJobLogs() {
      return opts.logs ?? [];
    },
    ...(opts.prState ? { async prState() { return opts.prState; } } : {}),
  };
  return { adapter: adapter as unknown as GitHubAdapter, rerunAsked: () => rerunAsked, setChecks: (next: Checks[]) => void (reads = [...next]) };
}

/**
 * The 28 checks #527 carried, by name, and the 17 that were still listed
 * three seconds after the re-run: `ci.yml`'s eleven jobs — `test` among them
 * — had dropped out of GitHub's answer while the new attempt was attached.
 */
const CI_YML = ["build", "test", "fmt", "clippy", "fuzz", "a11y", "e2e (operator path)", "e2e (screen witness)", "e2e (product demo)", "coverage (project floor)", "patch coverage (diff floor)"];
const OTHERS = [
  "cargo-audit", "cargo-deny check", "unsafe scan", "crs-subset --check", "equal-coverage-subset --check", "cargo xtask check-repo",
  "frozen-baseline changelog guard", "network-capability check", "helm chart controller surface", "revetment-k8s-controller attachment write witness",
  "build all three images", "build both images, validate compose topology", "build, a11y, assets, copy", "email capture form — stubbed suite",
  "R6 DoS attack suites", "dev-loop bench + p99 regression gate", "dev-loop added-latency pair",
];
const ALL_28 = [...OTHERS, ...CI_YML];
/** #527's head — the same commit before and after the re-run. */
const HEAD = "cdc9d3518bcc74a46b77b18a171bfa44843d59f8";

/** Plans one task, passes QA, validator says PASS; every worker commit is unique. */
function pool(opts: { qaFails?: boolean } = {}): AgentPool {
  const outputs = [DOCS, DAG, "worker done"];
  let i = 0;
  let files = 0;
  const impl = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "qa") {
        const verdict = opts.qaFails ? '{"verdict":"FAIL","reasons":["no"],"mustFix":["everything"]}' : '{"verdict":"PASS","notes":"good","unverified":[]}';
        return { sessionId: "sq", resultText: verdict, costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "validator") return { sessionId: "sv", resultText: PASS, costUsd: 0, turns: 1, outcome: "done" };
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, `work-${++files}.txt`), `commit ${files}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", `feat: ${files}`);
      }
      return { sessionId: `s${i}`, resultText: outputs[Math.min(i++, outputs.length - 1)]!, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return impl as unknown as AgentPool;
}

async function build(
  github: GitHubAdapter,
  agents: AgentPool,
  repo: string,
  over: Record<string, unknown> = {},
  resolvePitStop?: (stop: unknown) => Promise<PitStopDecision>,
  tune?: (controller: RunController) => void
) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const logs: string[] = [];
  bus.subscribe(({ event }) => {
    if (event.type === "agent.log") logs.push(event.text);
  });
  const controller = new RunController(
    store,
    bus,
    agents,
    github,
    {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
      ...(resolvePitStop ? { resolvePitStop } : {}),
    },
    repo
  );
  tune?.(controller);
  const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], checkTimeoutMinutes: 1, deployTimeoutMinutes: 1, ...over }));
  return { store, bus, runId, logs, controller };
}

/** The old shape: the red verdict goes into the outcome line and the run reports. */
const NO_HOLD = { holdUntilGreen: false };

const ciFixTasks = (store: Store, runId: string) => store.listTasks(runId).filter((t) => t.id.startsWith("ci-fix-"));

describe("a red check that was only unlucky", () => {
  it("re-runs the failed jobs once and takes the pass, spending no fix task on a flake", async () => {
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub([
      { state: "failing", failing: ["Backend test"], total: 3 },
      { state: "passing", failing: [], total: 3 },
    ]);
    const { store, runId, logs, controller } = await build(adapter, pool(), repo);

    expect(rerunAsked()).toBe(1);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(logs.join("\n")).toMatch(/re-ran the failed jobs on #7 before diagnosing/);
    expect(controller.outcome(runId).line).toContain("CI green");
  });
});

describe("a CI that outlives the wait budget", () => {
  it("waits through the expiry instead of walking on, then turns the eventual red into work", async () => {
    const repo = repoWithOrigin();
    // Twelve jobs on one runner outlive the budget: the first settle round
    // ends with "pending" on the record (the null read is GitHub hiccuping,
    // which ends a round early exactly the way an expired budget does). The
    // run must start the wait over and take the answer that finally arrives —
    // run 5743ce85 walked on here and reported "in review" over the check
    // that then went red.
    const { adapter, rerunAsked } = fakeGitHub(
      [
        { state: "pending", failing: [], total: 12 },
        null,
        { state: "failing", failing: ["Frontend tests"], total: 12 },
        { state: "failing", failing: ["Frontend tests"], total: 12 },
        { state: "passing", failing: [], total: 12 },
      ],
      { logs: [{ name: "Frontend tests", log: "AssertionError: expected ci.yml to match /floor=75/" }] }
    );
    const { store, runId, logs } = await build(adapter, pool(), repo);

    expect(logs.join("\n")).toMatch(/has not settled after another 1 minute/);
    expect(rerunAsked()).toBe(1);
    const fixes = ciFixTasks(store, runId);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]!.spec).toContain("floor=75");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
  });

  it("lands an operator's pause between waiting rounds instead of waiting through it", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "pending", failing: [], total: 2 }, null, { state: "pending", failing: [], total: 2 }]);
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const controller = new RunController(
      store,
      bus,
      pool(),
      adapter,
      {
        async resolvePlanGate() {
          return { approved: true, feedback: "" };
        },
        async resolveBudgetGate() {
          return null;
        },
      },
      repo
    );
    // The pause arrives the way it would from the dashboard: while the run is
    // recording that CI has not settled, not at some polite boundary.
    bus.subscribe(({ event }) => {
      if (event.type === "run.ci_status" && event.state === "pending") controller.pauseRun(event.runId);
    });
    const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], checkTimeoutMinutes: 1, deployTimeoutMinutes: 1 }));

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.ciStatus(runId)).toMatchObject({ state: "pending" });
  });

  it("keeps the red verdict when the re-run's re-ask never settles, instead of reading the wait's own 'pending' as a pass", async () => {
    const repo = repoWithOrigin();
    // Run bc691359, and the most expensive minute in it. #334 had gone red on
    // `test` and `coverage (project floor)`, the failed jobs were re-run, and
    // then GitHub went unreadable — once part-way through the next waiting
    // round, and again at the start of the round after it, which is the answer
    // that ends the wait. What that left as the newest `run.ci_status` was the
    // `pending` the wait itself had just published, and `ciStatus` is
    // last-event-wins: the red was not merely unconfirmed, it was gone. Both
    // fix rounds went unspent, the pit stop had nothing to escalate, and the
    // run reported "1 pull request open for review; CI still running" over a
    // branch that is red to this day.
    const { adapter, rerunAsked } = fakeGitHub(
      [
        { state: "failing", failing: ["test"], total: 20 }, // the wait's real answer
        { state: "pending", failing: [], total: 20 }, // re-run went out; jobs re-queued
        null, // unreadable part-way through — the round ends on "pending"
        null, // unreadable again, and this one ends the wait unsettled
        { state: "passing", failing: [], total: 20 }, // the fix task lands
      ],
      { logs: [{ name: "test", log: "FAIL: coverage 61.2% is under the 75% floor" }] }
    );
    const { store, runId, logs } = await build(adapter, pool(), repo);

    expect(rerunAsked()).toBe(1);
    expect(logs.join("\n")).toMatch(/has not settled after another 1 minute/);
    // The point of the whole exercise: the red outlived the blip and became work.
    const fixes = ciFixTasks(store, runId);
    expect(fixes.map((t) => t.id)).toEqual(["ci-fix-1-1"]);
    expect(fixes[0]!.spec).toContain("under the 75% floor");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
  });

  it("waits for the re-run's jobs to be back in GitHub's answer before believing a pass, instead of reading the checks left behind as green", async () => {
    // Run de2cb7aa, and the way the two guards below are not enough. Both of
    // them catch the re-run window arriving as "not knowing" — a `pending`, or
    // a `none`. This one arrived as an affirmative `passing`: #527 was red on
    // `test` over 28 checks at 18:08:25Z, the failed jobs were re-run at
    // 18:08:26Z, and the read at 18:08:28Z came back `passing` over 17 —
    // `ci.yml`'s eleven jobs, `test` among them, had dropped out of GitHub's
    // listing while the new attempt was attached. The run believed it, moved
    // to PR_REVIEW reporting "CI green", and stood down; `test` started at
    // 18:08:30Z and failed again at 18:33:27Z on the same commit. Run
    // 418049e4's #450 went the same way five days earlier, 25 to 15.
    //
    // The names are the tell, and the answer is to wait: a reading missing a
    // check the red verdict saw is the re-run not having settled, and the
    // whole answer comes a beat later. Here it comes back green, which is an
    // ordinary flake, and costs no fix task.
    const { adapter, rerunAsked } = fakeGitHub([
      { state: "failing", failing: ["test"], total: 28, names: ALL_28, sha: HEAD }, // the wait's real answer
      { state: "passing", failing: [], total: 17, names: OTHERS, sha: HEAD }, // re-run went out; ci.yml not re-attached yet
      null, // GitHub hiccups, which ends the round the way an expired budget does
      { state: "passing", failing: [], total: 28, names: ALL_28, sha: HEAD }, // the whole answer, next round
    ]);
    const { store, runId, logs } = await build(adapter, pool(), repoWithOrigin());

    expect(rerunAsked()).toBe(1);
    expect(logs.join("\n")).toMatch(/GitHub's answer for #7 is missing 11 check\(s\) this head carried \(build, test, fmt, clippy, fuzz, …\) — a re-run is re-attaching them, and the 17 left are not a verdict/);
    // A round that ends still short goes on the record as the pending it is,
    // and says why, rather than as the pass the listing resembled.
    expect(logs.join("\n")).toMatch(/has not settled after another 1 minute\(s\): 11 check\(s\) this head carried are still missing from GitHub's answer/);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    // The record carries the whole answer, not the short one.
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing", total: 28, sha: HEAD });
    expect(store.ciStatus(runId)!.names).toHaveLength(28);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("queues the fix when the re-attached re-run fails again, carrying the log, rather than the pass that preceded it", async () => {
    // The same three seconds, with the ending #527 actually had: the re-run
    // came back, `test` ran for twenty-five minutes, and failed on the same
    // assertion. That is not flake, and it is the run's work.
    const { adapter, rerunAsked } = fakeGitHub(
      [
        { state: "failing", failing: ["test"], total: 28, names: ALL_28, sha: HEAD },
        { state: "passing", failing: [], total: 17, names: OTHERS, sha: HEAD }, // the short answer that used to end the run
        { state: "failing", failing: ["test"], total: 28, names: ALL_28, sha: HEAD }, // the re-run, settled
        { state: "passing", failing: [], total: 28, names: ALL_28, sha: "5ec50b9" }, // the fix task lands, on a new head
      ],
      { logs: [{ name: "test", log: "coverage_diff_floor_passes_against_a_fully_covered_synthetic_lcov ... FAILED" }] }
    );
    const { store, runId } = await build(adapter, pool(), repoWithOrigin());

    expect(rerunAsked()).toBe(1);
    const fixes = ciFixTasks(store, runId);
    expect(fixes.map((t) => t.id)).toEqual(["ci-fix-1-1"]);
    expect(fixes[0]!.spec).toContain("coverage_diff_floor_passes_against_a_fully_covered_synthetic_lcov");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing", total: 28 });
  });

  it("judges a head pushed part-way through the wait on its own checks, not the last head's", async () => {
    // The hold is per commit. A push that moves the branch mid-wait — an
    // operator's own fix — can honestly carry fewer checks than the head
    // before it (a path-filtered workflow that does not run for it), and
    // holding the new head to the old head's list would wait for checks that
    // are never coming.
    const { adapter, rerunAsked } = fakeGitHub([
      { state: "pending", failing: [], total: 28, names: ALL_28, sha: HEAD },
      { state: "passing", failing: [], total: 17, names: OTHERS, sha: "5ec50b9" }, // a new head, with fewer checks
    ]);
    const { store, runId, logs } = await build(adapter, pool(), repoWithOrigin());

    expect(rerunAsked()).toBe(0);
    expect(logs.join("\n")).not.toMatch(/is missing/);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing", total: 17, sha: "5ec50b9" });
    expect(store.ciStatus(runId)!.names).toHaveLength(17);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("keeps the red verdict when the re-run comes back with no checks attached at all", async () => {
    // The other way the same minute goes wrong, and the one the `pending` fix
    // above does not cover. `awaitChecks` publishes `state: "none"` when the
    // head carries no check runs — and its own comment says why that is not a
    // pass: "'None' is not a pass — it is the absence of the only check that
    // judges the merge." A re-run answers by re-queueing jobs, and for the
    // moments before GitHub re-attaches them the head honestly has none. Read
    // as an answer, that discards the red exactly as the `pending` did.
    const { adapter, rerunAsked } = fakeGitHub(
      [
        { state: "failing", failing: ["test"], total: 20 }, // the wait's real answer
        { state: "none", failing: [], total: 0 }, // re-run went out; nothing re-attached yet
        null, // unreadable part-way through — the round ends on "none"
        null, // unreadable again, and this one ends the wait unsettled
        { state: "passing", failing: [], total: 20 }, // the fix task lands
      ],
      { logs: [{ name: "test", log: "FAIL: coverage 61.2% is under the 75% floor" }] }
    );
    const { store, runId } = await build(adapter, pool(), repoWithOrigin());

    expect(rerunAsked()).toBe(1);
    // Without the guard this is an empty list: "none" is not "failing", the
    // round returns early, and the red is gone with the fix rounds unspent.
    const fixes = ciFixTasks(store, runId);
    expect(fixes.map((t) => t.id)).toEqual(["ci-fix-1-1"]);
    expect(fixes[0]!.spec).toContain("under the 75% floor");
  });
});

describe("a red check that survives its re-run", () => {
  it("queues a fix task per failing check, carrying the job's own log", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub(
      [
        { state: "failing", failing: ["Backend test", "Frontend lint"], total: 3 },
        { state: "failing", failing: ["Backend test", "Frontend lint"], total: 3 },
        { state: "passing", failing: [], total: 3 },
      ],
      { logs: [{ name: "Backend test", log: "FAIL: TestThing — want 2, got 3" }] }
    );
    // A pit stop handler that must NOT be consulted about CI: the rounds are
    // not spent, so the failure is still the run's own work. (The run's
    // ordinary epic-boundary stops still open; they answer "continue".)
    const { store, runId } = await build(adapter, pool(), repo, {}, async (stop) => {
      if ((stop as { reason: string }).reason.includes("CI is red")) throw new Error("the pit stop opened while fix rounds remained");
      return { action: "continue", feedback: "" };
    });

    const fixes = ciFixTasks(store, runId);
    expect(fixes.map((t) => t.id)).toEqual(["ci-fix-1-1", "ci-fix-1-2"]);
    expect(fixes.every((t) => t.state === "MERGED")).toBe(true);
    // The first task carries its job's log; the second had none to carry.
    expect(fixes[0]!.spec).toContain("want 2, got 3");
    expect(fixes[1]!.spec).toContain("No log could be fetched");
    // Chained, so two fixes to one cause cannot conflict.
    expect(fixes[1]!.dependsOn).toEqual(["ci-fix-1-1"]);
    // One retry, not one per task.
    expect(store.eventCount(runId, "run.ci_retry")).toBe(1);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
  });

  it("proceeds on the failure as it stands when nothing could be re-run", async () => {
    // Commit statuses from an external CI have no jobs to re-run. The `false`
    // is an answer, not an error: diagnose what is on the record.
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub(
      [
        { state: "failing", failing: ["external-ci"], total: 1 },
        { state: "passing", failing: [], total: 1 },
      ],
      { rerun: false }
    );
    const { store, runId } = await build(adapter, pool(), repo);

    expect(rerunAsked()).toBe(1);
    expect(ciFixTasks(store, runId)).toHaveLength(1);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("copes with an adapter that reports checks but can neither re-run nor fetch logs", async () => {
    // The adapter contract makes both optional: a CI reachable only through
    // commit statuses answers "what failed" but offers no job to re-run and no
    // log to read. The loop still turns — no retry, a fix task whose spec says
    // the log could not be fetched.
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([
      { state: "failing", failing: ["Backend test"], total: 1 },
      { state: "passing", failing: [], total: 1 },
    ]);
    delete (adapter as unknown as Record<string, unknown>).rerunFailedChecks;
    delete (adapter as unknown as Record<string, unknown>).failingJobLogs;
    const { store, runId } = await build(adapter, pool(), repo);

    expect(ciFixTasks(store, runId)).toHaveLength(1);
    expect(ciFixTasks(store, runId)[0]!.spec).toContain("No log could be fetched");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
  });

  it("caps a matrix of failures at ten tasks and names what it dropped", async () => {
    const names = Array.from({ length: 11 }, (_, i) => `shard-${i}`);
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([
      { state: "failing", failing: names, total: 11 },
      { state: "failing", failing: names, total: 11 },
      { state: "passing", failing: [], total: 11 },
    ]);
    const { store, runId, logs } = await build(adapter, pool(), repo);

    expect(ciFixTasks(store, runId)).toHaveLength(10);
    expect(logs.join("\n")).toMatch(/Not queued, and yours to judge: shard-10/);
  });
});

describe("a failure that outlives its rounds", () => {
  it("holds rather than reporting, when nobody is there to grant more rounds", async () => {
    const repo = repoWithOrigin();
    // Sticky failing: no fix round ever helps.
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId, controller, logs } = await build(adapter, pool(), repo);

    const rounds = new Set(ciFixTasks(store, runId).map((t) => /^ci-fix-(\d+)-/.exec(t.id)![1]));
    expect(rounds.size).toBe(2);
    // Not PR_REVIEW: a run does not report itself in review over a branch the
    // repo has rejected. Paused, with the reason where `resume` reads it.
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toMatch(/^green hold: CI is red on #7/);
    expect(store.ciStatus(runId)).toMatchObject({ state: "failing" });
    expect(controller.outcome(runId).line).toContain("CI red (Backend test)");
    expect(logs.join("\n")).toMatch(/no pit stop can grant more here, so the run is pausing. `harness resume` grants another 2/);
  });

  it("stops treating it as its own work and leaves the verdict on the record, with the hold off", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId, controller } = await build(adapter, pool(), repo, NO_HOLD);

    const rounds = new Set(ciFixTasks(store, runId).map((t) => /^ci-fix-(\d+)-/.exec(t.id)![1]));
    expect(rounds.size).toBe(2);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "failing" });
    expect(controller.outcome(runId).line).toContain("CI red (Backend test)");
    // The red branch is work a resume can pick up, not a report to file.
    expect(controller.hasRecoverableWork(runId)).toBe(true);
  });

  it("re-asks on resume with the hold off, and reports again when the rounds are still spent", async () => {
    // The pre-hold resume shape, kept: no pit stop, no grant — the escalation
    // was shown on the way in, and a resume with nothing left to spend reports.
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId, controller } = await build(adapter, pool(), repo, NO_HOLD);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    await controller.resume(runId);

    expect(new Set(ciFixTasks(store, runId).map((t) => /^ci-fix-(\d+)-/.exec(t.id)![1])).size).toBe(2);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.eventCount(runId, "run.ci_rounds_granted")).toBe(0);
  });

  it("keeps the old behaviour when the fix loop is switched off, with the hold off", async () => {
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 0, ...NO_HOLD }, async (stop) => {
      if ((stop as { reason: string }).reason.includes("CI is red")) throw new Error("the pit stop opened with the loop switched off");
      return { action: "continue", feedback: "" };
    });

    expect(rerunAsked()).toBe(0);
    expect(store.eventCount(runId, "run.ci_retry")).toBe(0);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("pauses with the fix loop switched off and the hold on, saying which knob to turn", async () => {
    // `ciFixRounds: 0` means "never fix CI yourself"; the hold means "never
    // report red". Together they can only wait for a person, and say so.
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId, logs } = await build(adapter, pool(), repo, { ciFixRounds: 0 }, async (stop) => {
      if ((stop as { reason: string }).reason.includes("CI is red")) throw new Error("the pit stop opened with the loop switched off");
      return { action: "continue", feedback: "" };
    });

    expect(rerunAsked()).toBe(0);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(logs.join("\n")).toMatch(/`ciFixRounds` is 0, so the run will not fix it itself/);
  });

  it("asks nobody when checks are off entirely", async () => {
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId, controller } = await build(adapter, pool(), repo, { waitForChecks: false });

    expect(rerunAsked()).toBe(0);
    expect(store.ciStatus(runId)).toBeNull();
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    // And a resume of that run has no status to recheck.
    await controller.resume(runId);
    expect(store.ciStatus(runId)).toBeNull();
  });
});

describe("the pit stop at the end of the rounds", () => {
  /**
   * Answers the run's ordinary epic-boundary stops with "continue" and counts
   * only the CI escalation — the stop this block is about.
   */
  const spent = (decide: (n: number) => PitStopDecision) => {
    let asked = 0;
    const resolve = async (stop: unknown): Promise<PitStopDecision> => {
      if (!(stop as { reason: string }).reason.includes("CI is red")) return { action: "continue", feedback: "" };
      return decide(++asked);
    };
    return { resolve, asked: () => asked };
  };

  it("parks the run when the operator says stop", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent(() => ({ action: "stop", feedback: "" }));
    const { store, runId, logs } = await build(adapter, pool(), repo, { ciFixRounds: 1 }, stop.resolve);

    expect(stop.asked()).toBe(1);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(logs.join("\n")).toMatch(/CI is still red after 1 fix round\(s\): Backend test/);
  });

  it("grants another block of rounds when they say continue, and asks again when those are spent too", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent((n) => (n === 1 ? { action: "continue", feedback: "" } : { action: "stop", feedback: "" }));
    const { store, runId, logs } = await build(adapter, pool(), repo, { ciFixRounds: 1 }, stop.resolve);

    expect(stop.asked()).toBe(2);
    // One round configured, one granted: two rounds of fix tasks on the record.
    expect(new Set(ciFixTasks(store, runId).map((t) => /^ci-fix-(\d+)-/.exec(t.id)![1])).size).toBe(2);
    const grants = store.eventsSince(runId, 0, 10_000).map((r) => r.event).filter((e) => e.type === "run.ci_rounds_granted");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ prNumber: 7, rounds: 2, by: "pitstop" });
    expect(logs.join("\n")).toMatch(/"continue" grants another 1 round\(s\)/);
    expect(logs.join("\n")).toMatch(/round 2 of 2/);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.ciStatus(runId)).toMatchObject({ state: "failing" });
  });

  it("proceeds with the red verdict on the record when they say continue, with the hold off", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent(() => ({ action: "continue", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 1, ...NO_HOLD }, stop.resolve);

    expect(stop.asked()).toBe(1);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "failing" });
    expect(store.eventCount(runId, "run.ci_rounds_granted")).toBe(0);
  });

  it("sends the run back to work on a redirect, and asks again when it comes back red", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent((n) => (n === 1 ? { action: "redirect", feedback: "look at the runner" } : n === 2 ? { action: "continue", feedback: "" } : { action: "stop", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 1 }, stop.resolve);

    // Asked three times: once redirected, once — the failure still standing
    // on the fresh status the next pass published — granted a round, and once
    // that round was spent too, answered for good.
    expect(stop.asked()).toBe(3);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
  });

  it("sends the run back to work on a redirect, with the hold off", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent((n) => (n === 1 ? { action: "redirect", feedback: "look at the runner" } : { action: "continue", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 1, ...NO_HOLD }, stop.resolve);

    expect(stop.asked()).toBe(2);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("has nothing to ask about a run whose repo never reported at all, and pauses on not knowing", async () => {
    const repo = repoWithOrigin();
    const adapter = {
      enabled: true,
      async ensureIssue() {
        return null;
      },
      async ensurePR() {
        return { number: 7, url: "https://example.test/pull/7", fresh: true };
      },
      async markPrReady() {
        return true;
      },
    } as unknown as GitHubAdapter;
    const stop = spent(() => ({ action: "stop", feedback: "" }));
    const { store, runId, logs } = await build(adapter, pool(), repo, {}, stop.resolve, (c) => {
      c.githubRetryMs = 1;
    });

    expect(stop.asked()).toBe(0);
    expect(store.ciStatus(runId)).toBeNull();
    // Asked three times, then paused: not knowing is not green.
    expect(logs.filter((t) => /GitHub could not be read while waiting on CI for #7 — asking again/.test(t))).toHaveLength(2);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("green hold: GitHub could not be read while waiting on CI for #7");
  });

  it("has nothing to ask about a run whose repo never reported at all, with the hold off", async () => {
    const repo = repoWithOrigin();
    const adapter = {
      enabled: true,
      async ensureIssue() {
        return null;
      },
      async ensurePR() {
        return { number: 7, url: "https://example.test/pull/7", fresh: true };
      },
      async markPrReady() {
        return true;
      },
    } as unknown as GitHubAdapter;
    const stop = spent(() => ({ action: "stop", feedback: "" }));
    const { store, runId, controller } = await build(adapter, pool(), repo, NO_HOLD, stop.resolve);

    expect(stop.asked()).toBe(0);
    expect(store.ciStatus(runId)).toBeNull();
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    // And a resume finds no status to re-ask about: with the hold off there is
    // nothing to hold, so it hands the run straight back to review rather than
    // re-entering integration over a repo that never answered.
    await controller.resume(runId);
    expect(store.ciStatus(runId)).toBeNull();
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("never opens with the loop switched off, even red and spent — and pauses instead", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent(() => ({ action: "stop", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 0, pitStop: { every: "never" } }, stop.resolve);

    expect(stop.asked()).toBe(0);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
  });

  it("never opens with the loop switched off, with the hold off", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent(() => ({ action: "stop", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 0, pitStop: { every: "never" }, ...NO_HOLD }, stop.resolve);

    expect(stop.asked()).toBe(0);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });
});

describe("a resume onto a branch whose CI moved while the run was parked", () => {
  it("re-asks, and spends the fix rounds it never used — but not a second retry", async () => {
    const repo = repoWithOrigin();
    // The run itself went green on the flake retry, so no round was spent.
    const { adapter, rerunAsked } = fakeGitHub([
      { state: "failing", failing: ["Backend test"], total: 1 },
      { state: "passing", failing: [], total: 1 },
    ]);
    const { store, bus, runId, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(rerunAsked()).toBe(1);

    // The world moves: a nightly re-run flips the same head red.
    bus.publish({ type: "run.ci_status", runId, prNumber: 7, state: "failing", failing: ["Backend test"], total: 1, ts: Date.now() } as never);
    // What GitHub will answer from here on: red until the fix lands. The
    // resume asks once to refresh the record before deciding, then waits.
    (adapter as unknown as { prChecks: () => Promise<Checks> }).prChecks = (() => {
      const reads: Checks[] = [
        { state: "failing", failing: ["Backend test"], total: 1 },
        { state: "failing", failing: ["Backend test"], total: 1 },
        { state: "passing", failing: [], total: 1 },
      ];
      return () => Promise.resolve(reads.length > 1 ? reads.shift()! : reads[0]!);
    })();

    await controller.resume(runId);

    // The retry was already spent on this round's flake; the resume queues the
    // fix directly rather than gambling on a second one.
    expect(rerunAsked()).toBe(1);
    expect(ciFixTasks(store, runId)).toHaveLength(1);
    expect(ciFixTasks(store, runId)[0]!.state).toBe("MERGED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
  });

  it("asks again on a red prior status and stands down when the world already fixed it", async () => {
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub([{ state: "passing", failing: [], total: 1 }]);
    const { store, bus, runId, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    // A nightly re-run flips the head red while the run is parked...
    bus.publish({ type: "run.ci_status", runId, prNumber: 7, state: "failing", failing: ["Backend test"], total: 1, ts: Date.now() } as never);
    expect(controller.hasRecoverableWork(runId)).toBe(true);
    // ...and a human re-runs it green again before the resume lands: the
    // sticky script answers "passing" to the recheck.

    await controller.resume(runId);

    expect(rerunAsked()).toBe(0);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("treats a run that stopped waiting mid-CI as unfinished, and resumes into the answer", async () => {
    const repo = repoWithOrigin();
    const { adapter, rerunAsked, setChecks } = fakeGitHub([{ state: "passing", failing: [], total: 1 }]);
    const { store, bus, runId, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    // The process died mid-wait: the last thing on the record is "pending",
    // which is not an answer — the run never learned what the repo said.
    bus.publish({ type: "run.ci_status", runId, prNumber: 7, state: "pending", failing: [], total: 12, ts: Date.now() } as never);
    expect(controller.hasRecoverableWork(runId)).toBe(true);
    // CI is still running when the resume asks, and settles during the wait.
    setChecks([{ state: "pending", failing: [], total: 12 }, { state: "passing", failing: [], total: 12 }]);

    await controller.resume(runId);

    expect(rerunAsked()).toBe(0);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    // The recheck itself must be visible while it runs: PR_REVIEW is the one
    // working moment the dashboard's listOpenRuns cannot see, so the resume
    // wears INTEGRATING for the wait and hands PR_REVIEW back afterwards.
    // Without this, `harness resume` against run 5743ce85 showed a dashboard
    // that said "no active runs" while twelve checks were being re-asked.
    const states = store
      .eventsSince(runId, 0, 10_000)
      .map((r) => r.event)
      .filter((e): e is Extract<typeof e, { type: "run.state_changed" }> => e.type === "run.state_changed")
      .map((e) => `${e.from}->${e.to}`);
    expect(states.slice(-2)).toEqual(["PR_REVIEW->INTEGRATING", "INTEGRATING->PR_REVIEW"]);
  });

  it("leaves a green run alone", async () => {
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub([{ state: "passing", failing: [], total: 1 }]);
    const { store, runId, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    await controller.resume(runId);

    expect(rerunAsked()).toBe(0);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });
});

describe("the run that reports whatever the repo said, with the hold off", () => {
  /** Answers only the CI escalation, counting how often it was asked. */
  const spentStop = () => {
    let asked = 0;
    const resolve = async (stop: unknown): Promise<PitStopDecision> => {
      if (!/CI is red/.test((stop as { reason: string }).reason)) return { action: "continue", feedback: "" };
      asked++;
      return { action: "stop", feedback: "" };
    };
    return { resolve, asked: () => asked };
  };

  it("parks the run when the operator says stop, and does not blame the hold for it", async () => {
    // The same stop, without the hold: the run was stopped at a pit stop, and
    // the reason says exactly that rather than naming a gate that is switched
    // off. `harness resume` must not read it back as a grant.
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spentStop();
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 1, ...NO_HOLD }, stop.resolve);

    expect(stop.asked()).toBe(1);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("the run was stopped at a pit stop");
    expect(store.eventCount(runId, "run.ci_rounds_granted")).toBe(0);
  });

  it("stands down on resume when the world fixed the red branch, without confirming the merge again", async () => {
    // The pre-hold resume path: the recheck re-asks, the fresh answer is green,
    // and the run goes straight back to review. With the hold on this same run
    // would go on to confirm the pull request still merges.
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "passing", failing: [], total: 1 }]);
    const { store, bus, runId, controller } = await build(adapter, pool(), repo, NO_HOLD);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    bus.publish({ type: "run.ci_status", runId, prNumber: 7, state: "failing", failing: ["Backend test"], total: 1, ts: Date.now() } as never);
    await controller.resume(runId);

    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });
});

describe("a branch that went red after the run stood down", () => {
  it("asks GitHub again before trusting the pass on the record, and turns the red into work", async () => {
    // What the operator found on #527: the run in PR_REVIEW with "CI green"
    // on the record, `test` red on GitHub, and `harness resume` answering that
    // there was nothing to resume — because the only thing anyone consulted
    // was the record. The record is a snapshot; the pull request is live.
    const repo = repoWithOrigin();
    const THREE = ["build", "test", "lint"];
    const { adapter, rerunAsked, setChecks } = fakeGitHub([{ state: "passing", failing: [], total: 3, names: THREE, sha: HEAD }], {
      logs: [{ name: "test", log: "fatal: bad object a7fdc9ab177d58ad411309cc93551a2ff2108ef2" }],
    });
    const { store, runId, logs, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(controller.hasRecoverableWork(runId)).toBe(false);

    // The head is re-run by hand, or by a nightly, and fails.
    const RED: Checks = { state: "failing", failing: ["test"], total: 3, names: THREE, sha: HEAD };
    setChecks([RED, RED, RED, RED, { state: "passing", failing: [], total: 3, names: THREE, sha: "5ec50b9" }]);

    await controller.refreshCiStatus(runId);

    expect(store.ciStatus(runId)).toMatchObject({ state: "failing", failing: ["test"] });
    expect(logs.join("\n")).toMatch(/asked GitHub about #7 again: CI is failing on test over 3 check\(s\), where the record said passing/);
    expect(controller.hasRecoverableWork(runId)).toBe(true);

    await controller.resume(runId);

    expect(rerunAsked()).toBe(1);
    const fixes = ciFixTasks(store, runId);
    expect(fixes.map((t) => t.id)).toEqual(["ci-fix-1-1"]);
    expect(fixes[0]!.spec).toContain("bad object a7fdc9ab");
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("holds the fresh reading to the checks the record saw on the same commit, so a resume inside a re-run's gap waits rather than believing it", async () => {
    // The same three seconds as the re-run tests above, met by `harness
    // resume` instead of by the wait: the operator re-runs `test` by hand and
    // resumes at once. The one reading the refresh takes is the short one, and
    // read as a pass it would say "nothing to resume" over a job that is about
    // to fail again. On the record as pending, with the whole list, the resume
    // enters the wait and the wait is held to the list.
    const repo = repoWithOrigin();
    const { adapter, rerunAsked, setChecks } = fakeGitHub([{ state: "passing", failing: [], total: 28, names: ALL_28, sha: HEAD }]);
    const { store, runId, logs, controller } = await build(adapter, pool(), repo);
    expect(controller.hasRecoverableWork(runId)).toBe(false);

    setChecks([
      { state: "passing", failing: [], total: 17, names: OTHERS, sha: HEAD }, // the refresh's reading
      { state: "passing", failing: [], total: 17, names: OTHERS, sha: HEAD }, // the resume's own refresh
      { state: "passing", failing: [], total: 27, names: ALL_28.filter((n) => n !== "test"), sha: HEAD }, // only `test` still absent
      { state: "failing", failing: ["test"], total: 28, names: ALL_28, sha: HEAD }, // the wait's first whole reading
      { state: "failing", failing: ["test"], total: 28, names: ALL_28, sha: HEAD }, // and after the flake re-run
      { state: "passing", failing: [], total: 28, names: ALL_28, sha: "5ec50b9" }, // the fix task lands
    ]);
    await controller.refreshCiStatus(runId);

    expect(store.ciStatus(runId)).toMatchObject({ state: "pending", total: 17, sha: HEAD });
    expect(store.ciStatus(runId)!.names).toHaveLength(28);
    expect(controller.hasRecoverableWork(runId)).toBe(true);

    await controller.resume(runId);

    // The wait was held to the record's list: 27 with `test` absent is not 28.
    expect(logs.join("\n")).toMatch(/GitHub's answer for #7 is missing 1 check\(s\) this head carried \(test\) — a re-run is re-attaching them, and the 27 left are not a verdict/);
    expect(rerunAsked()).toBe(1);
    expect(ciFixTasks(store, runId).map((t) => t.id)).toEqual(["ci-fix-1-1"]);
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing", total: 28 });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("asks about a run that never waited for CI, once the wait is switched on for its resume", async () => {
    // `harness resume` patches `waitForChecks` from the config file before
    // resuming, which is how a run recorded with the wait off comes to be
    // asked: it is in review, its pull request is open, and nothing is on the
    // record at all.
    const repo = repoWithOrigin();
    const { adapter, setChecks } = fakeGitHub([{ state: "passing", failing: [], total: 3, names: ["build", "test", "lint"], sha: HEAD }]);
    const { store, runId, logs, controller } = await build(adapter, pool(), repo, { waitForChecks: false });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toBeNull();

    await controller.refreshCiStatus(runId);
    expect(store.ciStatus(runId)).toBeNull();

    store.patchRunConfig(runId, { waitForChecks: true });
    setChecks([{ state: "failing", failing: ["test"], total: 3, names: ["build", "test", "lint"], sha: HEAD }]);
    await controller.refreshCiStatus(runId);

    expect(store.ciStatus(runId)).toMatchObject({ state: "failing", failing: ["test"] });
    expect(logs.join("\n")).toMatch(/where the record said nothing/);
    expect(controller.hasRecoverableWork(runId)).toBe(true);
  });

  it("leaves the record alone when GitHub cannot be read, and writes nothing when the answer has not changed", async () => {
    const repo = repoWithOrigin();
    const { adapter, setChecks } = fakeGitHub([{ state: "passing", failing: [], total: 3 }]);
    const { store, runId, controller } = await build(adapter, pool(), repo);
    const before = store.eventCount(runId, "run.ci_status");

    setChecks([null]);
    await controller.refreshCiStatus(runId);
    expect(store.eventCount(runId, "run.ci_status")).toBe(before);

    setChecks([{ state: "passing", failing: [], total: 3 }]);
    await controller.refreshCiStatus(runId);
    expect(store.eventCount(runId, "run.ci_status")).toBe(before);
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });

  it("leaves a pull request a human has already merged alone, however red its head went", async () => {
    // Nothing left to hold: the merge is the operator's, and a red on a merged
    // head is theirs to read, not work for a run that has handed over.
    const repo = repoWithOrigin();
    const { adapter, setChecks } = fakeGitHub([{ state: "passing", failing: [], total: 3 }], { prState: "merged" });
    const { store, runId, controller } = await build(adapter, pool(), repo);

    setChecks([{ state: "failing", failing: ["test"], total: 3 }]);
    await controller.refreshCiStatus(runId);

    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });

  it("has nothing to ask about a run that merged nothing, or one that is not in review", async () => {
    const repo = repoWithOrigin();
    const { adapter, setChecks } = fakeGitHub([{ state: "failing", failing: ["test"], total: 3 }]);
    const { store, runId, controller } = await build(adapter, pool({ qaFails: true }), repo);
    // Nothing merged: the closing gate holds it rather than calling it in review.
    expect(store.getRun(runId)!.state).toBe("BLOCKED");
    expect(store.ciStatus(runId)).toBeNull();

    setChecks([{ state: "failing", failing: ["test"], total: 3 }]);
    await controller.refreshCiStatus(runId);
    await controller.refreshCiStatus("no-such-run");

    expect(store.ciStatus(runId)).toBeNull();
  });
});

describe("a run that stopped waiting mid-CI, with the hold off", () => {
  it("treats the pending it left behind as unfinished and resumes into the answer", async () => {
    // Pending is not an answer, and that was true before the hold existed: the
    // process died mid-wait, so the run never learned what the repo said. The
    // resume re-asks whether or not the hold is on.
    const repo = repoWithOrigin();
    const { adapter, rerunAsked, setChecks } = fakeGitHub([{ state: "passing", failing: [], total: 1 }]);
    const { store, bus, runId, controller } = await build(adapter, pool(), repo, NO_HOLD);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    bus.publish({ type: "run.ci_status", runId, prNumber: 7, state: "pending", failing: [], total: 12, ts: Date.now() } as never);
    expect(controller.hasRecoverableWork(runId)).toBe(true);
    // Still running when the resume asks; settles during the wait.
    setChecks([{ state: "pending", failing: [], total: 12 }, { state: "passing", failing: [], total: 12 }]);

    await controller.resume(runId);

    expect(rerunAsked()).toBe(0);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });
});
