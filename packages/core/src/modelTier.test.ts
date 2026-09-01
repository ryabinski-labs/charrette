import { describe, expect, it } from "vitest";
import { LIGHT_TIER_MAX_PATHS, taskTier, tierModel, workerModelFor } from "./modelTier.js";

/**
 * The rule that decides whether a task is cheap enough to run cheaply.
 *
 * Every test here is really the same test: that the rule refuses when it is not
 * sure. The saving is a side effect; the property being pinned is that nothing
 * ambiguous, unscoped or dangerous reaches the light tier.
 */

/**
 * A task that passes every condition. Each case breaks exactly one of them.
 *
 * Deliberately not interface work: the interface rule reads the same text and
 * outranks the light one, so a fixture that mentioned a dashboard or a badge
 * on a screen would be testing that rule instead of this one.
 */
const eligible = {
  title: "Rename the status word in the log line",
  spec: "The CLI's progress line says 'Running'. Change it to 'In progress' and update the snapshot.",
  acceptanceCriteria: ["The log line reads 'In progress'"],
  touchedPaths: ["src/status.ts", "src/status.test.ts"],
  completionProbe: "rg -q 'In progress' src/status.ts",
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

describe("what reaches the heavy tier", () => {
  /** Sized L, in a domain where a plausible-looking mistake passes QA. */
  const hard = {
    ...eligible,
    title: "Rework the session refresh under concurrent logins",
    spec: "Two tabs refreshing the same session race each other and one of them logs the user out.",
    touchedPaths: ["src/auth/session.ts", "src/auth/refresh.ts", "src/auth/store.ts"],
    estimatedSize: "L" as const,
  };

  it("admits a task the planner sized L in a risky domain, and says which domain", () => {
    const d = taskTier(hard);

    expect(d.tier).toBe("heavy");
    expect(d.why).toContain("sized it L");
    expect(d.why).toContain("passes QA");
  });

  it("refuses size alone: an L-sized rename is still a rename", () => {
    const d = taskTier({ ...hard, title: "Rename the status word across the CLI", spec: "Every 'Running' becomes 'In progress'.", touchedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"] });

    expect(d.tier).toBe("standard");
    expect(d.why).toContain("L");
  });

  it("refuses a risky domain alone: that is what the light rule refuses, not what this one admits", () => {
    expect(taskTier({ ...hard, estimatedSize: "M" }).tier).toBe("standard");
    // Sized S, the light rule is what turns it down, and it says why.
    const small = taskTier({ ...hard, estimatedSize: "S", touchedPaths: ["src/auth/session.ts"] });
    expect(small.tier).toBe("standard");
    expect(small.why).toContain("passes QA");
  });

  it("admits a second-round fix of a check the standard tier already failed to turn green", () => {
    for (const id of ["ci-fix-2-1", "spec-fix-3-2", "intent-fix-2-1"]) {
      const d = taskTier({ ...eligible, id, estimatedSize: "M" });
      expect(d.tier).toBe("heavy");
      expect(d.why).toContain("round-");
    }
  });

  it("leaves a first-round fix, and a planner's own task id, to the ordinary rules", () => {
    expect(taskTier({ ...eligible, id: "ci-fix-1-1", estimatedSize: "M" }).tier).toBe("standard");
    expect(taskTier({ ...eligible, id: "task-a" }).tier).toBe("light");
  });

  it("outranks the interface rule: a big risky screen is heavy, not merely UI", () => {
    const d = taskTier({ ...hard, title: "Rebuild the login form and the session refresh behind it" });

    expect(d.tier).toBe("heavy");
  });
});

describe("what reaches the interface tier", () => {
  it("admits a task in the interface vocabulary, and names the word that matched", () => {
    const d = taskTier({ ...eligible, title: "Add an empty state to the projects dashboard" });

    expect(d.tier).toBe("ui");
    expect(d.why).toContain("interface work");
    expect(d.why).toMatch(/dashboard|empty state/);
  });

  it("takes a small interface task ahead of the light tier, because it is still a screen", () => {
    // Everything the light rule wants — sized S, two paths, a probe — and
    // still interface work. The design model, not the cheap one.
    const d = taskTier({ ...eligible, spec: "The dashboard's status badge says 'Running'. Change it to 'In progress' and fix the hover state." });

    expect(d.tier).toBe("ui");
  });

  it("ignores the vocabulary's own false friends", () => {
    // Bare `page` is pagination when followed by size; bare `table` is a
    // database table. Neither is a screen, and the rule says so.
    expect(taskTier({ ...eligible, spec: "Raise the default page size of the list endpoint to 50." }).tier).toBe("light");
  });
});

describe("which model a decision buys", () => {
  const models = {
    worker: "claude-sonnet-5",
    workerLight: "claude-haiku-4-5-20251001",
    workerUi: "claude-opus-5",
    workerHeavy: "claude-fable-5-1",
  };

  it("sends an eligible task to the light model", () => {
    expect(workerModelFor(eligible, models).model).toBe("claude-haiku-4-5-20251001");
  });

  it("sends everything else to the standard model", () => {
    expect(workerModelFor({ ...eligible, estimatedSize: "L" }, models).model).toBe("claude-sonnet-5");
  });

  it("sends interface work to the design model and the hardest work to the top", () => {
    expect(workerModelFor({ ...eligible, title: "Restyle the settings page" }, models).model).toBe("claude-opus-5");
    expect(workerModelFor({ ...eligible, id: "ci-fix-2-1", estimatedSize: "M" }, models).model).toBe("claude-fable-5-1");
  });

  it("maps every rung, and the standard one by default", () => {
    expect(tierModel("light", models)).toBe(models.workerLight);
    expect(tierModel("ui", models)).toBe(models.workerUi);
    expect(tierModel("heavy", models)).toBe(models.workerHeavy);
    expect(tierModel("standard", models)).toBe(models.worker);
  });

  it("changes nothing while the light tier points at the same model", () => {
    // How an operator switches the experiment off. The rule still runs and
    // still reports what it would have done, so the measurement survives the
    // decision not to spend on it.
    const inert = { ...models, workerLight: "claude-sonnet-5" };
    const out = workerModelFor(eligible, inert);

    expect(out.model).toBe("claude-sonnet-5");
    expect(out.decision.tier).toBe("light");
  });
});
