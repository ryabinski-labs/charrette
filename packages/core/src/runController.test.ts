import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController } from "./runController.js";
import { Store } from "./store.js";
import { RunConfig } from "@harness/shared";

/** A pool that replays canned planner outputs instead of calling the API. */
function fakePool(outputs: string[], outcome: AgentResult["outcome"] = "done", errorDetail?: string) {
  const specs: AgentSpec[] = [];
  let i = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const resultText = outputs[Math.min(i, outputs.length - 1)]!;
      i++;
      return { sessionId: `s${i}`, resultText, costUsd: 0, turns: 1, outcome, errorDetail };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, calls: () => i };
}

function harness(outputs: string[], outcome?: AgentResult["outcome"], errorDetail?: string) {
  const repo = mkdtempSync(path.join(tmpdir(), "harness-plan-"));
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: { type: string; reason?: string }[] = [];
  bus.subscribe(({ event }) => events.push(event as { type: string; reason?: string }));
  const { pool, specs, calls } = fakePool(outputs, outcome, errorDetail);
  const controller = new RunController(
    store,
    bus,
    pool,
    new GitHubAdapter(undefined, undefined),
    { async resolvePlanGate() { return { approved: true, feedback: "" }; } },
    repo
  );
  return { repo, store, controller, events, specs, calls };
}

const CONFIG = RunConfig.parse({});
const attemptsDir = (repo: string, runId: string) => path.join(repo, ".harness", runId);

describe("planning failure diagnostics", () => {
  it("names the reason in the thrown error instead of a bare 'planning failed'", async () => {
    const { controller } = harness(["I could not complete this task."]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(
      /planner attempts rejected — the plan JSON could not be read: no JSON object found/
    );
  });

  it("records the reason on the run so `status` and the dashboard can show it", async () => {
    const { controller, store } = harness(["no json here"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    expect(store.getRun(runId)!.state).toBe("FAILED");
    const failure = store
      .eventsSince(runId, 0, 100)
      .map((e) => e.event)
      .find((e) => e.type === "run.state_changed" && e.to === "FAILED");
    expect((failure as { reason: string }).reason).toMatch(/no JSON object found/);
  });

  it("persists every rejected attempt verbatim for post-mortem", async () => {
    const { controller, repo, store } = harness(["garbage one", "garbage two", "garbage three"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    const dir = attemptsDir(repo, runId);
    expect(readdirSync(dir).sort()).toEqual([
      "planner-attempt-1.txt",
      "planner-attempt-2.txt",
      "planner-attempt-3.txt",
    ]);
    expect(readFileSync(path.join(dir, "planner-attempt-2.txt"), "utf8")).toBe("garbage two");
  });

  it("emits a plan_attempt_failed event per rejection, not just at the end", async () => {
    const { controller, events } = harness(["nope"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const failures = events.filter((e) => e.type === "run.plan_attempt_failed");
    expect(failures).toHaveLength(3);
  });

  it("tells the planner what was wrong with its previous attempt", async () => {
    const { controller, specs } = harness(["nope"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    expect(specs[0]!.prompt).not.toMatch(/rejected/);
    expect(specs[1]!.prompt).toMatch(/rejected: the plan JSON could not be read/);
  });

  it("does not pay to re-survey the repository on a retry", async () => {
    const { controller, specs } = harness(["I analysed the repo but forgot the JSON."]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);

    expect(specs[0]!.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(specs[0]!.maxTurns).toBe(40);
    for (const retry of specs.slice(1)) {
      expect(retry.allowedTools).toEqual([]);       // no survey tools at all
      expect(retry.maxTurns).toBeLessThanOrEqual(4); // and no room to wander
      expect(retry.prompt).toContain("I analysed the repo but forgot the JSON.");
      expect(retry.prompt).toMatch(/do not read it again/);
    }
  });

  it("falls back to a full survey when the previous attempt returned nothing to repair", async () => {
    const { controller, specs } = harness([""]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    expect(specs[1]!.allowedTools).toEqual(["Read", "Glob", "Grep"]);
  });

  it("surfaces an abnormal session end alongside the parse failure", async () => {
    const { controller } = harness(["truncated…"], "error", "error_max_turns");
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(
      /session also ended abnormally: error_max_turns/
    );
  });

  it("reports a DAG violation as such rather than as a parse failure", async () => {
    const plan = JSON.stringify({
      prdMarkdown: "# PRD",
      conventionsMarkdown: "c",
      epics: [{ id: "epic-e", title: "E", summary: "s" }],
      tasks: [
        { id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: ["ghost"], touchedPaths: [], estimatedSize: "S" },
      ],
    });
    const { controller } = harness([`\`\`\`json\n${plan}\n\`\`\``]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(/not a valid DAG/);
  });

  it("accepts a plan whose PRD embeds json fences — the case that failed in production", async () => {
    const prd = ["# PRD", "```json", '{"posts":[]}', "```"].join("\n");
    const plan = JSON.stringify({
      prdMarkdown: prd,
      conventionsMarkdown: "use vitest",
      epics: [{ id: "epic-e", title: "E", summary: "s" }],
      tasks: [
        { id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], estimatedSize: "S" },
      ],
    });
    const { controller, repo, store, calls } = harness([`\`\`\`json\n${plan}\n\`\`\``]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;

    expect(calls()).toBe(1); // accepted first time — no retry, no wasted Opus call
    expect(store.listTasks(runId).map((t) => t.id)).toEqual(["task-a"]);
    expect(readFileSync(path.join(attemptsDir(repo, runId), "PRD.md"), "utf8")).toBe(prd);
  });
});
