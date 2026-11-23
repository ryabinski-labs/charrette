import { describe, expect, it } from "vitest";
import type { TaskRow } from "./store.js";
import {
  advisorPrompt,
  demoPrompt,
  demoSystemPrompt,
  livePrompt,
  liveSystemPrompt,
  OPERATOR_DECISIONS_BUDGET,
  operatorDecisionsBlock,
  pitStopDeciderPrompt,
  prodValidatorPrompt,
  qaTaskPrompt,
  reviewerPrompt,
  validatorNarrowedPrompt,
} from "./prompts.js";

/**
 * At stops 16 and 19 of run 614e06d5 the reviewers called the operator's own
 * decision (Meta by CSV import instead of live) "scope drift" and asked whether
 * they had approved it. Only the intent validator had been told.
 */

const DECISION = { stop: 16, action: "redirect", feedback: "Meta comes in by CSV import, not the live API." };
const task = { title: "Import", spec: "s", acceptanceCriteria: ["x"] } as unknown as TaskRow;

describe("the operator's pit stop decisions", () => {
  it("says they supersede the brief and are not drift", () => {
    const block = operatorDecisionsBlock([DECISION]);
    expect(block).toContain("SUPERSEDE the brief");
    expect(block).toContain("do not call it scope drift");
    expect(block).toContain("do not ask whether they approved it");
    expect(block).toContain("- stop 16 (redirect): Meta comes in by CSV import");
  });

  it("adds nothing at all when there are none", () => {
    expect(operatorDecisionsBlock([])).toBe("");
  });

  it("keeps them in order and gives up the oldest when the budget runs out", () => {
    const long = (stop: number, c: string) => ({ stop, action: "redirect", feedback: c.repeat(1_500) });
    const decisions = [long(1, "a"), long(2, "b"), long(3, "c"), long(4, "d"), long(5, "e")];

    const block = operatorDecisionsBlock(decisions);

    expect(block.indexOf("- stop 1 ")).toBeLessThan(block.indexOf("- stop 5 "));
    expect(block).toContain("e".repeat(1_500));
    expect(block).not.toContain("a".repeat(10));
    expect(block).toContain("- stop 1 (redirect):  […1500 more characters]");
    expect(block.length).toBeLessThan(OPERATOR_DECISIONS_BUDGET + 1_000);
  });

  it("cuts one very long decision and says how much is missing", () => {
    expect(operatorDecisionsBlock([{ stop: 2, action: "replan", feedback: "z".repeat(1_600) }])).toContain("[…100 more characters]");
  });

  it.each([
    ["the reviewers", () => reviewerPrompt("qa-agent", "brief", "", "{}", "- a", "", [DECISION])],
    ["the pit stop decider", () => pitStopDeciderPrompt("brief", "", "report", "", "", "", [DECISION])],
    ["the demo", () => demoPrompt("brief", "- a", "", "", [DECISION])],
    ["the live exercise", () => livePrompt("brief", "path", ["step"], [DECISION])],
    ["QA", () => qaTaskPrompt(task, "summary", "diff", undefined, [], "", [], [DECISION])],
    ["the advisor", () => advisorPrompt(task, "why", [], 0, [DECISION])],
    ["the production validator", () => prodValidatorPrompt("brief", "", "https://app.example.com", "- a", [DECISION])],
    ["the validator's narrowed pass", () => validatorNarrowedPrompt(["item"], "summary", [DECISION])],
  ])("reach %s", (_who, prompt) => {
    expect(prompt()).toContain("SUPERSEDE the brief");
    expect(prompt()).toContain("Meta comes in by CSV import");
  });
});

describe("the standing rule against real third-party systems", () => {
  it.each([
    ["demo", demoSystemPrompt("/art", "/repo")],
    ["live", liveSystemPrompt("/art", "/repo")],
  ])("is in the %s agent's instructions", (_who, prompt) => {
    expect(prompt).toContain("NEVER call a real third-party API with real credentials");
    expect(prompt).toContain("NEVER mint or read real credentials");
    expect(prompt).toContain("NEVER change anything in a real account");
    expect(prompt).toContain("gcloud auth print-access-token");
    expect(prompt).toContain("Keychain");
    expect(prompt).toContain("product's own stand-ins");
    expect(prompt).toContain("UNVERIFIED");
  });

  it("no longer tells the live agent to make a real external call", () => {
    expect(liveSystemPrompt("/art", "/repo")).not.toContain("real external call");
  });

  it("gives the live agent a way to report an unexercised step without calling it worked", () => {
    expect(liveSystemPrompt("/art", "/repo")).toContain('`not-reached`, its `observed` starts with "UNVERIFIED:"');
  });
});
