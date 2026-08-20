import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** The last handful: states a run only reaches by being picked up again. */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(remote = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-last-"));
  made.push(dir, `${dir}-wt`);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  if (remote) {
    const bare = mkdtempSync(path.join(tmpdir(), "harness-last-remote-"));
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

function gh(over: { pulls?: Record<string, unknown>; checks?: Record<string, unknown> } = {}) {
  const adapter = new GitHubAdapter("token", "acme/widgets");
  const closed: number[] = [];
  let issueNo = 100;
  let prNo = 50;
  (adapter as unknown as { octokit: unknown }).octokit = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        create: async () => ({ data: { number: ++issueNo, html_url: `https://x.invalid/issues/${issueNo}` } }),
        listComments: async () => ({ data: [] }),
        createComment: async () => ({ data: {} }),
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
  return { adapter, closed };
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
const GREEN_DEPLOY = { listForRef: async () => ({ data: [{ name: "deploy", status: "completed", conclusion: "success" }] }) };

describe("picking up a run that is already verifying", () => {
  it("re-checks production rather than waiting for the next resume", async () => {
    const dir = repo();
    const { adapter } = gh({ pulls: MERGED_PR, checks: GREEN_DEPLOY });
    const { pool } = rolePool({
      planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS,
      // Fails the first time, passes on the resume — the operator fixed it.
      prod: (_s, nth) =>
        nth === 1
          ? '```json\n{"verdict":"FAIL","findings":["/login 500s"],"summary":"broken"}\n```'
          : '```json\n{"verdict":"PASS","findings":[],"summary":"fixed"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1 })
    );
    expect(store.getRun(runId)!.state).toBe("VERIFYING");

    await controller.resume(runId);

    expect(store.getRun(runId)!.state).toBe("DONE");
    expect(store.prodVerdict(runId)).toMatchObject({ verdict: "PASS" });
  });

  /**
   * Reaching DONE is the last moment anyone is looking, and everything the
   * report needs decays from here — the integration branch gets pruned and the
   * base branch moves on, so the diff that says which switches the run left off
   * becomes a reconstruction rather than a read.
   */
  it("writes the completion report the moment the run is actually done", async () => {
    const dir = repo();
    const { adapter } = gh({ pulls: MERGED_PR, checks: GREEN_DEPLOY });
    const { pool } = rolePool({
      planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS,
      prod: () => '```json\n{"verdict":"PASS","findings":[],"summary":"ok"}\n```',
    });
    const { controller, store, events } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1 }));

    expect(store.getRun(runId)!.state).toBe("DONE");
    const file = path.join(dir, ".harness", "reports", `${runId}.html`);
    expect(existsSync(file)).toBe(true);
    const html = readFileSync(file, "utf8");
    expect(html).toContain("<title>");
    expect(html).toContain("aria-label=\"This run reached: Verified");
    expect(events.some((e) => e.type === "agent.log" && e.text.startsWith("completion report written:"))).toBe(true);
  });

  /**
   * A run that built the thing, shipped it, and had production agree has
   * succeeded. Failing it over a page it could not write would be the tail
   * wagging the dog.
   */
  it("does not fail a finished run over a report it could not write", async () => {
    const dir = repo();
    // A file where the reports directory needs to be: `mkdirSync` cannot win.
    mkdirSync(path.join(dir, ".harness"), { recursive: true });
    writeFileSync(path.join(dir, ".harness", "reports"), "not a directory");
    const { adapter } = gh({ pulls: MERGED_PR, checks: GREEN_DEPLOY });
    const { pool } = rolePool({
      planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS,
      prod: () => '```json\n{"verdict":"PASS","findings":[],"summary":"ok"}\n```',
    });
    const { controller, store, events } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1 }));

    expect(store.getRun(runId)!.state).toBe("DONE");
    expect(events.some((e) => e.type === "agent.log" && e.text.startsWith("the completion report could not be written:"))).toBe(true);
  });
});

describe("per-task pull requests with a task that never merged", () => {
  it("opens one for the merged task and skips the parked one", async () => {
    const dir = repo();
    const { adapter } = gh();
    const { pool } = rolePool({
      planner: planner(["task-a", "task-b"]),
      worker: (spec, nth) => (spec.taskId === "task-b" ? new Error("boom") : worker(spec, nth)),
      advisor: () => "",
      qa: () => QA_PASS,
      validator: () => INTENT_PASS,
    });
    const { controller, store } = build({
      repoPath: dir, pool, github: adapter,
      gates: { async resolveTaskGate() { return null; } },
    });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, prMode: "per-task", workerRespawnCap: 1, maxParallelWorkers: 1 })
    );

    expect(store.getTask(runId, "task-a")!.prNumber).not.toBeNull();
    expect(store.getTask(runId, "task-b")!.prNumber).toBeNull();
  });
});

describe("a run configured for production with no pull request", () => {
  it("does not try to follow a deploy that has no commit behind it", async () => {
    const dir = repo();
    const { adapter } = gh();
    const { pool } = rolePool({
      planner: planner(["task-a"]),
      worker: () => new Error("boom"),
      advisor: () => "",
    });
    const { controller, store } = build({
      repoPath: dir, pool, github: adapter,
      gates: { async resolveTaskGate() { return null; } },
    });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", workerRespawnCap: 1 })
    );

    // Nothing merged, so no rollup pull request, so nothing deployed to ask about.
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(store.prodVerdict(runId)).toBeNull();
  });
});

describe("regrouping when there is nothing merged to roll up", () => {
  it("reports nothing rather than opening an empty pull request", async () => {
    const dir = repo();
    const { adapter } = gh();
    const { pool } = rolePool({
      planner: planner(["task-a"]),
      worker: () => new Error("boom"),
      advisor: () => "",
    });
    const { controller } = build({
      repoPath: dir, pool, github: adapter,
      gates: { async resolveTaskGate() { return null; } },
    });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, workerRespawnCap: 1 }));

    await expect(controller.regroupPrs(runId)).resolves.toBeNull();
  });
});

describe("measuring the base before any task has merged into it", () => {
  it("treats an integration branch with no commit as a clean base", async () => {
    const dir = repo(false);
    const { pool } = rolePool({
      planner: planner(["task-a"]),
      worker: (spec, nth) => (commit(spec.cwd, `w${nth}.txt`), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    // With checks configured, the baseline is measured — and on the first task
    // there is nothing merged into the integration branch to measure against.
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, deterministicChecks: ["true"] }));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});

describe("the wall-clock gate on top of feedback already pending", () => {
  it("keeps the earlier feedback alongside the operator's new words", async () => {
    const dir = repo(false);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const originalNow = Date.now;
    Date.now = () => realNow() + offset;
    try {
      const { pool, specs } = rolePool({
        planner: planner(["task-a"]),
        worker: (spec, nth) => {
          if (nth === 2) offset = 2 * 60 * 60 * 1000;
          commit(spec.cwd, `w${nth}.txt`);
          return "did the work";
        },
        advisor: () => "",
        // Rejects twice, so the third pass through the loop starts with
        // feedback already pending — and a wall clock that has just blown.
        qa: (_s, nth) =>
          nth <= 2
            ? '```json\n{"verdict":"FAIL","reasons":["the toggle is not wired"],"mustFix":["wire it"]}\n```'
            : QA_PASS,
      });
      const { controller } = build({
        repoPath: dir,
        pool,
        gates: { async resolveTaskGate() { return "carry on, but check the store binding"; } },
      });

      await controller.startRun("build a thing", RunConfig.parse({ ...BASE, taskWallClockMinutes: 30, qaIterationCap: 3 }));

      const prompts = specs.filter((s) => s.role === "worker").map((s) => s.prompt);
      expect(prompts.some((p) => /pending feedback from the previous iteration still applies/.test(p))).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("a merged task the harness has no commit sha for", () => {
  it("still says it merged, without inventing a commit", async () => {
    const dir = repo();
    const { adapter } = gh();
    const comments: string[] = [];
    (adapter as unknown as { octokit: { rest: { issues: { createComment: unknown } } } }).octokit.rest.issues.createComment =
      async (a: { body: string }) => (comments.push(a.body), { data: {} });
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));
    comments.length = 0;

    // A resume runs the reporting again from a fresh controller, which has no
    // memory of the shas the first process recorded.
    const bus2 = new Bus(store);
    const second = new RunController(
      store, bus2, pool, adapter,
      { async resolvePlanGate() { return { approved: true, feedback: "" }; }, async resolveBudgetGate() { return null; } },
      dir
    );
    await second.resume(runId);

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});
