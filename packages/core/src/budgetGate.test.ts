import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController, type BudgetGate } from "./runController.js";
import { Store } from "./store.js";

/**
 * A pool that behaves like the real one where budget is concerned: it consults
 * `budgetCheck` before producing anything, and books what it spent into the
 * ledger, so caps trip on real accumulated spend rather than on a stub.
 */
function spendingPool(store: Store, perCallUsd: number, outputs: string[]) {
  let i = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      await spec.budgetCheck?.();
      const sessionId = `s${++i}`;
      store.recordUsage({
        runId: spec.runId,
        taskId: spec.taskId,
        sessionId,
        model: spec.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: perCallUsd,
      });
      return { sessionId, resultText: outputs[Math.min(i - 1, outputs.length - 1)]!, costUsd: perCallUsd, turns: 1, outcome: "done" };
    },
  };
  return { pool: pool as unknown as AgentPool, calls: () => i };
}

/** Planning is two calls: the documents, then the DAG. Both are on the ledger. */
const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";

function harness(opts: {
  perCallUsd: number;
  runCapUsd: number;
  onBudget: (gate: BudgetGate) => Promise<number | null>;
  outputs?: string[];
}) {
  const repo = mkdtempSync(path.join(tmpdir(), "harness-budget-"));
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: { type: string; [k: string]: unknown }[] = [];
  bus.subscribe(({ event }) => events.push(event as { type: string }));
  const seen: BudgetGate[] = [];
  const { pool, calls } = spendingPool(store, opts.perCallUsd, opts.outputs ?? [DOCS, "not a plan"]);
  const controller = new RunController(
    store,
    bus,
    pool,
    new GitHubAdapter(undefined, undefined),
    {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate(gate) {
        seen.push(gate);
        return opts.onBudget(gate);
      },
    },
    repo
  );
  const config = RunConfig.parse({ budget: { runCapUsd: opts.runCapUsd } });
  const runId = () => (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
  return { repo, store, controller, config, events, seen, calls, runId };
}

describe("budget gate", () => {
  it("asks the operator instead of killing the run the moment a cap is reached", async () => {
    // $0.60 a call against a $1.00 cap: the third call is the one that trips it.
    const h = harness({ perCallUsd: 0.6, runCapUsd: 1, onBudget: async () => 10 });
    await h.controller.startRun("do a thing", h.config).catch(() => undefined);

    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]).toMatchObject({ capUsd: 1 });
    expect(h.seen[0]!.spentUsd).toBeCloseTo(1.2, 5);
    // Raised, so planning ran to its own attempt limit rather than dying at the cap:
    // one call for the documents, three for the DAG.
    expect(h.calls()).toBe(4);
  });

  it("persists the raised cap so a resume does not trip on the old one", async () => {
    const h = harness({ perCallUsd: 0.6, runCapUsd: 1, onBudget: async () => 10 });
    await h.controller.startRun("do a thing", h.config).catch(() => undefined);
    expect(h.store.getRun(h.runId())!.config.budget.runCapUsd).toBe(10);
  });

  it("stops with a resumable message when the operator declines", async () => {
    const h = harness({ perCallUsd: 0.6, runCapUsd: 1, onBudget: async () => null });
    await expect(h.controller.startRun("do a thing", h.config)).rejects.toThrow(
      /run budget exceeded: \$1\.20 >= \$1\.00 — run parked\. Raise the cap and pick it up with: harness resume/
    );
    // The cap it declined to raise is still the cap on record.
    expect(h.store.getRun(h.runId())!.config.budget.runCapUsd).toBe(1);
  });

  it("treats a new cap at or below what is already spent as a decline, not a loop", async () => {
    let asked = 0;
    const h = harness({
      perCallUsd: 0.6,
      runCapUsd: 1,
      onBudget: async () => {
        asked++;
        return 1.2; // exactly what has been spent — would trip again immediately
      },
    });
    await expect(h.controller.startRun("do a thing", h.config)).rejects.toThrow(/budget exceeded/);
    expect(asked).toBe(1);
  });

  it("records the gate on the event stream so the dashboard and audit log see it", async () => {
    const h = harness({ perCallUsd: 0.6, runCapUsd: 1, onBudget: async () => 10 });
    await h.controller.startRun("do a thing", h.config).catch(() => undefined);
    const opened = h.events.find((e) => e.type === "run.gate_opened" && e.kind === "budget");
    const resolved = h.events.find((e) => e.type === "run.gate_resolved" && e.kind === "budget");
    expect(opened).toBeTruthy();
    expect(resolved).toMatchObject({ resolution: "approved" });
    expect(h.events.some((e) => e.type === "run.budget_updated" && e.capUsd === 10)).toBe(true);
  });
});

describe("budget hold", () => {
  /** A repo the worktree manager can actually operate on. */
  function gitRepo(): string {
    const repo = mkdtempSync(path.join(tmpdir(), "harness-hold-"));
    writeFileSync(path.join(repo, "README.md"), "# fixture\n");
    for (const args of [
      ["init", "-b", "main"],
      ["config", "user.email", "harness@example.com"],
      ["config", "user.name", "harness"],
      ["add", "-A"],
      ["commit", "-m", "init"],
    ]) {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    }
    return repo;
  }

  const DAG = JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      { id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" },
    ],
  });

  it("parks the run in BUDGET_HOLD while the operator decides, then puts it back", async () => {
    const repo = gitRepo();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const states: string[] = [];
    bus.subscribe(({ event }) => {
      if (event.type === "run.state_changed") states.push(event.to);
    });
    // Both planning calls clear the cap; the worker is the one that trips it.
    const { pool } = spendingPool(store, 0.6, [DOCS, `\`\`\`json\n${DAG}\n\`\`\``, "worker done"]);
    const controller = new RunController(
      store,
      bus,
      pool,
      new GitHubAdapter(undefined, undefined),
      {
        async resolvePlanGate() {
          return { approved: true, feedback: "" };
        },
        async resolveBudgetGate() {
          // Mid-decision the run must be visibly held, not silently running.
          expect(states.at(-1)).toBe("BUDGET_HOLD");
          return null;
        },
      },
      repo
    );
    // $0.60 a call: planning spends $1.20, so the worker's check is the first
    // over. The forge is off so no skillsmith session lands in between and
    // takes the breach that is aimed at the worker.
    const config = RunConfig.parse({ budget: { runCapUsd: 1.1 }, deterministicChecks: [], skillForge: { enabled: false } });
    await expect(controller.startRun("do a thing", config)).rejects.toThrow(/budget exceeded/);

    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    // Declined, so it stays held — and BUDGET_HOLD is what `resume` continues from.
    expect(store.getRun(runId)!.state).toBe("BUDGET_HOLD");
  });

  it("does not re-ask a second worker's way into a gate the operator already declined", async () => {
    // Two workers in flight, both over the cap. The first opens the gate; the
    // second must not queue a duplicate of a question already answered "no" —
    // it stops on the held state instead. Otherwise declining once costs the
    // operator one modal per running session.
    const repo = gitRepo();
    const store = new Store(":memory:");
    const bus = new Bus(store);
    const dag = JSON.stringify({
      epics: [{ id: "epic-e", title: "E", summary: "s" }],
      tasks: ["task-a", "task-b"].map((id) => ({
        id, epicId: "epic-e", title: id, spec: "s", acceptanceCriteria: ["x"],
        dependsOn: [], touchedPaths: [], completionProbe: "", estimatedSize: "S" as const,
      })),
    });
    const { pool } = spendingPool(store, 0.6, [DOCS, `\`\`\`json\n${dag}\n\`\`\``, "worker done"]);
    let asked = 0;
    const controller = new RunController(
      store,
      bus,
      pool,
      new GitHubAdapter(undefined, undefined),
      {
        async resolvePlanGate() {
          return { approved: true, feedback: "" };
        },
        async resolveBudgetGate() {
          asked++;
          // Hold the decision open long enough for the other worker to arrive at
          // its own check and find the run already held.
          await new Promise((r) => setTimeout(r, 20));
          return null;
        },
      },
      repo
    );
    const config = RunConfig.parse({
      budget: { runCapUsd: 1.1 },
      deterministicChecks: [],
      maxParallelWorkers: 2,
      planIntentCheck: false,
      // Same calibration as above: the two workers must be the sessions over
      // the cap, not a skillsmith dispatched ahead of them.
      skillForge: { enabled: false },
    });

    await expect(controller.startRun("do a thing", config)).rejects.toThrow(/budget exceeded/);
    expect(asked).toBe(1);
  }, 30_000);
});
