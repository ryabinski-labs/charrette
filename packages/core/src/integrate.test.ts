import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter, isNoCommitsError } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" }],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

/** A repo on branch `release`, with a bare origin the harness can actually push to. */
function repoWithOrigin(): { repo: string; origin: string } {
  const origin = mkdtempSync(path.join(tmpdir(), "harness-origin-"));
  gitIn(origin, "init", "--bare", "-b", "release");
  const repo = mkdtempSync(path.join(tmpdir(), "harness-integrate-"));
  writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  gitIn(repo, "init", "-b", "release");
  gitIn(repo, "config", "user.email", "harness@example.com");
  gitIn(repo, "config", "user.name", "harness");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "init");
  gitIn(repo, "remote", "add", "origin", origin);
  gitIn(repo, "push", "-u", "origin", "release");
  return { repo, origin };
}

/** Plans, then has the worker commit real code, then passes QA. */
function buildingPool(commit: boolean, validatorOut?: string, prodOut?: string) {
  const outputs = [DOCS, DAG, "worker done", '{"verdict":"PASS"}'];
  let i = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "prod") {
        return { sessionId: "sp", resultText: prodOut ?? '{"verdict":"PASS","summary":"live and correct"}', costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "validator" && validatorOut) {
        return { sessionId: "sv", resultText: validatorOut, costUsd: 0, turns: 1, outcome: "done" };
      }
      const resultText = outputs[Math.min(i, outputs.length - 1)]!;
      i++;
      if (spec.role === "worker" && commit) {
        writeFileSync(path.join(spec.cwd, "feature.txt"), "implemented\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "feat: task-a");
      }
      return { sessionId: `s${i}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return pool as unknown as AgentPool;
}

/** Stands in for GitHub: records what it was asked for, or fails on demand. */
function fakeGitHub(
  onPr: (args: { head: string; base: string }) => { number: number; url: string; fresh?: boolean } | null,
  checks?: { state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number },
  merge?: { sha: string | null; deploy: { state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null }
) {
  const prs: { head: string; base: string }[] = [];
  const prBodies: string[] = [];
  const closedPrs: number[] = [];
  const adapter = {
    enabled: true,
    async ensureIssue() {
      return null;
    },
    async ensurePR(_runId: string, _taskId: string, head: string, base: string, _title: string, body: string) {
      prs.push({ head, base });
      prBodies.push(body);
      return onPr({ head, base });
    },
    async closePR(prNumber: number) {
      closedPrs.push(prNumber);
      return true;
    },
    ...(checks ? { async prChecks() { return checks; } } : {}),
    ...(merge
      ? {
          async mergedSha() {
            return merge.sha;
          },
          async checksForRef() {
            return merge.deploy;
          },
        }
      : {}),
  };
  return { adapter: adapter as unknown as GitHubAdapter, prs, prBodies, closedPrs };
}

/** Plans, commits, then has QA reject every iteration until the task parks. */
function parkingPool() {
  const outputs = [DOCS, DAG];
  let i = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "qa") {
        return { sessionId: "sq", resultText: '{"verdict":"FAIL","reasons":["no tests"],"mustFix":["add tests"]}', costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, "feature.txt"), `attempt ${i}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "feat: task-a");
        return { sessionId: `sw${i++}`, resultText: "worker done", costUsd: 0, turns: 1, outcome: "done" };
      }
      return { sessionId: `s${i}`, resultText: outputs[Math.min(i++, outputs.length - 1)]!, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return pool as unknown as AgentPool;
}

async function build(
  github: GitHubAdapter,
  commit = true,
  validatorOut?: string,
  prMode: "single" | "per-task" = "single",
  pool?: AgentPool,
  checkTimeoutMinutes = 20,
  extra?: { prodUrl?: string; prodOut?: string }
) {
  const { repo } = repoWithOrigin();
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const logs: string[] = [];
  bus.subscribe(({ event }) => {
    if (event.type === "agent.log") logs.push(event.text);
  });
  const controller = new RunController(store, bus, pool ?? buildingPool(commit, validatorOut, extra?.prodOut), github, {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
  }, repo);
  const runId = await controller.startRun(
    "do a thing",
    RunConfig.parse({ deterministicChecks: [], prMode, checkTimeoutMinutes, deployTimeoutMinutes: 1, prodUrl: extra?.prodUrl ?? "" })
  );
  return { store, runId, logs, repo, controller };
}

describe("a task branch that carries nothing", () => {
  it("is never merged, however cleanly git says the merge went", async () => {
    // Run da8325bd: three task branches held zero commits, `git merge --no-ff`
    // answered "Already up to date" and exited 0 for each of them, and all
    // three were booked MERGED against the integration branch's own commit —
    // one of them for the work whose absence the operator found at the demo.
    const { adapter, prs } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const { store, runId, logs } = await build(adapter, false);

    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(store.getTask(runId, "task-a")!.state).not.toBe("MERGED");
    // Nothing was merged, so there is no diff and no PR to open.
    expect(prs).toEqual([]);
    expect(logs.join("\n")).toMatch(/nothing to review: harness\/.*\/task-a changes no file against harness\/.*\/main \(0 commits\)/);
  });

  it("goes back to the worker with the question only the worker can answer", async () => {
    // Not "your code is wrong" — the code is usually written and simply not on
    // this branch, so the prompt sends it looking for where the work went.
    const prompts: string[] = [];
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const base = buildingPool(false);
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        if (spec.role === "worker") prompts.push(spec.prompt as string);
        return base.run(spec);
      },
    } as unknown as AgentPool;
    const { store, runId } = await build(adapter, false, undefined, "single", pool);

    // The first dispatch is the ordinary task briefing; every one after it is a
    // re-dispatch caused by the empty branch, and each costs a QA iteration.
    expect(prompts.length).toBeGreaterThan(1);
    expect(prompts.slice(1).join("\n")).toContain("delivers nothing");
    expect(prompts.slice(1).join("\n")).toContain("it has no commits on it at all");
    expect(prompts.slice(1).join("\n")).toContain("do not commit anything outside it");
    expect(store.getTask(runId, "task-a")!.qaIterations).toBeGreaterThan(0);
  });

  it("does not spend a QA agent on an empty diff", async () => {
    // The gate sits before the deterministic checks and before QA precisely so
    // that reviewing nothing is never paid for.
    const roles: string[] = [];
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const base = buildingPool(false);
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        roles.push(spec.role);
        return base.run(spec);
      },
    } as unknown as AgentPool;
    await build(adapter, false, undefined, "single", pool);

    expect(roles).not.toContain("qa");
  });
});

describe("opening the component PR", () => {
  it("bases the per-task PR on the branch the run started from, not the integration branch", async () => {
    // The integration branch already contains the task by the time the PR is
    // opened, so a PR based there has no commits — GitHub rejects it outright.
    const { adapter, prs } = fakeGitHub(() => ({ number: 7, url: "https://example.invalid/pr/7" }));
    const { store, runId } = await build(adapter, true, undefined, "per-task");

    expect(prs).toEqual([{ head: `harness/${runId}/task-a`, base: "release" }]);
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(7);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("opens one rollup PR from the integration branch by default", async () => {
    // Task branches are cut from the integration branch, so per-task PRs overlap
    // each other; the default publishes the complete diff exactly once.
    const { adapter, prs, prBodies } = fakeGitHub(() => ({ number: 9, url: "u" }));
    const { store, runId } = await build(adapter);

    expect(prs).toEqual([{ head: `harness/${runId}/main`, base: "release" }]);
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(9);
    // The reviewer sees what shipped and what the validator thought of it.
    expect(prBodies[0]).toContain("- A (QA iterations:");
    expect(prBodies[0]).toContain("Intent check: **PASS**");
  });

  it("records the base branch on the run, so a resume opens PRs against the same one", async () => {
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const { store, runId } = await build(adapter);
    expect(store.getRun(runId)!.config.baseBranch).toBe("release");
  });

  it("keeps a merged task merged when GitHub refuses the PR", async () => {
    // The reported failure: a 422 from GitHub propagated out of the integrator and
    // killed the whole run, discarding work that was already committed and merged.
    const { adapter } = fakeGitHub(() => {
      throw Object.assign(new Error("Validation Failed"), { status: 422 });
    });
    const { store, runId, logs } = await build(adapter);

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(logs.join("\n")).toMatch(/merged locally, but the pull request could not be opened/);
  });

  it("says so plainly when the integration branch adds nothing to the base", async () => {
    // GitHub refusing the PR is the signal, not an empty task branch: a task
    // whose work is already in the base merges fine and still has no PR to open.
    const { adapter } = fakeGitHub(() => null);
    const { store, runId, logs } = await build(adapter);

    expect(store.getTask(runId, "task-a")!.prNumber).toBeNull();
    expect(logs.join("\n")).toMatch(/no commits that release does not already have/);
  });
});

describe("what the run says it produced", () => {
  const reason = (store: Store, runId: string) =>
    store
      .eventsSince(runId, 0)
      .map((e) => e.event)
      .filter((e) => e.type === "run.state_changed" && e.to === "PR_REVIEW")
      .map((e) => (e as { reason: string }).reason)
      .join("");

  it("counts the pull requests it actually opened", async () => {
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const { store, runId } = await build(adapter);
    expect(reason(store, runId)).toBe("1 pull request open for review; intent check passed");
  });

  it("does not claim pull requests when it opened none", async () => {
    // The reported symptom: a run whose foundation tasks all parked cancelled
    // everything downstream, then announced "PRs opened; human review on GitHub"
    // and sent the operator to GitHub to look at work that was never pushed.
    const { adapter } = fakeGitHub(() => null);
    const { store, runId } = await build(adapter);
    expect(reason(store, runId)).toBe("no pull requests opened; intent check passed");
    expect(reason(store, runId)).not.toMatch(/PRs opened/);
  });

  it("says the branch is red when the repo's own CI fails it", async () => {
    // The deterministic checks are green in the worktree by construction here —
    // that is exactly the blind spot. They ran on one task's branch in isolation
    // and never saw the merged whole, the workflow, or a base that had moved.
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "failing", failing: ["Deploy", "CI / build"], total: 3 });
    const { store, runId, logs } = await build(adapter);

    expect(store.ciStatus(runId)).toMatchObject({ prNumber: 7, state: "failing", failing: ["Deploy", "CI / build"] });
    expect(reason(store, runId)).toBe("1 pull request open for review; CI red (Deploy, CI / build); intent check passed");
    expect(logs.join("\n")).toMatch(/CI is red on #7: Deploy, CI \/ build/);
  });

  it("says CI is green when it passes, and stays quiet when the repo has none", async () => {
    const green = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "passing", failing: [], total: 4 });
    expect(reason(...(await build(green.adapter).then((b) => [b.store, b.runId] as const)))).toBe(
      "1 pull request open for review; CI green; intent check passed"
    );
    // A repo with no CI at all must not gain a phantom "CI" clause. It still
    // spends the grace polls first, in case CI simply had not been queued yet.
    const none = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "none", failing: [], total: 0 });
    const b = await build(none.adapter, true, undefined, "single", undefined, 1);
    expect(reason(b.store, b.runId)).toBe("1 pull request open for review; intent check passed");
  }, 20_000);

  it("says why no pull request exists when nothing was merged", async () => {
    // The reported symptom: billing-app and sendant each parked their one running
    // task, cancelled every dependent, and flipped to PR_REVIEW. `openRunPr`
    // returns null on `!merged.length` without publishing anything, so the event
    // feed showed a run that finished and produced no pull request and no reason.
    const { adapter, prs } = fakeGitHub(() => ({ number: 11, url: "u" }));
    const { store, runId, logs } = await build(adapter, true, undefined, "single", parkingPool());

    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(prs).toEqual([]);
    expect(logs.join("\n")).toMatch(/no pull request opened: no task reached MERGED.*1 task parked/);
  });

  it("reports what is parked and what was abandoned", async () => {
    const { adapter } = fakeGitHub(() => null);
    const { store, runId, controller } = await build(adapter);
    // One task the operator has to deal with, and two that never became reachable —
    // the second only transitively, through the first.
    store.insertTasks(runId, [], [
      { id: "b", epicId: "epic-e", title: "B", spec: "", acceptanceCriteria: [], dependsOn: [], state: "NEEDS_HUMAN", branch: "harness/x/b", worktreePath: null, githubIssueNumber: 12, prNumber: null, qaIterations: 3, respawns: 0, assignedSkills: [], errorSummary: "QA rejected it 3 times (the cap): still no tests", touchedPaths: [], completionProbe: "", estimatedSize: "M" },
      { id: "c", epicId: "epic-e", title: "C", spec: "", acceptanceCriteria: [], dependsOn: ["b"], state: "CANCELLED", branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "M" },
      { id: "d", epicId: "epic-e", title: "D", spec: "", acceptanceCriteria: [], dependsOn: ["c"], state: "CANCELLED", branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "M" },
    ]);
    const out = controller.outcome(runId);
    expect(out.line).toBe("no pull requests opened; 1 task needs you; 2 never started, blocked behind them; intent check passed");
    // "1 task needs you" on its own is not actionable: which one, why, and where.
    expect(out.parked).toEqual([
      { taskId: "b", title: "B", issue: 12, branch: "harness/x/b", why: "QA rejected it 3 times (the cap): still no tests", blocking: ["c", "d"] },
    ]);
  });

  it("recovers the park reason from the event when the task row never got one", async () => {
    // Runs written before the reason was stored on the task still have it in the
    // transition event, which is the only record the operator's finished run has.
    const { adapter } = fakeGitHub(() => null);
    const { store, runId, controller } = await build(adapter);
    store.insertTasks(runId, [], [
      { id: "e", epicId: "epic-e", title: "E", spec: "", acceptanceCriteria: [], dependsOn: [], state: "PENDING", branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "M" },
    ]);
    store.transitionTask(runId, "e", "READY");
    store.transitionTask(runId, "e", "WORKING");
    store.transitionTask(runId, "e", "NEEDS_HUMAN", "iteration cap hit on deterministic checks");
    expect(controller.outcome(runId).parked[0]!.why).toBe("iteration cap hit on deterministic checks");
  });
});

describe("closing the cycle in production", () => {
  const state = (store: Store, runId: string) => store.getRun(runId)!.state;

  it("follows the merge to the deploy and checks production, then calls the run DONE", async () => {
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "passing", failing: [], total: 2 }, {
      sha: "deadbeef",
      deploy: { state: "passing", failing: [], total: 1 },
    });
    const { store, runId } = await build(adapter, true, undefined, "single", undefined, 20, { prodUrl: "https://example.invalid" });

    expect(store.deployStatus(runId)).toMatchObject({ sha: "deadbeef", state: "passing" });
    expect(store.prodVerdict(runId)).toMatchObject({ verdict: "PASS", url: "https://example.invalid" });
    expect(state(store, runId)).toBe("DONE");
  });

  it("stays in VERIFYING when the merge deployed red, and never asks production", async () => {
    // marrymath: the pull request merged, the deploy failed on a step nothing in
    // the repo could have caught, and the change never reached a single user.
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "passing", failing: [], total: 2 }, {
      sha: "deadbeef",
      deploy: { state: "failing", failing: ["Deploy"], total: 2 },
    });
    const { store, runId, logs } = await build(adapter, true, undefined, "single", undefined, 20, { prodUrl: "https://example.invalid" });

    expect(store.deployStatus(runId)).toMatchObject({ state: "failing", failing: ["Deploy"] });
    // Asking production about a deploy that never happened would have produced a
    // verdict about the *old* code — worse than no verdict at all.
    expect(store.prodVerdict(runId)).toBeNull();
    expect(state(store, runId)).toBe("VERIFYING");
    expect(logs.join("\n")).toMatch(/deployed red: Deploy — the change is merged but not live/);
  });

  it("stays in VERIFYING when production disagrees, and says what it found", async () => {
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "passing", failing: [], total: 2 }, {
      sha: "deadbeef",
      deploy: { state: "passing", failing: [], total: 1 },
    });
    const { store, runId, controller } = await build(adapter, true, undefined, "single", undefined, 20, {
      prodUrl: "https://example.invalid",
      prodOut: '{"verdict":"FAIL","summary":"still the old page","findings":["/blog/ still returns the frozen SPA snapshot"]}',
    });

    expect(store.prodVerdict(runId)).toMatchObject({ verdict: "FAIL", findings: ["/blog/ still returns the frozen SPA snapshot"] });
    expect(state(store, runId)).toBe("VERIFYING");
    expect(controller.outcome(runId).line).toContain("production check found 1 problem");
    // The whole point of not calling it DONE: `resume` comes back here.
    expect(controller.awaitingVerification(runId)).toBe(true);
  });

  it("ends at the pull request when no production URL is configured", async () => {
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "passing", failing: [], total: 2 }, {
      sha: "deadbeef",
      deploy: { state: "passing", failing: [], total: 1 },
    });
    const { store, runId, controller } = await build(adapter);

    expect(state(store, runId)).toBe("PR_REVIEW");
    expect(store.prodVerdict(runId)).toBeNull();
    expect(controller.awaitingVerification(runId)).toBe(false);
  });

  it("stops at the pull request while the human has not merged", async () => {
    // No merge commit: the boundary the harness does not cross. Not a failure.
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }), { state: "passing", failing: [], total: 2 }, { sha: null, deploy: null });
    const { store, runId } = await build(adapter, true, undefined, "single", undefined, 20, { prodUrl: "https://example.invalid" });

    expect(state(store, runId)).toBe("PR_REVIEW");
    expect(store.deployStatus(runId)).toBeNull();
    expect(store.prodVerdict(runId)).toBeNull();
  });
});

describe("validating intent before the PRs", () => {
  it("judges the merged whole against the original intent, and only then opens PRs", async () => {
    // Task-level QA has already passed each task against its own criteria. The
    // validator answers the question none of them asked — does the sum deliver
    // what the operator wanted? — and its verdict must be on record before any
    // pull request invites a human to review.
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const { store, runId, controller } = await build(adapter);

    const events = store.eventsSince(runId, 0);
    const seqOf = (type: string) => events.find((e) => e.event.type === type)?.seq ?? Infinity;
    expect(seqOf("run.intent_verdict")).toBeLessThan(seqOf("github.pr_opened"));
    expect(controller.outcome(runId).intent).toEqual({ verdict: "PASS", gaps: [], summary: "" });
  });

  it("reports the gaps when the validator says the intent is not met", async () => {
    const { adapter } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const { runId, controller } = await build(adapter, true, '{"verdict":"FAIL","summary":"half a feature","gaps":["the toggle is never wired to the call screen"]}');
    const out = controller.outcome(runId);
    expect(out.intent).toEqual({ verdict: "FAIL", summary: "half a feature", gaps: ["the toggle is never wired to the call screen"] });
    expect(out.line).toContain("intent check found 1 gap");
    // A FAIL does not block the PRs — the harness never merges, and the human
    // review the PRs exist for is exactly where the gap list belongs.
    expect(out.prs).toHaveLength(1);
  });
});

describe("resuming to open the missing PRs", () => {
  it("backfills the base branch and opens PRs for merged tasks, spending no agent tokens", async () => {
    // The marrymath shape: tasks merged locally, zero PRs, because the run
    // predated base-branch capture and every open failed with "no base branch
    // (detached HEAD)". Resume must repair the config from the repo and finish
    // the publishing step — without re-running a single agent.
    const { adapter: broken } = fakeGitHub(() => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    const { store, runId, repo } = await build(broken, true, undefined, "per-task");
    expect(store.getTask(runId, "task-a")!.prNumber).toBeNull();
    // Simulate the pre-capture run: strip the recorded base branch.
    const cfg = { ...store.getRun(runId)!.config } as Record<string, unknown>;
    delete cfg.baseBranch;
    store.db.prepare("UPDATE runs SET config = ? WHERE id = ?").run(JSON.stringify(cfg), runId);

    const { adapter: working, prs } = fakeGitHub(() => ({ number: 42, url: "u" }));
    const silent = {
      async run() {
        throw new Error("no agent should run for a PR retry");
      },
    } as unknown as AgentPool;
    const controller = new RunController(store, new Bus(store), silent, working, {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
    }, repo);

    expect(controller.hasRecoverableWork(runId)).toBe(true);
    await controller.resume(runId);

    expect(prs).toEqual([{ head: `harness/${runId}/task-a`, base: "release" }]);
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(42);
    expect(store.getRun(runId)!.config.baseBranch).toBe("release");
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });
});

describe("regrouping per-task PRs into the rollup", () => {
  it("opens the rollup first, closes the superseded PRs, and flips the run to single mode", async () => {
    // The marrymath shape after publishing: one PR per task, each late PR
    // repeating every earlier task's commits. Regroup replaces them with the
    // integration branch's single complete diff.
    const { adapter: perTask } = fakeGitHub(() => ({ number: 7, url: "u" }));
    const { store, runId, repo } = await build(perTask, true, undefined, "per-task");
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(7);

    const { adapter, prs, closedPrs } = fakeGitHub(() => ({ number: 99, url: "https://example.invalid/pr/99" }));
    const controller = new RunController(store, new Bus(store), buildingPool(false), adapter, {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
    }, repo);

    const res = await controller.regroupPrs(runId);
    expect(res!.pr.number).toBe(99);
    expect(res!.closed).toEqual([7]);
    expect(closedPrs).toEqual([7]);
    expect(prs).toEqual([{ head: `harness/${runId}/main`, base: "release" }]);
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(99);
    // Future resumes publish the same way instead of reopening per-task PRs.
    expect(store.getRun(runId)!.config.prMode).toBe("single");
  });
});

describe("the rollup PR outlived by its branch", () => {
  it("opens a follow-up PR naming the merged one, and says so in the log", async () => {
    // Run publishes rollup #7, the human merges it while more work lands, and
    // republishing must produce a fresh PR that reads as a continuation — not
    // silently find the merged PR and strand the new commits.
    const first = fakeGitHub(() => ({ number: 7, url: "u7" }));
    const { store, runId, repo } = await build(first.adapter);
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(7);

    const followUp = fakeGitHub(() => ({ number: 101, url: "u101", fresh: true }));
    (followUp.adapter as unknown as { prState: unknown }).prState = async () => "merged";
    const logs: string[] = [];
    const bus = new Bus(store);
    bus.subscribe(({ event }) => {
      if (event.type === "agent.log") logs.push(event.text);
    });
    const controller = new RunController(store, bus, buildingPool(false), followUp.adapter, {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
    }, repo);

    const res = await controller.regroupPrs(runId);
    expect(res!.pr.number).toBe(101);
    expect(followUp.prBodies[0]).toContain("Continues #7");
    expect(logs.some((l) => l.includes("#7 was merged before the run finished") && l.includes("follow-up PR #101"))).toBe(true);
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(101);
  });
});

describe("telling GitHub's 422s apart", () => {
  const noCommits = {
    status: 422,
    message: "Validation Failed",
    response: { data: { errors: [{ message: "No commits between harness/x/main and harness/x/task-a" }] } },
  };

  it("recognises an empty diff from the errors array", () => {
    expect(isNoCommitsError(noCommits)).toBe(true);
  });

  it("recognises it from the message alone, which is where Octokit puts it", () => {
    expect(isNoCommitsError({ status: 422, message: "Validation Failed: No commits between a and b" })).toBe(true);
  });

  it("does not swallow other 422s — a protected base is a real failure", () => {
    expect(
      isNoCommitsError({ status: 422, message: "Validation Failed", response: { data: { errors: [{ message: "base is protected" }] } } })
    ).toBe(false);
  });

  it("does not swallow auth or not-found errors", () => {
    expect(isNoCommitsError({ status: 401, message: "Bad credentials" })).toBe(false);
    expect(isNoCommitsError({ status: 404, message: "Not Found: No commits between" })).toBe(false);
  });
});
