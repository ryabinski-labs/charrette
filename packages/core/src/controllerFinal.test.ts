import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The last of it: verification against a repo that has not merged, regrouping
 * pull requests that overlap, and the handful of guards that only fire when the
 * harness is asked about a run in a state it does not normally reach.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(remote = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-final-"));
  made.push(dir, `${dir}-wt`);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  if (remote) {
    const bare = mkdtempSync(path.join(tmpdir(), "harness-final-remote-"));
    made.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
    run("remote", "add", "origin", bare);
    run("push", "-q", "origin", "main");
  }
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

const dagJson = (ids: string[]) =>
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

function rolePool(answers: Partial<Record<string, Answer>>, bill = 0) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const ref = { store: null as Store | null };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      if (bill && ref.store) {
        ref.store.recordUsage({
          runId: spec.runId, taskId: spec.taskId, sessionId: `s${specs.length}`, model: spec.model,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: bill,
        });
      }
      await spec.budgetCheck?.();
      const answer = answers[spec.role];
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: bill, turns: 1, outcome: "done" };
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

/** A GitHub whose behaviour each test overrides piecewise. */
function gh(over: { pulls?: Record<string, unknown>; checks?: Record<string, unknown>; drop?: string[] } = {}) {
  const adapter = new GitHubAdapter("token", "acme/widgets");
  const closed: number[] = [];
  const comments: { issue: number; body: string }[] = [];
  let issueNo = 100;
  let prNo = 50;
  (adapter as unknown as { octokit: unknown }).octokit = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        create: async () => ({ data: { number: ++issueNo, html_url: `https://x.invalid/issues/${issueNo}` } }),
        listComments: async () => ({ data: [] }),
        createComment: async (a: { issue_number: number; body: string }) => (comments.push({ issue: a.issue_number, body: a.body }), { data: {} }),
        get: async () => ({ data: { state: "open" } }),
        update: async () => ({ data: {} }),
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: ++prNo, html_url: `https://x.invalid/pull/${prNo}` } }),
        get: async () => ({ data: { state: "open", draft: false, merged_at: null, head: { sha: "abc" } } }),
        update: async (a: { pull_number: number; state?: string }) => (a.state === "closed" && closed.push(a.pull_number), { data: {} }),
        ...over.pulls,
      },
      checks: { listForRef: async () => ({ data: [] }), ...over.checks },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    },
    graphql: async () => ({}),
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
  };
  for (const name of over.drop ?? []) (adapter as unknown as Record<string, unknown>)[name] = undefined;
  return { adapter, closed, comments };
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

const worker = (spec: AgentSpec, nth: number) => (commit(spec.cwd, `w-${path.basename(spec.cwd)}-${nth}.txt`), "did the work");
const planner = (ids: string[]) => (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dagJson(ids));
const BASE = { deterministicChecks: [] as string[], waitForChecks: false };

const MERGED_PR = {
  get: async () => ({ data: { state: "closed", draft: false, merged_at: "2026-08-01T00:00:00Z", merge_commit_sha: "abc123", head: { sha: "abc123" } } }),
};

describe("asking about a run that cannot be verified", () => {
  it("says no when the run is not awaiting review", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller, store } = build({ repoPath: dir, pool, github: gh().adapter });
    store.createRun({
      id: "run1", repoPath: dir, assignment: "a", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "harness/run1/main", config: RunConfig.parse({ prodUrl: "https://app.example.com" }),
    });

    // A run still being planned has nothing deployed to check.
    expect(controller.awaitingVerification("run1")).toBe(false);
  });

  it("says no when there is no pull request to follow", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller, store } = build({ repoPath: dir, pool, github: gh().adapter });
    store.createRun({
      id: "run1", repoPath: dir, assignment: "a", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "harness/run1/main", config: RunConfig.parse({ prodUrl: "https://app.example.com" }),
    });
    for (const to of ["PLANNING", "PLAN_REVIEW", "EXECUTING", "INTEGRATING", "PR_REVIEW"] as const) store.transitionRun("run1", to);

    expect(controller.awaitingVerification("run1")).toBe(false);
  });
});

describe("following a deploy the repo cannot report on", () => {
  it("does not claim production was reached when the base branch has no deploy at all", async () => {
    const dir = repo(true);
    // No checks on the merged commit: nothing here can say the change reached
    // production, and "no signal" is not the same as "green".
    const { adapter } = gh({ pulls: MERGED_PR });
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS, prod: () => "" });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1 })
    );

    expect(store.getRun(runId)!.state).toBe("VERIFYING");
    expect(store.prodVerdict(runId)).toBeNull();
  });

  it("copes with an adapter that cannot report checks at all", async () => {
    const dir = repo(true);
    const { adapter } = gh({ pulls: MERGED_PR, drop: ["checksForRef"] });
    const { pool } = rolePool({
      planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS,
      prod: () => '```json\n{"verdict":"PASS","findings":[],"summary":"ok"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com" }));

    // No deploy signal at all is not a red deploy — it goes straight to asking
    // production, which is the only thing left that can answer.
    expect(store.prodVerdict(runId)).toMatchObject({ verdict: "PASS" });
  });

  it("counts production findings, and says unstated when there are none", async () => {
    for (const [findings, expected] of [
      [["/login 500s"], "production check found 1 problem"],
      [["/login 500s", "/pay times out"], "production check found 2 problems"],
      [[], "production check found unstated problems"],
    ] as const) {
      const dir = repo(true);
      const { adapter } = gh({ pulls: MERGED_PR, checks: { listForRef: async () => ({ data: [{ name: "deploy", status: "completed", conclusion: "success" }] }) } });
      const { pool } = rolePool({
        planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS,
        prod: () => `\`\`\`json\n${JSON.stringify({ verdict: "FAIL", findings, summary: "" })}\n\`\`\``,
      });
      const { controller } = build({ repoPath: dir, pool, github: adapter });

      const runId = await controller.startRun(
        "build a thing",
        RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1 })
      );

      expect(controller.outcome(runId).line, expected).toContain(expected);
    }
  });

  it("lets a budget stop out of the production check rather than logging it as a failed check", async () => {
    const dir = repo(true);
    const { adapter } = gh({ pulls: MERGED_PR, checks: { listForRef: async () => ({ data: [{ name: "deploy", status: "completed", conclusion: "success" }] }) } });
    const { pool, ref } = rolePool(
      { planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS, prod: () => "" },
      9
    );
    const { controller, store } = build({ repoPath: dir, pool, github: adapter, gates: { async resolveBudgetGate() { return null; } } });
    ref.store = store;

    await expect(
      controller.startRun(
        "build a thing",
        // The forge is off because this test is calibrated in sessions: at $9 a
        // session and a $45 cap, an extra skillsmith session moves the breach
        // from the stage under test into the QA loop, which handles it itself.
        RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1, budget: { runCapUsd: 45 }, skillForge: { enabled: false } })
      )
    ).rejects.toThrow(/budget exceeded/);
  });
});

describe("regrouping overlapping pull requests", () => {
  it("closes the per-task PRs it superseded and leaves its own alone", async () => {
    const dir = repo(true);
    const { adapter, closed } = gh();
    const { pool } = rolePool({ planner: planner(["task-a", "task-b"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS });
    const { controller } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prMode: "per-task" }));

    const result = await controller.regroupPrs(runId);

    expect(result!.closed.length).toBe(2);
    expect(closed).toHaveLength(2);
    // The rollup itself is never closed.
    expect(closed).not.toContain(result!.pr.number);
  });

  it("reports nothing to roll up when the branch holds no commits the base lacks", async () => {
    const dir = repo(true);
    const { adapter } = gh({
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => {
          throw Object.assign(new Error("Validation Failed"), {
            status: 422,
            response: { data: { errors: [{ message: "No commits between main and the branch" }] } },
          });
        },
        get: async () => ({ data: { state: "open", draft: false, head: { sha: "abc" } } }),
        update: async () => ({ data: {} }),
      },
    });
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS });
    const { controller } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prMode: "per-task" }));

    await expect(controller.regroupPrs(runId)).resolves.toBeNull();
  });

  it("says one pull request in the singular", async () => {
    const dir = repo(true);
    const { adapter } = gh();
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS });
    const { controller } = build({ repoPath: dir, pool, github: adapter });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(controller.outcome(runId).line).toContain("1 pull request open for review");
  });
});

describe("opening per-task pull requests", () => {
  it("skips a task that already has one", async () => {
    const dir = repo(true);
    const { adapter } = gh();
    let created = 0;
    (adapter as unknown as { octokit: { rest: { pulls: { create: unknown } } } }).octokit.rest.pulls.create = async () => {
      created++;
      return { data: { number: 60 + created, html_url: `https://x.invalid/pull/${60 + created}` } };
    };
    const { pool } = rolePool({ planner: planner(["task-a", "task-b"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prMode: "per-task" }));
    expect(created).toBe(2);

    // A resume must not open a second pull request for work already published.
    await controller.resume(runId);

    expect(created).toBe(2);
    expect(store.listTasks(runId).every((t) => t.prNumber !== null)).toBe(true);
  });
});

describe("the skills lens for a role that has none", () => {
  it("matches on the task text alone", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS });
    const { controller } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, skillsDirs: [] }));

    // No skills directory means no skills block, whatever the lens would add.
    expect(specs.find((s) => s.role === "worker")!.systemPrompt).not.toContain("<skill");
  });
});
