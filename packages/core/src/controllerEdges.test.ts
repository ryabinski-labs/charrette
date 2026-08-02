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
      dependsOn: [], touchedPaths: [], estimatedSize: "S" as const,
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

const BASE = { deterministicChecks: [] as string[], waitForChecks: false };

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

    await expect(
      controller.startRun("build a thing", RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", budget: { runCapUsd: 22, taskCapUsd: 1000 } }))
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
      controller.startRun("build a thing", RunConfig.parse({ ...BASE, budget: { runCapUsd: 22, taskCapUsd: 1000 } }))
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
      controller.startRun("build a thing", RunConfig.parse({ ...BASE, maxParallelWorkers: 2, budget: { runCapUsd: 20, taskCapUsd: 1000 } }))
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

    await controller.startRun("add rate limiting to the API\nand nothing else", RunConfig.parse(BASE));

    expect(created[0]!.title).toContain("add rate limiting to the API");
    // One task, one gap: both singular.
    expect(created[0]!.body).toMatch(/1 task merged/);
    expect(created[0]!.body).toMatch(/Intent check: \*\*FAIL\*\* — 1 gap:/);
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
    vi.spyOn(reaper, "reapUnder").mockResolvedValue([{ pid: 1, command: "sleep 99", signal: "SIGKILL" }]);

    await controller.resume("run1");

    expect(logs(events).some((t) => /swept 1 process left over/.test(t))).toBe(true);
  });
});

describe("a task gate opened before anything was rejected", () => {
  /**
   * The wall-clock gate is the only one that does not know its own cause: every
   * other gate names the failure that opened it. Reaching it with nothing yet
   * rejected takes the merge-conflict path, which is the one loop that comes
   * back round without recording a rejection.
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
        if (/ACCEPTED by QA/.test(spec.prompt)) {
          // Handed a conflict it cannot settle, and slow about it.
          offset = 2 * 60 * 60 * 1000;
          return "I could not work out which side to keep";
        }
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
          // Answer the conflict gate so the loop comes back round once more —
          // that next pass is the one whose wall clock has already blown, with
          // nothing yet rejected to explain it.
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
