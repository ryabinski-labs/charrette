import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The controller's other paths: resuming out of a state a run was interrupted
 * in, a plan the operator sent back, a production check that never completed,
 * and the sentences the closing line is assembled from. These are reached by a
 * real run often enough to matter and by the happy-path tests never.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function repo(withRemote = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-ctl-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  if (withRemote) {
    // A bare repo standing in for GitHub. Without somewhere to push, opening a
    // pull request fails and the run stops one step short of everything the
    // production check is about.
    const remote = mkdtempSync(path.join(tmpdir(), "harness-remote-"));
    made.push(remote);
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "ignore" });
    run("remote", "add", "origin", remote);
    run("push", "-q", "origin", "main");
  }
  return dir;
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";

const dagJson = (tasks = [{ id: "task-a", dependsOn: [] as string[] }]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: tasks.map((t) => ({
      id: t.id,
      epicId: "epic-e",
      title: t.id.toUpperCase(),
      spec: "s",
      acceptanceCriteria: ["x"],
      dependsOn: t.dependsOn,
      touchedPaths: [],
      estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

/** A pool whose answer depends on the role that asked, so any stage can be scripted. */
function rolePool(answers: Partial<Record<string, string | ((spec: AgentSpec) => string)>>, outcome: AgentResult["outcome"] = "done") {
  const specs: AgentSpec[] = [];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      // The real pool checks the budget on every message; a fake that never
      // does leaves the run-wide cap unexercised for every role.
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const resultText = typeof answer === "function" ? answer(spec) : (answer ?? "");
      return { sessionId: `s${specs.length}`, resultText, costUsd: 0, turns: 1, outcome };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
}

function build(opts: {
  repoPath: string;
  pool: AgentPool;
  gates?: Partial<GateHandler>;
  github?: GitHubAdapter;
}): { controller: RunController; store: Store; events: HarnessEvent[] } {
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

/** Seeds a run row directly, so a resume can be started from any state. */
function seedRun(store: Store, state: string, config = RunConfig.parse({})): string {
  const id = "run1";
  store.createRun({
    id,
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: `harness/${id}/main`,
    config,
  });
  // Walk the state machine rather than writing the column, so the row and its
  // event history agree — `reopen` reads both.
  const route: Record<string, string[]> = {
    INTAKE: ["INTAKE"],
    PLANNING: ["PLANNING"],
    BUDGET_HOLD: ["PLANNING", "PLAN_REVIEW", "EXECUTING", "BUDGET_HOLD"],
  };
  for (const to of route[state] ?? []) store.transitionRun(id, to as never);
  return id;
}

const QA_PASS = '```json\n{"verdict":"PASS","summary":"looks right","issues":[]}\n```';

describe("resuming a run that was interrupted mid-conversation", () => {
  it("plans from the assignment on record rather than re-interviewing", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({ planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS) });
    const { controller, store, events } = build({ repoPath: dir, pool });
    const runId = seedRun(store, "INTAKE");

    await controller.resume(runId);

    const reasons = events
      .filter((e): e is HarnessEvent & { reason?: string; to?: string } => e.type === "run.state_changed")
      .map((e) => `${e.to}:${e.reason ?? ""}`);
    expect(reasons).toContain("PLANNING:resumed mid-intake");
    // No intake session was opened — the brief is gone and re-asking would make
    // the operator answer everything twice.
    expect(specs.some((s) => s.role === "intake")).toBe(false);
  });

  it("re-opens the budget gate on a run parked at its cap", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller, store, events } = build({ repoPath: dir, pool });
    const runId = seedRun(store, "BUDGET_HOLD");

    await controller.resume(runId);

    const reasons = events
      .filter((e): e is HarnessEvent & { reason?: string; to?: string } => e.type === "run.state_changed")
      .map((e) => `${e.to}:${e.reason ?? ""}`);
    expect(reasons).toContain("EXECUTING:resumed from budget hold");
  });

  it("refuses to resume a run it has never heard of", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller } = build({ repoPath: dir, pool });

    await expect(controller.resume("no-such-run")).rejects.toThrow("unknown run no-such-run");
  });
});

describe("a plan the operator sends back", () => {
  it("re-plans with the operator's words and stops when they approve", async () => {
    const dir = repo();
    let planCalls = 0;
    const { pool, specs } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: () => "did the work",
      qa: () => QA_PASS,
    });
    const { controller } = build({
      repoPath: dir,
      pool,
      gates: {
        async resolvePlanGate() {
          planCalls++;
          return planCalls === 1
            ? { approved: false, feedback: "split the auth task in two" }
            : { approved: true, feedback: "" };
        },
      },
    });

    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));

    expect(planCalls).toBe(2);
    // The second planning round is told what the operator objected to.
    const plannerPrompts = specs.filter((s) => s.role === "planner").map((s) => s.prompt);
    expect(plannerPrompts.some((p) => p.includes("split the auth task in two"))).toBe(true);
  });
});

describe("the closing line", () => {
  /** Drives a whole run to PR_REVIEW, then reports what `outcome()` says. */
  async function finished(opts: { events?: (store: Store, runId: string) => void } = {}) {
    const dir = repo();
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: () => "did the work",
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"does what was asked"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));
    opts.events?.(store, runId);
    return { controller, store, runId };
  }

  const record = (store: Store, runId: string, ev: Record<string, unknown>) =>
    store.db
      .prepare("INSERT INTO events (runId, taskId, sessionId, type, payload, ts) VALUES (?,?,?,?,?,?)")
      .run(runId, null, null, String(ev.type), JSON.stringify({ runId, ...ev }), Date.now());

  it("says CI is green, red with names, or still running", async () => {
    for (const [state, expected] of [
      ["passing", "CI green"],
      ["failing", "CI red (build, lint, test, +1 more)"],
      ["pending", "CI still running"],
    ] as const) {
      const { controller, store, runId } = await finished({
        events: (s, id) =>
          record(s, id, { type: "run.ci_status", prNumber: 1, state, failing: ["build", "lint", "test", "typecheck"], total: 4 }),
      });

      expect(controller.outcome(runId).line, state).toContain(expected);
      expect(store.ciStatus(runId)!.state).toBe(state);
    }
  });

  it("says whether the merged whole did what was asked", async () => {
    const { controller, runId } = await finished();

    expect(controller.outcome(runId).line).toContain("intent check passed");
  });

  it("counts the gaps when it did not, and copes with a verdict that named none", async () => {
    const withGaps = await finished({
      events: (s, id) => record(s, id, { type: "run.intent_verdict", verdict: "FAIL", gaps: ["no offline mode", "no receipts"], summary: "" }),
    });
    expect(withGaps.controller.outcome(withGaps.runId).line).toContain("intent check found 2 gaps");

    const noGaps = await finished({
      events: (s, id) => record(s, id, { type: "run.intent_verdict", verdict: "FAIL", gaps: [], summary: "" }),
    });
    expect(noGaps.controller.outcome(noGaps.runId).line).toContain("intent check found unstated gaps");
  });

  it("says whether any of it reached anyone", async () => {
    for (const [state, expected] of [
      ["passing", "deployed"],
      ["failing", "deploy red (deploy-prod)"],
      ["pending", "deploy still running"],
    ] as const) {
      const { controller, runId } = await finished({
        events: (s, id) => record(s, id, { type: "run.deploy_status", sha: "abc1234", state, failing: ["deploy-prod"], total: 1 }),
      });

      expect(controller.outcome(runId).line, state).toContain(expected);
    }
  });

  it("says nothing about a CI or a deploy the repo does not have", async () => {
    const { controller, runId } = await finished({
      events: (s, id) => {
        record(s, id, { type: "run.ci_status", prNumber: 1, state: "none", failing: [], total: 0 });
        record(s, id, { type: "run.deploy_status", sha: "abc", state: "none", failing: [], total: 0 });
      },
    });

    const line = controller.outcome(runId).line;
    expect(line).not.toContain("CI");
    expect(line).not.toContain("deploy");
  });
});

describe("checking the deployed system", () => {
  /**
   * A GitHub where the run's pull request is merged and the deploy on that
   * commit is green — the only state in which the harness asks production
   * anything at all.
   */
  function githubWithMergedPr(): GitHubAdapter {
    const adapter = new GitHubAdapter("token", "acme/widgets");
    (adapter as unknown as { octokit: unknown }).octokit = {
      rest: {
        issues: {
          listForRepo: async () => ({ data: [] }),
          create: async () => ({ data: { number: 1, html_url: "https://example.invalid/issues/1" } }),
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: {} }),
          get: async () => ({ data: { state: "open" } }),
          update: async () => ({ data: {} }),
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => ({ data: { number: 9, html_url: "https://example.invalid/pull/9" } }),
          get: async () => ({ data: { state: "closed", draft: false, merged_at: "2026-08-01T10:00:00Z", merge_commit_sha: "abc123", head: { sha: "abc123" } } }),
          update: async () => ({ data: {} }),
        },
        checks: { listForRef: async () => ({ data: [{ name: "deploy", status: "completed", conclusion: "success" }] }) },
        repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
      },
      graphql: async () => ({}),
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
    };
    return adapter;
  }

  const PROD_CONFIG = RunConfig.parse({
    deterministicChecks: [],
    prodUrl: "https://app.example.com",
    waitForChecks: false,
    deployTimeoutMinutes: 1,
  });

  it("records what production said when the check completed", async () => {
    const dir = repo(true);
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: () => "did the work",
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      prod: () => '```json\n{"verdict":"PASS","findings":[],"summary":"checkout works"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool, github: githubWithMergedPr() });

    const runId = await controller.startRun("build a thing", PROD_CONFIG);

    expect(store.prodVerdict(runId)).toMatchObject({ verdict: "PASS", url: "https://app.example.com" });
  });

  /**
   * A run that claims to have verified production it never reached is worse
   * than one that admits it could not check — the operator acts on the claim.
   */
  it("reports that the check did not complete rather than that production passed", async () => {
    const dir = repo(true);
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: () => "did the work",
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
      // Not JSON at all: the parse throws inside the production check.
      prod: () => "I could not reach the site.",
    });
    const { controller, store, events } = build({ repoPath: dir, pool, github: githubWithMergedPr() });

    const runId = await controller.startRun("build a thing", PROD_CONFIG);

    expect(store.prodVerdict(runId)).toBeNull();
    const logs = events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log");
    expect(logs.some((e) => e.text.includes("production validation did not complete"))).toBe(true);
    // And the run stays open rather than calling itself done.
    expect(store.getRun(runId)!.state).toBe("VERIFYING");
  });
});

describe("recording a planner attempt that cannot be saved", () => {
  it("names the shape errors the breakdown got wrong", async () => {
    const dir = repo();
    // Valid JSON, wrong shape: the epics are missing entirely.
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? '```json\n{"tasks":[]}\n```' : DOCS),
    });
    const { controller } = build({ repoPath: dir, pool });

    await expect(controller.startRun("build a thing", RunConfig.parse({}))).rejects.toThrow(
      /the breakdown does not match the required shape: .*epics/
    );
  });

  it("says the plan is not a valid DAG when it references a task that does not exist", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson([{ id: "task-a", dependsOn: ["task-ghost"] }]) : DOCS),
    });
    const { controller } = build({ repoPath: dir, pool });

    await expect(controller.startRun("build a thing", RunConfig.parse({}))).rejects.toThrow(
      /the plan is not a valid DAG: task task-a depends on unknown task task-ghost/
    );
  });

  it("still reports the reason when the raw output could not be written down", async () => {
    const dir = repo();
    const { pool } = rolePool({ planner: (s) => (s.prompt.includes("PRD") ? "not json" : DOCS) });
    const { controller } = build({ repoPath: dir, pool });
    // The attempts directory cannot be created, so there is nowhere to put the
    // raw output — the diagnosis must survive that.
    writeFileSync(path.join(dir, ".harness"), "not a directory");

    await expect(controller.startRun("build a thing", RunConfig.parse({}))).rejects.toThrow(
      /Raw output: \(could not be written\)/
    );
  });
});

describe("routing rules the operator wrote by hand", () => {
  it("skips a rule whose pattern is not a regex, rather than failing the run", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: () => "did the work",
      qa: () => QA_PASS,
    });
    const { controller } = build({ repoPath: dir, pool });

    await controller.startRun(
      "build a thing",
      RunConfig.parse({
        deterministicChecks: [],
        // `(` is an unterminated group — the operator's typo, not a reason to
        // refuse to run.
        skillRouting: [{ when: "(", skills: ["frontend-design"] }],
      })
    );

    expect(specs.some((s) => s.role === "worker")).toBe(true);
  });
});

describe("clearing the ground a resume is about to work on", () => {
  it("says what an earlier harness process left running", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller, store, events } = build({ repoPath: dir, pool });
    const runId = seedRun(store, "BUDGET_HOLD");
    const reaper = await import("./reaper.js");
    vi.spyOn(reaper, "reapUnder").mockResolvedValue([
      { pid: 4123, command: "node vitest --watch", signal: "SIGKILL" },
      { pid: 4124, command: "docker compose up", signal: "SIGTERM" },
    ]);

    await controller.resume(runId);

    const logs = events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log");
    expect(logs.some((e) => e.text.includes("swept 2 processes left over in this run's worktrees"))).toBe(true);
  });

  it("says nothing when there was nothing left running", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller, store, events } = build({ repoPath: dir, pool });
    const runId = seedRun(store, "BUDGET_HOLD");

    await controller.resume(runId);

    const logs = events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log");
    expect(logs.some((e) => e.text.includes("swept"))).toBe(false);
  });
});

describe("what a finished run leaves on disk", () => {
  it("writes the PRD and the conventions where the worker prompts read them", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: () => "did the work",
      qa: () => QA_PASS,
    });
    const { controller } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));

    const prd = path.join(dir, ".harness", runId, "PRD.md");
    expect(existsSync(prd)).toBe(true);
    expect(readFileSync(prd, "utf8")).toContain("Build the thing");
  });
});
