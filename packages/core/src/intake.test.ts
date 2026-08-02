import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { runIntake, type IntakeRequest } from "./intake.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { Store } from "./store.js";

const BRIEF =
  "```json\n" +
  JSON.stringify({ goal: "add rate limiting", context: "fastify app", decisions: [], outOfScope: [], openQuestions: [] }) +
  "\n```";

/** Answers immediately and records the spec it was handed. */
function pool(): { pool: AgentPool; specs: AgentSpec[] } {
  const specs: AgentSpec[] = [];
  return {
    specs,
    pool: {
      async run(spec: AgentSpec): Promise<AgentResult> {
        specs.push(spec);
        return { sessionId: "i", resultText: BRIEF, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool,
  };
}

function request(over: Partial<IntakeRequest> = {}): IntakeRequest {
  return {
    runId: "r1",
    seed: "add rate limiting",
    repoPath: process.cwd(),
    config: RunConfig.parse({}),
    ui: { async ask() { return ""; }, say() {} },
    budgetCheck: () => {},
    ...over,
  };
}

describe("the intake conversation", () => {
  it("carries the skills the controller selected for it", async () => {
    // Intake decides scope and what is explicitly out of scope — the earliest
    // product decision in a run, and one no task-text routing rule can reach.
    const { pool: p, specs } = pool();
    const store = new Store(":memory:");
    const block = '\n<skill name="product-manager" sha256="abc">body</skill>';
    await runIntake(p, new Bus(store), request({ skillsBlock: block }));

    expect(specs).toHaveLength(1);
    expect(specs[0]!.systemPrompt).toContain('<skill name="product-manager"');
    // Skills go last, after the role's own rules (PERF-1 prompt assembly).
    expect(specs[0]!.systemPrompt!.trimEnd().endsWith("</skill>")).toBe(true);
  });

  it("runs unchanged when no skills were selected", async () => {
    const { pool: p, specs } = pool();
    const store = new Store(":memory:");
    const brief = await runIntake(p, new Bus(store), request());

    expect(brief.goal).toBe("add rate limiting");
    expect(specs[0]!.systemPrompt).not.toContain("<skill");
  });
});
