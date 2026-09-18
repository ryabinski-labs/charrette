import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent } from "@charrette/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * Polling that gives up, a rollup that lands on a number already in use, and a
 * budget stop arriving inside the two stages that catch everything else.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-poll-"));
  made.push(dir, `${dir}-wt`);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  const bare = mkdtempSync(path.join(tmpdir(), "charrette-poll-remote-"));
  made.push(bare);
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
  run("remote", "add", "origin", bare);
  run("push", "-q", "origin", "main");
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

/** Bills only the named roles, so a cap can be made to trip inside one stage. */
function rolePool(answers: Partial<Record<string, Answer>>, bill = 0, billOnly?: string[]) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const ref = { store: null as Store | null };
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      if (bill && ref.store && (!billOnly || billOnly.includes(spec.role))) {
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
        update: async () => ({ data: {} }),
        ...over.pulls,
      },
      checks: { listForRef: async () => ({ data: [] }), ...over.checks },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    },
    graphql: async () => ({}),
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
  };
  return adapter;
}

function build(opts: { repoPath: string; pool: AgentPool; github?: GitHubAdapter; gates?: Partial<GateHandler> }) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: CharretteEvent[] = [];
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

describe("polling CI that stops answering", () => {
  it("keeps the last answer it got rather than waiting out the timeout", async () => {
    const dir = repo();
    let reads = 0;
    const adapter = gh({
      // The pull request itself becomes unreadable after the first look, so the
      // reader returns nothing at all rather than a weaker verdict.
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 51, html_url: "https://x.invalid/pull/51" } }),
        get: async () => {
          reads++;
          // The first look settles the pull request; the poll after it fails.
          if (reads <= 2) return { data: { state: "open", draft: false, merged_at: null, head: { sha: "abc" } } };
          throw new Error("502 from GitHub");
        },
        update: async () => ({ data: {} }),
      },
      checks: { listForRef: async () => ({ data: [{ name: "ci", status: "in_progress", conclusion: null }] }) },
    });
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS });
    const { controller, store } = build({ repoPath: dir, pool, github: adapter });
    // The green hold asks an unreadable GitHub again a few times before it
    // pauses; a millisecond between asks keeps this about the polling.
    controller.githubRetryMs = 1;

    const runId = await controller.startRun(
      "build a thing",
      // waitForChecks on, so the run actually polls. The poll interval scales
      // with the budget (budget/40, capped at 15s), so a one-minute budget
      // polls every 1.5s — long enough to be a real wait, short enough that a
      // test which never took the give-up path would still finish.
      RunConfig.parse({ ...BASE, waitForChecks: true, checkTimeoutMinutes: 1 })
    );

    expect(store.ciStatus(runId)).toMatchObject({ state: "pending" });
    // And pending is not green: the run pauses on not knowing rather than
    // reporting in review over a branch nothing answered for.
    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.lastRunStateChange(runId)!.reason).toMatch(/^green hold: GitHub could not be read/);
  });
});

describe("a rollup that lands on a number already in the run", () => {
  it("does not close the pull request it just opened", async () => {
    const dir = repo();
    const closed: number[] = [];
    // Every create answers 77, so the per-task PR and the rollup share a number.
    const adapter = gh({
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => ({ data: { number: 77, html_url: "https://x.invalid/pull/77" } }),
        get: async () => ({ data: { state: "open", draft: false, merged_at: null, head: { sha: "abc" } } }),
        update: async (a: { pull_number: number; state?: string }) => (a.state === "closed" && closed.push(a.pull_number), { data: {} }),
      },
    });
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS });
    const { controller } = build({ repoPath: dir, pool, github: adapter });
    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, prMode: "per-task" }));

    const result = await controller.regroupPrs(runId);

    expect(result!.pr.number).toBe(77);
    expect(result!.closed).toEqual([]);
    expect(closed).toEqual([]);
  });
});

describe("a budget stop inside the stages that catch everything", () => {
  it("comes out of the production check rather than being logged as a failed check", async () => {
    const dir = repo();
    const adapter = gh({
      pulls: MERGED_PR,
      checks: { listForRef: async () => ({ data: [{ name: "deploy", status: "completed", conclusion: "success" }] }) },
    });
    // Every session bills 4; the cap is set so it is the production session that
    // crosses it, after the validator has already been paid for.
    const { pool, ref } = rolePool(
      { planner: planner(["task-a"]), worker, qa: () => QA_PASS, validator: () => INTENT_PASS, prod: () => "" },
      50,
      // Only the production session costs anything, so the cap can only be
      // crossed inside it — the point being that the stop comes back out.
      ["prod"]
    );
    const { controller, store, events } = build({
      repoPath: dir, pool, github: adapter,
      gates: { async resolveBudgetGate() { return null; } },
    });
    ref.store = store;

    await expect(
      controller.startRun(
        "build a thing",
        RunConfig.parse({ ...BASE, prodUrl: "https://app.example.com", deployTimeoutMinutes: 1, budget: { runCapUsd: 40 } })
      )
    ).rejects.toThrow(/budget exceeded/);

    // Not reported as "production validation did not complete" — that would read
    // as a broken deploy rather than a run that ran out of money.
    const logs = events.filter((e): e is CharretteEvent & { text: string } => e.type === "agent.log");
    expect(logs.some((e) => /production validation did not complete/.test(e.text))).toBe(false);
  });

  it("comes out of the verdict re-ask rather than being read as no verdict", async () => {
    const dir = repo();
    // QA never writes the JSON, so the re-ask runs — and it is the re-ask
    // session that crosses the cap.
    const { pool, ref } = rolePool(
      { planner: planner(["task-a"]), worker, qa: () => "no verdict in this message" },
      30,
      ["qa"]
    );
    const { controller, store } = build({
      repoPath: dir, pool,
      gates: { async resolveBudgetGate() { return null; } },
    });
    ref.store = store;

    await expect(
      controller.startRun("build a thing", RunConfig.parse({ ...BASE, budget: { runCapUsd: 45 } }))
    ).rejects.toThrow(/budget exceeded/);
  });
});
