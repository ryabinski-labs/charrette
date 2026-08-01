import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const task = (id: string, dependsOn: string[] = []) => ({
  id,
  epicId: "epic-e",
  title: `Task ${id}`,
  spec: `Do ${id}`,
  acceptanceCriteria: ["works"],
  dependsOn,
  touchedPaths: [],
  estimatedSize: "S",
});
const dag = (tasks: object[]) => "```json\n" + JSON.stringify({ epics: [{ id: "epic-e", title: "E", summary: "s" }], tasks }) + "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-sched-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "harness@example.com");
  gitIn(dir, "config", "user.name", "harness");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-m", "init");
  return dir;
}

const noGithub = { enabled: false } as unknown as GitHubAdapter;
const approveAll: GateHandler = {
  async resolvePlanGate() {
    return { approved: true, feedback: "" };
  },
  async resolveBudgetGate() {
    return null;
  },
};

describe("parallel scheduler", () => {
  it("dispatches independent tasks concurrently up to maxParallelWorkers, dependents after", async () => {
    let planning = 0;
    let active = 0;
    let peak = 0;
    const workedOrder: string[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") {
          resultText = planning++ === 0 ? DOCS : dag([task("task-a"), task("task-b"), task("task-c"), task("task-d", ["task-a", "task-b", "task-c"])]);
        } else if (spec.role === "worker") {
          active++;
          peak = Math.max(peak, active);
          workedOrder.push(spec.taskId!);
          await new Promise((r) => setTimeout(r, 60));
          writeFileSync(path.join(spec.cwd, `${spec.taskId}.txt`), "done\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", `wip ${spec.taskId}`);
          active--;
          resultText = "worker done";
        } else if (spec.role === "qa") {
          resultText = '{"verdict":"PASS","notes":"fine"}';
        } else {
          resultText = '{"verdict":"PASS","summary":"n/a"}';
        }
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    };
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool as unknown as AgentPool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do things", RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 3 }));

    const summary = store.listTasks(runId).map((t) => `${t.id}=${t.state}${t.errorSummary ? `(${t.errorSummary})` : ""}`).join(" ");
    expect(summary).toBe("task-a=MERGED task-b=MERGED task-c=MERGED task-d=MERGED");
    // The three independent tasks really overlapped; only the dependent one had to wait.
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(workedOrder[3]).toBe("task-d");
  });

  it("keeps one-at-a-time execution when maxParallelWorkers is 1", async () => {
    let planning = 0;
    let active = 0;
    let peak = 0;
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : dag([task("task-a"), task("task-b")]);
        else if (spec.role === "worker") {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          writeFileSync(path.join(spec.cwd, `${spec.taskId}.txt`), "done\n");
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          active--;
          resultText = "worker done";
        } else if (spec.role === "qa") resultText = '{"verdict":"PASS","notes":"fine"}';
        else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    };
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool as unknown as AgentPool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do things", RunConfig.parse({ deterministicChecks: [], maxParallelWorkers: 1 }));
    expect(store.listTasks(runId).every((t) => t.state === "MERGED")).toBe(true);
    expect(peak).toBe(1);
  });

  it("resumes the worker's SDK session after a QA rejection, and only then", async () => {
    let planning = 0;
    let qaCalls = 0;
    const workerSpecs: AgentSpec[] = [];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        let resultText = "";
        let sdkSessionId: string | undefined;
        if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : dag([task("task-a")]);
        else if (spec.role === "worker") {
          workerSpecs.push(spec);
          sdkSessionId = `sdk-${workerSpecs.length}`;
          writeFileSync(path.join(spec.cwd, "w.txt"), `iteration ${workerSpecs.length}\n`);
          gitIn(spec.cwd, "add", "-A");
          gitIn(spec.cwd, "commit", "-m", "wip");
          resultText = "worker done";
        } else if (spec.role === "qa") {
          resultText = ++qaCalls === 1 ? '{"verdict":"FAIL","reasons":["missing test"],"mustFix":["add a test"]}' : '{"verdict":"PASS","notes":"fine"}';
        } else resultText = '{"verdict":"PASS","summary":"n/a"}';
        return { sessionId: `s${Math.random()}`, sdkSessionId, resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    };
    const store = new Store(":memory:");
    const controller = new RunController(store, new Bus(store), pool as unknown as AgentPool, noGithub, approveAll, repo());
    const runId = await controller.startRun("do things", RunConfig.parse({ deterministicChecks: [] }));

    expect(store.getTask(runId, "task-a")!.state).toBe("MERGED");
    expect(workerSpecs).toHaveLength(2);
    // First dispatch is cold; the re-dispatch re-attaches to the first session
    // and carries only the rejection, not the whole task brief again.
    expect(workerSpecs[0]!.resume).toBeUndefined();
    expect(workerSpecs[1]!.resume).toBe("sdk-1");
    expect(workerSpecs[1]!.prompt).toContain("previous session on this task continues");
    expect(workerSpecs[1]!.prompt).toContain("missing test");
  });
});
