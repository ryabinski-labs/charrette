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

type Checks = { state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null;

/**
 * A GitHub whose CI answers from a script, one entry per read, last entry
 * sticky — so "failing, then passing after the fix round" is a two-line story.
 */
function fakeGitHub(script: Checks[], opts: { rerun?: boolean; logs?: { name: string; log: string }[] } = {}) {
  const reads: Checks[] = [...script];
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
  };
  return { adapter: adapter as unknown as GitHubAdapter, rerunAsked: () => rerunAsked };
}

/** Plans one task, passes QA, validator says PASS; every worker commit is unique. */
function pool(): AgentPool {
  const outputs = [DOCS, DAG, "worker done"];
  let i = 0;
  let files = 0;
  const impl = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "qa") return { sessionId: "sq", resultText: '{"verdict":"PASS","notes":"good","unverified":[]}', costUsd: 0, turns: 1, outcome: "done" };
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
  resolvePitStop?: (stop: unknown) => Promise<PitStopDecision>
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
  const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], checkTimeoutMinutes: 1, deployTimeoutMinutes: 1, ...over }));
  return { store, bus, runId, logs, controller };
}

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
  it("stops treating it as its own work and leaves the verdict on the record", async () => {
    const repo = repoWithOrigin();
    // Sticky failing: no fix round ever helps.
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId, controller } = await build(adapter, pool(), repo);

    const rounds = new Set(ciFixTasks(store, runId).map((t) => /^ci-fix-(\d+)-/.exec(t.id)![1]));
    expect(rounds.size).toBe(2);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "failing" });
    expect(controller.outcome(runId).line).toContain("CI red (Backend test)");
    // The red branch is work a resume can pick up, not a report to file.
    expect(controller.hasRecoverableWork(runId)).toBe(true);
  });

  it("keeps the old behaviour when the fix loop is switched off", async () => {
    const repo = repoWithOrigin();
    const { adapter, rerunAsked } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 0 }, async (stop) => {
      if ((stop as { reason: string }).reason.includes("CI is red")) throw new Error("the pit stop opened with the loop switched off");
      return { action: "continue", feedback: "" };
    });

    expect(rerunAsked()).toBe(0);
    expect(store.eventCount(runId, "run.ci_retry")).toBe(0);
    expect(ciFixTasks(store, runId)).toHaveLength(0);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
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

  it("proceeds with the red verdict on the record when they say continue", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent(() => ({ action: "continue", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 1 }, stop.resolve);

    expect(stop.asked()).toBe(1);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.ciStatus(runId)).toMatchObject({ state: "failing" });
  });

  it("sends the run back to work on a redirect, and asks again when it comes back red", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent((n) => (n === 1 ? { action: "redirect", feedback: "look at the runner" } : { action: "continue", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 1 }, stop.resolve);

    // Asked twice: once redirected, once — the failure still standing on the
    // fresh status the next pass published — answered for good.
    expect(stop.asked()).toBe(2);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("has nothing to ask about a run whose repo never reported at all", async () => {
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
    const { store, runId } = await build(adapter, pool(), repo, {}, stop.resolve);

    expect(stop.asked()).toBe(0);
    expect(store.ciStatus(runId)).toBeNull();
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });

  it("never opens with the loop switched off, even red and spent", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub([{ state: "failing", failing: ["Backend test"], total: 1 }]);
    const stop = spent(() => ({ action: "stop", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, { ciFixRounds: 0, pitStop: { every: "never" } }, stop.resolve);

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
    // What GitHub will answer from here on: red until the fix lands.
    (adapter as unknown as { prChecks: () => Promise<Checks> }).prChecks = (() => {
      const reads: Checks[] = [
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
    const { adapter, rerunAsked } = fakeGitHub([{ state: "passing", failing: [], total: 1 }]);
    const { store, bus, runId, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    // The process died mid-wait: the last thing on the record is "pending",
    // which is not an answer — the run never learned what the repo said.
    bus.publish({ type: "run.ci_status", runId, prNumber: 7, state: "pending", failing: [], total: 12, ts: Date.now() } as never);
    expect(controller.hasRecoverableWork(runId)).toBe(true);

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
