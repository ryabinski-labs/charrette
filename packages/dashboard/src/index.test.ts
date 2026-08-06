import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunConfig, RunState, TaskState } from "@harness/shared";
import { Bus, Store } from "@harness/core";
import { Dashboard } from "./index.js";
import { PAGE_HTML } from "./page.js";

/** Hold a port the way a second harness would. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const close = (s: { close: (cb?: () => void) => void }) => new Promise<void>((r) => s.close(() => r()));

function dashboard(opts?: { port?: number }): Dashboard {
  const store = new Store(":memory:");
  return new Dashboard(store, new Bus(store), opts);
}

describe("port selection", () => {
  const started: Dashboard[] = [];
  const held: Server[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
    for (const s of held.splice(0)) await close(s);
  });

  /**
   * The lowest port a dashboard would pick whose successor is also free. Without
   * this the test asserts base+1 on a machine where a real harness is already
   * listening there, and fails for a reason that has nothing to do with the code.
   * Ports it rules out stay held for the duration so the search cannot loop.
   */
  async function freeAdjacentBase(): Promise<number> {
    for (;;) {
      const probe = dashboard();
      const base = Number(new URL(await probe.start()).port);
      await probe.stop();
      try {
        await close(await occupy(base + 1));
        return base;
      } catch {
        held.push(await occupy(base));
      }
    }
  }

  it("takes the next free port so a second repo can run at the same time", async () => {
    // Retried, because the port space is shared and the probe cannot hold what
    // it is proving free: `freeAdjacentBase` has to release base+1 before the
    // dashboard can bind it, and anything on the machine — including another
    // test file's dashboard, running in a parallel worker — can take it in that
    // window. The behaviour under test is deterministic; the machine is not,
    // and a suite that fails one run in ten teaches people to re-run CI rather
    // than read it.
    for (let attempt = 1; ; attempt++) {
      // A free base port, then squat on it exactly as a running harness would.
      const base = await freeAdjacentBase();
      held.push(await occupy(base));

      const second = dashboard();
      started.push(second);
      const url = await second.start();
      const port = Number(new URL(url).port);

      if (port !== base + 1 && attempt < 5) {
        // Somebody else took base+1 first. Give the ports back and try again.
        await started.pop()!.stop();
        await close(held.pop()!);
        continue;
      }
      expect(port).toBe(base + 1);
      // and it is actually serving there, not merely bound
      const res = await fetch(new URL("/api/state", url), {
        headers: { authorization: `Bearer ${second.token}`, connection: "close" },
      });
      expect(res.status).toBe(200);
      return;
    }
  });

  it("fails loudly instead of moving when the operator named the port", async () => {
    const probe = dashboard();
    started.push(probe);
    const port = Number(new URL(await probe.start()).port);
    await probe.stop();
    started.pop();
    held.push(await occupy(port));

    await expect(dashboard({ port }).start()).rejects.toThrow(/already in use/);
  });
});

describe("which runs the page shows", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
  });

  /** One finished run and nothing else, which is what a repo looks like afterwards. */
  function finishedRun(): Store {
    const store = new Store(":memory:");
    store.createRun({
      id: "run1",
      repoPath: tmpdir(),
      assignment: "build a thing",
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run1/main",
      config: RunConfig.parse({}),
    });
    for (const to of ["PLANNING", "PLAN_REVIEW", "EXECUTING", "INTEGRATING", "PR_REVIEW"] as RunState[]) {
      store.transitionRun("run1", to);
    }
    return store;
  }

  async function runIds(store: Store, opts?: { includeFinished?: boolean }): Promise<string[]> {
    const dash = new Dashboard(store, new Bus(store), opts);
    started.push(dash);
    const url = await dash.start();
    const res = await fetch(new URL("/api/state", url), { headers: { authorization: `Bearer ${dash.token}`, connection: "close" } });
    return ((await res.json()) as { runs: { id: string }[] }).runs.map((r) => r.id);
  }

  it("drops a run that has finished, because it is a view of work in flight", async () => {
    expect(await runIds(finishedRun())).toEqual([]);
  });

  it("keeps it for `harness dashboard`, where the finished run is the whole subject", async () => {
    // Nothing is executing when that command runs, so the open-runs view serves
    // an empty page for the one thing the operator opened it to read.
    expect(await runIds(finishedRun(), { includeFinished: true })).toEqual(["run1"]);
  });
});

describe("linking issues and PRs", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
    delete process.env.HARNESS_GITHUB_REPO;
  });

  /** A run in a real repo whose only record of the GitHub slug is its origin remote. */
  function runWithoutSlug(): Store {
    const repo = mkdtempSync(path.join(tmpdir(), "harness-dash-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:ryabinski-labs/billing-app.git"], {
      cwd: repo,
      stdio: "ignore",
    });
    const store = new Store(":memory:");
    store.createRun({
      id: "run1",
      repoPath: repo,
      assignment: "build a thing",
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: "harness/run1/main",
      config: RunConfig.parse({}), // no githubRepo — as every run before it was persisted
    });
    return store;
  }

  async function state(store: Store) {
    const dash = new Dashboard(store, new Bus(store));
    started.push(dash);
    const url = await dash.start();
    const res = await fetch(new URL("/api/state", url), { headers: { authorization: `Bearer ${dash.token}`, connection: "close" } });
    return (await res.json()) as { runs: { githubRepo: string | null }[] };
  }

  it("falls back to the origin remote, so old runs still link their issues", async () => {
    // The reported symptom: a task card showed "issue #28" as dead plain text
    // because the run config, written before the slug was persisted, had no repo.
    delete process.env.HARNESS_GITHUB_REPO;
    const body = await state(runWithoutSlug());
    expect(body.runs[0]!.githubRepo).toBe("ryabinski-labs/billing-app");
  });

  it("lets the environment override what the remote says", async () => {
    process.env.HARNESS_GITHUB_REPO = "someone/else";
    const body = await state(runWithoutSlug());
    expect(body.runs[0]!.githubRepo).toBe("someone/else");
  });
});

describe("saying why a task is parked", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
  });

  it("falls back to the transition event when the row carries no reason", async () => {
    // Runs recorded before the reason was written to the task row have it only in
    // the event — and the card would otherwise be a red NEEDS_HUMAN pill with
    // nothing under it, which is the state the operator can least act on.
    const store = new Store(":memory:");
    store.createRun({
      id: "run1", repoPath: "/tmp/x", assignment: "a", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "harness/run1/main", config: RunConfig.parse({}),
    });
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [
      { id: "t1", epicId: "e1", title: "T", spec: "", acceptanceCriteria: [], dependsOn: [], state: "PENDING", branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0, assignedSkills: [], errorSummary: null, touchedPaths: [], completionProbe: "", estimatedSize: "M" as const },
    ]);
    store.transitionTask("run1", "t1", "READY");
    store.transitionTask("run1", "t1", "WORKING");
    store.transitionTask("run1", "t1", "NEEDS_HUMAN", "iteration cap hit on deterministic checks");

    const dash = new Dashboard(store, new Bus(store));
    started.push(dash);
    const url = await dash.start();
    const res = await fetch(new URL("/api/state", url), { headers: { authorization: `Bearer ${dash.token}`, connection: "close" } });
    const body = (await res.json()) as { runs: { tasks: { errorSummary: string | null }[] }[] };
    expect(body.runs[0]!.tasks[0]!.errorSummary).toBe("iteration cap hit on deterministic checks");
  });

  it("leaves every other task exactly as the store has it", async () => {
    const store = new Store(":memory:");
    store.createRun({
      id: "run1", repoPath: "/tmp/x", assignment: "a", state: "CREATED", prdPath: null, planHash: null,
      integrationBranch: "harness/run1/main", config: RunConfig.parse({}),
    });
    const task = (id: string, errorSummary: string | null) => ({
      id, epicId: "e1", title: id.toUpperCase(), spec: "", acceptanceCriteria: [], dependsOn: [], state: "PENDING" as TaskState,
      branch: null, worktreePath: null, githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0,
      assignedSkills: [], errorSummary, touchedPaths: [], completionProbe: "", estimatedSize: "M" as const,
    });
    store.insertTasks("run1", [{ id: "e1", title: "E" }], [task("working", null), task("parked", "the reason already on the row")]);
    store.transitionTask("run1", "working", "READY");
    store.transitionTask("run1", "working", "WORKING");
    store.transitionTask("run1", "parked", "READY");
    store.transitionTask("run1", "parked", "WORKING");
    store.transitionTask("run1", "parked", "NEEDS_HUMAN", "a different reason in the event");

    const dash = new Dashboard(store, new Bus(store));
    started.push(dash);
    const url = await dash.start();
    const res = await fetch(new URL("/api/state", url), { headers: { authorization: `Bearer ${dash.token}`, connection: "close" } });
    const body = (await res.json()) as { runs: { tasks: { id: string; errorSummary: string | null }[] }[] };

    const byId = new Map(body.runs[0]!.tasks.map((t) => [t.id, t.errorSummary]));
    // A task that is not parked is not given a reason it does not have…
    expect(byId.get("working")).toBeNull();
    // …and one whose row already carries the reason keeps that one, not the event's.
    expect(byId.get("parked")).toBe("the reason already on the row");
  });
});

describe("task-escalation gate", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
  });

  /** A dashboard with one task waiting on the operator, plus the worker's promise. */
  async function withOpenGate() {
    const dash = dashboard();
    started.push(dash);
    const url = await dash.start();
    const pending = dash.resolveTaskGate({
      runId: "r1", taskId: "t1", title: "Wire the toggle", why: "QA rejected it 3 times (the cap): never wired", iterations: 3,
      recommendation: "wire the toggle to the store in Settings.tsx, then re-run the suite",
      branch: "harness/r1/t1", worktreePath: null,
    });
    const post = (body: unknown) =>
      fetch(new URL("/api/gates/task", url), {
        method: "POST",
        headers: { authorization: `Bearer ${dash.token}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify(body),
      });
    return { dash, url, pending, post };
  }

  it("shows the waiting task, its reason, its branch, and the advisor's suggestion", async () => {
    const { dash, url } = await withOpenGate();
    const res = await fetch(new URL("/api/state", url), { headers: { authorization: `Bearer ${dash.token}`, connection: "close" } });
    const body = (await res.json()) as { taskGates: { taskId: string; why: string; branch: string | null; recommendation: string }[] };
    expect(body.taskGates).toHaveLength(1);
    expect(body.taskGates[0]!.why).toContain("QA rejected it 3 times");
    expect(body.taskGates[0]!.branch).toBe("harness/r1/t1");
    expect(body.taskGates[0]!.recommendation).toContain("Settings.tsx");
  });

  it("hands the operator's answer to the waiting worker", async () => {
    const { pending, post } = await withOpenGate();
    expect((await post({ runId: "r1", taskId: "t1", guidance: "start DynamoDB first" })).status).toBe(200);
    await expect(pending).resolves.toBe("start DynamoDB first");
  });

  it("parks on request, resolving null", async () => {
    const { pending, post } = await withOpenGate();
    expect((await post({ runId: "r1", taskId: "t1", park: true })).status).toBe(200);
    await expect(pending).resolves.toBeNull();
  });

  it("rejects an empty answer that is not an explicit park — a misclick must not spend iterations", async () => {
    const { pending, post } = await withOpenGate();
    expect((await post({ runId: "r1", taskId: "t1", guidance: "  " })).status).toBe(400);
    // Still open: the worker is still waiting, and a real answer still lands.
    expect((await post({ runId: "r1", taskId: "t1", guidance: "do X" })).status).toBe(200);
    await expect(pending).resolves.toBe("do X");
  });

  it("rejects an unauthenticated resolution", async () => {
    const { url } = await withOpenGate();
    const res = await fetch(new URL("/api/gates/task", url), {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ runId: "r1", taskId: "t1", park: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe("the pit stop gate", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
  });

  const STOP = {
    runId: "r1",
    number: 2,
    reason: 'the "Sign-in" epic is finished',
    demo: { started: true, howStarted: "pnpm dev on :5173", summary: "", journeys: [], couldNotReach: ["payments"], artifacts: [], commands: [] },
    reviews: [],
    merged: ["Sign in (task-a)"],
    upcoming: ["The map (task-b)"],
    parked: [],
    cancelled: [],
    spentUsd: 41.5,
    capUsd: 120,
    stopCostUsd: 3.75,
    projectedUsd: 98,
    intent: null,
    artifactsDir: "/repo/.harness/r1/pitstops/2",
    markdown: "# Pit stop 2\n\n**It runs.** pnpm dev on :5173",
  };

  async function withOpenStop() {
    const dash = dashboard();
    started.push(dash);
    const url = await dash.start();
    const pending = dash.resolvePitStop(STOP);
    const post = (body: unknown) =>
      fetch(new URL("/api/gates/pitstop", url), {
        method: "POST",
        headers: { authorization: `Bearer ${dash.token}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify(body),
      });
    return { dash, url, pending, post };
  }

  it("puts the whole report in the state the page renders", async () => {
    const { dash, url } = await withOpenStop();

    const res = await fetch(new URL("/api/state", url), { headers: { authorization: `Bearer ${dash.token}`, connection: "close" } });

    const body = (await res.json()) as { pitStop: { number: number; markdown: string; upcoming: string[] } | null };
    expect(body.pitStop!.number).toBe(2);
    expect(body.pitStop!.markdown).toContain("It runs.");
    // "Stop before you build X" is only sayable by someone shown X.
    expect(body.pitStop!.upcoming).toEqual(["The map (task-b)"]);
  });

  it("continues the run on keep going, with nothing written", async () => {
    const { pending, post } = await withOpenStop();

    expect((await post({ action: "continue" })).status).toBe(200);

    await expect(pending).resolves.toEqual({ action: "continue", feedback: "" });
  });

  it("carries their words through on a redirect", async () => {
    const { pending, post } = await withOpenStop();

    expect((await post({ action: "redirect", feedback: "drop the offline mode" })).status).toBe(200);

    await expect(pending).resolves.toEqual({ action: "redirect", feedback: "drop the offline mode" });
  });

  it("refuses a redirect or a re-plan with an empty box", async () => {
    const { pending, post } = await withOpenStop();

    // An empty box submitted by accident would spend a planner session on no
    // instruction at all.
    expect((await post({ action: "replan", feedback: "  " })).status).toBe(400);
    expect((await post({ action: "stop" })).status).toBe(200);
    await expect(pending).resolves.toEqual({ action: "stop", feedback: "" });
  });

  it("rejects an action it does not have", async () => {
    const { post } = await withOpenStop();

    expect((await post({ action: "delete-everything" })).status).toBe(400);
  });

  it("refuses a request that names no action at all", async () => {
    const { pending, post } = await withOpenStop();

    // Defaulting a missing action to "keep going" would spend the operator's
    // one checkpoint on a click they never made.
    expect((await post({ feedback: "something" })).status).toBe(400);
    // Still open, so the real answer still lands.
    expect((await post({ action: "stop" })).status).toBe(200);
    await expect(pending).resolves.toEqual({ action: "stop", feedback: "" });
  });

  it("answers 409 when nothing is waiting", async () => {
    const dash = dashboard();
    started.push(dash);
    const url = await dash.start();

    const res = await fetch(new URL("/api/gates/pitstop", url), {
      method: "POST",
      headers: { authorization: `Bearer ${dash.token}`, "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ action: "continue" }),
    });

    expect(res.status).toBe(409);
  });

  it("rejects an unauthenticated resolution", async () => {
    const { url } = await withOpenStop();

    const res = await fetch(new URL("/api/gates/pitstop", url), {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ action: "stop" }),
    });

    expect(res.status).toBe(401);
  });

  it("rejects a cross-origin resolution", async () => {
    const { url } = await withOpenStop();

    const res = await fetch(new URL("/api/gates/pitstop", url), {
      method: "POST",
      headers: {
        authorization: `Bearer ${started.at(-1)!.token}`,
        "content-type": "application/json",
        origin: "https://evil.example",
        connection: "close",
      },
      body: JSON.stringify({ action: "stop" }),
    });

    expect(res.status).toBe(403);
  });
});

describe("the page itself", () => {
  it("names the repository, not just the product", () => {
    // A hex run id is a resume handle; the folder is what the operator can say.
    expect(PAGE_HTML).toMatch(/id="repo"/);
    expect(PAGE_HTML).toMatch(/function repoName\(\)/);
    expect(PAGE_HTML).toMatch(/document\.title = name \? name/);
  });

  it("offers a desktop notification for the states that end or block a run", () => {
    for (const s of ["PR_REVIEW", "FAILED", "ABORTED", "PAUSED", "BUDGET_HOLD", "PLAN_REVIEW"]) {
      expect(PAGE_HTML).toContain(s + ":");
    }
    expect(PAGE_HTML).toMatch(/Notification\.requestPermission\(\)/);
  });

  it("gives every run and task state a colour, so no pill renders as 'no status'", () => {
    // The board is read at a glance by colour, and a state with no rule inherits
    // the neutral pill — indistinguishable from PENDING. VERIFYING, BUDGET_HOLD
    // and ABORTED all shipped that way: a run halted on the operator's budget
    // decision looked exactly as urgent as one that had not started.
    const coloured = new Set([...PAGE_HTML.matchAll(/\.s-([A-Z_]+)/g)].map((m) => m[1]!));
    for (const state of [...RunState.options, ...TaskState.options]) {
      expect(coloured, `${state} has no .s-${state} colour rule`).toContain(state);
    }
  });

  it("sorts every task state into a group, so no finished task hides in 'Queued'", () => {
    // GROUPS is the board's whole routing table, and an unlisted state falls through
    // to the Queued bucket — the board would then report merged work as not started.
    const literal = /const GROUPS = (\[[\s\S]*?\n\]);/.exec(PAGE_HTML)![1]!;
    const groups = new Function("return " + literal)() as { key: string; states: string[] }[];
    const routed = new Set(groups.flatMap((g) => g.states));
    for (const state of TaskState.options) expect(routed).toContain(state);

    // ACCEPTED is done work waiting on the integrator; counting it as pending would
    // undercount a finished run by however many PRs are still being merged.
    expect(groups.find((g) => g.key === "done")!.states).toEqual(["ACCEPTED", "MERGED"]);
  });

  it("renders task-escalation gates and preserves a half-typed answer across refreshes", () => {
    expect(PAGE_HTML).toMatch(/id="taskgates"/);
    expect(PAGE_HTML).toMatch(/function renderTaskGates/);
    // Rebuilt only when the set of gates changes — the textarea holds a
    // half-written answer, and the 5s refresh must not wipe it.
    expect(PAGE_HTML).toMatch(/sig !== taskGateSig/);
    // A gate opening is exactly the interruption the Notify button promises.
    expect(PAGE_HTML).toMatch(/a task needs you/);
  });

  it("never re-aims a half-written note at a task the operator did not choose", () => {
    // Reproduced in a browser against a real run: the operator picked
    // `ach-origination`, typed a note, that task merged, the 5s poll rebuilt the
    // <select>, and the option was gone — so the browser fell back to the first
    // one and the note was POSTed to `auth-middleware-hardening` under a
    // "Delivered" confirmation. Feedback is how a run gets steered; sending it
    // to the wrong agent is worse than not sending it.
    const literal = /(function keepTarget\([\s\S]*?\n\})/.exec(PAGE_HTML)![1]!;
    const keepTarget = new Function("return " + literal)() as (p: string, v: string[], t: boolean) => string;
    const open = ["r/a", "r/b"];

    expect(keepTarget("r/b", open, true)).toBe("r/b");
    // Gone, with a note in the box: ask, never guess.
    expect(keepTarget("r/b", ["r/a"], true)).toBe("");
    // Gone with nothing typed is nothing to misroute, so the first is fine.
    expect(keepTarget("r/b", ["r/a"], false)).toBe("r/a");
    expect(keepTarget("", open, false)).toBe("r/a");
    expect(keepTarget("r/b", [], true)).toBe("");

    // …and the UI has to say why the target went blank, or the operator just
    // sees a Send that refuses.
    expect(PAGE_HTML).toContain("finished \\u2014 choose who gets this");
    expect(PAGE_HTML).toMatch(/That task finished while you were writing/);
    // An explicit pick is the only thing allowed to re-aim it.
    expect(PAGE_HTML).toMatch(/\$\("fb-task"\)\.addEventListener\("change"/);
  });

  it("declares its own icon, so no dashboard load logs a 404 in the console", () => {
    // The console is where an operator looks when a run stalls; a favicon 404 on
    // every load is noise in exactly that place.
    expect(PAGE_HTML).toMatch(/<link rel="icon" href="data:image\/svg\+xml,/);
  });

  it("parses as JavaScript", () => {
    // The whole SPA lives in one template literal, so a syntax error in it compiles
    // cleanly and only fails in the browser, where nobody is watching the console.
    const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("budget gate", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
  });

  /** A dashboard with an open budget gate, plus the promise the agent is waiting on. */
  async function withOpenGate() {
    const dash = dashboard();
    started.push(dash);
    const url = await dash.start();
    const pending = dash.resolveBudgetGate({ scope: "run", spentUsd: 8.5, capUsd: 8, runSpentUsd: 8.5 });
    const post = (body: unknown) =>
      fetch(new URL("/api/gates/budget", url), {
        method: "POST",
        headers: { authorization: `Bearer ${dash.token}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify(body),
      });
    return { dash, url, pending, post };
  }

  it("offers a raise above what was already spent, so the operator is not re-prompted", async () => {
    const { url, dash } = await withOpenGate();
    const res = await fetch(new URL("/api/state", url), { headers: { authorization: `Bearer ${dash.token}`, connection: "close" } });
    const body = (await res.json()) as { budgetGate: { suggestedUsd: number; spentUsd: number } };
    expect(body.budgetGate.spentUsd).toBe(8.5);
    expect(body.budgetGate.suggestedUsd).toBeGreaterThan(8.5);
  });

  it("hands the new cap back to the waiting agent", async () => {
    const { pending, post } = await withOpenGate();
    expect((await post({ capUsd: 20 })).status).toBe(200);
    await expect(pending).resolves.toBe(20);
  });

  it("refuses a cap that would trip again immediately, leaving the gate open", async () => {
    const { post, pending } = await withOpenGate();
    const res = await post({ capUsd: 8.5 });
    expect(res.status).toBe(400);
    // Still open: the agent must not be resumed on a cap that cannot hold.
    expect((await post({ capUsd: 20 })).status).toBe(200);
    await expect(pending).resolves.toBe(20);
  });

  it("parks the run when the operator stops", async () => {
    const { pending, post } = await withOpenGate();
    expect((await post({ stop: true })).status).toBe(200);
    await expect(pending).resolves.toBeNull();
  });

  it("rejects an unauthenticated raise", async () => {
    const { url } = await withOpenGate();
    const res = await fetch(new URL("/api/gates/budget", url), {
      method: "POST",
      headers: { "content-type": "application/json", connection: "close" },
      body: JSON.stringify({ capUsd: 1000 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("mid-flight feedback", () => {
  const started: Dashboard[] = [];
  afterEach(async () => {
    for (const d of started.splice(0)) await d.stop();
  });

  async function withDash() {
    const dash = dashboard();
    started.push(dash);
    const url = await dash.start();
    const post = (body: unknown) =>
      fetch(new URL("/api/feedback", url), {
        method: "POST",
        headers: { authorization: `Bearer ${dash.token}`, "content-type": "application/json", connection: "close" },
        body: JSON.stringify(body),
      });
    return { dash, url, post };
  }

  it("relays feedback to the controller and reports how it was delivered", async () => {
    const { dash, post } = await withDash();
    const relayed: string[] = [];
    dash.attach({
      sendFeedback(runId, taskId, text) {
        relayed.push(`${runId}/${taskId}: ${text}`);
        return "live";
      },
    });
    const res = await post({ runId: "r1", taskId: "task-a", text: "skip the flaky suite" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { delivery: string }).delivery).toBe("live");
    expect(relayed).toEqual(["r1/task-a: skip the flaky suite"]);
  });

  it("surfaces the controller's refusal instead of pretending it was sent", async () => {
    const { dash, post } = await withDash();
    dash.attach({
      sendFeedback() {
        throw new Error("task task-a is MERGED — no agent will read this");
      },
    });
    const res = await post({ runId: "r1", taskId: "task-a", text: "too late" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("MERGED");
  });

  it("rejects an empty message and an unwired dashboard", async () => {
    const { dash, post } = await withDash();
    expect((await post({ runId: "r1", taskId: "task-a", text: "hello" })).status).toBe(503);
    dash.attach({ sendFeedback: () => "queued" });
    expect((await post({ runId: "r1", taskId: "task-a", text: "  " })).status).toBe(400);
    expect((await post({ taskId: "task-a", text: "hi" })).status).toBe(400);
  });
});
