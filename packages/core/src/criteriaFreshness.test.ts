import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import type { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const ORIGINAL = "the original bar, written before anyone read the code";
const AMENDED = "the amended bar the operator set while the worker was running";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";
const DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      {
        id: "task-a",
        epicId: "epic-e",
        title: "A",
        spec: "s",
        acceptanceCriteria: [ORIGINAL],
        dependsOn: [],
        touchedPaths: [],
        completionProbe: "",
        estimatedSize: "S",
      },
    ],
  }) +
  "\n```";

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "charrette-criteria-"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  gitIn(dir, "init", "-b", "main");
  gitIn(dir, "config", "user.email", "charrette@example.com");
  gitIn(dir, "config", "user.name", "charrette");
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

/**
 * A pool that amends the task's criteria from inside the worker session — the
 * window this test is about. The iteration read its task row before the worker
 * was dispatched; an operator standing at a gate amends it during; QA is
 * briefed after.
 */
function poolAmendingDuringWorker(amend: (spec: AgentSpec) => void) {
  let planning = 0;
  const qaPrompts: string[] = [];
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      let resultText = "";
      if (spec.role === "planner") resultText = planning++ === 0 ? DOCS : DAG;
      else if (spec.role === "worker") {
        amend(spec);
        writeFileSync(path.join(spec.cwd, "feature.txt"), "work\n");
        gitIn(spec.cwd, "add", "-A");
        gitIn(spec.cwd, "commit", "-m", "wip");
        resultText = "worker done";
      } else if (spec.role === "qa") {
        qaPrompts.push(spec.prompt);
        resultText = '{"verdict":"PASS","summary":"fine"}';
      } else resultText = '{"verdict":"PASS","summary":"n/a"}';
      return { sessionId: `s${Math.random()}`, resultText, costUsd: 0, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, qaPrompts };
}

describe("criteria amended mid-iteration", () => {
  it("reach the QA session that grades the work, not just the database", async () => {
    // The whole point of `charrette criteria` on a live run: the operator moves
    // the bar because the bar was wrong, and the very next grading uses it.
    // Reading the task row once at the top of the iteration and briefing QA
    // from that snapshot means the amendment lands in the database and QA
    // still fails the work against wording the operator has already retracted.
    let store!: Store;
    let runId = "";
    const { pool, qaPrompts } = poolAmendingDuringWorker((spec) => {
      store.amendCriteria(spec.runId, spec.taskId!, [AMENDED], "operator", "the original was unsatisfiable");
    });
    const s = new Store(":memory:");
    store = s;
    const bus = new Bus(s);
    const controller = new RunController(s, bus, pool, noGithub, approveAll, repo());
    runId = await controller.startRun("do a thing", RunConfig.parse({ deterministicChecks: [], qaIterationCap: 3 }));

    expect(store.getTask(runId, "task-a")!.acceptanceCriteria).toEqual([AMENDED]);
    expect(qaPrompts).toHaveLength(1);
    expect(qaPrompts[0]).toContain(AMENDED);
    expect(qaPrompts[0]).not.toContain(ORIGINAL);
  });
});
