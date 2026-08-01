import { describe, expect, it } from "vitest";
import { Plan, validatePlanDag } from "./plan.js";

const base = {
  prdMarkdown: "# PRD",
  conventionsMarkdown: "conventions",
  epics: [{ id: "core", title: "Core", summary: "s" }],
};

function plan(tasks: object[]): Plan {
  return Plan.parse({
    ...base,
    tasks: tasks.map((t, i) => ({
      id: `t${i}`,
      epicId: "core",
      title: `T${i}`,
      spec: "spec",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      estimatedSize: "S",
      ...t,
    })),
  });
}

describe("validatePlanDag", () => {
  it("accepts a valid DAG", () => {
    expect(validatePlanDag(plan([{}, { dependsOn: ["t0"] }]))).toEqual([]);
  });

  it("rejects dangling dependencies", () => {
    const errors = validatePlanDag(plan([{ dependsOn: ["nope"] }]));
    expect(errors.some((e) => e.includes("unknown task nope"))).toBe(true);
  });

  it("rejects cycles", () => {
    const errors = validatePlanDag(plan([{ dependsOn: ["t1"] }, { dependsOn: ["t0"] }]));
    expect(errors).toContain("dependency cycle detected");
  });

  it("rejects unknown epics", () => {
    const errors = validatePlanDag(plan([{ epicId: "ghost" }]));
    expect(errors.some((e) => e.includes("unknown epic"))).toBe(true);
  });
});
