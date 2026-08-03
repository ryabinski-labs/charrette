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
  const dir = mkdtempSync(path.join(tmpdir(), "harness-loop-"));
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
  events: HarnessEvent[];
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
  tasks?: { id: string; dependsOn?: string[]; touchedPaths?: string[] }[];
}): Built {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
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
    integrationBranch: `harness/${runId}/main`,
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
      spec: "do the thing",
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

const logs = (events: HarnessEvent[]) =>
  events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log").map((e) => e.text);

const workerPrompts = (specs: AgentSpec[]) => specs.filter((s) => s.role === "worker").map((s) => s.prompt);

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

    expect(logs(events).some((t) => /test -f never-exists\.txt also fails on harness\/run1\/main — not charged to this task/.test(t))).toBe(true);
    expect(workerPrompts(specs)[1]).toMatch(/do NOT try to fix them[\s\S]*never-exists\.txt/);
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
        // once the operator has answered.
        if (nth === 1) offset = 2 * 60 * 60 * 1000;
        else commitInWorktree(spec.cwd, "work.txt", "done\n");
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
