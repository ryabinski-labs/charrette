import { describe, expect, it } from "vitest";
import { advisorPrompt, extractJson, plannerBreakdownSystemPrompt, qaSystemPrompt } from "./prompts.js";

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

describe("what an agent is told about the machine it is on", () => {
  it("tells QA a test that pins this host is worse than no test", () => {
    // Run 40da9337's PR came back red on CI over a QA-authored sanity check
    // that asserted `fe80::1` was rejected as an SSRF target. True on the
    // laptop that wrote it, false everywhere else, and green in the run.
    const p = qaSystemPrompt();
    expect(p).toMatch(/pass on a machine that is not this one/);
    expect(p).toContain("fe80::1");
    for (const trap of ["home directory", "timezone", "environment variable"]) {
      expect(p).toContain(trap);
    }
    // And the way out, so the rule does not just forbid without instructing.
    expect(p).toMatch(/a temp directory the test creates and removes/);
    expect(p).toMatch(/report it as unverified rather than committing a test that pins it/);
  });
});

describe("what the advisor is told about the repository", () => {
  const task = {
    id: "task-a", runId: "r", epicId: "e", title: "A", spec: "s", acceptanceCriteria: ["x"],
    dependsOn: [], state: "WORKING" as const, branch: null, worktreePath: null,
    githubIssueNumber: null, prNumber: null, qaIterations: 0, respawns: 0,
    assignedSkills: [], errorSummary: null, touchedPaths: [], estimatedSize: "M" as const,
  };

  it("names the commands the repository actually checks a task with", () => {
    // The advisor is asked to verify QA's claims and dropped into a worktree
    // with no idea how anything runs. In run 40da9337 the fact it needed was
    // one line, and nothing ever told it.
    const p = advisorPrompt(task, "QA rejected it", ["npx tsx scripts/testRun.ts <file>", "npm run lint"]);

    expect(p).toContain("npx tsx scripts/testRun.ts <file>");
    expect(p).toContain("npm run lint");
    expect(p).toMatch(/rather than guessing at a command/);
  });

  it("says nothing about checks when the repository declares none", () => {
    const p = advisorPrompt(task, "QA rejected it");

    expect(p).not.toMatch(/How this repository checks a task/);
    expect(p).toContain("Investigate the worktree you are in");
  });
});
