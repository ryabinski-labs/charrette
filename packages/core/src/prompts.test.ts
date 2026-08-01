import { describe, expect, it } from "vitest";
import { extractJson } from "./prompts.js";

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
