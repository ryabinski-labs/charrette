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
 * The green hold: a run does not report itself in review over a branch that
 * is red, unchecked, unread, conflicting or behind its base.
 *
 * ciGate.test.ts covers the red half — fix rounds, the re-run, the pit stop
 * that grants more. This file is the rest of "green and mergeable": what the
 * hold does with a repository that has no CI, a GitHub that will not answer, a
 * pull request the base moved out from under, and a resume of a run the hold
 * paused. Every test here ends in one of exactly two places — PR_REVIEW with
 * the branch green and mergeable, or PAUSED with a `green hold:` reason on the
 * record — because those are the only two ways out.
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
  const origin = mkdtempSync(path.join(tmpdir(), "harness-hold-origin-"));
  gitIn(origin, "init", "--bare", "-b", "release");
  const repo = mkdtempSync(path.join(tmpdir(), "harness-hold-"));
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
type Merge = { state: "mergeable" | "conflicting" | "behind" | "unknown"; mergeStateStatus: string } | null;

const GREEN: Checks = { state: "passing", failing: [], total: 1 };
const RED: Checks = { state: "failing", failing: ["Backend test"], total: 1 };
const NONE: Checks = { state: "none", failing: [], total: 0 };
const MERGES: Merge = { state: "mergeable", mergeStateStatus: "clean" };
const BEHIND: Merge = { state: "behind", mergeStateStatus: "behind" };
const CONFLICTS: Merge = { state: "conflicting", mergeStateStatus: "dirty" };
const UNSETTLED: Merge = { state: "unknown", mergeStateStatus: "unknown" };

/**
 * A GitHub whose answers come from scripts, one entry per read, last entry
 * sticky. `prs()` counts every publish, which is how many times the hold
 * reconciled and re-pushed the branch.
 */
function fakeGitHub(opts: { checks?: Checks[]; merge?: Merge[]; prState?: "open" | "merged" | "closed" } = {}) {
  let checks: Checks[] = [...(opts.checks ?? [GREEN])];
  let merge: Merge[] = [...(opts.merge ?? [MERGES])];
  let prs = 0;
  const adapter = {
    enabled: true,
    async ensureIssue() {
      return null;
    },
    async ensurePR() {
      prs++;
      return { number: 7, url: "https://example.test/pull/7", fresh: prs === 1 };
    },
    async markPrReady() {
      return true;
    },
    async prChecks(): Promise<Checks> {
      return checks.length > 1 ? checks.shift()! : checks[0]!;
    },
    async prMergeable(): Promise<Merge> {
      return merge.length > 1 ? merge.shift()! : merge[0]!;
    },
    async rerunFailedChecks() {
      return true;
    },
    async failingJobLogs() {
      return [];
    },
    ...(opts.prState ? { async prState() { return opts.prState; } } : {}),
  };
  return {
    adapter: adapter as unknown as GitHubAdapter,
    prs: () => prs,
    setChecks: (script: Checks[]) => void (checks = [...script]),
    setMerge: (script: Merge[]) => void (merge = [...script]),
  };
}

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
  // Every read GitHub refuses is retried a few times first; a millisecond is
  // enough to prove the retry happened without paying for the wait.
  controller.githubRetryMs = 1;
  tune?.(controller);
  const runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], checkTimeoutMinutes: 1, deployTimeoutMinutes: 1, ...over }));
  return { store, bus, runId, logs, controller };
}

const events = (store: Store, runId: string) => store.eventsSince(runId, 0, 10_000).map((r) => r.event);
const mergeStates = (store: Store, runId: string) =>
  events(store, runId)
    .filter((e): e is Extract<typeof e, { type: "run.merge_status" }> => e.type === "run.merge_status")
    .map((e) => e.state);
const transitions = (store: Store, runId: string) =>
  events(store, runId)
    .filter((e): e is Extract<typeof e, { type: "run.state_changed" }> => e.type === "run.state_changed")
    .map((e) => `${e.from}->${e.to}`);
const ciRounds = (store: Store, runId: string) => new Set(store.listTasks(runId).map((t) => /^ci-fix-(\d+)-/.exec(t.id)?.[1]).filter(Boolean)).size;

/** Answers every ordinary pit stop with "continue" and hands the hold's own to `decide`. */
function holdStops(match: RegExp, decide: (n: number) => PitStopDecision) {
  let asked = 0;
  const resolve = async (stop: unknown): Promise<PitStopDecision> => {
    if (!match.test((stop as { reason: string }).reason)) return { action: "continue", feedback: "" };
    return decide(++asked);
  };
  return { resolve, asked: () => asked };
}

describe("a red branch whose rounds are spent", () => {
  it("pauses, and a resume is the grant it was waiting for", async () => {
    const repo = repoWithOrigin();
    const { adapter, setChecks } = fakeGitHub({ checks: [RED] });
    const { store, runId, controller } = await build(adapter, pool(), repo);

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(ciRounds(store, runId)).toBe(2);
    expect(store.lastRunStateChange(runId)!.reason).toMatch(/^green hold: CI is red on #7/);

    // The operator resumes. Red on the re-ask, red again after the granted
    // round's flake re-run, and green once the third round's fix lands.
    setChecks([RED, RED, RED, GREEN]);
    await controller.resume(runId);

    const grants = events(store, runId).filter((e) => e.type === "run.ci_rounds_granted");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ prNumber: 7, rounds: 4, by: "resume" });
    expect(ciRounds(store, runId)).toBe(3);
    expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable" });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });
});

describe("a repository with no CI", () => {
  it("pauses rather than reporting a branch nothing has checked, and a resume publishes it anyway", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub({ checks: [NONE] });
    const { store, runId, controller, logs } = await build(adapter, pool(), repo);

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("green hold: #7 has no CI, so nothing has checked the merged branch");
    expect(logs.join("\n")).toMatch(/add a workflow, or `harness resume` to publish it anyway/);

    await controller.resume(runId);

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(logs.join("\n")).toMatch(/publishing it as the resume asked/);
    // Released, not passed: the headline still says nothing checked it.
    expect(controller.outcome(runId).line).toContain("NO CI");
  }, 120_000);

  it("lets the pit stop send the run back to add one, and then release it", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub({ checks: [NONE] });
    const stop = holdStops(/has no CI/, (n) => (n === 1 ? { action: "redirect", feedback: "add a workflow" } : { action: "continue", feedback: "" }));
    const { store, runId, logs } = await build(adapter, pool(), repo, {}, stop.resolve);

    expect(stop.asked()).toBe(2);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(logs.join("\n")).toMatch(/the pit stop released it anyway/);
  }, 120_000);

  it("lets the pit stop stop the run", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub({ checks: [NONE] });
    const stop = holdStops(/has no CI/, () => ({ action: "stop", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, {}, stop.resolve);

    expect(stop.asked()).toBe(1);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toMatch(/^green hold: #7 has no CI/);
  }, 120_000);
});

describe("a pull request the base moved out from under", () => {
  it("brings the branch up to date and asks again, rather than reporting a merge button GitHub will refuse", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ merge: [BEHIND, MERGES] });
    const { store, runId, logs, controller } = await build(adapter, pool(), repo);

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    // Published, found behind, reconciled and published again.
    expect(prs()).toBe(2);
    const states = mergeStates(store, runId);
    expect(states).toContain("behind");
    expect(states[states.length - 1]).toBe("mergeable");
    expect(logs.join("\n")).toMatch(/#7 is behind release: no conflict, but the base moved after the push/);
    expect(logs.join("\n")).toMatch(/#7 is behind against release — reconciling the branch with the base again and re-pushing \(attempt 1 of 2\)/);
    expect(controller.outcome(runId).line).not.toContain("BEHIND");
  });

  it("pauses when it stays behind after the reconciles, and the outcome line says so", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ merge: [BEHIND] });
    const { store, runId, controller } = await build(adapter, pool(), repo);

    expect(prs()).toBe(3);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("green hold: #7 is behind against release and the run may not report in review until it merges");
    expect(controller.outcome(runId).line).toContain("BEHIND release");
  });

  it("is reconciled on a resume of a run already in review", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs, setMerge } = fakeGitHub();
    const { store, bus, runId, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");

    // The base moves while the run is parked in review.
    bus.publish({ type: "run.merge_status", runId, prNumber: 7, state: "behind", baseBranch: "release", conflicts: [], resolvedBy: "none", ts: Date.now() } as never);
    expect(controller.hasRecoverableWork(runId)).toBe(true);
    setMerge([BEHIND, MERGES]);

    await controller.resume(runId);

    expect(prs()).toBe(2);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable" });
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(transitions(store, runId).slice(-2)).toEqual(["PR_REVIEW->INTEGRATING", "INTEGRATING->PR_REVIEW"]);
  });
});

describe("a pull request that will not merge", () => {
  it("reconciles twice, then pauses when nobody can be asked — and a resume tries twice more", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ merge: [CONFLICTS] });
    const { store, runId, controller, logs } = await build(adapter, pool(), repo);

    expect(prs()).toBe(3);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("green hold: #7 is conflicting against release and the run may not report in review until it merges");
    expect(logs.join("\n")).toMatch(/still conflicting after 2 reconcile\(s\) and the run may not report in review until it merges — pausing/);
    expect(controller.outcome(runId).line).toContain("CANNOT MERGE");

    await controller.resume(runId);

    // One publish on the way back in, two reconciles, the resume's grant of
    // two more, and the pause again.
    expect(prs()).toBe(8);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
  });

  it("asks the pit stop: continue tries again, stop pauses", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ merge: [CONFLICTS] });
    const stop = holdStops(/cannot be merged/, (n) => (n === 1 ? { action: "continue", feedback: "" } : { action: "stop", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, {}, stop.resolve);

    expect(stop.asked()).toBe(2);
    expect(prs()).toBe(5);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
  });

  it("asks the pit stop: a redirect sends the run back to work", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ merge: [CONFLICTS] });
    const stop = holdStops(/cannot be merged/, (n) => (n === 1 ? { action: "redirect", feedback: "look at the base" } : { action: "stop", feedback: "" }));
    const { store, runId } = await build(adapter, pool(), repo, {}, stop.resolve);

    expect(stop.asked()).toBe(2);
    expect(prs()).toBe(6);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(transitions(store, runId)).toContain("INTEGRATING->EXECUTING");
  });

  it("asks GitHub again without pushing when it has not settled, then pauses", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ merge: [UNSETTLED] });
    const { store, runId, logs } = await build(adapter, pool(), repo, {}, undefined, (c) => {
      c.mergeabilitySettleMinutes = 1 / 60;
    });

    expect(prs()).toBe(1);
    expect(logs.join("\n")).toMatch(/GitHub has not settled whether #7 merges into release — asking again \(attempt 1 of 2\)/);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("green hold: #7 is unknown against release and the run may not report in review until it merges");
  }, 120_000);

  it("asks GitHub again when it could not be read at all, then pauses", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ merge: [null] });
    const { store, runId, logs } = await build(adapter, pool(), repo);

    expect(prs()).toBe(1);
    expect(logs.filter((t) => /GitHub could not say whether #7 merges into release — asking again/.test(t))).toHaveLength(2);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toBe("green hold: GitHub could not say whether #7 merges into release");
  });
});

describe("what the hold leaves alone", () => {
  it("a pull request a human merged while the run was parked in review", async () => {
    const repo = repoWithOrigin();
    const { adapter } = fakeGitHub({ prState: "merged" });
    const { store, bus, runId, controller } = await build(adapter, pool(), repo);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    const before = transitions(store, runId).length;

    // A nightly re-run flips the head red after the merge.
    bus.publish({ type: "run.ci_status", runId, prNumber: 7, state: "failing", failing: ["Backend test"], total: 1, ts: Date.now() } as never);
    await controller.resume(runId);

    expect(transitions(store, runId)).toHaveLength(before);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(ciRounds(store, runId)).toBe(0);
  });

  it("a run that merged nothing, which has no pull request to hold", async () => {
    const repo = repoWithOrigin();
    const { adapter, prs } = fakeGitHub({ checks: [RED] });
    const { store, runId, logs } = await build(adapter, pool({ qaFails: true }), repo);

    expect(prs()).toBe(0);
    expect(logs.join("\n")).toMatch(/no pull request opened: no task reached MERGED/);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
  });
});
