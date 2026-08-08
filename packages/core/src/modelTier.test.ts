import { describe, expect, it } from "vitest";
import { LIGHT_TIER_MAX_PATHS, taskTier, workerModelFor } from "./modelTier.js";

/**
 * The rule that decides whether a task is cheap enough to run cheaply.
 *
 * Every test here is really the same test: that the rule refuses when it is not
 * sure. The saving is a side effect; the property being pinned is that nothing
 * ambiguous, unscoped or dangerous reaches the light tier.
 */

/** A task that passes every condition. Each case breaks exactly one of them. */
const eligible = {
  title: "Rename the status badge copy",
  spec: "The dashboard badge says 'Running'. Change it to 'In progress' and update the snapshot.",
  acceptanceCriteria: ["The badge reads 'In progress'"],
  touchedPaths: ["src/Badge.tsx", "src/Badge.test.tsx"],
  completionProbe: "rg -q 'In progress' src/Badge.tsx",
  estimatedSize: "S" as const,
};

describe("what reaches the light tier", () => {
  it("admits a small, scoped, probe-checked task", () => {
    const d = taskTier(eligible);

    expect(d.tier).toBe("light");
    expect(d.why).toContain("probe-checked");
  });

  it("refuses anything the planner sized above S", () => {
    for (const estimatedSize of ["M", "L"] as const) {
      const d = taskTier({ ...eligible, estimatedSize });
      expect(d.tier).toBe("standard");
      expect(d.why).toContain(estimatedSize);
    }
  });

  it("refuses a task that named no files, rather than reading it as touching none", () => {
    // The two are indistinguishable in the data and only one of them is safe.
    const d = taskTier({ ...eligible, touchedPaths: [] });

    expect(d.tier).toBe("standard");
    expect(d.why).toContain("blast radius is unknown");
  });

  it("refuses a task that spreads past the path limit", () => {
    const paths = Array.from({ length: LIGHT_TIER_MAX_PATHS + 1 }, (_, i) => `src/f${i}.ts`);
    const d = taskTier({ ...eligible, touchedPaths: paths });

    expect(d.tier).toBe("standard");
    expect(d.why).toContain(String(LIGHT_TIER_MAX_PATHS));
  });

  it("refuses a task with no completion probe", () => {
    // Without one, nothing but an agent's opinion says the task is done — which
    // is the check a cheap worker most needs and least deserves the benefit of.
    expect(taskTier({ ...eligible, completionProbe: "" }).tier).toBe("standard");
    expect(taskTier({ ...eligible, completionProbe: "   " }).tier).toBe("standard");
  });
});

describe("the domains it will not touch however small the task", () => {
  const risky: [string, Partial<typeof eligible>][] = [
    ["auth in the title", { title: "Tidy the login redirect" }],
    ["payments in the spec", { spec: "Round the invoice total to two decimals before display." }],
    ["a migration in the criteria", { acceptanceCriteria: ["The migration runs clean on an empty database"] }],
    ["concurrency in the spec", { spec: "Fix the race condition in the badge poller." }],
    ["a secret in the spec", { spec: "Read the signing secret from the environment instead of the constant." }],
    ["infrastructure in the paths", { touchedPaths: ["infra/main.tf"] }],
  ];

  it.each(risky)("refuses %s", (_name, override) => {
    const d = taskTier({ ...eligible, ...override });

    expect(d.tier).toBe("standard");
    expect(d.why).toContain("passes QA");
  });

  it("catches a risky domain named only in the spec, not the title", () => {
    // The failure this guards against is a task called "Small copy fix" whose
    // body turns out to be about the password reset screen.
    const d = taskTier({ ...eligible, title: "Small copy fix", spec: "Update the wording on the password reset email." });

    expect(d.tier).toBe("standard");
  });
});

describe("which model a decision buys", () => {
  const models = { worker: "claude-sonnet-5", workerLight: "claude-haiku-4-5-20251001" };

  it("sends an eligible task to the light model", () => {
    expect(workerModelFor(eligible, models).model).toBe("claude-haiku-4-5-20251001");
  });

  it("sends everything else to the standard model", () => {
    expect(workerModelFor({ ...eligible, estimatedSize: "L" }, models).model).toBe("claude-sonnet-5");
  });

  it("changes nothing while the light tier points at the same model", () => {
    // How an operator switches the experiment off. The rule still runs and
    // still reports what it would have done, so the measurement survives the
    // decision not to spend on it.
    const inert = { worker: "claude-sonnet-5", workerLight: "claude-sonnet-5" };
    const out = workerModelFor(eligible, inert);

    expect(out.model).toBe("claude-sonnet-5");
    expect(out.decision.tier).toBe("light");
  });
});
