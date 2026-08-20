// @vitest-environment happy-dom

// The feed's describe() lives in the page's client script, which the compiler
// never parses and page.test.ts never calls — its cases were only ever
// syntax-checked. This extracts it the same way mount() does and executes the
// newest case, so a feed line that renders garbage fails a test instead of a
// dashboard.
import { describe as suite, expect, it } from "vitest";
import { PAGE_HTML } from "./page.js";

function extractDescribe(): (ev: Record<string, unknown>) => [string, string, string] {
  const opensAt = PAGE_HTML.indexOf("<script>");
  const closesAt = PAGE_HTML.indexOf("</script>");
  const source = PAGE_HTML.slice(opensAt + "<script>".length, closesAt);
  document.documentElement.innerHTML =
    (PAGE_HTML.slice(0, opensAt) + PAGE_HTML.slice(closesAt + "</script>".length))
      .replace(/^[\s\S]*?<html[^>]*>/, "")
      .replace(/<\/html>\s*$/, "");
  const factory = new Function("fetch", "setInterval", source + "\n;return { describe: describe };");
  return factory(() => new Promise(() => {}), () => 0).describe;
}

suite("the skills.forged feed line", () => {
  it("renders a created skill with its name, size and resting place", () => {
    const describeEv = extractDescribe();
    const [kind, who, text] = describeEv({
      type: "skills.forged", runId: "r1", taskId: "task-a", name: "log-rotation",
      sha256: "abc", path: "/repo/.harness/skills/log-rotation/SKILL.md",
      action: "created", tokensApprox: 412, ts: 1,
    });
    expect(kind).toBe("tool");
    expect(who).toBe("task-a");
    expect(text).toBe("created skill “log-rotation” (~412 tokens) — /repo/.harness/skills/log-rotation/SKILL.md");
  });

  it("says extended when the forge grew an earlier skill", () => {
    const describeEv = extractDescribe();
    const [, , text] = describeEv({
      type: "skills.forged", runId: "r1", taskId: "task-b", name: "log-rotation",
      sha256: "def", path: "/repo/.harness/skills/log-rotation/SKILL.md",
      action: "extended", tokensApprox: 890, ts: 2,
    });
    expect(text).toContain("extended skill “log-rotation” (~890 tokens)");
  });
});

suite("the run.merge_status feed line", () => {
  it("names the files when the branch cannot merge", () => {
    const describeEv = extractDescribe();
    const [kind, who, text] = describeEv({
      type: "run.merge_status", runId: "r1", prNumber: 834, state: "conflicting",
      baseBranch: "main", conflicts: ["src/a.ts", "src/b.ts"], resolvedBy: "none", ts: 3,
    });
    expect(kind).toBe("bad");
    expect(who).toBe("integrator");
    expect(text).toBe("CANNOT MERGE into main — src/a.ts, src/b.ts");
  });

  it("credits the agent that resolved the conflict", () => {
    const describeEv = extractDescribe();
    const [kind, , text] = describeEv({
      type: "run.merge_status", runId: "r1", prNumber: 834, state: "mergeable",
      baseBranch: "main", conflicts: [], resolvedBy: "agent", ts: 4,
    });
    expect(kind).toBe("git");
    expect(text).toBe("merges into main (an agent resolved the conflict)");
  });

  it("says unconfirmed when GitHub never settled", () => {
    const describeEv = extractDescribe();
    const [, , text] = describeEv({
      type: "run.merge_status", runId: "r1", prNumber: 834, state: "unknown",
      baseBranch: "main", conflicts: [], resolvedBy: "none", ts: 5,
    });
    expect(text).toContain("mergeability unconfirmed");
  });
});

suite("the run.ci_retry feed line", () => {
  // Driving the real page showed this event falling through to the default
  // case and printing the bare type "run.ci_retry" — the least useful possible
  // rendering of "the harness is ruling out a flake before spending money".
  it("says the failed checks were re-run when they were", () => {
    const describeEv = extractDescribe();
    const [kind, who, text] = describeEv({
      type: "run.ci_retry", runId: "r1", prNumber: 834, reran: true, ts: 6,
    });
    expect(kind).toBe("git");
    expect(who).toBe("integrator");
    expect(text).toBe("re-ran the failed checks on PR #834 in case they were flakes");
  });

  it("says so when nothing could be re-run", () => {
    const describeEv = extractDescribe();
    const [, , text] = describeEv({
      type: "run.ci_retry", runId: "r1", prNumber: 834, reran: false, ts: 7,
    });
    expect(text).toBe("could not re-run the failed checks on PR #834 — treating the failure as real");
  });
});

/**
 * The two events the specification phase writes. Without a case each, the
 * feed's default renders them as the bare string "run.acceptance_verdict" —
 * which is the one moment in the run where the operator most needs to be told
 * which promise broke, spent on telling them an event type exists.
 */
suite("the specification feed lines", () => {
  it("says what the specification actually contains", () => {
    const describeEv = extractDescribe();
    const [kind, who, text] = describeEv({
      type: "run.spec_ready",
      runId: "r1",
      spec: { requirements: [{ id: "REQ-001" }, { id: "REQ-002" }], scenarios: [{ id: "SC-001" }], openQuestions: [] },
      ts: 1,
    });
    expect(kind).toBe("state");
    expect(who).toBe("spec");
    expect(text).toBe("specification ready — 2 requirement(s), 1 scenario(s)");
  });

  it("counts the open questions when the brief left some unanswered", () => {
    const describeEv = extractDescribe();
    const [, , text] = describeEv({
      type: "run.spec_ready",
      runId: "r1",
      spec: { requirements: [{ id: "REQ-001" }], scenarios: [], openQuestions: [{ id: "OQ-1" }, { id: "OQ-2" }] },
      ts: 1,
    });
    expect(text).toBe("specification ready — 1 requirement(s), 0 scenario(s), 2 open question(s)");
  });

  /**
   * A red gate is the run telling the operator it has not kept a promise, so it
   * is coloured like a failure rather than like a state change.
   */
  it("names the failing scenarios, and colours a red gate as an error", () => {
    const describeEv = extractDescribe();
    const [kind, who, text] = describeEv({
      type: "run.acceptance_verdict",
      runId: "r1",
      passed: false,
      failing: ["SC-002"],
      named: true,
      blocked: [],
      line: "1 of 2 gating scenario(s) failing: SC-002",
      ts: 1,
    });
    expect(kind).toBe("error");
    expect(who).toBe("spec");
    expect(text).toBe("acceptance: 1 of 2 gating scenario(s) failing: SC-002");
  });

  it("colours a green gate as an ordinary state line", () => {
    const describeEv = extractDescribe();
    const [kind, , text] = describeEv({
      type: "run.acceptance_verdict",
      runId: "r1",
      passed: true,
      failing: [],
      named: true,
      blocked: [],
      line: "2 gating scenario(s) green",
      ts: 1,
    });
    expect(kind).toBe("state");
    expect(text).toBe("acceptance: 2 gating scenario(s) green");
  });
});
