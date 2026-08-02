import { describe, expect, it } from "vitest";
import { Brief, briefToAssignment } from "./brief.js";
import { Plan, validatePlanDag } from "./plan.js";

/**
 * The malformed plans and half-filled briefs the schema alone will accept.
 * Every one of these is something a planner agent has produced or plausibly
 * could, and each has to be caught before tasks are created from it.
 */

const task = (id: string, dependsOn: string[] = [], epicId = "epic-a") => ({
  id,
  epicId,
  title: id,
  spec: "do the thing",
  acceptanceCriteria: ["it works"],
  dependsOn,
  touchedPaths: [],
  estimatedSize: "M" as const,
});

const plan = (over: Partial<{ epics: unknown[]; tasks: unknown[] }> = {}) =>
  Plan.parse({
    prdMarkdown: "# The PRD",
    conventionsMarkdown: "# Conventions",
    epics: [{ id: "epic-a", title: "A", summary: "" }],
    tasks: [task("placeholder")],
    ...over,
  });


describe("validating a plan's shape before anything is built from it", () => {
  it("accepts a plan that hangs together", () => {
    expect(validatePlanDag(plan({ tasks: [task("one"), task("two", ["one"])] }))).toEqual([]);
  });

  it("catches two tasks sharing an id", () => {
    // The second would silently overwrite the first everywhere it is looked up.
    expect(validatePlanDag(plan({ tasks: [task("same"), task("same")] }))).toContain("duplicate task id: same");
  });

  it("catches a task that depends on itself", () => {
    expect(validatePlanDag(plan({ tasks: [task("loop", ["loop"])] }))).toContain("task loop depends on itself");
  });

  it("catches a dependency on a task that does not exist", () => {
    expect(validatePlanDag(plan({ tasks: [task("one", ["ghost"])] }))).toContain("task one depends on unknown task ghost");
  });

  it("catches a task filed under an epic that does not exist", () => {
    expect(validatePlanDag(plan({ tasks: [task("one", [], "epic-ghost")] }))).toContain(
      "task one references unknown epic epic-ghost"
    );
  });

  it("catches a cycle between tasks", () => {
    const errors = validatePlanDag(plan({ tasks: [task("task-a", ["task-b"]), task("task-b", ["task-a"])] }));

    expect(errors.join(" ")).toMatch(/cycle/i);
  });
});

describe("rendering the brief the planner receives", () => {
  const brief = (over: Record<string, unknown> = {}) =>
    Brief.parse({ goal: "add rate limiting", context: "", decisions: [], ...over });

  it("carries the rationale for a decision when there is one", () => {
    const rendered = briefToAssignment(
      brief({ decisions: [{ question: "Keyed on what?", answer: "the API key", rationale: "there is no auth middleware yet" }] })
    );

    expect(rendered).toContain("Keyed on what? → **the API key** (there is no auth middleware yet)");
  });

  it("leaves the parentheses off a decision with no rationale", () => {
    const rendered = briefToAssignment(brief({ decisions: [{ question: "Keyed on what?", answer: "the API key", rationale: "" }] }));

    expect(rendered).toContain("Keyed on what? → **the API key**");
    expect(rendered).not.toContain("()");
  });

  it("omits the context paragraph rather than leaving a blank one", () => {
    // Not "# add rate limiting\n\n" — an empty context must not leave a stray blank paragraph.
    expect(briefToAssignment(brief())).toBe("# add rate limiting");
  });

  it("includes the context when the conversation produced any", () => {
    expect(briefToAssignment(brief({ context: "a fastify app with no middleware" }))).toContain("a fastify app with no middleware");
  });

  it("lists constraints and what was ruled out", () => {
    const rendered = briefToAssignment(
      brief({ constraints: ["stay in-process"], outOfScope: ["a Redis dependency"], openQuestions: ["what limit?"] })
    );

    expect(rendered).toContain("stay in-process");
    expect(rendered).toContain("a Redis dependency");
    expect(rendered).toContain("what limit?");
  });
});
