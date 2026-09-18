import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent, IntakeQuestion } from "@charrette/shared";

const { seedWorktreeDepsMock } = vi.hoisted(() => ({ seedWorktreeDepsMock: vi.fn(async () => [] as unknown[]) }));
vi.mock("./deps.js", () => ({ seedWorktreeDeps: seedWorktreeDepsMock }));

import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * The controller where it touches GitHub, and the two entry points either side
 * of it: the intake conversation that turns a seed into a brief, and the issue
 * thread an operator answers a stuck task in. All of it is driven against a
 * hand-rolled Octokit and a bare git remote — no network, but the real adapter.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  seedWorktreeDepsMock.mockReset().mockResolvedValue([]);
  vi.restoreAllMocks();
});

function repo(withRemote = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-gh-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  if (withRemote) {
    const remote = mkdtempSync(path.join(tmpdir(), "charrette-gh-remote-"));
    made.push(remote);
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote, stdio: "ignore" });
    run("remote", "add", "origin", remote);
    run("push", "-q", "origin", "main");
  }
  return dir;
}

function commitInWorktree(cwd: string, file: string, body: string): void {
  writeFileSync(path.join(cwd, file), body);
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-m", `add ${file}`], { cwd, stdio: "ignore" });
}

interface FakeGh {
  adapter: GitHubAdapter;
  comments: { issue: number; body: string }[];
  closed: { issue: number; reason: string }[];
  prsCreated: number;
  issueThread: { id: number; user: { login: string }; body: string }[];
}

/** The adapter with a hand-rolled Octokit, recording everything written. */
function fakeGithub(opts: { noCommits?: boolean } = {}): FakeGh {
  const adapter = new GitHubAdapter("token", "acme/widgets");
  const state: FakeGh = { adapter, comments: [], closed: [], prsCreated: 0, issueThread: [] };
  let nextIssue = 100;
  (adapter as unknown as { octokit: unknown }).octokit = {
    rest: {
      issues: {
        listForRepo: async () => ({ data: [] }),
        create: async () => {
          nextIssue++;
          return { data: { number: nextIssue, html_url: `https://example.invalid/issues/${nextIssue}` } };
        },
        listComments: async () => ({ data: state.issueThread }),
        createComment: async (args: { issue_number: number; body: string }) => {
          state.comments.push({ issue: args.issue_number, body: args.body });
          return { data: {} };
        },
        get: async () => ({ data: { state: "open" } }),
        update: async (args: { issue_number: number; state_reason?: string }) => {
          if (args.state_reason) state.closed.push({ issue: args.issue_number, reason: args.state_reason });
          return { data: {} };
        },
      },
      pulls: {
        list: async () => ({ data: [] }),
        create: async () => {
          if (opts.noCommits) {
            throw Object.assign(new Error("Validation Failed"), {
              status: 422,
              response: { data: { errors: [{ message: "No commits between main and the branch" }] } },
            });
          }
          state.prsCreated++;
          return { data: { number: 50 + state.prsCreated, html_url: `https://example.invalid/pull/${50 + state.prsCreated}` } };
        },
        get: async () => ({ data: { state: "open", draft: false, merged_at: null, head: { sha: "abc" } } }),
        update: async () => ({ data: {} }),
      },
      checks: { listForRef: async () => ({ data: [] }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    },
    graphql: async () => ({}),
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
  };
  return state;
}

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
  return { pool: pool as unknown as AgentPool, specs, counts };
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"looks right"}\n```';

const dagJson = (ids: string[] = ["task-a"]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: ids.map((id) => ({
      id,
      epicId: "epic-e",
      title: id.toUpperCase(),
      spec: "s",
      acceptanceCriteria: ["x"],
      dependsOn: [],
      touchedPaths: [],
      estimatedSize: "S" as const,
    })),
  }) +
  "\n```";

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

const workerThatCommits = (spec: AgentSpec, nth: number) => {
  commitInWorktree(spec.cwd, `work-${path.basename(spec.cwd)}-${nth}.txt`, "done\n");
  return "did the work";
};

describe("the intake conversation", () => {
  it("turns the seed into a brief, writes it down, and plans from it", async () => {
    const dir = repo(false);
    const asked: IntakeQuestion[] = [];
    const brief = JSON.stringify({
      goal: "add rate limiting keyed on the API key",
      context: "a fastify app",
      decisions: [{ question: "Keyed on what?", answer: "the API key", rationale: "" }],
      outOfScope: [],
      openQuestions: [],
    });
    const { pool, specs } = rolePool({
      intake: () => "```json\n" + brief + "\n```",
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
    });
    const { controller, store, events } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("add rate limiting", RunConfig.parse({ deterministicChecks: [] }), {
      async ask(q) {
        asked.push(q);
        return "the API key";
      },
      say() {},
    });

    // The brief replaces the seed as the run's assignment, and the planner works
    // from it rather than from what the operator first typed.
    expect(store.getRun(runId)!.assignment).toContain("add rate limiting keyed on the API key");
    expect(specs.find((s) => s.role === "planner")!.prompt).toContain("add rate limiting keyed on the API key");
    expect(events.some((e) => e.type === "intake.brief_ready")).toBe(true);
    expect(events.filter((e): e is CharretteEvent & { to?: string } => e.type === "run.state_changed").map((e) => e.to)).toContain("INTAKE");
  });
});

describe("what a run says on its issues", () => {
  it("reports each task's end on its own issue, and closes what was never attempted", async () => {
    const dir = repo();
    const gh = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson(["task-a", "task-b"]) : DOCS),
      // task-b crashes to its cap and parks; task-a merges.
      worker: (spec, nth) =>
        spec.taskId === "task-b" ? new Error("boom") : workerThatCommits(spec, nth),
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller } = build({ repoPath: dir, pool, github: gh.adapter });

    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], workerRespawnCap: 1, waitForChecks: false }));

    const bodies = gh.comments.map((c) => c.body);
    expect(bodies.some((b) => /\*\*Done\*\* — merged into `charrette\//.test(b))).toBe(true);
    expect(bodies.some((b) => /\*\*Parked for a human\*\*/.test(b))).toBe(true);
    // A parked task's thread is left open: a reply in it is picked up as guidance.
    expect(gh.closed).toEqual([]);

    // The issue has to say where its own commands run. The task branch is not on
    // the base branch, so the same commands from the operator's clone fail on
    // files that were never merged — the comment prints the `cd` to the task's
    // worktree rather than only naming a branch.
    const parked = bodies.find((b) => /\*\*Parked for a human\*\*/.test(b))!;
    expect(parked).toContain(`cd ${dir}-wt${path.sep}`);
    expect(parked).toMatch(/```sh\ncd \S+task-b\n```/);
    expect(parked).toMatch(/will not find the files this task wrote/);
  });

  it("says a task was never attempted and closes its issue as not planned", async () => {
    const dir = repo();
    const gh = fakeGithub();
    const { pool } = rolePool({
      planner: (s) =>
        s.prompt.includes("PRD")
          ? "```json\n" +
            JSON.stringify({
              epics: [{ id: "epic-e", title: "E", summary: "s" }],
              tasks: [
                { id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
                // Depends on the one that parks, so it never becomes reachable.
                { id: "task-b", epicId: "epic-e", title: "B", spec: "s", acceptanceCriteria: ["x"], dependsOn: ["task-a"], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
              ],
            }) +
            "\n```"
          : DOCS,
      worker: () => new Error("boom"),
      advisor: () => "",
    });
    const { controller, store } = build({ repoPath: dir, pool, github: gh.adapter });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], workerRespawnCap: 1, waitForChecks: false }));

    expect(store.getTask(runId, "task-b")!.state).toBe("CANCELLED");
    expect(gh.comments.some((c) => /\*\*Not attempted\*\*/.test(c.body))).toBe(true);
    expect(gh.closed).toEqual([{ issue: expect.any(Number), reason: "not_planned" }]);
  });
});

describe("an operator answering in the issue thread", () => {
  it("picks the comment up as feedback and hands it to the worker", async () => {
    const dir = repo();
    const gh = fakeGithub();
    gh.issueThread = [{ id: 7, user: { login: "operator" }, body: "the table is never created — call EnsureTable from main" }];
    const { pool, specs } = rolePool({
      // Fails once so the loop comes back round and polls the thread again.
      worker: (spec, nth) => (nth === 1 ? new Error("boom") : workerThatCommits(spec, nth)),
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller, events } = build({ repoPath: dir, pool, github: gh.adapter });

    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], workerRespawnCap: 3, waitForChecks: false }));

    expect(
      events.some(
        (e): e is CharretteEvent & { text: string; delivery?: string } =>
          e.type === "task.feedback" && /1 new comment on issue #/.test((e as { text: string }).text)
      )
    ).toBe(true);
    const prompts = specs.filter((s) => s.role === "worker").map((s) => s.prompt);
    expect(prompts.some((p) => /operator commented on issue #[\s\S]*EnsureTable/.test(p))).toBe(true);
  });

  it("reads the same comment only once, however many iterations it polls", async () => {
    const dir = repo();
    const gh = fakeGithub();
    gh.issueThread = [{ id: 7, user: { login: "operator" }, body: "one thought" }];
    const { pool } = rolePool({
      worker: (spec, nth) => (nth <= 2 ? new Error("boom") : workerThatCommits(spec, nth)),
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller, events } = build({ repoPath: dir, pool, github: gh.adapter });

    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], workerRespawnCap: 3, waitForChecks: false }));

    const queued = events.filter((e) => e.type === "task.feedback");
    expect(queued).toHaveLength(1);
  });

  it("carries on when the issue thread cannot be read at all", async () => {
    const dir = repo();
    const gh = fakeGithub();
    (gh.adapter as unknown as { octokit: { rest: { issues: { listComments: unknown } } } }).octokit.rest.issues.listComments =
      async () => {
        throw new Error("502 from GitHub");
      };
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool, github: gh.adapter });

    // Hold off: with it on, an unanswered check holds the run in BLOCKED and no
    // pull request opens at all.
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], waitForChecks: false, holdUntilProven: false }));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});

describe("pull requests per task", () => {
  it("says so when a task branch carries nothing the base does not already have", async () => {
    const dir = repo();
    const gh = fakeGithub({ noCommits: true });
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller, store, events } = build({ repoPath: dir, pool, github: gh.adapter });

    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ deterministicChecks: [], prMode: "per-task", waitForChecks: false })
    );

    expect(store.getTask(runId, "task-a")!.prNumber).toBeNull();
    expect(
      events.some((e): e is CharretteEvent & { text: string } => e.type === "agent.log" && /no pull request opened/.test((e as { text: string }).text))
    ).toBe(true);
  });

  it("reports one rollup pull request rather than one line per task", async () => {
    const dir = repo();
    const gh = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson(["task-a", "task-b"]) : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller } = build({ repoPath: dir, pool, github: gh.adapter });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], waitForChecks: false }));

    const prs = controller.outcome(runId).prs;
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ taskId: "run", title: "2 tasks (rollup)" });
  });

  it("opens the pull request without an intent section when the validator never answered", async () => {
    const dir = repo();
    const gh = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
      // No JSON, so no verdict is ever recorded.
      validator: () => "I could not run the suite.",
    });
    const { controller } = build({ repoPath: dir, pool, github: gh.adapter });

    // Hold off: with it on, an unanswered check holds the run in BLOCKED and
    // no pull request opens at all.
    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], waitForChecks: false, holdUntilProven: false }));

    expect(gh.prsCreated).toBe(1);
  });
});

describe("regrouping per-task pull requests", () => {
  it("backfills the base branch on a run that never recorded one", async () => {
    const dir = repo();
    const gh = fakeGithub();
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool, github: gh.adapter });
    const runId = await controller.startRun(
      "build a thing",
      RunConfig.parse({ deterministicChecks: [], prMode: "per-task", waitForChecks: false })
    );
    // A run recorded before the base branch was persisted with the config.
    store.patchRunConfig(runId, { baseBranch: "" });

    const result = await controller.regroupPrs(runId);

    expect(result).not.toBeNull();
    expect(store.getRun(runId)!.config.baseBranch).toBe("main");
    expect(store.getRun(runId)!.config.prMode).toBe("single");
  });

  it("refuses when there is no GitHub to regroup on", async () => {
    const dir = repo();
    const { pool } = rolePool({});
    const { controller, store } = build({ repoPath: dir, pool });
    store.createRun({
      id: "run1", repoPath: dir, assignment: "a", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "charrette/run1/main", config: RunConfig.parse({}),
    });

    await expect(controller.regroupPrs("run1")).rejects.toThrow("GitHub is not configured");
    await expect(controller.regroupPrs("nope")).rejects.toThrow("unknown run nope");
  });
});

describe("seeding a fresh worktree", () => {
  it("says what it installed, so the worker is not paying for it in tokens", async () => {
    const dir = repo(false);
    seedWorktreeDepsMock.mockResolvedValue([{ dir: "frontend", manager: "pnpm", ok: true, seconds: 4.2 }]);
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
    });
    const { controller, events } = build({ repoPath: dir, pool });

    await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));

    expect(events.some((e) => e.type === "task.deps_seeded")).toBe(true);
  });
});

describe("QA that answers with prose", () => {
  it("asks the same session for the verdict alone rather than counting it as a failure", async () => {
    const dir = repo(false);
    const { pool, specs } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      // QA forgets the JSON; the re-ask, which is its own role now, produces it.
      qa: "It all looks correct to me.",
      repair: QA_PASS,
    });
    const { controller, store } = build({ repoPath: dir, pool });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));

    const reask = specs.filter((s) => s.role === "repair").at(-1)!;
    expect(reask.prompt).toContain("did not contain the verdict JSON");
    expect(reask.maxTurns).toBe(2);
    // QA itself was asked once. The re-ask is not a second opinion, and billing
    // it as one would make every unparseable verdict cost two verifications.
    expect(specs.filter((s) => s.role === "qa")).toHaveLength(1);
    // The work is not sent back to the worker for a verdict QA had already
    // reached — one iteration, one verdict, merged.
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-a")!.qaIterations).toBe(1);
  });

  it("leaves the failure where it was when the re-ask will not answer either", async () => {
    const dir = repo(false);
    const { pool } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => "still no JSON",
      // Stated rather than left to the pool's empty default: the point of this
      // test is that the re-ask was asked and would not answer either.
      repair: () => "still no JSON",
    });
    const { controller, store } = build({ repoPath: dir, pool, gates: { async resolveTaskGate() { return null; } } });

    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [] }));

    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });
});

describe("judging the merged whole without a base to diff against", () => {
  it("still asks, and says the diff was unavailable", async () => {
    const dir = repo(false);
    // A detached HEAD: there is no branch name to record as the base, which is
    // the state a run started from a bare checkout begins in.
    execFileSync("git", ["checkout", "--detach"], { cwd: dir, stdio: "ignore" });
    const { pool, specs } = rolePool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson() : DOCS),
      worker: workerThatCommits,
      qa: () => QA_PASS,
      validator: () => '```json\n{"verdict":"PASS","gaps":[],"summary":"ok"}\n```',
    });
    const { controller, store } = build({ repoPath: dir, pool });

    // The plan-intent check shares the validator role, and this counts validators
    // to prove the end-of-run one still ran.
    const runId = await controller.startRun("build a thing", RunConfig.parse({ deterministicChecks: [], planIntentCheck: false }));

    expect(store.getRun(runId)!.config.baseBranch).toBe("");
    // It still judges the merged whole — it just cannot show a diffstat.
    const validators = specs.filter((s) => s.role === "validator");
    expect(validators).toHaveLength(1);
    expect(validators[0]!.prompt).toContain("unavailable");
  });
});

describe("recoverable work on a finished run", () => {
  it("is nothing at all for a run that is not awaiting review", async () => {
    const dir = repo(false);
    const { pool } = rolePool({});
    const { controller, store } = build({ repoPath: dir, pool });
    store.createRun({
      id: "run1", repoPath: dir, assignment: "a", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "charrette/run1/main", config: RunConfig.parse({}),
    });

    expect(controller.hasRecoverableWork("run1")).toBe(false);
    expect(controller.awaitingVerification("run1")).toBe(false);
    expect(controller.hasRecoverableWork("no-such-run")).toBe(false);
  });
});
