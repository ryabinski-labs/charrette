import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig, RunSpec } from "@harness/shared";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { git } from "./git.js";
import { Store, type TaskRow } from "./store.js";
import { assembleReport, buildCompletionReport, changedFiles, configuredEnv, outcomeFacts, reportPath, reporterBrief, rollupPrNumber, wasMerged } from "./reportRun.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-report-"));
  temps.push(dir);
  return dir;
};

function run(over: Partial<{ state: string; assignment: string }> = {}) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  store.createRun({
    id: "run-1",
    repoPath: "/tmp/repo",
    assignment: over.assignment ?? "Build the fulfillment spine",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run-1/main",
    config: RunConfig.parse({ prodUrl: "https://x.test" }),
  });
  return { store, bus };
}

const task = (store: Store, over: Partial<TaskRow> & { id: string }) =>
  store.insertTasks("run-1", [{ id: "e", title: "E" }], [
    {
      epicId: "e",
      title: "T",
      spec: "s",
      acceptanceCriteria: ["it works"],
      dependsOn: [],
      touchedPaths: [],
      estimatedSize: "M",
      state: "PENDING",
      qaIterations: 0,
      branch: null,
      worktreePath: null,
      githubIssueNumber: null,
      prNumber: null,
      respawns: 0,
      assignedSkills: [],
      errorSummary: null,
      completionProbe: "",
      unverified: [],
      ...over,
    } as unknown as Omit<TaskRow, "runId">,
  ]);

const sources = (store: Store, over: Partial<Parameters<typeof buildCompletionReport>[0]> = {}) => ({
  store,
  runId: "run-1",
  project: "demo",
  changed: [],
  configured: [],
  outcome: outcomeFacts(store, "run-1"),
  merged: false,
  prs: [],
  couldNotCheck: [],
  method: "test",
  now: Date.UTC(2026, 7, 20),
  ...over,
});

describe("the four facts the ledger turns on", () => {
  it("reads them off the event log rather than needing a live controller", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.deploy_status", runId: "run-1", sha: "abc", state: "passing", failing: [], total: 2, ts: 1 });
    bus.publish({ type: "run.prod_verdict", runId: "run-1", url: "https://x.test", verdict: "FAIL", findings: ["500s"], summary: "s", ts: 2 });
    bus.publish({ type: "run.intent_verdict", runId: "run-1", verdict: "FAIL", gaps: ["no admin"], unchecked: [], summary: "s", ts: 3 });

    const facts = outcomeFacts(store, "run-1");
    expect(facts.deploy?.state).toBe("passing");
    expect(facts.prod?.findings).toEqual(["500s"]);
    expect(facts.intent?.gaps).toEqual(["no admin"]);
  });

  it("names what each parked task is blocking", () => {
    const { store } = run();
    task(store, { id: "a", title: "Auth" });
    task(store, { id: "b", title: "Sessions", dependsOn: ["a"] });
    store.transitionTask("run-1", "a", "READY");
    store.transitionTask("run-1", "a", "NEEDS_HUMAN", "needs a real account");

    expect(outcomeFacts(store, "run-1").parked).toEqual([{ taskId: "a", why: "needs a real account", blocking: ["Sessions"] }]);
  });

  it("prefers the task's own error summary to the transition reason", () => {
    const { store } = run();
    task(store, { id: "a", title: "Auth", errorSummary: "the SMTP host refused the connection" });
    store.transitionTask("run-1", "a", "READY");
    store.transitionTask("run-1", "a", "NEEDS_HUMAN", "crashed");
    expect(outcomeFacts(store, "run-1").parked[0]!.why).toBe("the SMTP host refused the connection");
  });
});

describe("whether a person merged it", () => {
  /**
   * The one thing the harness never does for itself. VERIFYING is only entered
   * off a merged SHA, and a deploy status is only ever recorded for a commit on
   * the base branch — so either is proof, and PR_REVIEW alone is not.
   */
  it("takes VERIFYING, DONE or a recorded deploy as proof and nothing else", async () => {
    const { store, bus } = run();
    expect(await wasMerged(store, "run-1")).toBe(false);

    bus.publish({ type: "run.deploy_status", runId: "run-1", sha: "abc", state: "failing", failing: ["cd"], total: 1, ts: 1 });
    expect(await wasMerged(store, "run-1")).toBe(true);

    const fresh = run().store;
    fresh.transitionRun("run-1", "PLANNING");
    fresh.transitionRun("run-1", "PLAN_REVIEW");
    fresh.transitionRun("run-1", "EXECUTING");
    fresh.transitionRun("run-1", "INTEGRATING");
    fresh.transitionRun("run-1", "PR_REVIEW");
    expect(await wasMerged(fresh, "run-1")).toBe(false);
    fresh.transitionRun("run-1", "VERIFYING");
    expect(await wasMerged(fresh, "run-1")).toBe(true);
  });

  it("says no about a run that does not exist", async () => {
    expect(await wasMerged(run().store, "nope")).toBe(false);
  });

  /**
   * Run 1e7d3df3's report was published headlined "Nothing Shipped Yet" over a
   * pull request that had been merged: the run ended at PR_REVIEW, nobody
   * resumed it, and the report repeated the run's last memory of itself as
   * though it were the state of the world.
   */
  it("asks GitHub about a run whose own history stopped before the merge", async () => {
    const { store } = run();
    task(store, { id: "a", prNumber: 26 });
    task(store, { id: "b", prNumber: 26 });
    store.transitionRun("run-1", "PLANNING");
    store.transitionRun("run-1", "PLAN_REVIEW");
    store.transitionRun("run-1", "EXECUTING");
    store.transitionRun("run-1", "INTEGRATING");
    store.transitionRun("run-1", "PR_REVIEW");

    const asked: number[] = [];
    expect(await wasMerged(store, "run-1", async (pr) => (asked.push(pr), "sha123"))).toBe(true);
    expect(asked).toEqual([26]);
    // No merge commit means the pull request is genuinely still open.
    expect(await wasMerged(store, "run-1", async () => null)).toBe(false);
  });

  /**
   * Reporting "not merged" because the network was down is the same mistake in
   * the other direction, so a question that cannot be reached leaves the run's
   * own record standing.
   */
  it("keeps the run's own record when GitHub cannot be reached", async () => {
    const { store } = run();
    task(store, { id: "a", prNumber: 26 });
    expect(
      await wasMerged(store, "run-1", () => Promise.reject(new Error("network unreachable")))
    ).toBe(false);
  });

  it("does not ask about a run that never opened a pull request", async () => {
    const { store } = run();
    task(store, { id: "a", prNumber: null });
    let asked = false;
    expect(await wasMerged(store, "run-1", async () => ((asked = true), "sha"))).toBe(false);
    expect(asked).toBe(false);
  });

  it("asks about the pull request the most tasks point at", () => {
    const { store } = run();
    task(store, { id: "a", prNumber: 7 });
    task(store, { id: "b", prNumber: 26 });
    task(store, { id: "c", prNumber: 26 });
    expect(rollupPrNumber(store, "run-1")).toBe(26);
    expect(rollupPrNumber(run().store, "run-1")).toBeNull();

    // Two pull requests carrying the same number of tasks: the later one is the
    // rollup, because per-task branches stack and the last opened carries most.
    const tied = run().store;
    task(tied, { id: "x", prNumber: 12 });
    task(tied, { id: "y", prNumber: 30 });
    expect(rollupPrNumber(tied, "run-1")).toBe(30);
  });
});

describe("what this checkout actually sets", () => {
  it("reads the real env files and ignores the ones that are not there", () => {
    const dir = scratch();
    writeFileSync(path.join(dir, ".env"), "STRIPE_SECRET_KEY=sk_live\nEMPTY=\n");
    writeFileSync(path.join(dir, ".env.production"), "PROD_TOKEN=abc\n");
    expect(configuredEnv(dir).sort()).toEqual(["PROD_TOKEN", "STRIPE_SECRET_KEY"]);
    expect(configuredEnv(scratch())).toEqual([]);
  });
});

describe("reading what the run changed", () => {
  /**
   * Commit dates are pinned rather than left to the clock. The fallback below
   * splits history on "the last commit that predates the run", and git's
   * `--before` resolves to whole seconds — so a fixture whose commits all land
   * inside one second cannot exercise it. A real run takes hours.
   */
  const BEFORE = "2026-08-01T00:00:00Z";
  const AFTER = "2026-08-03T00:00:00Z";
  const STARTED = Date.UTC(2026, 7, 2);

  const KEYS = ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"] as const;
  const commit = async (dir: string, message: string, when: string) => {
    const prior = KEYS.map((k) => process.env[k]);
    for (const k of KEYS) process.env[k] = when;
    try {
      await git(dir, ["commit", "-qm", message]);
    } finally {
      // Deleted, not assigned back: `process.env.X = undefined` stores the
      // *string* "undefined", and the next `git checkout -b` stamps a reflog
      // entry with it and dies on an invalid date.
      KEYS.forEach((k, i) => {
        const was = prior[i];
        if (was === undefined) delete process.env[k];
        else process.env[k] = was;
      });
    }
  };

  const repo = async (): Promise<string> => {
    const dir = scratch();
    await git(dir, ["init", "-q", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@t.test"]);
    await git(dir, ["config", "user.name", "T"]);
    writeFileSync(path.join(dir, "README.md"), "base\n");
    await git(dir, ["add", "-A"]);
    await commit(dir, "base", BEFORE);
    return dir;
  };

  it("reads the diff against the base while the pull request is still open", async () => {
    const dir = await repo();
    await git(dir, ["checkout", "-qb", "harness/run-1/main"]);
    writeFileSync(path.join(dir, "app.ts"), "process.env.MY_API_KEY\n");
    await git(dir, ["add", "-A"]);
    await commit(dir, "work", AFTER);

    const diff = await changedFiles(dir, "main", "harness/run-1/main", STARTED);
    expect(diff.read).toBe(true);
    expect(diff.files).toEqual([{ path: "app.ts", text: "process.env.MY_API_KEY" }]);
    expect(diff.basis).toContain("between `main` and the run's branch");
  });

  /**
   * The case the obvious command cannot answer, and the one every finished run
   * reaches: once a human merges, the integration branch is an *ancestor* of
   * the base and `base...integration` correctly reports nothing changed.
   */
  it("still reads the diff after the pull request has been merged", async () => {
    const dir = await repo();
    await git(dir, ["checkout", "-qb", "harness/run-1/main"]);
    writeFileSync(path.join(dir, "app.ts"), "process.env.MY_API_KEY\n");
    await git(dir, ["add", "-A"]);
    await commit(dir, "work", AFTER);
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["merge", "-q", "--ff-only", "harness/run-1/main"]);

    expect((await git(dir, ["diff", "--name-only", "main...harness/run-1/main"])).trim()).toBe("");
    const diff = await changedFiles(dir, "main", "harness/run-1/main", STARTED);
    expect(diff.read).toBe(true);
    expect(diff.files.map((f) => f.path)).toEqual(["app.ts"]);
    expect(diff.basis).toContain("the last commit that predates it");
  });

  /**
   * The answer that matters most. A report saying "no switches were found"
   * because the branch was pruned is indistinguishable from one saying it
   * because the run left nothing off, and they are opposite facts.
   */
  it("says it could not read the diff rather than reporting nothing changed", async () => {
    const dir = await repo();
    const diff = await changedFiles(dir, "main", "harness/gone/main", STARTED);
    expect(diff.read).toBe(false);
    expect(diff.files).toEqual([]);
    expect(diff.basis).toContain("no longer exists in this checkout");
  });

  it("says so when the branch exists but has no history before the run", async () => {
    const dir = await repo();
    const diff = await changedFiles(dir, "main", "main", 0);
    expect(diff.read).toBe(false);
    expect(diff.basis).toContain("could not be made to say where run history");
  });

  it("leaves out a file the run deleted, because a gone file declares nothing", async () => {
    const dir = await repo();
    await git(dir, ["checkout", "-qb", "harness/run-1/main"]);
    await git(dir, ["rm", "-q", "README.md"]);
    writeFileSync(path.join(dir, "app.ts"), "ok\n");
    await git(dir, ["add", "-A"]);
    await commit(dir, "work", AFTER);

    const diff = await changedFiles(dir, "main", "harness/run-1/main", STARTED);
    expect(diff.files.map((f) => f.path)).toEqual(["app.ts"]);
  });
});

describe("assembling the report", () => {
  it("refuses to report on a run that does not exist", () => {
    expect(() => buildCompletionReport(sources(run().store, { runId: "nope" }))).toThrow("unknown run nope");
  });

  it("carries the run's own numbers and the ledger through", () => {
    const { store } = run();
    task(store, { id: "a", title: "Checkout", prNumber: 7, touchedPaths: ["src/checkout.ts"] });
    store.recordUsage({ runId: "run-1", sessionId: "s1", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 12.5 });

    const report = buildCompletionReport(sources(store, { project: "demo", changed: [{ path: "src/checkout.ts", text: "process.env.STRIPE_SECRET_KEY" }] }));
    expect(report.project).toBe("demo");
    expect(report.spentUsd).toBe(12.5);
    expect(report.prodUrl).toBe("https://x.test");
    expect(report.ledger.switches.map((s) => s.name)).toEqual(["STRIPE_SECRET_KEY"]);
    expect(report.wallClockHours).toBeGreaterThanOrEqual(0);
  });

  it("does not treat a name this checkout sets as a switch that is off", () => {
    const { store } = run();
    task(store, { id: "a", title: "Checkout" });
    const report = buildCompletionReport(
      sources(store, { changed: [{ path: "src/checkout.ts", text: "process.env.STRIPE_SECRET_KEY" }], configured: ["STRIPE_SECRET_KEY"] })
    );
    expect(report.ledger.switches).toEqual([]);
  });

  /**
   * A merged task's old escalation was answered. Reprinting it as though it
   * were still outstanding is how a report invents work for its reader.
   */
  it("attaches a runbook only to the task that is still asking for one", () => {
    const { store, bus } = run();
    task(store, { id: "a", title: "Auth" });
    task(store, { id: "b", title: "Billing" });
    const runbook = { blocked: "needs a real account", steps: [{ do: "Create it", command: "stripe login" }], sendBack: "the account id" };
    bus.publish({ type: "task.gate_opened", runId: "run-1", taskId: "a", why: "w", iterations: 1, recommendation: "r", runbook, ts: 1 });
    bus.publish({ type: "task.gate_opened", runId: "run-1", taskId: "b", why: "w", iterations: 1, recommendation: "r", runbook, ts: 2 });
    store.transitionTask("run-1", "a", "READY");
    store.transitionTask("run-1", "a", "NEEDS_HUMAN", "parked");

    const report = buildCompletionReport(sources(store));
    expect(report.ledger.entries.find((e) => e.taskId === "a")!.runbook).toEqual(runbook);
    expect(report.ledger.entries.find((e) => e.taskId === "b")!.runbook).toBeNull();
  });

  it("attaches no runbook to a task that parked without ever opening a gate", () => {
    const { store } = run();
    task(store, { id: "a", title: "Auth" });
    store.transitionTask("run-1", "a", "READY");
    store.transitionTask("run-1", "a", "NEEDS_HUMAN", "the worktree would not build");

    expect(buildCompletionReport(sources(store)).ledger.entries[0]!.runbook).toBeNull();
  });

  /**
   * An empty runbook is worse than none: it takes the space the prose
   * recommendation would have filled and says nothing.
   */
  it("attaches no runbook when the gate carried one with no steps in it", () => {
    const { store, bus } = run();
    task(store, { id: "a", title: "Auth" });
    bus.publish({ type: "task.gate_opened", runId: "run-1", taskId: "a", why: "w", iterations: 1, recommendation: "r", runbook: { blocked: "b", steps: [], sendBack: "s" }, ts: 1 });
    store.transitionTask("run-1", "a", "READY");
    store.transitionTask("run-1", "a", "NEEDS_HUMAN", "parked");

    expect(buildCompletionReport(sources(store)).ledger.entries[0]!.runbook).toBeNull();
  });

  it("falls back to the run's configured production URL when nothing checked it", () => {
    const { store } = run();
    expect(buildCompletionReport(sources(store)).prodUrl).toBe("https://x.test");
  });

  it("has no production URL at all for a run that was never given one", () => {
    const { store } = run();
    store.patchRunConfig("run-1", { prodUrl: "" });
    expect(buildCompletionReport(sources(store)).prodUrl).toBe("");
  });

  it("prefers the URL that was actually checked", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.prod_verdict", runId: "run-1", url: "https://checked.test", verdict: "PASS", findings: [], summary: "s", ts: 1 });
    expect(buildCompletionReport(sources(store, { outcome: outcomeFacts(store, "run-1") })).prodUrl).toBe("https://checked.test");
  });
});

describe("the inventory the reporter agent has to account for", () => {
  it("hands over every derived switch, numbered, and what is claimed live", () => {
    const { store } = run();
    task(store, { id: "a", title: "Checkout", touchedPaths: ["src/checkout.ts"] });
    const report = buildCompletionReport(sources(store, { changed: [{ path: "src/checkout.ts", text: "process.env.STRIPE_SECRET_KEY" }] }));

    const brief = reporterBrief(report);
    expect(brief).toContain("account for every one");
    expect(brief).toContain("1. [secret] STRIPE_SECRET_KEY — declared at src/checkout.ts:1");
    expect(brief).toContain("Production: https://x.test");
  });

  it("says plainly when there is nothing derived and no production to check", () => {
    const { store } = run();
    store.patchRunConfig("run-1", { prodUrl: "" });
    const brief = reporterBrief(buildCompletionReport(sources(store)));
    expect(brief).toContain("No switches were derived");
    expect(brief).toContain("no URL is configured");
  });

  it("lists what is being reported live so the agent can attack it", () => {
    const { store, bus } = run();
    task(store, { id: "a", title: "Checkout" });
    store.transitionTask("run-1", "a", "READY");
    store.transitionTask("run-1", "a", "WORKING");
    store.transitionTask("run-1", "a", "QA");
    store.transitionTask("run-1", "a", "ACCEPTED");
    store.transitionTask("run-1", "a", "MERGED");
    bus.publish({ type: "run.deploy_status", runId: "run-1", sha: "abc", state: "passing", failing: [], total: 1, ts: 1 });
    bus.publish({ type: "run.prod_verdict", runId: "run-1", url: "https://x.test", verdict: "PASS", findings: [], summary: "s", ts: 2 });

    const report = buildCompletionReport(sources(store, { merged: true, outcome: outcomeFacts(store, "run-1") }));
    expect(reporterBrief(report)).toContain("Reported as live");
    expect(reporterBrief(report)).toContain("- Checkout");
  });
});

describe("assembling a report from a run id and a checkout", () => {
  const KEYS = ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"] as const;
  const repo = async (): Promise<string> => {
    const dir = scratch();
    await git(dir, ["init", "-q", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@t.test"]);
    await git(dir, ["config", "user.name", "T"]);
    writeFileSync(path.join(dir, "README.md"), "base\n");
    await git(dir, ["add", "-A"]);
    for (const k of KEYS) process.env[k] = "2026-08-01T00:00:00Z";
    await git(dir, ["commit", "-qm", "base"]);
    for (const k of KEYS) delete process.env[k];
    await git(dir, ["checkout", "-qb", "harness/run-1/main"]);
    writeFileSync(path.join(dir, ".env.example"), "STRIPE_SECRET_KEY=\n");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-qm", "work"]);
    return dir;
  };

  it("reads the diff, finds the switches, and links the pull requests to the remote", async () => {
    const dir = await repo();
    const { store } = run();
    // What a real run records when it starts. Without it the diff is taken
    // against `HEAD`, which on the run's own branch is the branch itself.
    store.patchRunConfig("run-1", { baseBranch: "main" });
    task(store, { id: "a", title: "Checkout", prNumber: 26 });
    task(store, { id: "b", title: "Refunds", prNumber: 26 });
    // A task that never reached a pull request contributes no number at all.
    task(store, { id: "c", title: "Admin", prNumber: null });

    const report = await assembleReport({ store, repoPath: dir, runId: "run-1", merged: false, slug: "ryabinski-labs/icelandcopilot-companion", origin: "cli", now: 1 });
    expect(report.project).toBe("icelandcopilot-companion");
    expect(report.ledger.switches.map((s) => s.name)).toEqual(["STRIPE_SECRET_KEY"]);
    // One rollup pull request shared by both tasks, listed once.
    expect(report.prs).toEqual([{ number: 26, title: "#26", url: "https://github.com/ryabinski-labs/icelandcopilot-companion/pull/26" }]);
    expect(report.method).toContain("Nothing here was verified against the running system");
  });

  it("falls back to the run's own configured repository when the caller resolved none", async () => {
    const dir = await repo();
    const { store } = run();
    store.patchRunConfig("run-1", { githubRepo: "acme/widgets", baseBranch: "main" });

    const report = await assembleReport({ store, repoPath: dir, runId: "run-1", merged: true, origin: "done", now: 1 });
    expect(report.project).toBe("widgets");
    expect(report.method).toContain("Written when the run reached DONE");
  });

  it("names the project by its directory when there is no remote at all", async () => {
    const dir = await repo();
    const { store } = run();
    task(store, { id: "a", title: "Checkout", prNumber: 26 });

    const report = await assembleReport({ store, repoPath: dir, runId: "run-1", merged: false, origin: "cli", now: 1 });
    expect(report.project).toBe(path.basename(dir));
    expect(report.prs).toEqual([{ number: 26, title: "#26", url: "" }]);
  });

  it("says the diff was unreadable rather than letting it read as nothing found", async () => {
    const dir = await repo();
    const { store } = run();
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, ["branch", "-qD", "harness/run-1/main"]);

    const report = await assembleReport({ store, repoPath: dir, runId: "run-1", merged: false, origin: "cli", now: 1 });
    expect(report.couldNotCheck[0]).toContain("not for want of switches");
    expect(report.ledger.switches).toEqual([]);
  });

  it("refuses a run it does not have", async () => {
    await expect(assembleReport({ store: run().store, repoPath: scratch(), runId: "nope", merged: false, origin: "cli", now: 1 })).rejects.toThrow("unknown run nope");
  });

  it("puts a run's report where both the controller and the CLI look for it", () => {
    expect(reportPath("/repo", "run-1")).toBe(path.join("/repo", ".harness", "reports", "run-1.html"));
  });
});

describe("what the specification proves, on the finished page", () => {
  // Parsed rather than hand-written: the event carries a complete RunSpec, and
  // spelling out every default in a fixture is how a fixture drifts from the
  // schema it is standing in for.
  const SPEC = RunSpec.parse({
    feature: "checkout",
    artifactPath: "tdd/checkout.tdd.yaml",
    requirements: [
      { id: "REQ-001", text: "charge a card", priority: "P0" as const },
      { id: "REQ-002", text: "refund a charge", priority: "P0" as const },
      { id: "REQ-003", text: "export a report", priority: "P2" as const },
    ],
    scenarios: [
      { id: "SC-001", requirement: "REQ-001", priority: "P0" as const, level: "unit" as const },
      { id: "SC-002", requirement: "REQ-002", priority: "P0" as const, level: "unit" as const },
    ],
    commands: { all: "npx vitest run tests/tdd", byId: 'npx vitest run -t "{{ids}}"' },
  });

  /**
   * The other half of the same question: proof asks whether a promise is
   * checked, scope asks whether anyone ever delivered it. A run can ship a
   * requirement whose scenario is red, and the operator needs both readings.
   */
  it("sorts every requirement into what became of it, and carries the write-off answer through", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    task(store, { id: "shipped-it", state: "MERGED", scenarioIds: ["SC-001"] });
    task(store, { id: "gave-up", state: "CANCELLED", scenarioIds: ["SC-002"], errorSummary: "unreachable: dependencies parked" });
    bus.publish({ type: "run.scope_written_off", runId: "run-1", requirementId: "REQ-002", requirement: "refund a charge", answer: "next run", decidedBy: "operator", claimants: [], ts: 2 });

    const scope = buildCompletionReport(sources(store)).scope!;
    expect(scope.shipped).toBe(1);
    expect(scope.writtenOff).toEqual([{ id: "REQ-002", text: "refund a charge", answer: "next run" }]);
    expect(scope.dropped).toEqual([]);
    // REQ-003 is a nice-to-have nobody claimed: reported, never a hold.
    expect(scope.unclaimed).toEqual([{ id: "REQ-003", text: "export a report" }]);
  });

  it("names what a dropped requirement was last seen doing", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    task(store, { id: "gave-up", state: "CANCELLED", scenarioIds: ["SC-001"], errorSummary: "unreachable: dependencies parked" });

    const scope = buildCompletionReport(sources(store)).scope!;
    expect(scope.dropped).toEqual([{ id: "REQ-001", text: "charge a card", why: "gave-up CANCELLED (unreachable: dependencies parked)" }]);
  });

  it("says only what it knows about a claimant that left no reason", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    task(store, { id: "vanished", state: "CANCELLED", scenarioIds: ["SC-001"] });

    expect(buildCompletionReport(sources(store)).scope!.dropped).toEqual([{ id: "REQ-001", text: "charge a card", why: "vanished CANCELLED" }]);
  });

  it("has no scope section at all for a run that was never specified", () => {
    const { store } = run();
    expect(buildCompletionReport(sources(store)).scope).toBeNull();
  });

  /**
   * "Nothing is proven because nothing was ever checked" and "nothing is proven
   * because every check failed" are opposite facts, and a row of zeroes reads
   * as the second.
   */
  it("has no proof section at all for a run that was never specified", () => {
    const { store } = run();
    expect(buildCompletionReport(sources(store)).coverage).toBeNull();
  });

  it("says the gate never ran, rather than implying the scenarios passed", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    const coverage = buildCompletionReport(sources(store)).coverage!;
    expect(coverage).toMatchObject({ proven: 2, broken: 0, unproven: ["REQ-003"], total: 3 });
    expect(coverage.line).toContain("acceptance gate never ran");
  });

  it("counts a requirement whose scenario is failing as broken", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    bus.publish({ type: "run.acceptance_verdict", runId: "run-1", passed: false, failing: ["SC-002"], named: true, blocked: [], line: "1 of 2 failing", ts: 2 });
    const coverage = buildCompletionReport(sources(store)).coverage!;
    expect(coverage).toMatchObject({ proven: 1, broken: 1 });
    expect(coverage.line).toContain("The acceptance gate is red: 1 of 2 failing.");
  });

  /** "No opinion" used to be spelled `passed: true`; the report must not read it as green. */
  it("says the gate had no opinion rather than carrying its line through as a pass", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    bus.publish({ type: "run.acceptance_verdict", runId: "run-1", verdict: "no-opinion", passed: false, failing: [], named: true, blocked: ["SC-001"], line: "all 1 gating scenario(s) are blocked", ts: 2 });
    const coverage = buildCompletionReport(sources(store)).coverage!;
    expect(coverage.line).toBe("The acceptance gate has no opinion: all 1 gating scenario(s) are blocked — nothing below was proven either way.");
  });

  it("carries a green gate's own sentence through", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    bus.publish({ type: "run.acceptance_verdict", runId: "run-1", passed: true, failing: [], named: true, blocked: [], line: "2 gating scenario(s) green", ts: 2 });
    expect(buildCompletionReport(sources(store)).coverage!.line).toBe("2 gating scenario(s) green");
  });

  /**
   * A red suite that named nothing tells you a promise broke and not which one,
   * so no requirement may be reported as proven off the back of it.
   */
  it("refuses to name a proven requirement when the gate could not say what failed", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: SPEC, ts: 1 });
    bus.publish({ type: "run.acceptance_verdict", runId: "run-1", passed: false, failing: [], named: false, blocked: [], line: "red", ts: 2 });
    const coverage = buildCompletionReport(sources(store)).coverage!;
    expect(coverage.line).toContain("named no scenario");
    expect(coverage.line).toContain("unproven rather than passing");
  });

  it("has no proof section for a specification that declares no requirement", () => {
    const { store, bus } = run();
    bus.publish({ type: "run.spec_ready", runId: "run-1", spec: RunSpec.parse({ ...SPEC, requirements: [] }), ts: 1 });
    expect(buildCompletionReport(sources(store)).coverage).toBeNull();
  });
});
