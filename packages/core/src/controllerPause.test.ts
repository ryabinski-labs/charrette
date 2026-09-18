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
 * The operator closing the laptop.
 *
 * A pause is the one run-wide stop nothing is wrong about: no cap was reached,
 * no plan window ran out, and the only thing needed to start again is the
 * operator coming back. What it must guarantee is what these tests check —
 * every session stops at its next message, the run parks resumable rather than
 * failing, and the commits the workers already made are still there.
 */

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-pause-"));
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

type Answer = (spec: AgentSpec, nth: number) => string;

/**
 * A pool shaped like the real one on the only point that matters here: it asks
 * `budgetCheck` on the way through, so a pause requested during one session is
 * what stops the next.
 */
function pool(answers: Partial<Record<string, Answer>>): AgentPool {
  const counts: Record<string, number> = {};
  let n = 0;
  return {
    async run(spec: AgentSpec): Promise<AgentResult> {
      counts[spec.role] = (counts[spec.role] ?? 0) + 1;
      await spec.budgetCheck?.();
      n += 1;
      return {
        sessionId: `s${n}`, sdkSessionId: `sdk${n}`,
        resultText: answers[spec.role]?.(spec, counts[spec.role]!) ?? "",
        costUsd: 0, turns: 1, outcome: "done",
      };
    },
  } as unknown as AgentPool;
}

function build(repoPath: string, agents: AgentPool) {
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
  const controller = new RunController(store, bus, agents, new GitHubAdapter(undefined, undefined), gates, repoPath);
  return { controller, store, bus, events };
}

const config = () => RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 1 });

describe("pausing a run the operator is going to come back to", () => {
  it("stops at the next message, parks the run resumable, and keeps the work", async () => {
    const dir = repo();
    const said: string[] = [];
    const holder: { controller?: RunController } = {};
    let worktree = "";
    const agents = pool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson(["task-a", "task-b"]) : DOCS),
      // The operator clicks Pause while the first worker is mid-task. Its own
      // commits are already made; what stops is everything after this message.
      worker: (s) => {
        worktree = s.cwd;
        commitInWorktree(s.cwd, "work.txt");
        said.push(holder.controller!.pauseRun(s.runId));
        // Clicking again because nothing has visibly happened yet is a fair
        // question, not an error.
        said.push(holder.controller!.pauseRun(s.runId));
        return "did the work";
      },
      qa: () => QA_PASS,
    });
    const { controller, store, events } = build(dir, agents);
    holder.controller = controller;

    // It resolves. A pause is not a failure, and a caller that has to catch one
    // to print an outcome will eventually print a stack trace instead.
    const runId = await controller.startRun("build a thing", config());

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(said).toEqual([
      expect.stringMatching(/^pausing —/),
      "already pausing — the agents stop at their next message",
    ]);
    expect(events.some((e) => e.type === "run.pause_requested" && e.runId === runId)).toBe(true);
    expect(
      events.some((e) => e.type === "run.state_changed" && e.to === "PAUSED" && e.reason === "the operator paused the run")
    ).toBe(true);

    // The second task never started: the scheduler stops dispatching the moment
    // the pause is seen, so there is nothing half-built to explain later.
    expect(store.getTask(runId, "task-b")!.state).toBe("PENDING");
    // And the first one's commit is still in its worktree, which is the whole
    // promise: an operator gets back what the workers had actually finished.
    expect(execFileSync("git", ["log", "--oneline"], { cwd: worktree, encoding: "utf8" })).toContain("add work.txt");
  }, 60_000);

  it("parks a run paused while it was integrating, rather than failing it", async () => {
    const dir = repo();
    const holder: { controller?: RunController; runId?: string } = {};
    const agents = pool({
      planner: (s) => (s.prompt.includes("PRD") ? dagJson(["task-a"]) : DOCS),
      worker: (s) => (commitInWorktree(s.cwd, "work.txt"), "did the work"),
      qa: () => QA_PASS,
    });
    const { controller, store, bus } = build(dir, agents);
    holder.controller = controller;
    // The click lands after the last task merged — there is no scheduler loop
    // left to notice it, only the intent validator's next message.
    bus.subscribe(({ event }) => {
      if (event.type === "run.state_changed" && event.to === "INTEGRATING") controller.pauseRun(event.runId);
    });

    const runId = await controller.startRun("build a thing", config());

    expect(store.getRun(runId)!.state).toBe("PAUSED");
    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
  }, 60_000);
});

describe("what a pause refuses", () => {
  /** No agents needed: every answer here is decided before anything is dispatched. */
  function idle() {
    const dir = repo();
    const { controller, store } = build(dir, pool({}));
    return { controller, store, dir };
  }

  it("says so when there is no such run", () => {
    const { controller } = idle();
    expect(controller.pauseRun("nope")).toBe("no run nope");
  });

  it("refuses a run that is not working, and names the state it is in", () => {
    const { controller, store, dir } = idle();
    store.createRun({
      id: "r1", repoPath: dir, assignment: "a", state: "PR_REVIEW",
      prdPath: "", planHash: "", integrationBranch: "", config: config(),
    });
    expect(controller.pauseRun("r1")).toBe("this run is PR_REVIEW — only a run that is still working can be paused");
  });
});
