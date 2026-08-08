import { describe, expect, it } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool } from "./pool.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store } from "./store.js";

/**
 * `raiseBudget` — moving a cap before it is ever reached, the way an
 * operator typing `budget run 50` into a live terminal does. The gate at
 * `enforceNow` is exercised in controllerBudget.test.ts; this is the other
 * half, where nothing has tripped yet.
 */

function build() {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: HarnessEvent[] = [];
  bus.subscribe(({ event }) => void events.push(event));
  const gates: GateHandler = {
    async resolvePlanGate() {
      return { approved: true, feedback: "" };
    },
    async resolveBudgetGate() {
      return null;
    },
  };
  const controller = new RunController(store, bus, {} as AgentPool, new GitHubAdapter(undefined, undefined), gates, "/tmp/repo");
  return { controller, store, events };
}

function makeRun(store: Store, id = "run1", budget: Partial<RunConfig["budget"]> = {}): void {
  store.createRun({
    id,
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "EXECUTING",
    prdPath: null,
    planHash: null,
    integrationBranch: `harness/${id}/main`,
    config: RunConfig.parse({ budget: { runCapUsd: 30, taskCapUsd: 10, ...budget } }),
  });
}

describe("raiseBudget", () => {
  it("raises the run cap and publishes run.budget_updated", () => {
    const { controller, store, events } = build();
    makeRun(store);

    const result = controller.raiseBudget("run1", "run", 100);

    expect(result).toBe("run cap raised to $100.00");
    expect(store.getRun("run1")!.config.budget.runCapUsd).toBe(100);
    const updated = events.find((e) => e.type === "run.budget_updated");
    expect(updated).toMatchObject({ capUsd: 100 });
  });

  it("raises the task cap without touching the run cap", () => {
    const { controller, store } = build();
    makeRun(store);

    const result = controller.raiseBudget("run1", "task", 25);

    expect(result).toBe("task cap raised to $25.00");
    expect(store.getRun("run1")!.config.budget.taskCapUsd).toBe(25);
    expect(store.getRun("run1")!.config.budget.runCapUsd).toBe(30);
  });

  it("refuses a run cap at or below what has already been spent", () => {
    const { controller, store } = build();
    makeRun(store);
    store.recordUsage({ runId: "run1", sessionId: "s1", model: "claude-sonnet-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 40 });

    const result = controller.raiseBudget("run1", "run", 40);

    expect(result).toMatch(/already spent \$40\.00/);
    expect(store.getRun("run1")!.config.budget.runCapUsd).toBe(30);
  });

  it("refuses a non-positive cap", () => {
    const { controller, store } = build();
    makeRun(store);

    expect(controller.raiseBudget("run1", "run", 0)).toMatch(/positive number/);
    expect(controller.raiseBudget("run1", "run", -5)).toMatch(/positive number/);
    expect(controller.raiseBudget("run1", "run", NaN)).toMatch(/positive number/);
  });

  it("reports an unknown run instead of throwing", () => {
    const { controller } = build();

    expect(controller.raiseBudget("nope", "run", 100)).toBe("no run nope");
  });
});
