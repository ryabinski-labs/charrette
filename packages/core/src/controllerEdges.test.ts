import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler, type TaskGate } from "./runController.js";
import { Store } from "./store.js";

/**
 * The remaining arms: the sentences that change with a count, the fallbacks for
 * a value that is normally there, and the budget stop landing in each of the
 * stages that has to let it through rather than swallowing it.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function repo(opts: { remote?: boolean; detached?: boolean } = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-edge-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  if (opts.remote) {
    const remote = mkdtempSync(path.join(tmpdir(), "harness-edge-remote-"));
    made.push(remote);
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "ignore" });
    run("remote", "add", "origin", remote);
    run("push", "-q", "origin", "main");
  }
  if (opts.detached) run("checkout", "--detach");
  return dir;
}

function commitInWorktree(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), "done\n");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", `add ${file}`], { cwd, stdio: "ignore" });
}

const DOCS = (heading = "# PRD — Build the thing") => `<prd>\n${heading}\n</prd>\n<conventions>\nuse vitest\n</conventions>`;
const QA_PASS = '```json\n{"verdict":"PASS","notes":"ok"}\n```';

const dagJson = (ids: string[] = ["task-a"]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: ids.map((id) => ({
      id, epicId: "epic-e", title: id.toUpperCase(), spec: "s", acceptanceCriteria: ["x"],
      dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

type Answer = string | ((spec: AgentSpec, nth: number) => string | Partial<AgentResult> | Error);

function rolePool(answers: Partial<Record<string, Answer>>, opts: { bill?: number; noSdkSession?: boolean } = {}) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const ref = { store: null as Store | null };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      if (opts.bill && ref.store) {
        ref.store.recordUsage({
          runId: spec.runId, taskId: spec.taskId, sessionId: `s${specs.length}`, model: spec.model,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: opts.bill,
        });
      }
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const base: AgentResult = {
        sessionId: `s${specs.length}`,
        ...(opts.noSdkSession ? {} : { sdkSessionId: `sdk${specs.length}` }),
        resultText: "", costUsd: opts.bill ?? 0, turns: 1, outcome: "done",
      };
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

function fakeGithub(over: Record<string, unknown> = {}) {
  const adapter = new GitHubAdapter("token", "acme/widgets");
  const comments: { issue: number; body: string }[] = [];
  let nextIssue = 100;
  (adapter as unknown as { octokit: unknown }).octokit = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        create: async () => ({ data: { number: ++nextIssue, html_url: `https://x.invalid/issues/${nextIssue}` } }),
        listComments: async () => ({ data: [] }),
        createComment: async (a: { issue_number: number; body: string }) => (comments.push({ issue: a.issue_number, body: a.body }), { data: {} }),
        get: async () => ({ data: { state: "open" } }),
        update: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 51, html_url: "https://x.invalid/pull/51" } }),
        get: async () => ({ data: { state: "open", draft: false, merged_at: null, head: { sha: "abc" } } }),
        update: async () => ({ data: {} }),
      },
      checks: { listForRef: async () => ({ data: [] }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
      ...over,
    },
    graphql: async () => ({}),
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
  };
  return { adapter, comments };
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

const worker = (spec: AgentSpec, nth: number) => (commitInWorktree(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");
const logs = (events: HarnessEvent[]) => events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log").map((e) => e.text);

// The forge is off because the budget cases below are calibrated in sessions:
// a skillsmith session for these skill-less tasks would move each breach off
// the stage it is aimed at. The forge's own stage has the same rethrow test
// in skillForgeRun.test.ts.
const BASE = { deterministicChecks: [] as string[], waitForChecks: false, skillForge: { enabled: false } };

describe("a budget stop reaching each stage that must let it through", () => {
  /**
   * Every one of these catches an exception and carries on — which is right for
   * a stage that failed, and wrong for a run that is out of money. Swallowing
   * the stop would keep spending after the operator said no.
   */
  it.each([
    ["the intent validator", "validator"],
    ["the production check", "prod"],
  ])("stops the run rather than being swallowed by %s", async (_name, role) => {
    const dir = repo();
    const { pool, ref } = rolePool(
      {
        planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
        worker,
        qa: () => QA_PASS,
        // Bills enough to trip the cap the moment this stage starts.
        [role]: () => "",
      },
      { bill: 5 }
    );
    const { controller, store } = build({
      repoPath: dir,
      pool,
      gates: { async resolveBudgetGate() { return null; } },
    });
    ref.store = store;

    // The plan-intent check shares the validator role and runs first, so with it
    // on the cap would trip at the plan gate and never reach the stage under
    // test. It has its own case below.
    await expect(
      controller.startRun(
        "build a thing",
        RunConfig.parse({ ...BASE, planIntentCheck: false, prodUrl: "https://app.example.com", budget: { runCapUsd: 22 } })
      )
    ).rejects.toThrow(/budget exceeded/);
  });

  it("stops the run rather than being swallowed by the plan-intent check", async () => {
    // This one catches too — an unchecked plan is still a plan the operator may
    // approve — so it has the same way of hiding a budget stop as the others.
    const dir = repo();
    const { pool, ref } = rolePool(
      {
        planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
        worker,
        qa: () => QA_PASS,
        validator: () => "",
      },
      { bill: 5 }
    );
    const { controller, store } = build({
      repoPath: dir,
      pool,
      gates: { async resolveBudgetGate() { return null; } },
    });
    ref.store = store;

    await expect(
      controller.startRun("build a thing", RunConfig.parse({ ...BASE, budget: { runCapUsd: 3 } }))
    ).rejects.toThrow(/budget exceeded/);
  });

  it("stops the run rather than being swallowed by the verdict re-ask", async () => {
    const dir = repo();
    const { pool, ref } = rolePool(
      {
        planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
        worker,
        // Never writes the verdict, so the re-ask runs — and trips the cap.
        qa: () => "no verdict here",
      },
      { bill: 6 }
    );
    const { controller, store } = build({ repoPath: dir, pool, gates: { async resolveBudgetGate() { return null; } } });
    ref.store = store;

    await expect(
      controller.startRun("build a thing", RunConfig.parse({ ...BASE, budget: { runCapUsd: 22 } }))
    ).rejects.toThrow(/budget exceeded/);
  });

  it("does not re-open the gate for every other session once the operator has declined", async () => {
    const dir = repo();
    let asked = 0;
    const { pool, ref } = rolePool(
      {
        planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson(["task-a", "task-b"])),
        worker,
        qa: () => QA_PASS,
      },
      { bill: 8 }
    );
    const { controller, store } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolveBudgetGate() {
          asked++;
          return null;
        },
      },
    });
    ref.store = store;

    await expect(
      controller.startRun("build a thing", RunConfig.parse({ ...BASE, maxParallelWorkers: 2, budget: { runCapUsd: 20 } }))
    ).rejects.toThrow(/budget exceeded/);

    // The run sits in BUDGET_HOLD; every later check stops without asking again.
    expect(asked).toBe(1);
  });
});

describe("following a merge that has not happened yet", () => {
  it("waits rather than verifying when nobody has merged the pull request", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      prod: () => '```json\n{"verdict":"PASS","findings":[],"summary":"ok"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com" }));

    // Merging is the boundary the harness does not cross; waiting is not failing.
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.prodVerdict(runId)).toBeNull();
    expect(controller.awaitingVerification(runId)).toBe(true);
  });

  it("reports a red deploy as merged but not live, and stays open", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub({
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 51, html_url: "https://x.invalid/pull/51" } }),
        get: async () => ({ data: { state: "closed", draft: false, merged_at: "2026-08-01T00:00:00Z", merge_commit_sha: "abc123", head: { sha: "abc123" } } }),
        update: async () => ({ data: {} }),
      },
      checks: { listForRef: async () => ({ data: [{ name: "deploy-prod", status: "completed", conclusion: "failure" }] }) },
    });
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      prod: () => '```json\n{"verdict":"PASS","findings":[],"summary":"ok"}\n```',
    });
    const { controller, store, events } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1 })
    );

    expect(store.getRun(runId)!.state).toBe("VERIFYING");
    expect(logs(events).some((t) => /deployed red: deploy-prod — the change is merged but not live/.test(t))).toBe(true);
    // Production is never asked about a deploy that did not land.
    expect(store.prodVerdict(runId)).toBeNull();
  });
});

describe("opening pull requests from a detached HEAD", () => {
  it("refuses rather than guessing a base branch", async () => {
    const dir = repo({ remote: true, detached: true });
    const { adapter } = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller, events } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    // Reported, not thrown: the work is merged locally either way, and losing
    // the run over a missing branch name would throw that away.
    expect(logs(events).some((t) => /pull request could not be opened[\s\S]*detached HEAD/.test(t))).toBe(true);
  });

  it("refuses the same way for per-task pull requests", async () => {
    const dir = repo({ remote: true, detached: true });
    const { adapter } = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller, events } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prMode: "per-task" }));

    expect(logs(events).some((t) => /pull request could not be opened[\s\S]*detached HEAD/.test(t))).toBe(true);
  });
});

describe("the pull request's title and body", () => {
  it("takes the title from the assignment when the PRD has no heading", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { title: string; body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: {
      title: string;
      body: string;
    }) => (created.push(a), { data: { number: 51, html_url: "https://x.invalid/pull/51" } });
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"FAIL","gaps":["no offline mode"],"summary":"most of it"}\n```',
    });
    const { controller } = build({ repoPath: dir, pool, github: adapter });

    // The gap is a fixture for the singular wording, not work to do: without
    // this the harness queues a task to close it and the counts stop being one.
    await controller.startRun("add rate limiting to the API\nand nothing else", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    expect(created[0]!.title).toContain("add rate limiting to the API");
    // One task, one gap: both singular.
    expect(created[0]!.body).toMatch(/1 task merged/);
    expect(created[0]!.body).toMatch(/Intent check: \*\*FAIL\*\* — 1 gap:/);
  });

  /**
   * Run 1e7d3df3's rollup carried `Intent check: FAIL` and four gaps in its own
   * description — the NetworkPolicy, the CloudFront CSP, the edge fleet roll,
   * and the session table nobody had applied — and was flipped ready anyway,
   * because the only question asked here was whether the tasks had stopped.
   * It was merged with the FAIL still in the body, dns-project's CD shipped the
   * application half of it, and the console answered 503 to every request.
   *
   * A verdict a reviewer has to notice is not a control. A draft is one.
   */
  it("holds the rollup as a draft when the intent check failed", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { draft?: boolean; body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: {
      draft?: boolean;
      body: string;
    }) => (created.push(a), { data: { number: 52, html_url: "https://x.invalid/pull/52" } });
    let flippedReady = false;
    (adapter as unknown as { markPrReady: unknown }).markPrReady = async () => ((flippedReady = true), true);
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"FAIL","gaps":["the NetworkPolicy was never applied"],"summary":"half of it"}\n```',
    });
    const { controller } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("roll the edge fleet", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    expect(created[0]!.draft).toBe(true);
    expect(flippedReady).toBe(false);
    // And the body says why, so the draft is not a mystery the operator clears
    // by clicking the button the moment they notice it.
    expect(created[0]!.body).toContain("**This PR is held as a draft because of that.**");
  });

  /**
   * The intent check asks whether the work is there. It cannot ask whether the
   * work was ever exercised, because a task satisfied entirely against mocks
   * arrives at it looking exactly like one that was run for real — so a run can
   * pass every gate here and still have shipped something nobody ran.
   *
   * dns-project's af60742 is what that costs. Its own commit message ends "NOT YET
   * verified this session (turn budget ran out first)" and names both halves of
   * the outage that followed. The disclosure was written; nothing read it.
   */
  it("holds the rollup as a draft over a criterion QA passed without settling", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { draft?: boolean; body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: {
      draft?: boolean;
      body: string;
    }) => (created.push(a), { data: { number: 54, html_url: "https://x.invalid/pull/54" } });
    let flippedReady = false;
    (adapter as unknown as { markPrReady: unknown }).markPrReady = async () => ((flippedReady = true), true);
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      // A PASS — the work is accepted and merges. What it could not settle is
      // the session table's live behaviour, said out loud instead of implied.
      qa: () =>
        '```json\n{"verdict":"PASS","notes":"ok","unverified":["criterion 3: revocation exercised only against an in-memory double; no live DynamoDB run"]}\n```',
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"does what was asked"}\n```',
    });
    const { controller } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("move session revocation to its own table", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    // The intent check PASSED. The hold comes from the unverified list alone —
    // if it did not, this run would ship exactly the way dns-project's did.
    expect(created[0]!.draft).toBe(true);
    expect(flippedReady).toBe(false);
    expect(created[0]!.body).toMatch(/Passed but \*\*not verified\*\* — 1 criterion/);
    expect(created[0]!.body).toContain("no live DynamoDB run");
  });

  it("names every unsettled criterion, and says so while the run is still going", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: { body: string }) =>
      (created.push(a), { data: { number: 55, html_url: "https://x.invalid/pull/55" } });
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      qa: () => '```json\n{"verdict":"PASS","notes":"ok","unverified":["no live DynamoDB run","the manifest was never applied"]}\n```',
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller, events } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("move session revocation to its own table", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    expect(created[0]!.body).toMatch(/Passed but \*\*not verified\*\* — 2 criteria/);
    expect(created[0]!.body).toContain("the manifest was never applied");
    // The PR is where an operator eventually reads this; the run's own log is
    // where they can see it at the moment it happens, with tasks still running.
    expect(logs(events).some((t) => /could not settle 2 criteria[\s\S]*no live DynamoDB run/.test(t))).toBe(true);
  });

  it("reports an intent check that reached no verdict as one that reached no verdict", async () => {
    // ledger-app a8df0107's validator was denied Bash, said so in prose, and
    // ended `done` having cost $2.58 and concluded nothing. That is honest
    // behaviour from the agent; what the harness lacked was anywhere to put
    // "could not tell", so the parse error became a log line and the run went
    // on quoting an earlier pass's verdict at a tree nobody had read. The run
    // closed with "intent check found 2 gaps" — one of which it had merged a
    // fix for an hour earlier, the other of which was never real.
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: { body: string }) =>
      (created.push(a), { data: { number: 57, html_url: "https://x.invalid/pull/57" } });
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      qa: () => '```json\n{"verdict":"PASS","notes":"ok","unverified":[]}\n```',
      // The shape of the real thing: a refusal to invent a verdict, in prose.
      validator: () => "Stopping tool use as instructed — Bash is being explicitly denied right now, so I won't retry it.",
    });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun("move session revocation to its own table", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    expect(store.intentCheckStale(runId)).toBe(true);
    expect(controller.outcome(runId).line).toContain("the intent check did not complete");
    expect(controller.outcome(runId).line).not.toContain("intent check passed");
    // And the reviewer is told the same thing, rather than being shown a
    // verdict about some other tree.
    expect(created[0]!.body).toContain("Intent check: **DID NOT COMPLETE**");
  });

  it("does not repeat an earlier pass's verdict when a later check reached none", async () => {
    // The full ledger-app a8df0107 shape, which needs two passes to reproduce:
    // the validator reaches a FAIL, the run queues the fixes and merges them,
    // and the next pass — the one that would have judged the tree those fixes
    // produced — ends without a verdict. The stored verdict then describes a
    // tree that no longer exists, and every surface went on quoting it: the PR
    // body, the closing line, the delivery ledger's "Gaps" section, and
    // `queueIntentFixes`, which would have paid a worker to close a gap the run
    // had already closed itself.
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: { body: string }) =>
      (created.push(a), { data: { number: 58, html_url: "https://x.invalid/pull/58" } });
    // The plan-intent check shares the `validator` role, so the two are told
    // apart the way the planner's two calls are: it is the one given no tools.
    let endOfRun = 0;
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      qa: () => '```json\n{"verdict":"PASS","notes":"ok","unverified":[]}\n```',
      validator: (s) => {
        if (Array.isArray(s.tools) && s.tools.length === 0) return '```json\n{"verdict":"PASS","gaps":[],"summary":"the plan covers it"}\n```';
        endOfRun += 1;
        return endOfRun === 1
          ? '```json\n{"verdict":"FAIL","gaps":["the worker is scheduled nowhere"],"summary":"half wired"}\n```'
          : "I could not run the checks I needed, so I am not going to state a verdict.";
      },
    });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun("wire up the disbursement worker", RunConfig.parse({ ...BASE, intentFixRounds: 1 }));

    // Both passes happened: a verdict is on record, and so is a later failure.
    expect(endOfRun).toBeGreaterThan(1);
    expect(store.intentVerdict(runId)!.verdict).toBe("FAIL");
    expect(store.intentCheckStale(runId)).toBe(true);

    // The reviewer is told there is no current answer, and told that the older
    // one is being withheld rather than silently dropped.
    const body = created.at(-1)!.body;
    expect(body).toContain("Intent check: **DID NOT COMPLETE**");
    expect(body).toContain("read a different tree and is not repeated here");
    expect(body).not.toContain("Intent check: **FAIL**");
    // The gap is not re-listed as an outstanding one. It survives only as the
    // title of the task the run queued to close it, which is the merged list
    // doing its job.
    expect(body).not.toContain("\n- the worker is scheduled nowhere");
    expect(body).toContain("- Close intent gap: the worker is scheduled nowhere (QA iterations:");

    // And the run's own closing line does not inherit it either.
    expect(controller.outcome(runId).line).toContain("the intent check did not complete");
    expect(controller.outcome(runId).intent).toBeNull();
  });

  it("caps the unsettled list rather than letting it grow the body past what GitHub accepts", async () => {
    // ledger-app a8df0107: 127 merged tasks carrying 159 unsettled criteria made
    // that one section 73,908 characters — over GitHub's 65,536-character limit
    // on its own, before the task list or the verdict were added. The 422 cost
    // the run its pull request at the one step it cannot retry itself, and
    // every entry was already capped at 500 chars: it was the count that was
    // unbounded. "The more the run builds, the more certainly it fails at the
    // last step" is the shape being designed out.
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: { body: string }) =>
      (created.push(a), { data: { number: 56, html_url: "https://x.invalid/pull/56" } });
    const many = Array.from({ length: 95 }, (_, i) => `criterion ${i} was never exercised against anything live`);
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      qa: () => `\`\`\`json\n${JSON.stringify({ verdict: "PASS", notes: "ok", unverified: many })}\n\`\`\``,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("move session revocation to its own table", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    const body = created[0]!.body;
    // The count is still reported in full — what is bounded is how many lines
    // it spends saying it.
    expect(body).toMatch(/Passed but \*\*not verified\*\* — 95 criteria/);
    expect(body).toContain("criterion 0 was never exercised");
    expect(body).toContain("…and 55 more");
    expect(body).toContain("REPORT.md");
    expect(body).not.toContain("criterion 94 was never exercised");
    expect(body.length).toBeLessThanOrEqual(65_536);
  });

  it("still flips the rollup ready when the intent check passed", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { draft?: boolean }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: { draft?: boolean }) =>
      (created.push(a), { data: { number: 53, html_url: "https://x.invalid/pull/53" } });
    let flippedReady = false;
    (adapter as unknown as { markPrReady: unknown }).markPrReady = async () => ((flippedReady = true), true);
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS("no heading here, just prose") : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"does what was asked"}\n```',
    });
    const { controller } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("roll the edge fleet", RunConfig.parse({ ...BASE, intentFixRounds: 0 }));

    expect(flippedReady).toBe(true);
  });

  it("cuts a very long title on a word boundary", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { title: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: { title: string }) =>
      (created.push(a), { data: { number: 51, html_url: "https://x.invalid/pull/51" } });
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS(`# ${"a rather wordy heading ".repeat(8)}`) : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"FAIL","gaps":[],"summary":""}\n```',
    });
    const { controller } = build({ repoPath: dir, pool, github: adapter });

    await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(created[0]!.title.length).toBeLessThanOrEqual(80);
    expect(created[0]!.title.endsWith("…")).toBe(true);
    expect(created[0]!.title).not.toMatch(/\s…$/);
  });

  it("says the gaps are unstated when the validator named none", async () => {
    const dir = repo({ remote: true });
    const { adapter } = fakeGithub();
    const created: { body: string }[] = [];
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async (a: { body: string }) =>
      (created.push(a), { data: { number: 51, html_url: "https://x.invalid/pull/51" } });
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
      worker,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"FAIL","gaps":[],"summary":""}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(created[0]!.body).toMatch(/unstated gaps/);
    expect(controller.outcome(runId).line).toContain("intent check found unstated gaps");
    expect(store.intentVerdict(runId)!.gaps).toEqual([]);
  });
});

describe("what the issue comment says when the harness knows less", () => {
  it("names no branch for a task that parked before it ever had one", async () => {
    const dir = repo({ remote: true });
    const { adapter, comments } = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
      worker,
      qa: () => QA_PASS,
    });
    // A file where the worktree root has to go: the task cannot be given a
    // branch at all, so the issue has nothing to point the operator at.
    writeFileSync(`${dir}-wt`, "not a directory");
    const { controller, store } = build({
      repoPath: dir,
      pool,
      github: adapter,
      gates: { async resolveTaskGate() { return null; } },
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getTask(runId, "task-a")!.branch).toBeNull();
    expect(comments.some((c) => /\*\*Parked for a human\*\*/.test(c.body) && /on \`no branch\`/.test(c.body))).toBe(true);
  });
});

describe("counting things the operator reads", () => {
  it("says one process, not one processes, when a sweep finds a single orphan", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller, store, events } = build({ repoPath: dir, pool });
    store.createRun({
      id: "run1", repoPath: dir, assignment: "a", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "harness/run1/main", config: RunConfig.parse({}),
    });
    for (const to of ["PLANNING", "PLAN_REVIEW", "EXECUTING", "BUDGET_HOLD"] as const) store.transitionRun("run1", to);
    const reaper = await import("./reaper.js");
    vi.spyOn(reaper, "reapUnder").mockResolvedValue([{ pid: 1, command: "sleep 99", signal: "SIGKILL", tooling: false }]);

    await controller.resume("run1");

    expect(logs(events).some((t) => /swept 1 process left over/.test(t))).toBe(true);
  });
});

describe("a task gate opened before anything was rejected", () => {
  /**
   * The wall-clock gate is the only one that does not know its own cause: every
   * other gate names the failure that opened it. Reaching it with nothing yet
   * rejected takes the merge-conflict path, which is the one loop that comes
   * back round without recording a rejection — and, since an answered gate
   * re-arms the clock, without an operator having been asked anything either.
   */
  it("says only that time passed, because that is all it knows", async () => {
    const dir = repo();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const gates: TaskGate[] = [];
    const { pool } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson(["task-a", "task-b"])),
      worker: (spec, nth) => {
        // Handed a conflict it cannot settle.
        if (/ACCEPTED by QA/.test(spec.prompt)) return "I could not work out which side to keep";
        // Slow about the work itself, which is what the bound is there to catch.
        // It has to be *this* session rather than the conflict-resolving one: an
        // answered gate re-arms the clock, so time spent before the gate cannot
        // open one after it, and only the unattended stretch counts. Additive
        // because both tasks run at once — an assignment could land entirely
        // before the second task started its own clock, and advance nothing.
        offset += 2 * 60 * 60 * 1000;
        commitInWorktree(spec.cwd, "shared.txt");
        writeFileSync(path.join(spec.cwd, "shared.txt"), `${path.basename(spec.cwd)} ${nth}\n`);
        execFileSync("git", ["add", "-A"], { cwd: spec.cwd, stdio: "ignore" });
        execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", "differ"], { cwd: spec.cwd, stdio: "ignore" });
        return "did the work";
      },
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolveTaskGate(gate) {
          gates.push(gate);
          return /merge conflicts/.test(gate.why) ? "keep both sides" : null;
        },
      },
    });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, taskWallClockMinutes: 30, maxParallelWorkers: 2 }));

    const wallClock = gates.find((g) => /still not accepted after 30 minutes/.test(g.why));
    expect(wallClock).toBeDefined();
    expect(wallClock!.why).not.toContain("Why the last iteration was sent back");
  });
});

describe("the advisor with nowhere of its own to work", () => {
  it("falls back to the repository when the task has no worktree yet", async () => {
    const dir = repo();
    const seen: AgentSpec[] = [];
    const { pool, specs } = rolePool({
      planner: (s) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS() : dagJson()),
      worker: () => new Error("boom"),
      advisor: (spec) => (seen.push(spec), ""),
    });
    const { controller, store } = build({
      repoPath: dir,
      pool,
      gates: { async resolveTaskGate() { return null; } },
    });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, workerRespawnCap: 1 }));
    store.updateTask(runId, "task-a", { worktreePath: null });
    void specs;

    // Reopening asks the advisor again, this time for a task with no worktree.
    await controller.resume(runId);

    expect(seen.at(-1)!.cwd).toBe(dir);
    expect(seen.at(-1)!.reapOnEnd).toBe(false);
  });
});
