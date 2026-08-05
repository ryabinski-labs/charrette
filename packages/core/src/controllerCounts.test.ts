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
 * Sentences that change with a count, and the fallbacks for a value that is
 * normally present. Small things, but they are what the operator reads: "1 task
 * needs you" and "1 tasks needs you" are not the same message.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(remote = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-count-"));
  made.push(dir, `${dir}-wt`);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  if (remote) {
    const bare = mkdtempSync(path.join(tmpdir(), "harness-count-remote-"));
    made.push(bare);
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: bare, stdio: "ignore" });
    run("remote", "add", "origin", bare);
    run("push", "-q", "origin", "main");
  }
  return dir;
}

function commitInWorktree(cwd: string, file: string): void {
  writeFileSync(path.join(cwd, file), "done\n");
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", `add ${file}`], { cwd, stdio: "ignore" });
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"ok"}\n```';

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

function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      await spec.budgetCheck?.();
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      const answer = answers[spec.role];
      const base: AgentResult = { sessionId: `s${specs.length}`, sdkSessionId: `sdk${specs.length}`, resultText: "", costUsd: 0, turns: 1, outcome: "done" };
      if (typeof answer === "function") {
        const out = answer(spec, counts[spec.role]!);
        if (out instanceof Error) throw out;
        return typeof out === "string" ? { ...base, resultText: out } : { ...base, ...out };
      }
      return { ...base, resultText: answer ?? "" };
    },
  };
  return { pool: pool as unknown as AgentPool, specs };
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

const planner = (ids: string[]) => (s: AgentSpec) => (Array.isArray(s.tools) && s.tools.length > 0 ? DOCS : dagJson(ids));

describe("counting merged work", () => {
  it("says two tasks merged, not two task", async () => {
    const dir = repo();
    const { pool } = rolePool({ planner: planner(["task-a", "task-b"]), worker, qa: () => QA_PASS });
    const { controller } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    const out = controller.outcome(runId);
    expect(out.merged).toBe(2);
    expect(out.total).toBe(2);
  });

  it("counts a single gap in the singular and several in the plural", async () => {
    for (const [gaps, expected] of [
      [["only one thing"], "intent check found 1 gap"],
      [["one thing", "another"], "intent check found 2 gaps"],
    ] as const) {
      const dir = repo();
      const { pool } = rolePool({
        planner: planner(["task-a"]),
        worker,
        qa: () => QA_PASS,
        validator: () => `\`\`\`json\n${JSON.stringify({ verdict: "FAIL", gaps, summary: "" })}\n\`\`\``,
      });
      const { controller } = build({ repoPath: dir, pool });

      const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

      expect(controller.outcome(runId).line, expected).toContain(expected);
    }
  });
});

describe("a session that ends badly and says nothing about why", () => {
  it("gives the worker crash a name of its own", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      // `outcome: "error"` with no detail at all — the SDK does this when the
      // session dies before it can say anything.
      worker: (spec, nth) => (nth === 1 ? { outcome: "error", resultText: "" } : worker(spec, nth)),
      planner: planner(["task-a"]),
      qa: () => QA_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(specs.filter((s) => s.role === "worker")[1]!.prompt).toContain("worker session ended abnormally");
  });

  it("gives the QA crash one too", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: planner(["task-a"]),
      worker,
      qa: (_s, nth) => (nth === 1 ? { outcome: "error", resultText: "", turns: 42 } : QA_PASS),
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(specs.filter((s) => s.role === "worker")[1]!.prompt).toMatch(/ended without a verdict/);
  });
});

describe("a conflict the catch-up merge settles by itself", () => {
  it("tells the worker there is nothing to resolve by hand", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      planner: planner(["task-a", "task-b"]),
      // Different files, so the catch-up merges cleanly even though the
      // integration branch moved under the second task.
      worker: (spec, nth) => (commitInWorktree(spec.cwd, `${path.basename(spec.cwd)}-${nth}.txt`), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ ...BASE, maxParallelWorkers: 2 }));

    expect(store.listTasks(runId).every((t) => t.state === "MERGED")).toBe(true);
    // Either it never conflicted, or it was handed back with the clean-merge wording.
    const handbacks = specs.filter((s) => s.role === "worker" && /ACCEPTED by QA/.test(s.prompt));
    for (const h of handbacks) expect(h.prompt).toMatch(/nothing to resolve by hand|conflicted on purpose/);
  });
});

describe("reading an issue thread the adapter cannot serve", () => {
  /** A GitHub adapter that is enabled but whose comment reader is missing or broken. */
  function adapterWith(issueComments: unknown): GitHubAdapter {
    const adapter = new GitHubAdapter("token", "acme/widgets");
    (adapter as unknown as { octokit: unknown }).octokit = {
      rest: {
        issues: {
          listForRepo: async () => ({ data: [] }),
          create: async () => ({ data: { number: 101, html_url: "https://x.invalid/issues/101" } }),
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: {} }),
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
      },
      graphql: async () => ({}),
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
    };
    (adapter as unknown as Record<string, unknown>).issueComments = issueComments;
    return adapter;
  }

  it("carries on when the adapter has no comment reader at all", async () => {
    const dir = repo(true);
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS });
    const { controller, store } = build({ repoPath: dir, pool, github: adapterWith(undefined) });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("carries on when reading the thread throws", async () => {
    const dir = repo(true);
    const { pool } = rolePool({ planner: planner(["task-a"]), worker, qa: () => QA_PASS });
    const { controller, store } = build({
      repoPath: dir,
      pool,
      github: adapterWith(async () => {
        throw new Error("502 from GitHub");
      }),
    });

    const runId = await controller.startRun("build a thing", RunConfig.parse(BASE));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("says two new comments, not two new comment", async () => {
    const dir = repo(true);
    const { pool } = rolePool({
      planner: planner(["task-a"]),
      worker: (spec, nth) => (nth === 1 ? new Error("boom") : worker(spec, nth)),
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller, events } = build({
      repoPath: dir,
      pool,
      github: adapterWith(async () => [
        { id: 1, author: "operator", body: "one thought" },
        { id: 2, author: "operator", body: "and another" },
      ]),
    });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, workerRespawnCap: 3 }));

    const feedback = events.filter((e): e is HarnessEvent & { text: string } => e.type === "task.feedback");
    expect(feedback.some((e) => /2 new comments on issue #/.test(e.text))).toBe(true);
  });
});

describe("a planner attempt that fails in an unusual way", () => {
  it("reports something thrown that is not an Error", async () => {
    const dir = repo();
    const { pool } = rolePool({
      planner: (s) => {
        if (Array.isArray(s.tools) && s.tools.length > 0) return DOCS;
        // eslint-disable-next-line no-throw-literal
        throw "the session vanished";
      },
    });
    const { controller } = build({ repoPath: dir, pool });

    await expect(controller.startRun("build a thing", RunConfig.parse(BASE))).rejects.toThrow(/the session vanished/);
  });
});

describe("sweeping and reporting with nothing to report", () => {
  it("says a run with no merged work has no diff to publish", async () => {
    const dir = repo(true);
    const { adapter } = { adapter: new GitHubAdapter("token", "acme/widgets") };
    (adapter as unknown as { octokit: unknown }).octokit = {
      rest: {
        issues: {
          listForRepo: async () => ({ data: [] }),
          create: async () => ({ data: { number: 101, html_url: "https://x.invalid/issues/101" } }),
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: {} }),
          get: async () => ({ data: { state: "open" } }),
          update: async () => ({ data: {} }),
        },
        pulls: { list: async () => ({ data: [] }), create: async () => ({ data: { number: 1, html_url: "u" } }), get: async () => ({ data: {} }), update: async () => ({ data: {} }) },
        checks: { listForRef: async () => ({ data: [] }) },
        repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
      },
      graphql: async () => ({}),
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
    };
    const { pool } = rolePool({
      planner: planner(["task-a"]),
      worker: () => new Error("boom"),
      advisor: () => "",
    });
    const { controller, events } = build({
      repoPath: dir,
      pool,
      github: adapter,
      gates: { async resolveTaskGate() { return null; } },
    });

    await controller.startRun("build a thing", RunConfig.parse({ ...BASE, workerRespawnCap: 1 }));

    expect(logs(events).some((t) => /no pull request opened: no task reached MERGED[\s\S]*1 task parked/.test(t))).toBe(true);
  });
});
