import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent } from "@charrette/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler, type TaskGate } from "./runController.js";
import { Store } from "./store.js";

/**
 * The per-task loop, driven straight from EXECUTING.
 *
 * Every case here is a way a task goes wrong — the worker runs out of turns or
 * dies mid-thought, the checks stay red to the cap, QA never writes a verdict,
 * the base moves under a branch that already passed — and then what the
 * operator's answer does about it. Going through planning first to reach any of
 * them would triple the setup and test the planner again instead.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-loop-"));
  made.push(dir, `${dir}-wt`);
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@example.invalid");
  run("config", "user.name", "T");
  writeFileSync(path.join(dir, "README.md"), "start\n");
  run("add", "-A");
  run("commit", "-m", "first");
  return dir;
}

/** Commits a file inside a worker's worktree, the way a real worker would. */
function commitInWorktree(cwd: string, file: string, body: string): void {
  writeFileSync(path.join(cwd, file), body);
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=w@example.invalid", "-c", "user.name=W", "commit", "-m", `add ${file}`], {
    cwd,
    stdio: "ignore",
  });
}

/** Lands a task branch on the integration branch without the store hearing about it. */
function mergeIntoIntegration(dir: string, runId: string, taskId: string): void {
  const scratch = path.join(`${dir}-wt`, runId, "__landed__");
  execFileSync("git", ["worktree", "add", scratch, `charrette/${runId}/main`], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=i@example.invalid", "-c", "user.name=I", "merge", "--no-ff", "--no-edit", `charrette/${runId}/${taskId}`],
    { cwd: scratch, stdio: "ignore" }
  );
  execFileSync("git", ["worktree", "remove", "--force", scratch], { cwd: dir, stdio: "ignore" });
}

const QA_PASS = '```json\n{"verdict":"PASS","summary":"looks right","issues":[]}\n```';
const QA_FAIL = '```json\n{"verdict":"FAIL","reasons":["the toggle is not wired"],"mustFix":["wire it to the store"]}\n```';

/** Returning an Error makes the session itself fail, the way a dead subprocess does. */
type Answer = string | ((spec: AgentSpec, nth: number) => string | Partial<AgentResult> | Error);

/** A pool that answers per role, and can count how many times each was asked. */
function rolePool(answers: Partial<Record<string, Answer>>) {
  const specs: AgentSpec[] = [];
  const counts: Record<string, number> = {};
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      // The real pool checks the budget on every message; a fake that never
      // does leaves the run-wide cap unexercised for every role.
      await spec.budgetCheck?.();
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      const answer = answers[spec.role];
      const base: AgentResult = { sessionId: `s${specs.length}`, resultText: "", costUsd: 0, turns: 1, outcome: "done" };
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

interface Built {
  controller: RunController;
  store: Store;
  events: CharretteEvent[];
  gates: TaskGate[];
  runId: string;
}

/**
 * A run already in EXECUTING with one task queued, so `resume` goes straight
 * into the task loop.
 */
function executing(opts: {
  repoPath: string;
  pool: AgentPool;
  config?: Partial<Parameters<typeof RunConfig.parse>[0]>;
  guidance?: string | null;
  github?: GitHubAdapter;
  tasks?: { id: string; dependsOn?: string[]; touchedPaths?: string[]; completionProbe?: string; spec?: string }[];
}): Built {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: CharretteEvent[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: TaskGate[] = [];
  const handler: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    async resolveTaskGate(gate) {
      gates.push(gate);
      return opts.guidance ?? null;
    },
  };
  const config = RunConfig.parse({ deterministicChecks: [], ...opts.config });
  const runId = "run1";
  store.createRun({
    id: runId,
    repoPath: opts.repoPath,
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: `charrette/${runId}/main`,
    config: { ...config, baseBranch: "main" },
  });
  for (const to of ["PLANNING", "PLAN_REVIEW", "EXECUTING"] as const) store.transitionRun(runId, to);
  store.insertTasks(
    runId,
    [{ id: "epic-e", title: "E" }],
    (opts.tasks ?? [{ id: "task-a" }]).map((t) => ({
      id: t.id,
      epicId: "epic-e",
      title: t.id.toUpperCase(),
      spec: t.spec ?? "do the thing",
      acceptanceCriteria: ["it works"],
      dependsOn: t.dependsOn ?? [],
      state: "PENDING" as const,
      branch: null,
      worktreePath: null,
      githubIssueNumber: null,
      prNumber: null,
      qaIterations: 0,
      respawns: 0,
      assignedSkills: [],
      errorSummary: null,
      touchedPaths: t.touchedPaths ?? [],
      completionProbe: t.completionProbe ?? "",
      estimatedSize: "M" as const,
    }))
  );
  const controller = new RunController(
    store,
    bus,
    opts.pool,
    opts.github ?? new GitHubAdapter(undefined, undefined),
    handler,
    opts.repoPath
  );
  return { controller, store, events, gates, runId };
}

const logs = (events: CharretteEvent[]) =>
  events.filter((e): e is CharretteEvent & { text: string } => e.type === "agent.log").map((e) => e.text);

const workerPrompts = (specs: AgentSpec[]) => specs.filter((s) => s.role === "worker").map((s) => s.prompt);

describe("focused worker briefings", () => {
  it.each(["rejection", "crash"])("preserves previously delivered human guidance after a %s starts a cold worker", async (failure) => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        commitInWorktree(spec.cwd, "thing.txt", `attempt ${nth}\n`);
        if (nth === 1 && failure === "crash") return new Error("connection closed");
        return { resultText: "Implementation notes without the operator's constraint", sdkSessionId: "synthetic" };
      },
      qa: (_spec, nth) => failure === "rejection" && nth === 1 ? QA_FAIL : QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool, config: { models: { worker: "gpt-5.6-terra" }, workerRespawnCap: 3 } });
    controller.sendFeedback(runId, "task-a", "Keep the existing adapter; do not add another provider");
    await controller.resume(runId);
    const workers = specs.filter((spec) => spec.role === "worker");
    expect(workers).toHaveLength(2);
    for (const worker of workers) expect(worker.prompt).toContain("Keep the existing adapter; do not add another provider");
  });

  it("does not offer successful check results for reuse after a probe changes the checked files", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => {
        commitInWorktree(spec.cwd, "thing.txt", "working\n");
        return "Implemented";
      },
      qa: QA_PASS,
    });
    const { controller, runId } = executing({
      repoPath: dir, pool,
      config: { deterministicChecks: ["! grep -q broken thing.txt"] },
      tasks: [{ id: "task-a", completionProbe: "node -e \"require('node:fs').writeFileSync('thing.txt', 'broken')\"" }],
    });
    await controller.resume(runId);
    expect(specs.find((spec) => spec.role === "qa")!.prompt).not.toContain("checks successfully in this worktree");
  });

  it.each(["gpt-5.6-terra", "gemini-3.6-flash"])("keeps the full assignment when %s retries without a resumable transcript", async (model) => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        commitInWorktree(spec.cwd, "thing.txt", `attempt ${nth}\n`);
        return { resultText: "Implemented the adapter in thing.txt", sdkSessionId: `synthetic-${nth}` };
      },
      qa: (_spec, nth) => nth === 1 ? QA_FAIL : QA_PASS,
    });
    const { controller, store, runId } = executing({ repoPath: dir, pool, config: { models: { worker: model } }, tasks: [{ id: "task-a", spec: "Use the existing adapter", touchedPaths: ["thing.txt"] }] });
    await controller.resume(runId);
    const workers = specs.filter((spec) => spec.role === "worker");
    expect(workers).toHaveLength(2);
    expect(workers[1]!.resume).toBeUndefined();
    expect(workers[1]!.prompt).toContain("Use the existing adapter");
    expect(workers[1]!.prompt).toContain("it works");
    expect(workers[1]!.prompt).toContain("wire it to the store");
    expect(workers[1]!.prompt).toContain("Implemented the adapter in thing.txt");
    expect(workers[0]!.prompt).toContain("Planned files");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("keeps an Anthropic retry short when its conversation can be resumed", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        commitInWorktree(spec.cwd, "thing.txt", `attempt ${nth}\n`);
        return { resultText: "Completed first attempt", sdkSessionId: "sdk-worker" };
      },
      qa: (_spec, nth) => nth === 1 ? QA_FAIL : QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool });
    await controller.resume(runId);
    const retry = specs.filter((spec) => spec.role === "worker")[1]!;
    expect(retry.resume).toBe("sdk-worker");
    expect(retry.prompt).toContain("wire it to the store");
    expect(retry.prompt).not.toMatch(/Acceptance criteria|Previous worker's summary/);
  });

  it("recovers the worker's checkpoint after a crash and passes green check evidence to QA", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        if (nth === 1) {
          commitInWorktree(spec.cwd, "adapter.txt", "already built\n");
          built.store.db.prepare("INSERT INTO sessions (id,runId,taskId,role,model,state,startedAt) VALUES ('interrupted',?,'task-a','worker','claude-sonnet-5','crashed',0)").run(spec.runId);
          built.store.appendEvent({ type: "agent.checkpoint", runId: spec.runId, taskId: "task-a", sessionId: "interrupted", turn: 20, digest: "adapter.txt is committed; next add its test", questions: [], ts: 0 });
          return new Error("connection closed");
        }
        commitInWorktree(spec.cwd, "adapter-test.txt", "tested\n");
        return "Added the missing test";
      },
      qa: QA_PASS,
    });
    const built = executing({ repoPath: dir, pool, config: { deterministicChecks: ["true"], workerRespawnCap: 3 } });
    await built.controller.resume(built.runId);
    const retry = specs.filter((spec) => spec.role === "worker")[1]!;
    expect(retry.resume).toBeUndefined();
    expect(retry.prompt).toContain("adapter.txt is committed; next add its test");
    expect(retry.prompt).toContain("connection closed");
    const qa = specs.find((spec) => spec.role === "qa")!;
    expect(qa.prompt).toContain("checks successfully in this worktree:\n- true");
    expect(qa.prompt).toContain("rerun affected checks after any edits");
    expect(built.store.getTask(built.runId, "task-a")!.state).toBe("MERGED");
  });

  it("starts with the full brief when escalation changes the worker's provider", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        commitInWorktree(spec.cwd, "thing.txt", `attempt ${nth}\n`);
        return { resultText: `Attempt ${nth} completed`, sdkSessionId: "sdk-worker" };
      },
      qa: (_spec, nth) => nth < 3 ? QA_FAIL : QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool, config: { models: { workerHeavy: "gpt-5.6-terra" } } });
    await controller.resume(runId);
    const workers = specs.filter((spec) => spec.role === "worker");
    expect(workers).toHaveLength(3);
    expect(workers[1]!.resume).toBe("sdk-worker");
    expect(workers[2]!.model).toBe("gpt-5.6-terra");
    expect(workers[2]!.resume).toBeUndefined();
    expect(workers[2]!.prompt).toContain("Acceptance criteria");
    expect(workers[2]!.prompt).toContain("Attempt 2 completed");
  });

  it.each([false, true])("keeps the last completed summary unless the interrupted retry checkpoints newer work (%s)", async (newCheckpoint) => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        if (nth === 1 || (nth === 2 && newCheckpoint)) {
          const sessionId = `worker-${nth}`;
          built.store.db.prepare("INSERT INTO sessions (id,runId,taskId,role,model,state,startedAt) VALUES (?,?,'task-a','worker','claude-sonnet-5','done',0)").run(sessionId, spec.runId);
          built.store.appendEvent({ type: "agent.checkpoint", runId: spec.runId, taskId: "task-a", sessionId, turn: 20, digest: nth === 1 ? "old incomplete plan" : "new partial retry progress", questions: [], ts: 0 });
        }
        if (nth === 2) return new Error("connection closed before a result");
        commitInWorktree(spec.cwd, "thing.txt", `attempt ${nth}\n`);
        return { resultText: "latest completed implementation", sdkSessionId: "sdk-worker" };
      },
      qa: (_spec, nth) => nth === 1 ? QA_FAIL : QA_PASS,
    });
    const built = executing({ repoPath: dir, pool, config: { workerRespawnCap: 3 } });
    await built.controller.resume(built.runId);
    const workers = specs.filter((spec) => spec.role === "worker");
    expect(workers).toHaveLength(3);
    expect(workers[2]!.resume).toBeUndefined();
    expect(workers[2]!.prompt).not.toContain("old incomplete plan");
    expect(workers[2]!.prompt).toContain(newCheckpoint ? "new partial retry progress" : "latest completed implementation");
    expect(workers[2]!.prompt).not.toContain(newCheckpoint ? "latest completed implementation" : "new partial retry progress");
  });

  it("refreshes a pool-internal cold retry with live feedback and its latest checkpoint", async () => {
    const dir = repo();
    let restarted = "";
    const { pool } = rolePool({
      worker: (spec) => {
        built.store.db.prepare("INSERT INTO sessions (id,runId,taskId,role,model,state,startedAt) VALUES ('active',?,'task-a','worker','gpt-5.6-terra','running',0)").run(spec.runId);
        built.store.appendEvent({ type: "agent.checkpoint", runId: spec.runId, taskId: "task-a", sessionId: "active", turn: 20, digest: "adapter implemented, test pending", questions: [], ts: 0 });
        built.controller.sendFeedback(spec.runId, "task-a", "Keep the public adapter interface");
        restarted = spec.restartPrompt!();
        commitInWorktree(spec.cwd, "thing.txt", "implemented\n");
        return "done";
      },
      qa: QA_PASS,
    });
    // Delivered live: nothing reaches the pending feedback queue.
    Object.assign(pool, { inject: () => true });
    const built = executing({ repoPath: dir, pool, config: { models: { worker: "gpt-5.6-terra" } } });
    await built.controller.resume(built.runId);
    expect(restarted).toContain("Acceptance criteria");
    expect(restarted).toContain("adapter implemented, test pending");
    expect(restarted).toContain("Keep the public adapter interface");
    expect(built.store.drainFeedback(built.runId, "task-a")).toBe("");
  });
});

/**
 * Run da8325bd, Goal 8: a task scoped to remove an unenforced claim from the
 * product's pricing surfaces removed it from one page and left it on twenty
 * others. Nothing was broken — the criterion it was given was met, and QA
 * passed it correctly. A probe is the same criterion in a form that has no
 * half-satisfied reading.
 */
describe("a task whose definition of done is a command", () => {
  const SWEEP = "! grep -q unenforced claims.txt";

  it("sends the worker back until the probe passes, and spends no QA before it does", async () => {
    const dir = repo();
    const { pool, counts } = rolePool({
      worker: (spec, nth) => {
        // The first attempt does real, committed work and still leaves the
        // claim behind — the exact shape that used to merge.
        commitInWorktree(spec.cwd, "claims.txt", nth === 1 ? "unenforced claim\n" : "enforced claim\n");
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, store, events, runId } = executing({
      repoPath: dir,
      pool,
      tasks: [{ id: "task-a", completionProbe: SWEEP }],
    });

    await controller.resume(runId);

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(counts.worker).toBe(2);
    // The first iteration never reached QA: the probe is checked before a
    // reviewer is paid to read a diff that is not finished.
    expect(counts.qa).toBe(1);
    expect(logs(events).some((t) => t.includes(`completion probe failed: ${SWEEP}`))).toBe(true);
  });

  it("tells the worker to finish the job, not to edit the probe", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        commitInWorktree(spec.cwd, "claims.txt", nth === 1 ? "unenforced claim\n" : "enforced claim\n");
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool, tasks: [{ id: "task-a", completionProbe: SWEEP }] });

    await controller.resume(runId);

    const second = workerPrompts(specs)[1] as string;
    expect(second).toContain("completion probe still fails");
    expect(second).toContain(SWEEP);
    expect(second).toContain("Do not change or delete the probe");
  });

  it("escalates to the operator when the probe never passes, naming the command", async () => {
    const dir = repo();
    const { pool } = rolePool({
      // Each attempt commits something real and still leaves the claim behind.
      worker: (spec, nth) => (commitInWorktree(spec.cwd, "claims.txt", `unenforced claim, attempt ${nth}\n`), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      tasks: [{ id: "task-a", completionProbe: SWEEP }],
    });

    await controller.resume(runId);

    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
    expect(gates.at(-1)!.why).toContain("the completion probe still fails");
    expect(gates.at(-1)!.why).toContain("not finished everywhere it was scoped to reach");
  });

  it("carries the operator's answer into the next attempt, above the probe's own instructions", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        commitInWorktree(spec.cwd, "claims.txt", nth < 3 ? `unenforced claim ${nth}\n` : "enforced claim\n");
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, store, runId } = executing({
      repoPath: dir,
      pool,
      guidance: "the other twenty are in pricing/*.md — sweep those too",
      config: { qaIterationCap: 1 },
      tasks: [{ id: "task-a", completionProbe: SWEEP }],
    });

    await controller.resume(runId);

    // The operator's sentence is what unblocked it, so it goes first and the
    // probe's own text stays underneath.
    const after = workerPrompts(specs)[1] as string;
    expect(after).toContain("The operator looked at the failing probe and says");
    expect(after).toContain("sweep those too");
    expect(after.indexOf("sweep those too")).toBeLessThan(after.indexOf("Do not change or delete the probe"));
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("tells QA the probe passed, so it reviews correctness rather than coverage", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, "claims.txt", "enforced claim\n"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool, tasks: [{ id: "task-a", completionProbe: SWEEP }] });

    await controller.resume(runId);

    const qaPrompt = specs.find((s) => s.role === "qa")!.prompt as string;
    expect(qaPrompt).toContain("completion probe passes");
    expect(qaPrompt).toContain("says nothing about whether the change is correct");
  });

  it("runs nothing extra for the ordinary task that has no probe", async () => {
    const dir = repo();
    const { pool, counts } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, "work.txt", "done\n"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, store, events, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(counts.worker).toBe(1);
    expect(logs(events).some((t) => t.includes("completion probe"))).toBe(false);
  });
});

describe("what the plan said a task would touch", () => {
  it("puts the files it never changed in front of QA", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, "a.txt", "done\n"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, events, runId } = executing({
      repoPath: dir,
      pool,
      tasks: [{ id: "task-a", touchedPaths: ["a.txt", "b.txt", "c.txt"] }],
    });

    await controller.resume(runId);

    const qaPrompt = specs.find((s) => s.role === "qa")!.prompt as string;
    expect(qaPrompt).toContain("Declared in the plan and NOT changed: b.txt, c.txt");
    expect(qaPrompt).toContain("merges half-done");
    expect(logs(events).some((t) => t.includes("never changed: b.txt, c.txt"))).toBe(true);
  });

  it("names the files nobody planned for, and stops naming them past a handful", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: (spec) => {
        for (const f of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt"]) commitInWorktree(spec.cwd, f, "done\n");
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, events, runId } = executing({ repoPath: dir, pool, tasks: [{ id: "task-a", touchedPaths: ["a.txt"] }] });

    await controller.resume(runId);

    const drift = logs(events).find((t) => t.startsWith("plan said"))!;
    // One path, so it is not "1 paths"; and nothing was missed, so the reader is
    // not shown an empty list of what was.
    expect(drift).toContain("plan said 1 path, diff touched 7");
    expect(drift).not.toContain("never changed");
    expect(drift).toContain("not in the plan: b.txt, c.txt, d.txt, e.txt, f.txt, …");
  });

  it("prints a short list of unplanned files in full", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, "a.txt", "done\n"), commitInWorktree(spec.cwd, "b.txt", "done\n"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, events, runId } = executing({ repoPath: dir, pool, tasks: [{ id: "task-a", touchedPaths: ["a.txt"] }] });

    await controller.resume(runId);

    expect(logs(events).find((t) => t.startsWith("plan said"))).toBe("plan said 1 path, diff touched 2; not in the plan: b.txt");
  });

  it("says nothing when the diff matches the plan", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, "a.txt", "done\n"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool, tasks: [{ id: "task-a", touchedPaths: ["a.txt"] }] });

    await controller.resume(runId);

    expect(specs.find((s) => s.role === "qa")!.prompt as string).not.toContain("Declared in the plan");
  });
});

/**
 * The one thing about an infrastructure change that no reader of the
 * infrastructure can see. api-service merged a template declaring a
 * managed policy it named itself, past `sam validate --lint`, `sam build`, a
 * suite at 100% coverage and a green pull request, into a pipeline that
 * deployed with `--capabilities CAPABILITY_IAM`. CloudFormation refused the
 * changeset, on main, after the merge, and every push behind it was stuck.
 */
describe("infrastructure the repo's own pipeline cannot deploy", () => {
  /** Several files at once, including ones in directories that do not exist yet. */
  function commitTree(cwd: string, files: Record<string, string>): void {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), body);
    }
    execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=w@example.invalid", "-c", "user.name=W", "commit", "-m", "infra"], { cwd, stdio: "ignore" });
  }

  const NAMED_IAM = `Resources:
  RunnerPolicy:
    Type: AWS::IAM::ManagedPolicy
    Properties:
      ManagedPolicyName: delivery-log-runner-write
`;
  const DEPLOY = "name: CD\njobs:\n  deploy:\n    steps:\n      - run: sam deploy --capabilities CAPABILITY_IAM\n";

  it("puts the refused changeset in front of QA before the task is done", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitTree(spec.cwd, { "template.yaml": NAMED_IAM, ".github/workflows/cd.yml": DEPLOY }), "added the table"),
      qa: () => QA_PASS,
    });
    const { controller, events, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    const qaPrompt = specs.find((s) => s.role === "qa")!.prompt as string;
    expect(qaPrompt).toContain("template.yaml names RunnerPolicy (AWS::IAM::ManagedPolicy, via ManagedPolicyName)");
    expect(qaPrompt).toContain(".github/workflows/cd.yml deploys with CAPABILITY_IAM");
    expect(qaPrompt).toContain("Requires capabilities : [CAPABILITY_NAMED_IAM]");
    expect(logs(events).some((t) => t.includes("CloudFormation would refuse the changeset"))).toBe(true);
  });

  it("says nothing about a repo whose deployment it cannot see", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitTree(spec.cwd, { "template.yaml": NAMED_IAM }), "added the table"),
      qa: () => QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(specs.find((s) => s.role === "qa")!.prompt as string).not.toContain("Deploy capability");
  });

  it("says nothing about a template that names nothing", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) =>
        (commitTree(spec.cwd, { "template.yaml": "Resources:\n  Table:\n    Type: AWS::DynamoDB::Table\n", ".github/workflows/cd.yml": DEPLOY }),
        "added the table"),
      qa: () => QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(specs.find((s) => s.role === "qa")!.prompt as string).not.toContain("Deploy capability");
  });
});

/**
 * The same empty diff, for the one reason no worker can do anything about.
 *
 * Run bc691359's `m1-exit-evidence` was accepted by QA eight times over six
 * days. Each accept tried to merge, each merge failed on an integration
 * worktree a test suite had left dirty, and the work reached the integration
 * branch anyway — after which the branch changed no file against it, and the
 * pre-QA gate below read that as "nothing has been committed to this branch".
 * It parked, the operator reopened it, and it parked again with the identical
 * message, three times in one morning. Nothing else could happen: a branch
 * cannot be un-merged, so no worker could produce the commit being asked for
 * and no answer to the escalation could have changed that.
 */
describe("a branch that is empty because its work already landed", () => {
  it("books it as merged instead of sending the worker back for it", async () => {
    const dir = repo();
    const { pool, counts, specs } = rolePool({
      worker: (spec) => {
        commitInWorktree(spec.cwd, "work.txt", "done\n");
        // Whatever landed it — a merge the store never recorded, an operator
        // resolving the conflict by hand — the branch is on the integration
        // branch before the gate reads it.
        mergeIntoIntegration(dir, "run1", "task-a");
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, store, events, gates, runId } = executing({ repoPath: dir, pool, guidance: "look again" });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("MERGED");
    // Dispatched once. The loop this fixes dispatched forever.
    expect(counts.worker).toBe(1);
    expect(gates).toEqual([]);
    expect(workerPrompts(specs).join("\n")).not.toContain("nothing has been committed");
    // Booked against the integration commit that carries it, not the branch tip
    // and not the integration branch's own pre-existing head.
    const merged = events.find((e) => e.type === "git.merged");
    expect(merged).toBeDefined();
    expect((merged as CharretteEvent & { sha: string }).sha).toBe(
      execFileSync("git", ["rev-parse", "charrette/run1/main"], { cwd: dir, encoding: "utf8" }).trim()
    );
    expect(logs(events).some((t) => t.includes("its work has landed, not because it has none"))).toBe(true);
  });

  /**
   * And when it landed before the task was ever dispatched — the shape every
   * reopen of `m1-exit-evidence` had — no worker is paid to find that out.
   */
  it("costs nothing when the work landed before the task was dispatched", async () => {
    const dir = repo();
    const { pool, counts } = rolePool({ worker: () => "did the work", qa: () => QA_PASS });
    const built = executing({ repoPath: dir, pool, guidance: "look again" });

    // The branch exists with real work on it and is already on the integration
    // branch: a task the charrette merged without recording it, then reopened.
    execFileSync("git", ["branch", "charrette/run1/main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", path.join(`${dir}-wt`, "pre"), "-b", "charrette/run1/task-a", "charrette/run1/main"], { cwd: dir, stdio: "ignore" });
    commitInWorktree(path.join(`${dir}-wt`, "pre"), "work.txt", "done\n");
    execFileSync("git", ["worktree", "remove", "--force", path.join(`${dir}-wt`, "pre")], { cwd: dir, stdio: "ignore" });
    mergeIntoIntegration(dir, "run1", "task-a");

    await built.controller.resume(built.runId);

    expect(built.store.getTask(built.runId, "task-a")!.state).toBe("MERGED");
    expect(counts.worker ?? 0).toBe(0);
    expect(counts.qa ?? 0).toBe(0);
    expect(built.gates).toEqual([]);
  });
});

/**
 * The pre-QA gate sends an empty branch back to the worker, which is right the
 * first few times — the work is usually written and simply not committed here.
 * What it must not do is send it back forever: run da8325bd's empty branches
 * were empty because the commits went to another repository, and no number of
 * re-dispatches was going to move them.
 */
describe("a branch that arrives empty over and over", () => {
  it("parks the task once re-dispatching it has stopped being an answer", async () => {
    const dir = repo();
    const { pool, counts, specs } = rolePool({ worker: () => "did the work", qa: () => QA_PASS });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      // The operator answers every time, so nothing but the attempt count can
      // end this loop.
      guidance: "check the primary repository's own branch",
      config: { qaIterationCap: 1 },
    });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("NEEDS_HUMAN");
    expect(task.errorSummary).toContain("still empty after 5 attempts");
    // No reviewer was ever paid to read nothing.
    expect(counts.qa ?? 0).toBe(0);
    // The operator was asked, and the answer was carried to the worker rather
    // than logged and dropped.
    expect(gates.some((g) => g.why.includes("still empty"))).toBe(true);
    expect(workerPrompts(specs).at(-1)).toContain("check the primary repository's own branch");
  });

  /**
   * The counter that ends the loop used to be a local variable, so every
   * restart of the charrette process handed the task a fresh set of attempts.
   * Run bc691359 restarted many times a day; `m1-exit-evidence` went round
   * eight times with its recorded iteration count still reading 1.
   */
  it("does not start counting again because the process did", async () => {
    const dir = repo();
    const { pool, counts } = rolePool({ worker: () => "did the work", qa: () => QA_PASS });
    const { controller, store, runId } = executing({ repoPath: dir, pool, guidance: "look again", config: { qaIterationCap: 1 } });
    // What the previous process had already spent on this task before it died.
    store.updateTask(runId, "task-a", { emptyDeliveries: 4 });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("NEEDS_HUMAN");
    // The fifth attempt is the one over the cap, so it parks on this dispatch
    // rather than buying four more.
    expect(task.errorSummary).toContain("still empty after 5 attempts");
    expect(counts.worker).toBe(1);
  });

  it("counts one commit that changed nothing as one commit", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: (spec, nth) => {
        // A commit that delivers nothing: the branch is not empty, the diff is.
        if (nth === 1) execFileSync("git", ["-c", "user.email=w@e.invalid", "-c", "user.name=W", "commit", "--allow-empty", "-m", "wip"], { cwd: spec.cwd, stdio: "ignore" });
        else commitInWorktree(spec.cwd, "work.txt", "done\n");
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, store, events, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(logs(events).some((t) => /changes no file against charrette\/run1\/main \(1 commit\)$/.test(t))).toBe(true);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});

/**
 * The empty branch the charrette caused itself.
 *
 * The background-shell denial tells a worker to redirect a long command —
 * `cmd > log 2>&1 &` — and poll for it; the teardown sweep then kills
 * everything still running in the worktree the moment the turn ends. Run
 * bc691359's `m1-live-block-witness` did exactly what it was told, ended its
 * session 49 seconds in with the container build still going, and had that
 * build killed and the empty branch counted against it. Five of those and it
 * parked on a question about work that had never been allowed to finish.
 */
describe("a branch that is empty because the session killed its own job", () => {
  it("re-dispatches with the instruction that helps, and does not charge the attempt", async () => {
    const dir = repo();
    const { pool, specs, counts } = rolePool({
      worker: (spec, nth) => {
        // First attempt: started the smoke script, polled it, ended the turn.
        if (nth === 1) return { resultText: "waiting on the build", abandoned: ["bash bench/scripts/m1-live-smoke.sh > /tmp/m1-live-smoke-run.log 2>&1"] };
        commitInWorktree(spec.cwd, "verdict.md", "witnessed\n");
        return "ran it in the foreground and committed the evidence";
      },
      qa: () => QA_PASS,
    });
    const { controller, store, events, gates, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("MERGED");
    // The attempt the charrette caused is not spent out of the budget that parks
    // the task, and the operator was never asked about it.
    expect(task.emptyDeliveries).toBe(0);
    expect(task.abandonedJobs).toBe(1);
    expect(gates).toEqual([]);
    expect(counts.worker).toBe(2);
    // And the worker was told what actually happened, not sent to look for work
    // it never lost.
    const second = workerPrompts(specs)[1]!;
    expect(second).toContain("m1-live-smoke.sh");
    expect(second).toContain("in the foreground");
    expect(second).not.toContain("git stash list");
    expect(logs(events).some((t) => t.includes("does not count as an empty delivery (1 of 2)"))).toBe(true);
  });

  it("stops forgiving it, so a worker that keeps doing it still reaches the operator", async () => {
    const dir = repo();
    const { pool, counts } = rolePool({
      worker: () => ({ resultText: "still waiting", abandoned: ["pnpm build > /tmp/b.log 2>&1", "docker run --rm ghcr.io/x/y"] }),
      qa: () => QA_PASS,
    });
    const { controller, store, runId } = executing({ repoPath: dir, pool, guidance: "look again", config: { qaIterationCap: 1 } });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("NEEDS_HUMAN");
    expect(task.errorSummary).toContain("still empty after 5 attempts");
    // Two forgiven, then five counted: the bound holds and the loop ends.
    expect(task.abandonedJobs).toBe(2);
    expect(counts.worker).toBe(7);
  });

  /**
   * The counter is on the task row rather than in a variable for the same
   * reason `emptyDeliveries` is: run bc691359 restarted the charrette many times
   * a day, and a forgiveness budget that resets with the process is not a bound.
   */
  it("does not hand out a fresh set of forgiven attempts because the process restarted", async () => {
    const dir = repo();
    const { pool, counts } = rolePool({
      worker: () => ({ resultText: "still waiting", abandoned: ["pnpm build > /tmp/b.log 2>&1"] }),
      qa: () => QA_PASS,
    });
    const { controller, store, runId } = executing({ repoPath: dir, pool, guidance: "look again", config: { qaIterationCap: 1 } });
    // What the previous process had already forgiven before it died.
    store.updateTask(runId, "task-a", { abandonedJobs: 2, emptyDeliveries: 4 });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("NEEDS_HUMAN");
    expect(task.errorSummary).toContain("still empty after 5 attempts");
    expect(counts.worker).toBe(1);
  });

  /**
   * A task written against a repository this run does not own is empty for a
   * reason no instruction to this worker can change, and the leftover process
   * is beside the point. Forgiving it would send the worker back for another go
   * at nothing instead of naming the repository the work belongs to.
   */
  it("does not forgive it when the task belongs to another repository", async () => {
    const dir = repo();
    const sibling = path.join(path.dirname(dir), "other-repo");
    const { pool, specs } = rolePool({
      worker: () => ({ resultText: "still waiting", abandoned: ["terraform apply > /tmp/t.log 2>&1"] }),
      qa: () => QA_PASS,
    });
    const { controller, store, runId } = executing({
      repoPath: dir,
      pool,
      guidance: "raise it as its own run",
      config: { qaIterationCap: 1 },
      tasks: [{ id: "task-a", spec: `In \`${sibling}/\`, add the delivery_log table to the SAM template.` }],
    });

    await controller.resume(runId);

    expect(store.getTask(runId, "task-a")!.abandonedJobs).toBe(0);
    expect(workerPrompts(specs)[1]!).toContain("a repository this run does not own");
  });
});

/**
 * The same empty branch, for the other reason.
 *
 * Run 7ef8fb4d's `api-delivery-table-infra` was written against a sibling
 * checkout the run did not own. Its branch was empty because the task was out
 * of scope, and every message the charrette produced said the opposite — "check
 * whether the work was written somewhere other than the worktree" — which is
 * how a worker ends up nesting a worktree of another repository inside its own
 * and committing where nothing will ever merge from. Plans are checked for this
 * before a worker runs now; this is what the pipeline says when one reaches
 * here anyway, which a run planned before the check still can.
 */
describe("a branch that is empty because the task belongs to another repository", () => {
  it("says so, instead of sending the worker to look for work it never lost", async () => {
    const dir = repo();
    const sibling = path.join(path.dirname(dir), "other-repo");
    const { pool, specs } = rolePool({ worker: () => "did the work", qa: () => QA_PASS });
    const { controller, store, events, gates, runId } = executing({
      repoPath: dir,
      pool,
      guidance: "raise it as its own run",
      config: { qaIterationCap: 1 },
      tasks: [{ id: "task-a", spec: `In \`${sibling}/\`, add the delivery_log table to the SAM template.` }],
    });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("NEEDS_HUMAN");
    expect(task.errorSummary).toContain(`written against ${sibling}`);
    expect(task.errorSummary).toContain("re-dispatching cannot change that");
    // The old, false diagnosis is gone from the park reason entirely.
    expect(task.errorSummary).not.toContain("somewhere other than the worktree");
    // The log line and the escalation carry the true reason too, so neither the
    // dashboard nor whoever answers the gate has to reconstruct it.
    expect(logs(events).some((t) => t.includes(`this task is written against ${sibling}, which this run does not own`))).toBe(true);
    expect(gates.some((g) => g.why.includes("no worker can change that from here"))).toBe(true);
    // And the worker is told to stop looking rather than to keep digging.
    const prompt = workerPrompts(specs).at(-1)!;
    expect(prompt).toContain("a repository this run does not own");
    expect(prompt).toContain("do not create a nested worktree");
    expect(prompt).not.toContain("every path you need is under this directory");
  });
});

/**
 * Run da8325bd again, from the other side: a worker wrote its entire deliverable
 * into the operator's own checkout instead of its worktree. The guard denies the
 * direct spelling, but indirection through a script or a Makefile is not
 * something any guard reads — so the run also watches, and says so when the one
 * repository nothing should write to has moved.
 */
/**
 * The pre-QA gate reads the branch before the review, and the merge happens
 * after it — so a branch can pass the gate and still arrive at the merge with
 * nothing on it. A worker resetting its own worktree while fixing a conflict is
 * how that happens, and `git merge --no-ff` reports it as success. It is not a
 * conflict and must not be described as one: there is no other side.
 */
describe("a branch that empties out after QA passed it", () => {
  it("is sent back to be committed rather than booked as merged", async () => {
    const dir = repo();
    const { pool, counts, specs } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, "work.txt", "done\n"), "did the work"),
      qa: (spec, nth) => {
        if (nth === 1) execFileSync("git", ["reset", "--hard", "charrette/run1/main"], { cwd: spec.cwd, stdio: "ignore" });
        return QA_PASS;
      },
    });
    const { controller, store, events, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(logs(events).some((t) => /merge produced nothing: charrette\/run1\/task-a left charrette\/run1\/main where it was/.test(t))).toBe(true);
    // Re-dispatched with the question the worker can answer, not with a merge
    // it has no way to resolve.
    expect(workerPrompts(specs)[1]).toContain("delivers nothing");
    expect(counts.worker).toBe(2);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});

describe("the operator's own checkout moving under a task", () => {
  it("records that it moved, and which task was live at the time", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: (spec) => {
        commitInWorktree(spec.cwd, "work.txt", "done\n");
        commitInWorktree(dir, "stray.txt", "committed in the wrong repository\n");
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, store, events, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    const moved = logs(events).find((t) => t.startsWith("the primary repository moved"));
    expect(moved).toMatch(/main@[0-9a-f]{40} -> main@[0-9a-f]{40}/);
    expect(moved).toContain("a branch this run will never merge or report");
    expect(events.some((e) => e.type === "agent.log" && e.taskId === "task-a" && e.text.startsWith("the primary repository moved"))).toBe(true);
    // Watching is not blocking: the task's own committed work still lands.
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});

describe("a worker that runs out of turns", () => {
  it("gets more of them on the next dispatch rather than the same wall", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: (spec, nth) =>
        nth === 1
          ? { outcome: "error", errorDetail: "error_max_turns (hit the turn ceiling of 100)", resultText: "" }
          : (commitInWorktree(spec.cwd, "work.txt", "done\n"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, store, events, runId } = executing({ repoPath: dir, pool, config: { workerMaxTurns: 100 } });

    await controller.resume(runId);

    expect(logs(events).some((t) => /worker ran out of turns; the next dispatch on this task gets 150/.test(t))).toBe(true);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});

describe("a worker that dies mid-thought", () => {
  /**
   * A worker that hit its turn ceiling stopped; one that died was stopped, and
   * its worktree is whatever it had written by then. Running the checks against
   * that tree would charge the task for being interrupted.
   */
  it("is treated as a crash and re-dispatched against the same worktree", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) =>
        nth === 1
          ? { outcome: "error", errorDetail: "Claude Code process exited with code 1", resultText: "" }
          : (commitInWorktree(spec.cwd, "work.txt", "done\n"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, store, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(store.getTask(runId, "task-a")!.respawns).toBe(1);
    // The second dispatch is told to pick up from what is committed.
    expect(workerPrompts(specs)[1]).toMatch(/Previous session was interrupted[\s\S]*Inspect git log/);
  });

  it("asks the operator once it has crashed to the cap, and carries their answer in", async () => {
    const dir = repo();
    let crashes = 0;
    const { pool, specs } = rolePool({
      worker: (spec) => {
        crashes++;
        // Crash until the operator answers, then finish.
        if (crashes <= 2) return { outcome: "error", errorDetail: "boom", resultText: "" };
        commitInWorktree(spec.cwd, "work.txt", "done\n");
        return "did the work";
      },
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      config: { workerRespawnCap: 2 },
      guidance: "the port is taken — start DynamoDB on 8030 first",
    });

    await controller.resume(runId);

    expect(gates[0]!.why).toMatch(/worker crashed 2 times \(the cap\)/);
    expect(workerPrompts(specs).at(-1)).toMatch(/The operator looked at the repeated crashes and says:[\s\S]*8030/);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("parks the task when the operator has nothing to add", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: () => ({ outcome: "error", errorDetail: "boom", resultText: "" }),
      advisor: () => "",
    });
    const { controller, store, gates, runId } = executing({ repoPath: dir, pool, config: { workerRespawnCap: 1 }, guidance: null });

    await controller.resume(runId);

    expect(gates).toHaveLength(1);
    expect(store.getTask(runId, "task-a")!.state).toBe("NEEDS_HUMAN");
  });
});

describe("checks that stay red", () => {
  it("asks the operator at the cap and hands the worker their answer with the output", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        // Leaves the tree red until the operator has spoken, then clears it.
        commitInWorktree(spec.cwd, "bad.txt", nth > 2 ? "" : `still broken, attempt ${nth}\n`);
        return "did the work";
      },
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      // Passes on the integration branch (no bad.txt there) and fails only while
      // this task has left content in it — so it is charged to this task.
      config: { deterministicChecks: ["! test -s bad.txt"], qaIterationCap: 2 },
      guidance: "the file is written by the build step — run npm run build first",
    });

    await controller.resume(runId);

    expect(gates[0]!.why).toMatch(/deterministic checks still failing after 2 attempts: ! test -s bad.txt/);
    expect(workerPrompts(specs).at(-1)).toMatch(/The operator looked at the failing checks and says:[\s\S]*npm run build/);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  /**
   * A check that is red on the integration branch too is somebody else's bug
   * arriving through the base. Charging it to whichever task happens to be in
   * flight parks correct work.
   */
  it("tells the worker which red checks are not its problem", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        // Introduces its own failure on the first pass, fixes it on the second.
        commitInWorktree(spec.cwd, "mine.txt", nth === 1 ? "broken\n" : `fixed ${nth}\n`);
        return "did the work";
      },
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller, events, runId } = executing({
      repoPath: dir,
      pool,
      config: {
        deterministicChecks: [
          // Red everywhere, including on the base: inherited.
          "test -f never-exists.txt",
          // Red only while the worker's first commit is in the tree.
          "! grep -q broken mine.txt",
        ],
        qaIterationCap: 3,
      },
    });

    await controller.resume(runId);

    expect(logs(events).some((t) => /test -f never-exists\.txt also fails on charrette\/run1\/main — not charged to this task/.test(t))).toBe(true);
    expect(workerPrompts(specs)[1]).toMatch(/do NOT try to fix them[\s\S]*never-exists\.txt/);
    const qa = specs.find((spec) => spec.role === "qa")!;
    const greenChecks = qa.prompt.split("checks successfully in this worktree:\n")[1]!.split("Use these results")[0]!;
    expect(greenChecks).toContain("grep -q broken mine.txt");
    expect(greenChecks).not.toContain("never-exists.txt");
  });
});

describe("QA that never writes a verdict", () => {
  it("re-dispatches the worker to finish, saying the work may well be fine", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, `w${Math.random()}.txt`, "x\n"), "did the work"),
      qa: (_spec, nth) => (nth === 1 ? new Error("Claude Code process exited with code 1") : QA_PASS),
      advisor: () => "",
    });
    const { controller, store, runId } = executing({ repoPath: dir, pool, config: { workerRespawnCap: 3 } });

    await controller.resume(runId);

    expect(workerPrompts(specs)[1]).toMatch(/ended without a verdict[\s\S]*may be fine, and was never judged/);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("asks the operator once QA has failed to answer to the cap", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, `w${Math.random()}.txt`, "x\n"), "did the work"),
      qa: (_spec, nth) => (nth <= 2 ? new Error("session died before the verdict") : QA_PASS),
      advisor: () => "",
    });
    const { controller, gates, runId } = executing({
      repoPath: dir,
      pool,
      config: { workerRespawnCap: 2 },
      guidance: "QA is running out of turns — raise qaMaxTurns",
    });

    await controller.resume(runId);

    expect(gates[0]!.why).toMatch(/QA ended without a verdict 2 times \(the cap\)/);
    expect(workerPrompts(specs).at(-1)).toMatch(/QA never delivered a verdict[\s\S]*raise qaMaxTurns/);
  });
});

describe("a task that keeps going and going", () => {
  it("asks the operator once it passes its wall clock, and resets it on their answer", async () => {
    const dir = repo();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const { pool, specs } = rolePool({
      worker: (spec, nth) => {
        // The first pass burns two hours of wall clock, then finishes cleanly
        // once the operator has answered. Every pass commits, and commits
        // something different: a branch that carries nothing never reaches QA
        // at all now, and a second identical commit is not a commit.
        if (nth === 1) offset = 2 * 60 * 60 * 1000;
        commitInWorktree(spec.cwd, "work.txt", `attempt ${nth}\n`);
        return "did the work";
      },
      advisor: () => "",
      qa: (_spec, nth) => (nth === 1 ? QA_FAIL : QA_PASS),
    });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      config: { taskWallClockMinutes: 30, qaIterationCap: 3 },
      guidance: "it is waiting on a container that never started — check docker compose ps",
    });

    await controller.resume(runId);

    expect(gates[0]!.why).toMatch(/still not accepted after 30 minutes of wall clock/);
    // The rejection that preceded it is quoted, so the operator is not guessing.
    expect(gates[0]!.why).toMatch(/the toggle is not wired/);
    expect(workerPrompts(specs).at(-1)).toMatch(/reviewed why this task is taking so long[\s\S]*docker compose ps/);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("does not count time the account was out of quota against that clock", async () => {
    const dir = repo();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const { pool } = rolePool({
      worker: (spec, nth) => {
        if (nth === 1) {
          // The quota window closed mid-session. The pool waited two hours and
          // continued the same session — which is two hours of the account
          // being unavailable, not two hours of this task going nowhere.
          offset = 2 * 60 * 60 * 1000;
          spec.onLimitWait!(offset);
        }
        commitInWorktree(spec.cwd, "work.txt", `attempt ${nth}\n`);
        return "did the work";
      },
      advisor: () => "",
      qa: (_spec, nth) => (nth === 1 ? QA_FAIL : QA_PASS),
    });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      config: { taskWallClockMinutes: 30, qaIterationCap: 3 },
      guidance: "carry on",
    });

    await controller.resume(runId);

    // Nobody was interrupted about a task that had been asleep, and the work
    // the wait preserved went on to merge.
    expect(gates).toEqual([]);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("does not count the time a QA session spent dying against that clock either", async () => {
    const dir = repo();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const { pool } = rolePool({
      worker: (spec, nth) => (commitInWorktree(spec.cwd, "work.txt", `attempt ${nth}\n`), "did the work"),
      advisor: () => "",
      qa: (_spec, nth) => {
        if (nth === 1) {
          // Two hours of turns and then the connection drops, which is run
          // f338b5c8's ci-workflow escalation exactly: no verdict was ever
          // reached, so those two hours judged nothing.
          offset = 2 * 60 * 60 * 1000;
          return new Error("QA ended after 78 turns without a verdict: API Error: Connection closed mid-response");
        }
        return QA_PASS;
      },
    });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      config: { taskWallClockMinutes: 30, qaIterationCap: 3, workerRespawnCap: 3 },
      guidance: "carry on",
    });

    await controller.resume(runId);

    // The gate this used to open was unanswerable: its whole content was a
    // dropped API connection, and the only thing a task gate can hand back is
    // guidance for a worker that had nothing to fix.
    expect(gates).toEqual([]);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });

  it("does not withdraw a quota credit from the session that then died", async () => {
    const dir = repo();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const { pool } = rolePool({
      // 45 real minutes of building after the death — more than the bound, so
      // the pass that follows tells us whether the quota credit survived it.
      worker: (spec, nth) => (nth === 2 && (offset += 45 * 60 * 1000), commitInWorktree(spec.cwd, "work.txt", `attempt ${nth}\n`), "did the work"),
      advisor: () => "",
      qa: (spec, nth) => {
        if (nth === 1) {
          // The pool credits a quota wait before it sleeps, so at this instant
          // the clock holds two hours the session has not yet spent — and then
          // the session dies without ever spending them.
          spec.onLimitWait!(2 * 60 * 60 * 1000);
          return new Error("QA ended after 78 turns without a verdict: API Error: Connection closed mid-response");
        }
        // A rejection rather than a pass: the wall clock is only read at the top
        // of the loop, so the task has to go round once more to be judged on it.
        return nth === 2 ? QA_FAIL : QA_PASS;
      },
    });
    const { controller, store, gates, runId } = executing({
      repoPath: dir,
      pool,
      config: { taskWallClockMinutes: 30, qaIterationCap: 3, workerRespawnCap: 3 },
      guidance: "carry on",
    });

    await controller.resume(runId);

    // Reducing the clock to the dead session's measured span would have handed
    // those two hours back to the bound and gated on the next 45 minutes.
    expect(gates).toEqual([]);
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  });
});

describe("a branch that passed QA but no longer merges", () => {
  it("asks the operator once the worker has failed to resolve it, and re-dispatches with their answer", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      // Both tasks touch the same file, so the second one's merge conflicts.
      worker: (spec, nth) => {
        if (/ACCEPTED by QA/.test(spec.prompt)) {
          // Handed the conflict back and unable to settle it: it leaves the
          // markers exactly where they were, which is what a worker that cannot
          // decide between the two sides actually does.
          return "I could not work out which side to keep";
        }
        commitInWorktree(spec.cwd, "shared.txt", `${path.basename(spec.cwd)} attempt ${nth}\n`);
        return "did the work";
      },
      advisor: () => "",
      qa: () => QA_PASS,
    });
    const { controller, gates, runId } = executing({
      repoPath: dir,
      pool,
      tasks: [{ id: "task-a" }, { id: "task-b" }],
      // In parallel, so both branch from the same base and the second to
      // finish meets the first one's change on the way in. Serially, the
      // second worktree would be cut after the first had already merged.
      config: { maxParallelWorkers: 2 },
      guidance: "keep both sides — they are independent additions",
    });

    await controller.resume(runId);

    const conflictGate = gates.find((g) => /merge conflicts in/.test(g.why));
    expect(conflictGate?.why).toMatch(/shared\.txt.*could not resolve them/);
    expect(workerPrompts(specs).at(-1)).toMatch(/The operator looked at the unresolved merge and says[\s\S]*keep both sides/);
  });
});

describe("a task that fails in a way the loop does not expect", () => {
  it("parks it and keeps driving the rest of the run", async () => {
    const dir = repo();
    const { pool } = rolePool({ worker: () => "did the work", qa: () => QA_PASS });
    // A file where the worktree root has to go: `git worktree add` cannot even
    // start, and the throw escapes the per-task loop entirely.
    writeFileSync(`${dir}-wt`, "not a directory");
    const { controller, store, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    const task = store.getTask(runId, "task-a")!;
    expect(task.state).toBe("NEEDS_HUMAN");
    expect(task.errorSummary).toMatch(/crashed:/);
  });
});

describe("the conventions a worker is given", () => {
  it("falls back to the repository's own when the run has no conventions file", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (commitInWorktree(spec.cwd, "work.txt", "done\n"), "did the work"),
      qa: () => QA_PASS,
    });
    // This run was seeded straight into EXECUTING, so planning never wrote one.
    const { controller, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(specs.find((s) => s.role === "worker")!.systemPrompt).toContain("Follow the existing repository conventions.");
  });
});

describe("the advisor's draft answer", () => {
  it("is dropped when the advisor did not produce one", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: () => ({ outcome: "error", errorDetail: "boom", resultText: "" }),
      // Valid JSON, but no recommendation in it.
      advisor: () => '```json\n{"checked":[]}\n```',
    });
    const { controller, gates, runId } = executing({ repoPath: dir, pool, config: { workerRespawnCap: 1 } });

    await controller.resume(runId);

    expect(gates[0]!.recommendation).toBe("");
  });

  it("is dropped when the advisor session itself failed", async () => {
    const dir = repo();
    const { pool } = rolePool({
      worker: () => ({ outcome: "error", errorDetail: "boom", resultText: "" }),
      advisor: () => "not json at all",
    });
    const { controller, gates, runId } = executing({ repoPath: dir, pool, config: { workerRespawnCap: 1 } });

    await controller.resume(runId);

    expect(gates[0]!.recommendation).toBe("");
  });
});

/**
 * The one thing about a cutover that no reader of the cutover can see. Run
 * 1e7d3df3 changed `control-plane/internal/store/dynamostore.go` and
 * `infra/aws/dynamodb/main.tf` in the same commit, wrote a 207-line plan
 * saying the table had to exist before the image rolled, confirmed against the
 * live account that it did not, and handed a human an ordered runbook. Then
 * the merge ran `deploy-web.yml`, which is CD on push to main with
 * `control-plane/**` in its paths, and the console answered 503 to every
 * authenticated request. A document cannot sequence a deploy it does not gate.
 */
describe("a merge that deploys ahead of the infrastructure it needs", () => {
  /** Several files at once, including ones in directories that do not exist yet. */
  function commitTree(cwd: string, files: Record<string, string>): void {
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
      writeFileSync(path.join(cwd, file), body);
    }
    execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=w@example.invalid", "-c", "user.name=W", "commit", "-m", "cutover"], { cwd, stdio: "ignore" });
  }

  const SESSIONS_TF = `resource "aws_dynamodb_table" "sessions" {\n  name = "dns-service-sessions"\n}\n`;
  const CD = `on:\n  push:\n    branches: [main]\n    paths:\n      - 'control-plane/**'\njobs:\n  api:\n    steps:\n      - run: kubectl rollout status deploy/api\n`;

  it("puts the ordering in front of QA before the task is done", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (
        commitTree(spec.cwd, {
          "infra/aws/dynamodb/main.tf": SESSIONS_TF,
          "control-plane/internal/store/dynamostore.go": "func IsSessionRevoked() {}",
          ".github/workflows/deploy-web.yml": CD,
        }),
        // A deletion in the same diff, because the changed-file list is what the
        // diff says and a removed file is an ordinary entry in it. Reading one
        // has to answer "declares nothing" rather than throw.
        execFileSync("git", ["rm", "-q", "README.md"], { cwd: spec.cwd, stdio: "ignore" }),
        execFileSync("git", ["-c", "user.email=w@example.invalid", "-c", "user.name=W", "commit", "-m", "drop readme"], {
          cwd: spec.cwd,
          stdio: "ignore",
        }),
        "moved revocation to its own table"
      ),
      qa: () => QA_PASS,
    });
    const { controller, events, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    const qaPrompt = specs.find((s) => s.role === "qa")!.prompt as string;
    expect(qaPrompt).toContain("Deploy order");
    expect(qaPrompt).toContain("aws_dynamodb_table.sessions");
    expect(qaPrompt).toContain("control-plane/**");
    expect(qaPrompt).toContain("A runbook, a handover document or a plan that states the order is not one of these.");
    expect(logs(events).some((t) => t.includes("the deploy would land first"))).toBe(true);
  });

  it("says nothing when nothing deploys on the merge", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (
        commitTree(spec.cwd, {
          "infra/aws/dynamodb/main.tf": SESSIONS_TF,
          "control-plane/internal/store/dynamostore.go": "func IsSessionRevoked() {}",
        }),
        "moved revocation to its own table"
      ),
      qa: () => QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(specs.find((s) => s.role === "qa")!.prompt as string).not.toContain("Deploy order");
  });

  it("says nothing about a change that declares no infrastructure", async () => {
    const dir = repo();
    const { pool, specs } = rolePool({
      worker: (spec) => (
        commitTree(spec.cwd, { "control-plane/internal/store/dynamostore.go": "func x() {}", ".github/workflows/deploy-web.yml": CD }),
        "touched the store"
      ),
      qa: () => QA_PASS,
    });
    const { controller, runId } = executing({ repoPath: dir, pool });

    await controller.resume(runId);

    expect(specs.find((s) => s.role === "qa")!.prompt as string).not.toContain("Deploy order");
  });
});
