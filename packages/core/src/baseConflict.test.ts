import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, RunPaused } from "./runController.js";
import { Store } from "./store.js";

/**
 * The run's own branch against the branch it must merge into.
 *
 * Every other merge in the charrette is between two things the run owns. This one
 * is against `main`, which keeps moving while the run works and is written by
 * people who do not know the run exists. Nothing used to look: run 5743ce85
 * spent $373.36, merged 64 tasks, opened a CONFLICTING pull request and told the
 * operator "1 pull request open for review". These tests pin the behaviour that
 * replaced that — reconcile first, hand a real conflict to an agent, and where
 * that fails, say so everywhere the operator looks instead of anywhere else.
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
const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repoWithOrigin(): { repo: string; origin: string } {
  const origin = mkdtempSync(path.join(tmpdir(), "charrette-base-origin-"));
  gitIn(origin, "init", "--bare", "-b", "release");
  const repo = mkdtempSync(path.join(tmpdir(), "charrette-base-"));
  writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  gitIn(repo, "init", "-b", "release");
  gitIn(repo, "config", "user.email", "charrette@example.com");
  gitIn(repo, "config", "user.name", "charrette");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-m", "init");
  gitIn(repo, "remote", "add", "origin", origin);
  gitIn(repo, "push", "-u", "origin", "release");
  return { repo, origin };
}

/**
 * Somebody else merges into the base branch while the run is working. Done
 * through a clone of the bare origin, because that is what it actually is: a
 * commit this run's checkout has never seen and did not fetch.
 */
function moveBase(origin: string, files: { file: string; body: string }[]): void {
  const clone = mkdtempSync(path.join(tmpdir(), "charrette-base-other-"));
  gitIn(clone, "clone", origin, ".");
  gitIn(clone, "config", "user.email", "someone@example.com");
  gitIn(clone, "config", "user.name", "someone else");
  for (const { file, body } of files) writeFileSync(path.join(clone, file), body);
  gitIn(clone, "add", "-A");
  gitIn(clone, "commit", "-m", `chore: ${files.map((f) => f.file).join(", ")} on the base`);
  gitIn(clone, "push", "origin", "release");
}

/** Records the draft flag, which is the control this whole phase turns on. */
function fakeGitHub(opts: { mergeable?: "mergeable" | "conflicting" | "unknown" } = {}) {
  const prs: { body: string; draft: boolean }[] = [];
  let readied = 0;
  const adapter = {
    enabled: true,
    async ensureIssue() {
      return null;
    },
    async ensurePR(_r: string, _t: string, _h: string, _b: string, _title: string, body: string, o?: { draft?: boolean }) {
      prs.push({ body, draft: Boolean(o?.draft) });
      return { number: 42, url: "https://example.test/pull/42", fresh: true };
    },
    async markPrReady() {
      readied++;
      return true;
    },
    ...(opts.mergeable
      ? {
          async prMergeable() {
            return { state: opts.mergeable!, mergeStateStatus: opts.mergeable === "conflicting" ? "dirty" : "clean" };
          },
        }
      : {}),
  };
  return { adapter: adapter as unknown as GitHubAdapter, prs, readied: () => readied };
}

/**
 * Plans, writes `feature.txt`, passes QA, and moves the base at `whenBaseMoves`
 * — the validator, which is the last thing that runs before the pull request is
 * opened, so the divergence is as fresh as it is on a real run.
 */
function pool(setup: {
  origin: string;
  baseFile?: { file: string; body: string };
  /** Fails every QA, so the task parks and the run publishes nothing. */
  qaFails?: boolean;
  /** Everything the run's own worker writes, beyond `feature.txt`. */
  workerFiles?: string[];
  resolveMerge?: (wt: string) => void;
  onIntegrator?: (attempt: number) => void;
}): { pool: AgentPool; integratorPrompts: string[]; integratorRuns: () => number } {
  const outputs = [DOCS, DAG, "worker done"];
  const integratorPrompts: string[] = [];
  let i = 0;
  let integratorRuns = 0;
  const impl = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "qa") {
        const verdict = setup.qaFails
          ? '{"verdict":"FAIL","notes":"not good enough","unverified":[]}'
          : '{"verdict":"PASS","notes":"good","unverified":[]}';
        return { sessionId: "sq", resultText: verdict, costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "validator") {
        if (setup.baseFile) {
          moveBase(setup.origin, [
            setup.baseFile,
            ...(setup.workerFiles ?? []).map((file) => ({ file, body: `the base's ${file}\n` })),
          ]);
        }
        return { sessionId: "sv", resultText: PASS, costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "integrator") {
        integratorRuns++;
        // The real pool asks before each turn whether the run is still allowed
        // to spend; a fake that never asks leaves the stop this session can hit
        // untested.
        await spec.budgetCheck?.();
        integratorPrompts.push(spec.prompt as string);
        // An agent that cannot resolve it leaves the worktree exactly as it
        // found it — conflicted — which is what a real one does when it gives up
        // without aborting.
        if (setup.onIntegrator) setup.onIntegrator(integratorRuns);
        if (setup.resolveMerge) setup.resolveMerge(spec.cwd);
        return { sessionId: `si${integratorRuns}`, resultText: "merge handled", costUsd: 0, turns: 1, outcome: "done" };
      }
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, "feature.txt"), "the run's implementation\n");
        for (const file of setup.workerFiles ?? []) writeFileSync(path.join(spec.cwd, file), `the run's ${file}\n`);
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "feat: task-a");
      }
      return { sessionId: `s${i}`, resultText: outputs[Math.min(i++, outputs.length - 1)]!, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: impl as unknown as AgentPool, integratorPrompts, integratorRuns: () => integratorRuns };
}

async function build(github: GitHubAdapter, agents: AgentPool, repo: string, over: { settleMinutes?: number; baseBranch?: string } = {}) {
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
    },
    repo
  );
  // `checkTimeoutMinutes` is a whole-minute integer, so a test that has to
  // exhaust the mergeability settle budget cannot get there through config.
  if (over.settleMinutes !== undefined) controller.mergeabilitySettleMinutes = over.settleMinutes;
  // The green hold is off here on purpose. These tests are about the base
  // merge, the resolver and the verdict GitHub records — the machinery — and
  // the fakes carry no CI at all, which the hold reads as "GitHub could not be
  // read" and pauses on before any of that is reached. What the hold does with
  // a conflicting or behind pull request is greenHold.test.ts's subject.
  const runId = await controller.startRun(
    "do a thing",
    // `holdUntilProven` is off too: nothing here answers the validator, and what the closing gate does with that is closingProof.test.ts's subject.
    RunConfig.parse({ deterministicChecks: [], checkTimeoutMinutes: 1, deployTimeoutMinutes: 1, holdUntilGreen: false, holdUntilProven: false, ...(over.baseBranch ? { baseBranch: over.baseBranch } : {}) })
  );
  return { store, bus, runId, logs, controller };
}

/** The run's integration worktree, where a base merge lands or is abandoned. */
const integrationWt = (repo: string, runId: string) => path.join(path.dirname(repo), `${path.basename(repo)}-wt`, runId, "__integration__");

describe("the base branch moved while the run was working", () => {
  it("merges it in before the pull request opens, so the branch is mergeable by construction", async () => {
    // A commit on the base that touches nothing this run touched. It still has
    // to come in: GitHub does not care that the merge would be trivial, and a
    // reviewer arriving at a branch cut from a month-old base is reading a diff
    // against a tree that no longer exists.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin, baseFile: { file: "unrelated.txt", body: "someone else's work\n" } });
    const { store, runId, logs, controller } = await build(adapter, agents.pool, repo);

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    // The other side's commit is on the branch the pull request was opened from.
    const wt = integrationWt(repo, runId);
    expect(existsSync(path.join(wt, "unrelated.txt"))).toBe(true);
    expect(readFileSync(path.join(wt, "unrelated.txt"), "utf8")).toBe("someone else's work\n");
    // And it was not held back for it.
    expect(prs).toHaveLength(1);
    expect(prs[0]!.draft).toBe(false);
    expect(logs.join("\n")).toMatch(/origin\/release moved while the run was working and has been merged/);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable", resolvedBy: "merge" });
    // Said in the one line the operator actually reads, because the branch they
    // are about to review is not only this run's work any more.
    expect(controller.outcome(runId).line).toContain("release merged in to keep it mergeable");
  });

  it("says nothing when the base never moved", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin });
    const { store, runId, logs, controller } = await build(adapter, agents.pool, repo);

    expect(prs[0]!.draft).toBe(false);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable", resolvedBy: "already-current" });
    expect(logs.join("\n")).not.toMatch(/moved while the run was working/);
    expect(controller.outcome(runId).line).not.toContain("merged in to keep it mergeable");
    expect(controller.outcome(runId).line).not.toContain("CANNOT MERGE");
  });
});

describe("the base branch moved and conflicts", () => {
  it("hands the conflict to an agent, and publishes normally when it is resolved", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({
      origin,
      // The same path the worker wrote: an add/add collision, which is the
      // ordinary shape of this conflict on a real repo.
      baseFile: { file: "feature.txt", body: "somebody else's feature\n" },
      resolveMerge: (wt) => {
        writeFileSync(path.join(wt, "feature.txt"), "the run's implementation\nsomebody else's feature\n");
        gitIn(wt, "add", "-A");
        gitIn(wt, "commit", "--no-edit");
      },
    });
    const { store, runId, logs, controller } = await build(adapter, agents.pool, repo);

    expect(agents.integratorRuns()).toBe(1);
    // It was told what each side is, which is the whole difference between this
    // and a task-branch conflict.
    expect(agents.integratorPrompts[0]).toContain("is this run's work");
    expect(agents.integratorPrompts[0]).toContain("what other people merged into the base branch");
    expect(agents.integratorPrompts[0]).toContain("feature.txt");

    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable", resolvedBy: "agent" });
    expect(prs[0]!.draft).toBe(false);
    expect(logs.join("\n")).toMatch(/the conflict with origin\/release was resolved and committed/);
    expect(controller.outcome(runId).line).not.toContain("CANNOT MERGE");
  });

  it("abandons a merge nobody could resolve, leaving the branch exactly where it was", async () => {
    // The failure that matters: the charrette must never publish a half-finished
    // merge, and must never quietly drop the base's commits to make one work.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin, baseFile: { file: "feature.txt", body: "somebody else's feature\n" } });
    const { store, runId, logs } = await build(adapter, agents.pool, repo);

    // Every attempt was spent, and the worktree was put back afterwards.
    expect(agents.integratorRuns()).toBe(2);
    const wt = integrationWt(repo, runId);
    expect(existsSync(path.join(wt, ".git"))).toBe(true);
    expect(gitOut(wt, "status", "--porcelain")).toBe("");
    expect(readFileSync(path.join(wt, "feature.txt"), "utf8")).toBe("the run's implementation\n");
    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting", resolvedBy: "none" });
    expect(store.mergeStatus(runId)!.conflicts).toContain("feature.txt");
    expect(logs.join("\n")).toMatch(/still does not merge into origin\/release after 2 attempt\(s\)/);
  });

  it("does not read an agent that aborted and committed something else as a resolution", async () => {
    // The cheap proxies for "it worked" both lie here. The head moved and there
    // are no conflicted paths left, and yet the base is not on this branch — so
    // the question asked is whether the branch actually contains the base commit.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({
      origin,
      baseFile: { file: "feature.txt", body: "somebody else's feature\n" },
      resolveMerge: (wt) => {
        gitIn(wt, "merge", "--abort");
        writeFileSync(path.join(wt, "notes.txt"), "gave up, wrote this instead\n");
        gitIn(wt, "add", "-A");
        gitIn(wt, "commit", "-m", "chore: unrelated");
      },
    });
    const { store, runId } = await build(adapter, agents.pool, repo);

    expect(agents.integratorRuns()).toBe(2);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting", resolvedBy: "none" });
    expect(prs[0]!.draft).toBe(true);
    // The base really is absent, which is the fact the assertion above stands on.
    const wt = integrationWt(repo, runId);
    expect(readFileSync(path.join(wt, "feature.txt"), "utf8")).toBe("the run's implementation\n");
  });

  it("holds the pull request as a draft and names the conflict in its body", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin, baseFile: { file: "feature.txt", body: "somebody else's feature\n" } });
    const { runId, controller } = await build(adapter, agents.pool, repo);

    expect(prs).toHaveLength(1);
    // GitHub refuses to merge a draft, so the sentence has to be acted on rather
    // than read past — the same control the intent FAIL and the unsettled
    // criteria already use.
    expect(prs[0]!.draft).toBe(true);
    expect(prs[0]!.body).toContain("This branch does not merge into");
    expect(prs[0]!.body).toContain("feature.txt");
    expect(prs[0]!.body).toContain("git fetch origin release && git merge origin/release");
    // And the run does not get to describe itself as finished.
    const line = controller.outcome(runId).line;
    expect(line).toContain("CANNOT MERGE — conflicts with release in 1 file");
    expect(line).toContain("pull request open for review");
  });
});

describe("resuming a run that already published an unmergeable pull request", () => {
  it("reconciles and republishes instead of waiting for a merge that cannot happen", async () => {
    // The gap that made all of the above unreachable for the run that prompted
    // it. A run at PR_REVIEW never re-enters INTEGRATING, so it dropped straight
    // into `verify` and waited for a human to merge a pull request GitHub would
    // not let anybody merge.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin, baseFile: { file: "feature.txt", body: "somebody else's feature\n" } });
    const { store, runId, controller, logs } = await build(adapter, agents.pool, repo);

    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting" });
    const before = prs.length;

    // Somebody resolves whatever was in the way — here, by the base no longer
    // conflicting — and resumes.
    gitIn(repo, "fetch", "origin", "release");
    await controller.resume(runId);

    expect(prs.length).toBeGreaterThan(before);
    expect(logs.join("\n")).toMatch(/is open and not known to merge into release — reconciling the branch/);
  });

  it("leaves a pull request a human already merged alone", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const merged = { ...adapter, async prState() { return "merged" as const; } } as unknown as GitHubAdapter;
    const agents = pool({ origin, baseFile: { file: "feature.txt", body: "somebody else's feature\n" } });
    const { store, runId, controller } = await build(merged, agents.pool, repo);

    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting" });
    const before = prs.length;
    await controller.resume(runId);
    expect(prs.length).toBe(before);
  });
});

describe("what GitHub says about the pull request it now has", () => {
  it("records a conflicting verdict even when the charrette's own merge went clean", async () => {
    // The window this closes: the base can move between the charrette's merge and
    // the push, so a locally-clean branch can still arrive unmergeable.
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub({ mergeable: "conflicting" });
    const agents = pool({ origin });
    const { store, runId, logs, controller } = await build(adapter, agents.pool, repo);

    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting", prNumber: 42 });
    expect(logs.join("\n")).toMatch(/#42 cannot be merged into release: GitHub reports it as conflicting/);
    expect(logs.join("\n")).toMatch(/the base moved again between the charrette's own merge and the push/);
    expect(controller.outcome(runId).line).toContain("CANNOT MERGE");
  });

  it("confirms a mergeable one without changing what the charrette already found", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub({ mergeable: "mergeable" });
    const agents = pool({ origin, baseFile: { file: "unrelated.txt", body: "someone else's work\n" } });
    const { store, runId, controller } = await build(adapter, agents.pool, repo);

    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable", prNumber: 42, resolvedBy: "merge" });
    expect(controller.outcome(runId).line).not.toContain("CANNOT MERGE");
  });

  it("never upgrades an unsettled answer to a merge it was not told about", async () => {
    // GitHub computes `mergeable` in the background and reports null until it
    // has. A timeout on that is "not known", and the run says exactly that.
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub({ mergeable: "unknown" });
    const agents = pool({ origin });
    // A settle budget of a second: this asserts what the charrette does when the
    // budget runs out, not how long the budget is.
    const { store, runId, controller } = await build(adapter, agents.pool, repo, { settleMinutes: 1 / 60 });

    expect(store.mergeStatus(runId)).toMatchObject({ state: "unknown" });
    expect(controller.outcome(runId).line).toContain("mergeability unconfirmed");
  }, 120_000);
});

describe("the base that is not a conflict, and the one that is many", () => {
  it("does not call an unresolvable base a conflict, and sends nobody to fix it", async () => {
    // A base that will not resolve — a typo, a deleted branch, a remote that
    // moved — fails the merge with no unmerged paths. Reporting that as a
    // conflict sends the operator hunting for markers that are not there.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin });
    const { store, runId, logs, controller } = await build(adapter, agents.pool, repo, { baseBranch: "no-such-base" });

    expect(agents.integratorRuns()).toBe(0);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting", conflicts: [], resolvedBy: "none" });
    expect(logs.join("\n")).toMatch(/git reported no conflicted files/);
    expect(prs[0]!.draft).toBe(true);
    // No file count, because there are no files — the line says the one thing
    // that is true rather than "in 0 files".
    expect(controller.outcome(runId).line).toContain("CANNOT MERGE — conflicts with no-such-base");
    expect(controller.outcome(runId).line).not.toContain("file");
  });

  it("truncates a long conflict list for the agent and for the reviewer, and says how much it cut", async () => {
    const extra = Array.from({ length: 20 }, (_, i) => `mod${i}.txt`);
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin, baseFile: { file: "feature.txt", body: "somebody else's feature\n" }, workerFiles: extra });
    const { store, runId, logs, controller } = await build(adapter, agents.pool, repo);

    expect(store.mergeStatus(runId)!.conflicts).toHaveLength(21);
    // Five in the log, twenty in the pull request: an operator reading a run's
    // output does not want twenty-one paths, and a reviewer does not want none.
    expect(logs.join("\n")).toMatch(/conflicts with charrette\/[a-z0-9]+\/main in 21 file\(s\):/);
    expect(logs.join("\n")).toMatch(/, \+16 more/);
    expect(prs[0]!.body).toContain("Conflicts in 21 files:");
    expect(prs[0]!.body).toContain("- …and 1 more");
    expect(controller.outcome(runId).line).toContain("CANNOT MERGE — conflicts with release in 21 files");
  });
});

describe("a resolver that does not come back with a resolution", () => {
  it("logs a session that failed and gives the conflict to the next attempt", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({
      origin,
      baseFile: { file: "feature.txt", body: "somebody else's feature\n" },
      onIntegrator: (attempt) => {
        if (attempt === 1) throw new Error("the session died");
      },
      resolveMerge: (wt) => {
        writeFileSync(path.join(wt, "feature.txt"), "both\n");
        gitIn(wt, "add", "-A");
        gitIn(wt, "commit", "--no-edit");
      },
    });
    const { store, runId, logs } = await build(adapter, agents.pool, repo);

    expect(agents.integratorRuns()).toBe(2);
    expect(logs.join("\n")).toMatch(/the session died/);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable", resolvedBy: "agent" });
    expect(prs[0]!.draft).toBe(false);
  });

  it("lets a stop the operator asked for through instead of retrying into it", async () => {
    // `RunPaused` is not a failed resolution, it is the run ending. Swallowing
    // it here would spend a second agent session on a run that is over.
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub();
    const agents = pool({
      origin,
      baseFile: { file: "feature.txt", body: "somebody else's feature\n" },
      onIntegrator: () => {
        throw new RunPaused("run1");
      },
    });

    const { store, runId } = await build(adapter, agents.pool, repo);

    // One session, not two: the retry loop is for a resolution that failed, and
    // an operator stopping the run is not one.
    expect(agents.integratorRuns()).toBe(1);
    expect(store.getRun(runId)!.state).toBe("PAUSED");
  });
});

describe("what an unmergeable pull request leaves behind", () => {
  it("counts as work a resume can pick up", async () => {
    // Otherwise a run whose every task merged reports nothing to resume while
    // holding the one artifact it produced hostage.
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub();
    const agents = pool({ origin, baseFile: { file: "feature.txt", body: "somebody else's feature\n" } });
    const { runId, controller } = await build(adapter, agents.pool, repo);

    expect(controller.hasRecoverableWork(runId)).toBe(true);
  });

  it("is not claimed as work when the branch merges", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub();
    const agents = pool({ origin });
    const { runId, controller } = await build(adapter, agents.pool, repo);

    expect(controller.hasRecoverableWork(runId)).toBe(false);
  });

  it("does not reconcile again on resume when the branch already merges", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin, baseFile: { file: "unrelated.txt", body: "someone else's work\n" } });
    const { store, runId, controller } = await build(adapter, agents.pool, repo);

    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable" });
    const before = prs.length;
    await controller.resume(runId);

    expect(prs.length).toBe(before);
  });

  it("does not blame the base for moving twice when the charrette never merged it", async () => {
    // The other half of the message: GitHub says conflicting and so did the
    // charrette, so this is the conflict it already reported, not a new one that
    // appeared between the merge and the push.
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub({ mergeable: "conflicting" });
    const agents = pool({ origin, baseFile: { file: "feature.txt", body: "somebody else's feature\n" } });
    const { store, runId, logs } = await build(adapter, agents.pool, repo);

    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting" });
    expect(logs.join("\n")).toMatch(/Nothing downstream of this pull request can happen until that is resolved/);
    expect(logs.join("\n")).not.toMatch(/the base moved again/);
  });
});

describe("a second look at the base after the first agent gave up", () => {
  it("takes a clean merge on the retry rather than sending another agent", async () => {
    // The agent abandoned the merge but left the branch agreeing with the base
    // — a resolution by another route. The next catch-up merges without a
    // conflict, and there is nothing left to send anybody for.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({
      origin,
      baseFile: { file: "feature.txt", body: "somebody else's feature\n" },
      resolveMerge: (wt) => {
        gitIn(wt, "merge", "--abort");
        writeFileSync(path.join(wt, "feature.txt"), "somebody else's feature\n");
        gitIn(wt, "add", "-A");
        gitIn(wt, "commit", "-m", "take the base's version");
      },
    });
    const { store, runId, controller } = await build(adapter, agents.pool, repo);

    expect(agents.integratorRuns()).toBe(1);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable", resolvedBy: "merge" });
    expect(prs[0]!.draft).toBe(false);
    expect(controller.outcome(runId).line).not.toContain("CANNOT MERGE");
  });

  it("stops when the retry cannot even reach a conflict", async () => {
    // The agent aborted and left the worktree dirty, so the re-merge refuses
    // outright rather than conflicting. There is no conflict to hand a second
    // agent, and re-running the same one would only produce the same refusal.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({
      origin,
      baseFile: { file: "feature.txt", body: "somebody else's feature\n" },
      resolveMerge: (wt) => {
        gitIn(wt, "merge", "--abort");
        writeFileSync(path.join(wt, "feature.txt"), "half-finished, uncommitted\n");
      },
    });
    const { store, runId } = await build(adapter, agents.pool, repo);

    expect(agents.integratorRuns()).toBe(1);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "conflicting" });
    expect(prs[0]!.draft).toBe(true);
  });
});

describe("a run whose merge status was never written, or written without a base", () => {
  /** Rewrites the run's last merge verdict as an older charrette would have left it. */
  function rewriteMergeStatus(store: Store, runId: string, payload: Record<string, unknown>): void {
    store.db.prepare("DELETE FROM events WHERE runId = ? AND type = 'run.merge_status'").run(runId);
    store.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?,?,?,?,?,?)")
      .run(runId, null, null, "run.merge_status", JSON.stringify({ runId, type: "run.merge_status", ...payload }), 1);
  }

  it("names the base branch generically when the record does not carry one", async () => {
    const { repo, origin } = repoWithOrigin();
    const { adapter } = fakeGitHub();
    const agents = pool({ origin });
    const { store, runId, controller } = await build(adapter, agents.pool, repo);

    rewriteMergeStatus(store, runId, { prNumber: 42, state: "conflicting", conflicts: [] });
    expect(controller.outcome(runId).line).toContain("CANNOT MERGE — conflicts with the base branch");

    rewriteMergeStatus(store, runId, { prNumber: 42, state: "mergeable", conflicts: [], resolvedBy: "merge" });
    expect(controller.outcome(runId).line).toContain("the base branch merged in to keep it mergeable");
  });

  it("reconciles a pull request the charrette has no verdict for at all", async () => {
    // A run that was already in review when this phase shipped: there is a pull
    // request and no record of whether it merges. Resume finds out rather than
    // assuming the answer it never wrote down.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin });
    const { store, runId, controller } = await build(adapter, agents.pool, repo);
    const before = prs.length;

    // With the verdict on the record, a resume has nothing to find out.
    await controller.resume(runId);
    expect(prs.length).toBe(before);

    store.db.prepare("DELETE FROM events WHERE runId = ? AND type = 'run.merge_status'").run(runId);
    expect(store.mergeStatus(runId)).toBeNull();
    await controller.resume(runId);

    expect(prs.length).toBeGreaterThan(before);
    expect(store.mergeStatus(runId)).toMatchObject({ state: "mergeable" });
  });
});

describe("a run in review that never opened a pull request", () => {
  it("has nothing to reconcile, and does not go looking", async () => {
    // Every task parked, so there is no rollup branch and no pull request. A
    // resume must not read "no pull request" as "a pull request that will not
    // merge" and start merging bases into a branch nobody will ever review.
    const { repo, origin } = repoWithOrigin();
    const { adapter, prs } = fakeGitHub();
    const agents = pool({ origin, qaFails: true });
    const { store, runId, controller } = await build(adapter, agents.pool, repo);

    expect(prs).toHaveLength(0);
    expect(store.mergeStatus(runId)).toBeNull();
    // Nobody is coming back for the parked task: what is left is a run in
    // review with no rollup, which is the state this guard is about.
    store.db.prepare("UPDATE tasks SET state = 'CANCELLED' WHERE runId = ?").run(runId);

    await controller.resume(runId);

    expect(prs).toHaveLength(0);
    expect(store.mergeStatus(runId)).toBeNull();
  });
});
