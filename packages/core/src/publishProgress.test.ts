import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent } from "@charrette/shared";

const { seedWorktreeDepsMock } = vi.hoisted(() => ({ seedWorktreeDepsMock: vi.fn(async () => [] as unknown[]) }));
vi.mock("./deps.js", () => ({ seedWorktreeDeps: seedWorktreeDepsMock }));

import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * Publishing a run as it goes, and the base branch it publishes into.
 *
 * Run 614e06d5 merged ~97 commits over many hours into a GitHub repository
 * that stayed empty the whole time: nothing was pushed until the end, and the
 * end could not open its pull request because origin had no `main`. These are
 * the two halves of the fix, driven against a real bare remote and the real
 * adapter over a hand-rolled Octokit that remembers what it opened.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  seedWorktreeDepsMock.mockReset().mockResolvedValue([]);
  vi.restoreAllMocks();
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A repository with one commit and a bare origin; `pushMain: false` leaves origin empty, as a new GitHub repository is. */
function repo(opts: { pushMain?: boolean; remote?: string } = {}): { dir: string; remote: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-progress-"));
  made.push(dir, `${dir}-wt`);
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "user.email", "t@example.invalid");
  sh(dir, "config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "first");
  let remote = opts.remote ?? "";
  if (!remote) {
    remote = mkdtempSync(path.join(tmpdir(), "charrette-progress-remote-"));
    made.push(remote);
    sh(remote, "init", "-q", "--bare", "-b", "main");
  }
  sh(dir, "remote", "add", "origin", remote);
  if (opts.pushMain ?? true) sh(dir, "push", "-q", "origin", "main");
  return { dir, remote };
}

const remoteHead = (remote: string, branch: string) => {
  try {
    return sh(remote, "rev-parse", "--verify", `refs/heads/${branch}`);
  } catch {
    return "";
  }
};

interface Pr {
  number: number;
  html_url: string;
  state: string;
  draft: boolean;
  head: string;
  title: string;
  body: string;
}

/** The real adapter over an Octokit that keeps its pull requests, so a later `ensurePR` adopts an earlier one. */
function fakeGithub(opts: { draftsUnsupported?: boolean; createError?: Error } = {}) {
  const adapter = new GitHubAdapter("token", "acme/widgets");
  const prs: Pr[] = [];
  const created: Pr[] = [];
  const updates: { pull_number: number; body?: string; title?: string }[] = [];
  const readied: unknown[] = [];
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
        list: async (args: { head: string }) => ({ data: prs.filter((p) => `acme:${p.head}` === args.head) }),
        create: async (args: { head: string; title: string; body: string; draft: boolean }) => {
          if (opts.createError) throw opts.createError;
          if (args.draft && opts.draftsUnsupported) {
            throw Object.assign(new Error("Validation Failed"), {
              status: 422,
              response: { data: { errors: [{ message: "Draft pull requests are not supported in this repository." }] } },
            });
          }
          const number = 70 + prs.length;
          const pr = { number, html_url: `https://example.invalid/pull/${number}`, state: "open", draft: args.draft, head: args.head, title: args.title, body: args.body };
          prs.push(pr);
          created.push({ ...pr });
          return { data: { number, html_url: pr.html_url } };
        },
        get: async (args: { pull_number: number }) => {
          const pr = prs.find((p) => p.number === args.pull_number)!;
          return { data: { state: pr.state, draft: pr.draft, merged_at: null, node_id: `node-${pr.number}`, head: { sha: "abc" } } };
        },
        update: async (args: { pull_number: number; body?: string; title?: string }) => {
          updates.push(args);
          const pr = prs.find((p) => p.number === args.pull_number)!;
          if (args.body !== undefined) pr.body = args.body;
          return { data: {} };
        },
      },
      checks: { listForRef: async () => ({ data: [] }) },
      repos: { getCombinedStatusForRef: async () => ({ data: { statuses: [] } }) },
    },
    graphql: async (_q: string, vars: { id: string }) => {
      readied.push(vars);
      const pr = prs.find((p) => `node-${p.number}` === vars.id)!;
      pr.draft = false;
      return {};
    },
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
  };
  return { adapter, prs, created, updates, readied };
}

const DOCS = "<prd>\n# PRD — Build the thing\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const QA_PASS = '```json\n{"verdict":"PASS","notes":"looks right"}\n```';
const dagJson = (ids: string[]) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: ids.map((id) => ({ id, epicId: "epic-e", title: id.toUpperCase(), spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], estimatedSize: "S" as const })),
  }) +
  "\n```";

function pool(ids: string[] = ["task-a"]): AgentPool {
  let n = 0;
  return {
    async run(spec: AgentSpec): Promise<AgentResult> {
      await spec.budgetCheck?.();
      n++;
      const base: AgentResult = { sessionId: `s${n}`, sdkSessionId: `sdk${n}`, resultText: "", costUsd: 0, turns: 1, outcome: "done" };
      if (spec.role === "planner") return { ...base, resultText: spec.prompt.includes("PRD") ? dagJson(ids) : DOCS };
      if (spec.role === "worker") {
        writeFileSync(path.join(spec.cwd, `work-${path.basename(spec.cwd)}-${n}.txt`), "done\n");
        sh(spec.cwd, "add", "-A");
        sh(spec.cwd, "-c", "user.email=w@x.invalid", "-c", "user.name=W", "commit", "-q", "-m", "work");
        return { ...base, resultText: "did the work" };
      }
      if (spec.role === "qa") return { ...base, resultText: QA_PASS };
      return base;
    },
  } as unknown as AgentPool;
}

function build(repoPath: string, github: GitHubAdapter) {
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
  };
  const controller = new RunController(store, bus, pool(), github, gates, repoPath);
  const logs = () => events.flatMap((e) => (e.type === "agent.log" ? [e.text] : []));
  return { controller, store, events, logs };
}

/** Nothing here answers the validator or drives the product, and what the closing gates make of that is not this file's subject. */
const CONFIG = { deterministicChecks: [] as string[], waitForChecks: false, holdUntilProven: false, live: { enabled: false } };

describe("publishing while the run is still going", () => {
  it("pushes after the merge and opens a draft that says not to merge, then makes that same pull request the run's", async () => {
    const { dir, remote } = repo();
    const gh = fakeGithub();
    const { controller, store, events, logs } = build(dir, gh.adapter);

    const runId = await controller.startRun("build a thing", RunConfig.parse(CONFIG));

    // The work reached origin.
    expect(remoteHead(remote, `charrette/${runId}/main`)).toBe(sh(dir, "rev-parse", `charrette/${runId}/main`));
    // One pull request, opened mid-run as a draft that says what it is...
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]!.draft).toBe(true);
    expect(gh.created[0]!.head).toBe(`charrette/${runId}/main`);
    expect(gh.created[0]!.body).toContain("**This run is still in progress. Do not merge this pull request yet.**");
    expect(gh.created[0]!.body).toContain("1 task merged so far:\n\n- TASK-A");
    expect(logs().some((l) => l.startsWith("opened draft PR #70 to show the run's progress"))).toBe(true);
    // ...then adopted by the end of the run: rewritten with the final body and flipped ready.
    expect(gh.prs[0]!.body).toContain("1 task merged on the run's integration branch");
    expect(gh.prs[0]!.body).not.toContain("still in progress");
    expect(gh.readied).toEqual([{ id: "node-70" }]);
    expect(gh.prs[0]!.draft).toBe(false);
    expect(store.getTask(runId, "task-a")!.prNumber).toBe(70);
    // The draft was never announced as the run's pull request; the final one is, once.
    expect(events.filter((e) => e.type === "github.pr_opened")).toHaveLength(1);
  });

  it("keeps today's behaviour with publish: end — nothing until the run is judged, and no draft first", async () => {
    const { dir } = repo();
    const gh = fakeGithub();
    const { controller, logs } = build(dir, gh.adapter);

    await controller.startRun("build a thing", RunConfig.parse({ ...CONFIG, publish: "end" }));

    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]!.draft).toBe(false);
    expect(gh.created[0]!.body).not.toContain("still in progress");
    expect(logs().some((l) => l.includes("progress"))).toBe(false);
  });

  it("publishes nothing early in per-task mode", async () => {
    const { dir } = repo();
    const gh = fakeGithub();
    const { controller } = build(dir, gh.adapter);

    await controller.startRun("build a thing", RunConfig.parse({ ...CONFIG, prMode: "per-task" }));

    expect(gh.created.map((p) => p.head)).toEqual([expect.stringMatching(/\/task-a$/)]);
  });

  it("lets a task stay merged when the progress push fails, and says so", async () => {
    // An origin that is not there: the base-branch check, the progress push and
    // the final publish all fail, and none of them may take the merge with them.
    const { dir } = repo({ pushMain: false, remote: path.join(tmpdir(), "charrette-progress-no-such-remote") });
    const gh = fakeGithub();
    const { controller, store, logs } = build(dir, gh.adapter);

    const runId = await controller.startRun("build a thing", RunConfig.parse(CONFIG));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(logs().some((l) => l.startsWith(`could not push charrette/${runId}/main to show progress; the merge stands`))).toBe(true);
    expect(logs().some((l) => l.startsWith("could not ask origin whether it has the base branch `main`"))).toBe(true);
    expect(gh.created).toHaveLength(0);
  });

  it("does not open a mergeable pull request mid-run on a repository that refuses drafts", async () => {
    const { dir } = repo();
    const gh = fakeGithub({ draftsUnsupported: true });
    const { controller, logs } = build(dir, gh.adapter);

    await controller.startRun("build a thing", RunConfig.parse(CONFIG));

    expect(logs().some((l) => l.includes("this repository does not allow draft pull requests"))).toBe(true);
    // The end of the run still publishes, ready, which is what it always did there.
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]!.body).not.toContain("still in progress");
  });

  it("logs a GitHub that refuses the progress PR and carries on", async () => {
    const { dir } = repo();
    const gh = fakeGithub({ createError: new Error("HttpError: Bad credentials") });
    const { controller, store, logs } = build(dir, gh.adapter);

    const runId = await controller.startRun("build a thing", RunConfig.parse(CONFIG));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(logs().some((l) => l.startsWith(`pushed charrette/${runId}/main, but the progress PR could not be opened or updated`))).toBe(true);
  });
});

describe("the base branch origin does not have", () => {
  it("is created at the start of the run, so the run's pull request has somewhere to go", async () => {
    // Run 614e06d5, in miniature: a GitHub repository with no commits.
    const { dir, remote } = repo({ pushMain: false });
    const gh = fakeGithub();
    const { controller, logs } = build(dir, gh.adapter);
    const startedAt = sh(dir, "rev-parse", "main");

    await controller.startRun("build a thing", RunConfig.parse(CONFIG));

    expect(remoteHead(remote, "main")).toBe(startedAt);
    expect(logs().some((l) => l.startsWith("origin had no `main` branch") && l.includes("Create-only"))).toBe(true);
    expect(gh.created).toHaveLength(1);
  });

  it("is created on resume, for a run that started before any of this", async () => {
    const { dir, remote } = repo();
    const gh = fakeGithub();
    const { controller, logs } = build(dir, gh.adapter);
    const runId = await controller.startRun("build a thing", RunConfig.parse(CONFIG));
    sh(remote, "update-ref", "-d", "refs/heads/main");
    expect(logs().some((l) => l.startsWith("origin had no `main` branch"))).toBe(false);

    await controller.resume(runId);

    expect(remoteHead(remote, "main")).toBe(sh(dir, "rev-parse", "main"));
    expect(logs().some((l) => l.startsWith("origin had no `main` branch"))).toBe(true);
  });

  it("is not looked for without GitHub", async () => {
    const { dir, remote } = repo({ pushMain: false });
    const { controller } = build(dir, new GitHubAdapter(undefined, undefined));

    await controller.startRun("build a thing", RunConfig.parse(CONFIG));

    expect(remoteHead(remote, "main")).toBe("");
  });
});

/**
 * PR #27 of run 614e06d5: an open draft from before the run published, a run
 * restarted several times, and a PR_REVIEW with every gate green that left it a
 * draft saying "do not merge". Nothing in memory survives a restart, so each of
 * these is a fresh controller over the same store, asking GitHub.
 */
describe("a draft on the run's head after a restart", () => {
  const GATES: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
  };

  async function finished() {
    const { dir, remote } = repo();
    const gh = fakeGithub();
    const { controller, store } = build(dir, gh.adapter);
    const runId = await controller.startRun("build a thing", RunConfig.parse(CONFIG));
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    const bus = new Bus(store);
    const logged: string[] = [];
    bus.subscribe(({ event }) => {
      if (event.type === "agent.log") logged.push(event.text);
    });
    bus.publish({ type: "run.merge_status", runId, prNumber: 70, state: "mergeable", baseBranch: "main", conflicts: [], resolvedBy: "already-current", ts: Date.now() });
    const restarted = new RunController(store, bus, pool(), gh.adapter, GATES, dir);
    return { dir, remote, gh, store, bus, runId, restarted, logged, pr: gh.prs[0]! };
  }

  it("rewrites and readies a draft somebody else opened", async () => {
    const { pr, restarted, runId, logged } = await finished();
    pr.draft = true;
    pr.body = "Draft opened by hand. Do not merge.";

    await restarted.resume(runId);

    expect(pr.draft).toBe(false);
    expect(pr.body).toContain("1 task merged on the run's integration branch");
    expect(pr.body).not.toContain("Do not merge");
    expect(logged.some((l) => l.startsWith("#70 is still a draft"))).toBe(true);
  });

  it("rewrites and readies the run's own progress draft", async () => {
    const { pr, restarted, runId } = await finished();
    pr.draft = true;
    pr.body = `**This run is still in progress. Do not merge this pull request yet.**\n\n<!-- charrette-run:${runId}/pr-run -->`;

    await restarted.resume(runId);

    expect(pr.draft).toBe(false);
    expect(pr.body).not.toContain("still in progress");
  });

  it("rewrites a draft that something still holds, says why, and leaves it a draft", async () => {
    const { pr, restarted, runId, store } = await finished();
    pr.draft = true;
    pr.body = "Draft opened by hand. Do not merge.";
    store.updateTask(runId, "task-a", { unverified: ["payments were only exercised against a mock"] });

    await restarted.resume(runId);

    expect(pr.draft).toBe(true);
    expect(pr.body).toContain("payments were only exercised against a mock");
    expect(pr.body).toContain("held as a draft");
  });

  it("leaves a pull request that is already ready exactly as it is", async () => {
    const { gh, pr, restarted, runId } = await finished();
    pr.body = "My own summary.";
    const writes = gh.updates.length;

    await restarted.resume(runId);

    expect(pr.body).toBe("My own summary.");
    expect(gh.updates).toHaveLength(writes);
  });

  it("keeps the run's link to the pull request when GitHub refuses to flip it", async () => {
    const { dir } = repo();
    const gh = fakeGithub();
    (gh.adapter as unknown as { octokit: { graphql: unknown } }).octokit.graphql = async () => {
      throw new Error("Resource not accessible by integration");
    };
    const { controller, store, events, logs } = build(dir, gh.adapter);

    const runId = await controller.startRun("build a thing", RunConfig.parse(CONFIG));

    expect(store.getTask(runId, "task-a")!.prNumber).toBe(70);
    expect(store.getRun(runId)!.state).toBe("PR_REVIEW");
    expect(events.some((e) => e.type === "github.pr_publish_failed")).toBe(false);
    expect(logs().some((l) => l.startsWith("#70 is open but could not be marked ready for review"))).toBe(true);
  });

  describe("a resume re-checking red CI", () => {
    /** A fix merged by a process that died before pushing it. */
    async function unpushedFix() {
      const s = await finished();
      const branch = `charrette/${s.runId}/main`;
      // By plumbing: the branch is checked out in the run's integration worktree.
      const parent = sh(s.dir, "rev-parse", branch);
      const head = sh(s.dir, "-c", "user.email=a@example.invalid", "-c", "user.name=A", "commit-tree", "-p", parent, "-m", "fix the red check", `${parent}^{tree}`);
      sh(s.dir, "update-ref", `refs/heads/${branch}`, head);
      s.store.patchRunConfig(s.runId, { waitForChecks: true, holdUntilGreen: false, checkTimeoutMinutes: 1 });
      s.bus.publish({ type: "run.ci_status", runId: s.runId, prNumber: 70, state: "failing", failing: ["test"], total: 1, names: ["test"], sha: "abc", ts: Date.now() });
      let onOrigin = "";
      let reads = 0;
      // The first read is `resume` refreshing the record: still the old head,
      // still red. The next is the re-check, which is what has to see the fix.
      (s.gh.adapter as unknown as { prChecks: unknown }).prChecks = async () => {
        if (++reads === 1) return { state: "failing", failing: ["test"], total: 1, names: ["test"], sha: parent };
        onOrigin ||= remoteHead(s.remote, branch);
        return { state: "passing", failing: [], total: 1, names: ["test"], sha: head };
      };
      return { ...s, head, onOrigin: () => onOrigin };
    }

    it("pushes the fix before asking about it", async () => {
      const { restarted, runId, head, onOrigin } = await unpushedFix();

      await restarted.resume(runId);

      expect(onOrigin()).toBe(head);
    });

    it("says so when that push fails, and still asks", async () => {
      const { dir, restarted, runId, logged, store } = await unpushedFix();
      sh(dir, "remote", "set-url", "origin", path.join(tmpdir(), "charrette-progress-no-such-remote"));

      await restarted.resume(runId);

      expect(logged.some((l) => l.startsWith(`could not push charrette/${runId}/main before re-checking CI`))).toBe(true);
      expect(store.ciStatus(runId)).toMatchObject({ state: "passing" });
    });
  });
});

describe("how often a progress pass goes to GitHub", () => {
  /** A run in the store with one merged task and a pushed integration branch, and an adapter that counts. */
  function staged(over: Partial<RunConfig> = {}) {
    const { dir, remote } = repo();
    sh(dir, "branch", "charrette/run1/main");
    const ensured: { draft?: boolean; draftOnly?: boolean }[] = [];
    let prState: "open" | "draft" | "closed" | "merged" = "draft";
    let answer: { number: number; url: string; fresh?: boolean } | null = { number: 9, url: "https://example.invalid/pull/9", fresh: true };
    const adapter = {
      enabled: true,
      async ensurePR(_r: string, _t: string, _h: string, _b: string, _title: string, _body: string, opts: { draft?: boolean; draftOnly?: boolean }) {
        ensured.push(opts);
        return answer;
      },
      async prState() {
        return prState;
      },
    } as unknown as GitHubAdapter;
    const { controller, store, logs } = build(dir, adapter);
    store.createRun({
      id: "run1", repoPath: dir, assignment: "build a thing", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "charrette/run1/main", config: RunConfig.parse({ ...CONFIG, baseBranch: "main", ...over }),
    });
    store.insertTasks("run1", [{ id: "epic-e", title: "E" }], [
      { id: "a", epicId: "epic-e", title: "A", spec: "", acceptanceCriteria: [], dependsOn: [], state: "MERGED", branch: "charrette/run1/a", worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 1, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "S" },
    ]);
    const c = controller as unknown as { queueProgressPublish(id: string): void; settleProgress(id: string): Promise<void>; progressPrRefreshMs: number };
    return {
      c,
      controller,
      dir,
      remote,
      store,
      logs,
      ensured,
      setState: (s: typeof prState) => (prState = s),
      setAnswer: (a: typeof answer) => (answer = a),
    };
  }

  it("coalesces a burst of merges into one more pass rather than one each", async () => {
    const { c, ensured } = staged();
    c.progressPrRefreshMs = 0;

    c.queueProgressPublish("run1");
    c.queueProgressPublish("run1");
    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(ensured).toHaveLength(2);
    expect(ensured[0]).toEqual({ draft: true, draftOnly: true });
  });

  it("does not ask GitHub again within the refresh window", async () => {
    const { c, ensured } = staged();

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");
    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(ensured).toHaveLength(1);
  });

  it("asks again when GitHub had nothing to open", async () => {
    const { c, ensured, setAnswer } = staged();
    setAnswer(null);

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");
    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(ensured).toHaveLength(2);
  });

  it("stops opening drafts once a human has closed ours", async () => {
    const { c, ensured, logs, setState } = staged();
    c.progressPrRefreshMs = 0;
    c.queueProgressPublish("run1");
    await c.settleProgress("run1");
    setState("closed");

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");
    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(ensured).toHaveLength(1);
    expect(logs().filter((l) => l.startsWith("progress PR #9 was closed by hand"))).toHaveLength(1);
  });

  it("keeps refreshing a draft that is still open", async () => {
    const { c, ensured } = staged();
    c.progressPrRefreshMs = 0;
    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(ensured).toHaveLength(2);
  });

  it("leaves the pull request alone once the run has published its own", async () => {
    // From then on `openRunPr` and the CI hold own its description.
    const { c, ensured, store } = staged();
    store.updateTask("run1", "a", { prNumber: 9 });

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(ensured).toHaveLength(0);
  });

  /** A commit on the integration branch, the way a merged CI fix lands there. */
  const landFix = (dir: string, name = "fix.txt") => {
    sh(dir, "checkout", "-q", "charrette/run1/main");
    writeFileSync(path.join(dir, name), "fixed\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "fix the red check");
    const head = sh(dir, "rev-parse", "HEAD");
    sh(dir, "checkout", "-q", "main");
    return head;
  };

  it("keeps pushing after the rollup exists, so a merged CI fix reaches GitHub", async () => {
    // Run 614e06d5's CI-fix loop waited on a commit GitHub did not have.
    const { c, dir, remote, ensured, store } = staged();
    store.updateTask("run1", "a", { prNumber: 9 });
    const head = landFix(dir);

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(remoteHead(remote, "charrette/run1/main")).toBe(head);
    // And the description is still not this pass's to rewrite.
    expect(ensured).toHaveLength(0);
  });

  it("says so, and carries on, when the integration branch is not there to push", async () => {
    const { c, dir, logs } = staged();
    sh(dir, "branch", "-D", "charrette/run1/main");

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(logs().some((l) => l.startsWith("could not push charrette/run1/main to show progress"))).toBe(true);
  });

  it("never forces that push over a commit someone else put on the branch", async () => {
    const { c, dir, remote, logs, store } = staged();
    store.updateTask("run1", "a", { prNumber: 9 });
    sh(dir, "push", "-q", "origin", "charrette/run1/main");
    const base = sh(remote, "rev-parse", "refs/heads/charrette/run1/main");
    const theirs = sh(remote, "-c", "user.email=a@example.invalid", "-c", "user.name=A", "commit-tree", "-p", base, "-m", "theirs", `${base}^{tree}`);
    sh(remote, "update-ref", "refs/heads/charrette/run1/main", theirs);
    landFix(dir);

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(remoteHead(remote, "charrette/run1/main")).toBe(theirs);
    expect(logs().some((l) => l.startsWith("could not push charrette/run1/main to show progress"))).toBe(true);
  });

  describe("reading CI after a push", () => {
    type Reading = { state: string; failing: string[]; total: number; names: string[]; sha: string };
    const reading = (sha: string, state: "passing" | "failing"): Reading => ({ state, failing: state === "failing" ? ["test"] : [], total: 1, names: ["test"], sha });

    /** A pushed fix, and a GitHub that answers from `answers`, repeating the last. */
    async function pushedFix(answers: (old: string, fixed: string) => Reading[]) {
      const s = staged({ waitForChecks: true, checkTimeoutMinutes: 1 });
      s.store.updateTask("run1", "a", { prNumber: 9 });
      const old = sh(s.dir, "rev-parse", "charrette/run1/main");
      const fixed = landFix(s.dir);
      s.c.queueProgressPublish("run1");
      await s.c.settleProgress("run1");
      const list = answers(old, fixed);
      let n = 0;
      const ctl = s.controller as unknown as { github: { prChecks: () => Promise<Reading> }; awaitChecks(id: string, pr: number): Promise<void>; pushedHeadSettleMs: number };
      ctl.github.prChecks = async () => list[Math.min(n++, list.length - 1)]!;
      return { ...s, ctl, old, fixed, reads: () => n };
    }

    it("waits for the pushed commit rather than reading the old one's red", async () => {
      const { ctl, store, logs, fixed } = await pushedFix((old, next) => [reading(old, "failing"), reading(next, "passing")]);

      await ctl.awaitChecks("run1", 9);

      expect(store.ciStatus("run1")).toMatchObject({ state: "passing", sha: fixed });
      expect(logs().filter((l) => l.startsWith("GitHub still shows"))).toHaveLength(1);
    });

    it("says so once however long GitHub takes to catch up", async () => {
      const { ctl, logs, reads } = await pushedFix((old, next) => [reading(old, "failing"), reading(old, "failing"), reading(next, "passing")]);

      await ctl.awaitChecks("run1", 9);

      expect(reads()).toBe(3);
      expect(logs().filter((l) => l.startsWith("GitHub still shows"))).toHaveLength(1);
    });

    it("stops waiting at the bound, in case someone moved the branch back", async () => {
      const { ctl, store, old } = await pushedFix((sha) => [reading(sha, "failing")]);
      ctl.pushedHeadSettleMs = 0;

      await ctl.awaitChecks("run1", 9);

      expect(store.ciStatus("run1")).toMatchObject({ state: "failing", sha: old });
    });

    it("believes a head that is not an ancestor of the push", async () => {
      // Someone pushed on top: that is the head now, and its verdict is real.
      const { ctl, store } = await pushedFix(() => [reading("0".repeat(40), "failing")]);

      await ctl.awaitChecks("run1", 9);

      expect(store.ciStatus("run1")).toMatchObject({ state: "failing" });
    });
  });

  it("names how many merged tasks it left off a long list", async () => {
    const { dir } = repo();
    sh(dir, "branch", "charrette/run1/main");
    const bodies: string[] = [];
    const adapter = {
      enabled: true,
      async ensurePR(_r: string, _t: string, _h: string, _b: string, _title: string, body: string) {
        bodies.push(body);
        return null;
      },
    } as unknown as GitHubAdapter;
    const { controller, store } = build(dir, adapter);
    store.createRun({
      id: "run1", repoPath: dir, assignment: "build a thing", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "charrette/run1/main", config: RunConfig.parse({ ...CONFIG, baseBranch: "main" }),
    });
    store.insertTasks("run1", [{ id: "epic-e", title: "E" }], Array.from({ length: 45 }, (_, i) => (
      { id: `t${i}`, epicId: "epic-e", title: `T${i}`, spec: "", acceptanceCriteria: [], dependsOn: [], state: "MERGED" as const, branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 1, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "S" as const }
    )));
    const c = controller as unknown as { queueProgressPublish(id: string): void; settleProgress(id: string): Promise<void> };

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(bodies[0]).toContain("45 tasks merged so far");
    expect(bodies[0]).toContain("- …and 5 more");
  });

  it("does nothing for a run with no base branch to publish into", async () => {
    const { c, ensured } = staged({ baseBranch: "" });

    c.queueProgressPublish("run1");
    await c.settleProgress("run1");

    expect(ensured).toHaveLength(0);
  });
});
