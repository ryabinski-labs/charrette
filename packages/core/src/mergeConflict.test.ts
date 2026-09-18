import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController } from "./runController.js";
import { Store } from "./store.js";

/**
 * Two accepted tasks that touched the same file.
 *
 * This is the ordinary shape of a parallel run — a shared module both branches
 * append to — and it used to end with the second task parked for a human while
 * holding work QA had already passed. These tests pin the behaviour that
 * replaced it: the conflict goes back to the worker that wrote the code, and
 * only reaches the operator if the worker cannot resolve it.
 */

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      { id: "task-a", epicId: "epic-e", title: "A", spec: "append to shared", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
      { id: "task-b", epicId: "epic-e", title: "B", spec: "append to shared", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
    ],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-conflict-"));
  writeFileSync(path.join(dir, "shared.ts"), "export const keys = {\n};\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "charrette@example.com");
  gitIn(dir, "config", "user.name", "charrette");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

const noGitHub = { enabled: false } as unknown as GitHubAdapter;

/** Rewrite the shared file wholesale so the two branches cannot merge textually. */
function commitShared(cwd: string, body: string, message: string): void {
  writeFileSync(path.join(cwd, "shared.ts"), `export const keys = {\n${body}\n};\n`);
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-m", message);
}

/**
 * Drives a two-task run where both workers edit the same file. `resolve` decides
 * what the worker does when it is handed the conflict back.
 */
function conflictingPool(resolve: (spec: AgentSpec) => void): { pool: AgentPool; workerPrompts: string[] } {
  const planning = [DOCS, DAG];
  let planned = 0;
  const seen = new Set<string>();
  const workerPrompts: string[] = [];
  // Hold task-a's worker until task-b's has started, so both worktrees are cut
  // from the same base. Otherwise the fakes are fast enough that task-a can
  // merge before task-b's worktree exists, and there is nothing to conflict.
  let releaseA: () => void;
  const bStarted = new Promise<void>((r) => (releaseA = r));

  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      if (spec.role === "qa") return { sessionId: "q", resultText: '{"verdict":"PASS","notes":"ok"}', costUsd: 0, turns: 1, outcome: "done" };
      if (spec.role !== "worker") {
        return { sessionId: `p${planned}`, resultText: planning[Math.min(planned++, planning.length - 1)]!, costUsd: 0, turns: 1, outcome: "done" };
      }
      workerPrompts.push(spec.prompt);
      const first = !seen.has(spec.taskId!);
      seen.add(spec.taskId!);
      if (spec.taskId === "task-b") releaseA!();
      if (first) {
        if (spec.taskId === "task-a") await bStarted;
        commitShared(spec.cwd, `  ${spec.taskId}: "${spec.taskId}",`, `feat: ${spec.taskId}`);
      } else {
        resolve(spec);
      }
      return { sessionId: `w-${spec.taskId}-${first ? 1 : 2}`, resultText: "done", costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, workerPrompts };
}

async function run(pool: AgentPool): Promise<{ store: Store; runId: string; dir: string }> {
  const dir = repo();
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const controller = new RunController(store, bus, pool, noGitHub, {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
    async resolveTaskGate() {
      return null; // park rather than answer — the fallback path under test
    },
  }, dir);
  // startRun drives the run to a terminal state on its own.
  const runId = await controller.startRun("two tasks, one file", RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 2 }));
  return { store, runId, dir };
}

describe("merge conflicts between parallel tasks", () => {
  it("hands the conflict back to the worker, which resolves it into a merge", async () => {
    // The worker does what the prompt asks: keep both sides.
    const { pool, workerPrompts } = conflictingPool((spec) => {
      commitShared(spec.cwd, `  task-a: "task-a",\n  task-b: "task-b",`, "merge: keep both");
    });
    const { store, runId, dir } = await run(pool);
    const tasks = Object.fromEntries(store.listTasks(runId).map((t) => [t.id, t.state]));

    expect(tasks).toEqual({ "task-a": "MERGED", "task-b": "MERGED" });
    // Nothing was parked, and the second task got exactly one extra dispatch.
    expect(workerPrompts.filter((p) => p.includes("ACCEPTED by QA"))).toHaveLength(1);

    // Both tasks' work survived the resolution — the whole point of the union.
    const merged = execFileSync("git", ["show", `charrette/${runId}/main:shared.ts`], { cwd: dir, encoding: "utf8" });
    expect(merged).toContain("task-a");
    expect(merged).toContain("task-b");
  }, 30_000);

  it("tells the worker the work is accepted and that both sides must survive", async () => {
    const { pool, workerPrompts } = conflictingPool((spec) => {
      commitShared(spec.cwd, `  task-a: "task-a",\n  task-b: "task-b",`, "merge: keep both");
    });
    await run(pool);
    const handback = workerPrompts.find((p) => p.includes("ACCEPTED by QA"))!;

    expect(handback).toContain("shared.ts");
    expect(handback).toMatch(/union/i);
    expect(handback).toContain("Never delete the other side");
    // It must not read as a rejection: the worker's own files are not in question.
    expect(handback).toMatch(/Do not redesign/i);
  }, 30_000);

  it("parks the task when the worker cannot resolve the conflict", async () => {
    // A worker that gives up: aborts the merge and changes nothing.
    const { pool } = conflictingPool((spec) => {
      execFileSync("git", ["merge", "--abort"], { cwd: spec.cwd, stdio: "ignore" });
    });
    const { store, runId } = await run(pool);
    const tasks = store.listTasks(runId);

    // Which task merges first is a race between two identical fakes, so assert
    // the shape: one lands, the other is parked rather than silently dropped.
    expect(tasks.filter((t) => t.state === "MERGED")).toHaveLength(1);
    const parked = tasks.filter((t) => t.state === "NEEDS_HUMAN");
    expect(parked).toHaveLength(1);
    // And it says why, rather than parking with an empty reason.
    expect(store.taskStateReason(runId, parked[0]!.id)).toMatch(/could not resolve/i);
  }, 30_000);
});
