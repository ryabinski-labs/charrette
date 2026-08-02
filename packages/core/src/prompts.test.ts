import { describe, expect, it } from "vitest";
import { extractJson, plannerBreakdownSystemPrompt, qaSystemPrompt } from "./prompts.js";

const fence = "```";

describe("extractJson", () => {
  it("reads a plain fenced object", () => {
    expect(extractJson(`${fence}json\n{"verdict":"PASS","notes":"fine"}\n${fence}`)).toEqual({
      verdict: "PASS",
      notes: "fine",
    });
  });

  it("reads an object with no fence around it", () => {
    expect(extractJson('Here you go: {"verdict":"PASS","notes":""}')).toEqual({ verdict: "PASS", notes: "" });
  });

  /**
   * The production failure: a planner PRD about JSON manifests embedded its own
   * ```json examples inside the prdMarkdown string. The old non-greedy fence
   * regex sliced at the first inner fence and threw away three valid plans.
   */
  it("survives a string field that embeds its own json fences", () => {
    const prd = [
      "# PRD",
      "The manifest looks like:",
      `${fence}json`,
      '{"posts":[{"slug":"a"}]}',
      fence,
      "and the sitemap entry is:",
      `${fence}json`,
      '{"loc":"/blog/a"}',
      fence,
    ].join("\n");
    const payload = { prdMarkdown: prd, conventionsMarkdown: "use vitest", epics: [], tasks: [] };
    const text = `Here is the plan.\n\n${fence}json\n${JSON.stringify(payload)}\n${fence}`;

    expect(extractJson(text)).toEqual(payload);
  });

  it("survives braces and escaped quotes inside string values", () => {
    const payload = { spec: 'call foo({ "a": 1 }) and expect "ok"', tasks: [] };
    expect(extractJson(`${fence}json\n${JSON.stringify(payload)}\n${fence}`)).toEqual(payload);
  });

  it("survives an unbalanced brace inside a string value", () => {
    const payload = { spec: "the regex is /^\\{+$/ which is fine" };
    expect(extractJson(JSON.stringify(payload))).toEqual(payload);
  });

  it("ignores prose before and after the object", () => {
    const text = `I surveyed the repo. Root cause: the deploy step overwrites {the manifest}.\n\n${fence}json\n{"ok":true}\n${fence}\n\nLet me know if you want changes.`;
    expect(extractJson(text)).toEqual({ ok: true });
  });

  it("takes the last complete object when the agent shows a draft first", () => {
    const text = `Draft:\n${fence}json\n{"v":1}\n${fence}\nFinal:\n${fence}json\n{"v":2}\n${fence}`;
    expect(extractJson(text)).toEqual({ v: 2 });
  });

  it("keeps nested objects and arrays intact", () => {
    const payload = { tasks: [{ id: "a", dependsOn: [], meta: { size: "S" } }] };
    expect(extractJson(JSON.stringify(payload))).toEqual(payload);
  });

  it("does not mistake an inner object for the answer", () => {
    const payload = { outer: true, inner: { outer: false } };
    expect(extractJson(`${fence}json\n${JSON.stringify(payload)}\n${fence}`)).toEqual(payload);
  });

  it("throws a diagnosable error when there is no object at all", () => {
    expect(() => extractJson("I could not complete this task.")).toThrow(/no JSON object found in 31 chars/);
  });

  it("throws rather than returning a fragment when the object is truncated", () => {
    expect(() => extractJson(`${fence}json\n{"prdMarkdown":"# PRD`)).toThrow(/no JSON object found/);
  });
});

/**
 * The harness could not build infrastructure for a reason that had nothing to do
 * with the worker: QA's only notion of "verified" was a green test suite, so
 * declarative configuration — which has no unit tests by construction — was
 * rejected for missing evidence it can never produce, three times, then parked.
 */
describe("infrastructure work", () => {
  it("stops QA failing declarative config for having no unit tests", () => {
    const p = qaSystemPrompt();
    expect(p).toMatch(/Do not fail an infra task for an empty tests directory/);
    expect(p).toMatch(/demanding them is a defect in your review/);
  });

  it("gives QA the verification loop the tools actually provide", () => {
    const p = qaSystemPrompt();
    for (const cmd of ["terraform plan", "cdk synth", "helm template", "kubectl --dry-run=server"]) {
      expect(p).toContain(cmd);
    }
    // A plan is QA's green suite, and it has to show its work like any verdict.
    expect(p).toMatch(/a plan that succeeds is your equivalent of a green suite/i);
  });

  it("points QA at the defects a plan cannot show", () => {
    // Infra bugs are almost never syntax; they are a wildcard nobody read.
    const p = qaSystemPrompt();
    for (const smell of ["0.0.0.0/0", "wildcard", "unencrypted", "deletion protection"]) {
      expect(p.toLowerCase()).toContain(smell.toLowerCase());
    }
  });

  it("forbids QA provisioning anything to settle a criterion", () => {
    const p = qaSystemPrompt();
    expect(p).toMatch(/NEVER apply, deploy, or destroy anything to verify it/);
    // An unverifiable criterion is a reported gap, never a licence to deploy.
    expect(p).toMatch(/a gap to report, not a reason to touch the operator's infrastructure/);
  });

  it("tells the planner infra is a deliverable, with criteria that need no account", () => {
    const p = plannerBreakdownSystemPrompt();
    expect(p).toMatch(/Infrastructure is a legitimate deliverable/);
    expect(p).toMatch(/checkable WITHOUT provisioning anything/);
    // The trap this closes: "the bucket exists in staging" is unjudgeable here.
    expect(p).toMatch(/cannot be judged and will park the task/);
  });
});
