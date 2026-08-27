import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";

const task = (id: string) => ({
  id,
  epicId: "epic-e",
  title: id,
  spec: `Build ${id}.`,
  acceptanceCriteria: [`${id} works`],
  dependsOn: [],
  touchedPaths: [],
  estimatedSize: "M",
});

const dag = (ids: string[]) =>
  "```json\n" + JSON.stringify({ epics: [{ id: "epic-e", title: "E", summary: "s" }], tasks: ids.map(task) }) + "\n```";

/** The first plan, and the plan the operator's rejection asks for instead. */
const V1 = dag(["scaffold-next-app", "db-cases", "auth-middleware"]);
const V2 = dag(["scaffold-next-app", "db-core-schema", "auth-supabase"]);

/**
 * Runs the planning loop twice: the operator rejects the first plan, so the
 * planner is asked again, and approves the second. Each planning round spends
 * two planner sessions — the PRD and conventions, then the DAG — which is why
 * the pool alternates.
 */
function harness() {
  const repo = mkdtempSync(path.join(tmpdir(), "harness-replan-supersedes-"));
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const plans = [DOCS, V1, DOCS, V2];
  let n = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      const base = { sessionId: `s${++n}`, costUsd: 0, turns: 1, outcome: "done" as const };
      if (spec.role === "planner") return { ...base, resultText: plans.shift() ?? V2 };
      return { ...base, resultText: "" };
    },
  } as unknown as AgentPool;
  let asked = 0;
  const gates: GateHandler = {
    async resolvePlanGate() {
      // Rejected once, approved once. Approving ends the loop; execute() then
      // fails on a repo that is not a git checkout, which the caller catches.
      return asked++ === 0 ? { approved: false, feedback: "use the other stack" } : { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
  };
  const controller = new RunController(store, bus, pool, new GitHubAdapter(undefined, undefined), gates, repo);
  return { controller, store };
}

const run = async () => {
  const { controller, store } = harness();
  await controller.startRun("build the platform", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
  const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
  return { store, runId, tasks: store.listTasks(runId) };
};

/**
 * Run b65127b0 re-planned once and came out holding two plans. `plan.json` had
 * 86 tasks; `tasks` had 139, because `insertTasks` is INSERT OR REPLACE and the
 * 53 ids the new plan dropped were never touched. The scheduler reads `tasks`.
 */
describe("re-planning at the plan gate", () => {
  it("leaves nothing dispatchable that the new plan did not ask for", async () => {
    const { tasks } = await run();

    const pending = tasks.filter((t) => t.state === "PENDING").map((t) => t.id).sort();
    expect(pending).toEqual(["auth-supabase", "db-core-schema", "scaffold-next-app"]);
    // The whole defect in one assertion: before the fix these were also PENDING.
    expect(pending).not.toContain("db-cases");
    expect(pending).not.toContain("auth-middleware");
  }, 30_000);

  it("cancels the dropped tasks rather than deleting them, so their ids stay taken", async () => {
    // A deleted id is one a later re-plan can reuse, inheriting whatever branch
    // and issue history the id already answers to.
    const { tasks } = await run();

    const dropped = tasks.filter((t) => ["db-cases", "auth-middleware"].includes(t.id));
    expect(dropped).toHaveLength(2);
    expect(dropped.every((t) => t.state === "CANCELLED")).toBe(true);
  }, 30_000);

  it("keeps an id both plans name, instead of cancelling and re-adding it", async () => {
    const { tasks } = await run();

    const kept = tasks.filter((t) => t.id === "scaffold-next-app");
    expect(kept).toHaveLength(1);
    expect(kept[0]!.state).toBe("PENDING");
  }, 30_000);

  it("cancels nothing on a first plan", async () => {
    // The same code path runs when there is no previous plan; it must be inert.
    const repo = mkdtempSync(path.join(tmpdir(), "harness-replan-first-"));
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const plans = [DOCS, V1];
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        const base = { sessionId: "s", costUsd: 0, turns: 1, outcome: "done" as const };
        return { ...base, resultText: spec.role === "planner" ? (plans.shift() ?? V1) : "" };
      },
    } as unknown as AgentPool;
    const gates: GateHandler = {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
    };
    const controller = new RunController(store, bus, pool, new GitHubAdapter(undefined, undefined), gates, repo);
    await controller.startRun("build the platform", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;

    expect(store.listTasks(runId).some((t) => t.state === "CANCELLED")).toBe(false);
  }, 30_000);
});
