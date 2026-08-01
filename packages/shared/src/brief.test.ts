import { describe, expect, it } from "vitest";
import { Brief, IntakeQuestion, briefToAssignment } from "./brief.js";

describe("Brief", () => {
  it("needs only a goal; everything else defaults to empty", () => {
    const brief = Brief.parse({ goal: "Add rate limiting" });
    expect(brief.decisions).toEqual([]);
    expect(brief.outOfScope).toEqual([]);
  });

  it("renders decisions so the planner cannot re-litigate them", () => {
    const md = briefToAssignment(
      Brief.parse({
        goal: "Add rate limiting to the public API",
        context: "Fastify 5, single instance.",
        decisions: [{ question: "Where enforced?", answer: "Fastify plugin", rationale: "no new infra" }],
        constraints: ["no new services"],
        outOfScope: ["the admin API"],
      })
    );
    expect(md).toContain("# Add rate limiting to the public API");
    expect(md).toContain("Where enforced? → **Fastify plugin** (no new infra)");
    expect(md).toContain("## Constraints");
    expect(md).toContain("- the admin API");
  });

  it("omits sections that have no items rather than emitting empty headings", () => {
    const md = briefToAssignment(Brief.parse({ goal: "Tidy the README" }));
    expect(md).toBe("# Tidy the README");
  });
});

describe("IntakeQuestion", () => {
  it("defaults options and detail so a bare question is valid", () => {
    const q = IntakeQuestion.parse({ question: "What is the limit keyed on?" });
    expect(q.options).toEqual([]);
    expect(q.detail).toBe("");
  });

  it("defaults an option's recommended flag to false", () => {
    const q = IntakeQuestion.parse({ question: "Where?", options: [{ label: "Plugin" }] });
    expect(q.options[0]).toEqual({ label: "Plugin", description: "", recommended: false });
  });
});
