import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { RunSpec, blockingQuestions, gating, type SpecScenario } from "@charrette/shared";
import { acceptanceVerdict, blockingQuestionsFor, failingScenarios, scenarioCommand, scenarioProbeCommand, specCoverage, suiteRunFrom } from "./acceptance.js";

const scenario = (over: Partial<SpecScenario> & { id: string }): SpecScenario =>
  ({ requirement: "REQ-001", title: "", level: "unit", priority: "P0", oracle: "", testRef: "", blocked: false, ...over }) as SpecScenario;

const spec = (over: Partial<z.input<typeof RunSpec>> = {}) =>
  RunSpec.parse({
    feature: "checkout",
    artifactPath: "tdd/checkout.tdd.yaml",
    requirements: [{ id: "REQ-001", text: "A card charge succeeds", priority: "P0" }],
    scenarios: [scenario({ id: "SC-001" })],
    commands: { all: "npx vitest run tests/tdd", byId: 'npx vitest run -t "{{ids}}"' },
    ...over,
  });

describe("which promises the gate is allowed to stop a run over", () => {
  it("holds the run to P0 and P1, and never to a nice-to-have", () => {
    const s = spec({
      scenarios: [
        scenario({ id: "SC-001", priority: "P0" }),
        scenario({ id: "SC-002", priority: "P1" }),
        scenario({ id: "SC-003", priority: "P2" }),
        scenario({ id: "SC-004", priority: "P3" }),
      ],
    });
    expect(gating(s).map((x) => x.id)).toEqual(["SC-001", "SC-002"]);
  });

  /**
   * An unanswerable test parked in CI teaches everyone to ignore a red bar,
   * which costs more than the scenario was worth.
   */
  it("never holds the run to a scenario blocked on a question nobody answered", () => {
    const s = spec({ scenarios: [scenario({ id: "SC-001" }), scenario({ id: "SC-002", blocked: true })] });
    expect(gating(s).map((x) => x.id)).toEqual(["SC-001"]);
  });
});

describe("the questions that must be answered before anyone builds", () => {
  /**
   * Run 40da9337 spent 37 hours and $773 shipping six of seven integrations as
   * fail-closed stubs, because it was interrupted one question into "real
   * vendor accounts, sandbox adapters, or fakes only?" and resumed past it.
   */
  it("asks anything blocking a P0 or P1 requirement", () => {
    const s = spec({
      requirements: [
        { id: "REQ-001", text: "charge a card", priority: "P0", blockedBy: ["OQ-1"] },
        { id: "REQ-009", text: "a nicer receipt", priority: "P3", blockedBy: ["OQ-2"] },
      ],
      openQuestions: [
        { id: "OQ-1", question: "Real Stripe account, or sandbox?", blocks: ["REQ-001"] },
        { id: "OQ-2", question: "Which font on the receipt?", blocks: ["REQ-009"] },
      ],
    });
    expect(blockingQuestions(s).map((q) => q.id)).toEqual(["OQ-1"]);
  });

  /** "It blocks nothing I could name" is not the same as "it does not matter". */
  it("asks a question that names nothing rather than dropping it", () => {
    const s = spec({ openQuestions: [{ id: "OQ-3", question: "Is this multi-tenant?", blocks: [] }] });
    expect(blockingQuestions(s).map((q) => q.id)).toEqual(["OQ-3"]);
  });
});

describe("reading which scenario broke out of a runner's output", () => {
  it("finds the id in the vocabularies the runners actually use", () => {
    const known = ["SC-001", "SC-002", "SC-003", "SC-004", "SC-005", "SC-006"];
    const output = [
      "   × SC-001 refuses an expired card 4ms",
      "FAILED tests/test_checkout.py::test_SC_002 - AssertionError",
      "FAILED tests/checkout_test.go::SC-003",
      "not ok 4 - SC-004 charges once",
      "  ● SC-005 › sends a receipt",
      "  ✘  6 [chromium] › SC-006 completes the journey",
    ].join("\n");
    // SC-002 is written `SC_002` by pytest's name mangling and is not claimed.
    expect(failingScenarios(output, known)).toEqual(["SC-001", "SC-003", "SC-004", "SC-005", "SC-006"]);
  });

  it("does not read a passing test as a failure", () => {
    const output = ["  ✓ SC-001 refuses an expired card", "  ok 2 - SC-002 charges once", "  --- PASS: SC-003", "  × SC-004 sends a receipt"].join("\n");
    expect(failingScenarios(output, ["SC-001", "SC-002", "SC-003", "SC-004"])).toEqual(["SC-004"]);
  });

  /**
   * A stray `SC-` in a stack trace or a source line must not invent a scenario,
   * so every id is matched against the ones the specification declares.
   */
  it("never invents a scenario the specification does not declare", () => {
    expect(failingScenarios("  × SC-999 something else entirely", ["SC-001"])).toEqual([]);
    expect(failingScenarios("  × SC-001 fails", [])).toEqual([]);
  });

  it("does not let one id match inside another", () => {
    expect(failingScenarios("  × SC-120 fails", ["SC-1", "SC-12", "SC-120"])).toEqual(["SC-120"]);
    expect(failingScenarios("  × SC-12 fails", ["SC-1", "SC-12", "SC-120"])).toEqual(["SC-12"]);
  });

  it("reports each broken scenario once however often the runner repeats it", () => {
    const output = "  × SC-001 fails\n  × SC-001 fails\nFAILED SC-001";
    expect(failingScenarios(output, ["SC-001"])).toEqual(["SC-001"]);
  });

  it("ignores blank lines and output with nothing in it", () => {
    expect(failingScenarios("\n\n   \n", ["SC-001"])).toEqual([]);
  });
});

describe("the verdict", () => {
  /**
   * The single most important rule in this file. Every other gate on the way
   * out of a run is a model reading a diff and forming a view; this one is an
   * exit code. Deriving the answer from the parsed ids instead would make the
   * gate exactly as good as the parser.
   */
  it("requires positive execution evidence and never overrides a failing process", () => {
    const green = acceptanceVerdict(spec(), { exitCode: 0, output: "FAILED is a word in this fixture\n✓ SC-001" });
    expect(green.verdict).toBe("green");
    expect(green.failing).toEqual([]);

    const red = acceptanceVerdict(spec(), { exitCode: 1, output: "everything looks fine" });
    expect(red.verdict).toBe("red");
  });

  /**
   * A red suite that named nothing still fails. What changes is that the report
   * says so, rather than naming two scenarios and implying the rest are fine.
   */
  it("says the output named no scenario rather than implying the rest passed", () => {
    const v = acceptanceVerdict(spec(), { exitCode: 1, output: "SyntaxError: unexpected token" });
    expect(v.verdict).toBe("red");
    expect(v.named).toBe(false);
    expect(v.failing).toEqual([]);
    expect(v.line).toContain("named no scenario");
  });

  it("names the failing scenarios worst first and caps the sentence", () => {
    const s = spec({
      scenarios: ["SC-001", "SC-002", "SC-003", "SC-004", "SC-005"].map((id, i) => scenario({ id, priority: i === 4 ? "P0" : "P1" })),
    });
    const output = ["SC-001", "SC-002", "SC-003", "SC-004", "SC-005"].map((id) => `  × ${id} broke`).join("\n");
    const v = acceptanceVerdict(s, { exitCode: 1, output });
    // P0 first, then the P1s in declaration order.
    expect(v.failing).toEqual(["SC-005", "SC-001", "SC-002", "SC-003", "SC-004"]);
    expect(v.line).toContain("SC-005, SC-001, SC-002, SC-003, +1 more");
  });

  it("names a short list in full, without a more-to-come clause", () => {
    const s = spec({ scenarios: [scenario({ id: "SC-001" }), scenario({ id: "SC-002" })] });
    const v = acceptanceVerdict(s, { exitCode: 1, output: "  × SC-002 broke\n  × SC-001 broke" });
    expect(v.line).toBe("2 of 2 gating scenario(s) failing: SC-001, SC-002");
    expect(v.named).toBe(true);
  });

  /** Severity decides the order, and the id breaks a tie inside a band. */
  it("orders a band by id and puts the worse band first whichever way they were declared", () => {
    const s = spec({
      scenarios: [scenario({ id: "SC-009", priority: "P1" }), scenario({ id: "SC-002", priority: "P1" }), scenario({ id: "SC-007", priority: "P0" })],
    });
    const v = acceptanceVerdict(s, { exitCode: 1, output: ["SC-009", "SC-002", "SC-007"].map((id) => `  × ${id} broke`).join("\n") });
    expect(v.failing).toEqual(["SC-007", "SC-002", "SC-009"]);
  });

  /**
   * The blocked list is read the same way the failing one is — top down, then
   * the operator stops — so a P0 nobody can run has to come first.
   */
  it("puts the worst blocked scenario first, whatever order they were declared in", () => {
    const s = spec({
      scenarios: [
        scenario({ id: "SC-b1", priority: "P1", blocked: true }),
        scenario({ id: "SC-b2", priority: "P0", blocked: true }),
        scenario({ id: "SC-b0", priority: "P0", blocked: true }),
        scenario({ id: "SC-001" }),
      ],
    });
    expect(acceptanceVerdict(s, { exitCode: 0, output: "" }).blocked).toEqual(["SC-b0", "SC-b2", "SC-b1"]);
  });

  it("does not list a blocked nice-to-have among what is blocking the run", () => {
    const s = spec({ scenarios: [scenario({ id: "SC-001" }), scenario({ id: "SC-002", blocked: true, priority: "P2" })] });
    expect(acceptanceVerdict(s, { exitCode: 0, output: "" }).blocked).toEqual([]);
  });

  it("counts a suite that could not be run as unproven, never as passing", () => {
    const v = acceptanceVerdict(spec(), { exitCode: 0, output: "", error: "no test framework detected" });
    expect(v.verdict).toBe("red");
    expect(v.named).toBe(false);
    expect(v.line).toContain("could not be run (no test framework detected)");
    expect(v.line).toContain("unproven, not passing");
  });

  it("refuses green when a required scenario remains blocked", () => {
    const s = spec({ scenarios: [scenario({ id: "SC-001" }), scenario({ id: "SC-002", blocked: true })] });
    const v = acceptanceVerdict(s, { exitCode: 0, output: "  ✓ SC-001" });
    expect(v.verdict).toBe("red");
    expect(v.blocked).toEqual(["SC-002"]);
    expect(v.line).toContain("1 required scenario(s) remain blocked: SC-002");
  });

  /**
   * "No scenario ran" and "every scenario passed" are the same exit code and
   * opposite facts, so the sentence has to tell them apart.
   */
  it("does not claim a specification with no gating scenario proved anything", () => {
    const v = acceptanceVerdict(spec({ scenarios: [scenario({ id: "SC-001", priority: "P2" })] }), { exitCode: 0, output: "" });
    expect(v.verdict).toBe("no-opinion");
    expect(v.line).toContain("declares no gating scenario, so nothing here was proven either way");
  });

  it("carries the tail of a red suite's output, and nothing of a green one's", () => {
    const red = acceptanceVerdict(spec(), { exitCode: 1, output: "x".repeat(5000) + "TAIL" });
    expect(red.output.endsWith("TAIL")).toBe(true);
    expect(red.output.length).toBe(4000);
    expect(acceptanceVerdict(spec(), { exitCode: 0, output: "✓ SC-001" }).output).toBe("");
    expect(acceptanceVerdict(spec(), { exitCode: 1, output: "boom", error: "no runner" }).output).toBe("boom");
  });

  /**
   * A blocked scenario carries no question of its own — its requirement does —
   * and the operator has to be asked the question, not shown the id.
   */
  it("names the open question behind each blocked scenario, and says when there is none", () => {
    const s = spec({
      requirements: [
        { id: "REQ-001", text: "take payment", priority: "P0", blockedBy: ["OQ-1"] },
        { id: "REQ-002", text: "orphan", priority: "P0", blockedBy: [] },
        { id: "REQ-003", text: "twice", priority: "P0", blockedBy: ["OQ-1", "OQ-missing"] },
      ],
      openQuestions: [{ id: "OQ-1", question: "Real Stripe account, or sandbox?", detail: "", blocks: ["REQ-001"] }],
      scenarios: [
        scenario({ id: "SC-001", requirement: "REQ-001", blocked: true }),
        scenario({ id: "SC-002", requirement: "REQ-002", blocked: true }),
        scenario({ id: "SC-003", requirement: "REQ-003", blocked: true }),
        scenario({ id: "SC-004", requirement: "REQ-nope", blocked: true }),
      ],
    });
    expect(blockingQuestionsFor(s, ["SC-001", "SC-002", "SC-003", "SC-004", "SC-001", "SC-999"])).toEqual([
      "SC-001 waits on: Real Stripe account, or sandbox?",
      "SC-002 is blocked and names no question",
      "SC-003 waits on: Real Stripe account, or sandbox? / OQ-missing",
      "SC-004 is blocked and names no question",
      "SC-999 is blocked and names no question",
    ]);
  });

  it("says so when every gating scenario is blocked", () => {
    const s = spec({ scenarios: [scenario({ id: "SC-001", blocked: true })] });
    const v = acceptanceVerdict(s, { exitCode: 0, output: "" });
    expect(v.line).toContain("all 1 gating scenario(s) are blocked on an unanswered question");
  });
});

describe("the command one task is judged by", () => {
  /**
   * A worker is judged on what it was asked to build. Holding task three to a
   * scenario task nine has not started is how a gate teaches a worker to go and
   * edit somebody else's file.
   */
  it("selects only that task's scenarios", () => {
    expect(scenarioCommand({ byId: 'npx vitest run -t "{{ids}}"' }, ["SC-001", "SC-002"])).toBe('npx vitest run -t "SC-001|SC-002"');
  });

  it("substitutes every occurrence, because a template may name them twice", () => {
    expect(scenarioCommand({ byId: 'echo "{{ids}}" && pytest -k "{{ids}}"' }, ["SC-001"])).toBe('echo "SC-001" && pytest -k "SC-001"');
  });

  it("is empty when there is no template or nothing to select, and never falls back to everything", () => {
    expect(scenarioCommand({ byId: "" }, ["SC-001"])).toBe("");
    expect(scenarioCommand({ byId: "   " }, ["SC-001"])).toBe("");
    expect(scenarioCommand({ byId: 'vitest -t "{{ids}}"' }, [])).toBe("");
  });
});

describe("what the specification proves about the finished run", () => {
  const covered = spec({
    requirements: [
      { id: "REQ-001", text: "charge a card", priority: "P0" },
      { id: "REQ-002", text: "refund a charge", priority: "P0" },
      { id: "REQ-003", text: "email a receipt", priority: "P1" },
      { id: "REQ-004", text: "export a report", priority: "P2" },
    ],
    scenarios: [
      scenario({ id: "SC-001", requirement: "REQ-001" }),
      scenario({ id: "SC-002", requirement: "REQ-002" }),
      scenario({ id: "SC-003", requirement: "REQ-003", blocked: true }),
    ],
  });

  it("separates what is proven from what is merely built", () => {
    const c = specCoverage(covered, ["SC-002"]);
    expect(c.proven).toBe(1);
    expect(c.broken).toBe(1);
    // REQ-003's only scenario is blocked, and REQ-004 has none at all.
    expect(c.unproven).toEqual(["REQ-003", "REQ-004"]);
    expect(c.total).toBe(4);
  });

  it("counts a requirement with one failing scenario as broken even when its others pass", () => {
    const s = spec({
      requirements: [{ id: "REQ-001", text: "charge a card", priority: "P0" }],
      scenarios: [scenario({ id: "SC-001" }), scenario({ id: "SC-002" })],
    });
    expect(specCoverage(s, ["SC-002"])).toMatchObject({ proven: 0, broken: 1 });
    expect(specCoverage(s, [])).toMatchObject({ proven: 1, broken: 0 });
  });

  it("has an answer for a run with no specification at all", () => {
    expect(specCoverage(RunSpec.parse({}), [])).toEqual({ proven: 0, broken: 0, unproven: [], total: 0 });
  });
});

describe("reading what a failed suite command actually said", () => {
  /**
   * A suite the charrette killed produced no verdict at all. Reporting its
   * partial output as "these scenarios failed" would name whichever ones
   * happened to run first, which is a statement about ordering.
   */
  it("treats a suite it had to kill as unfinished, not as a list of failures", () => {
    const run = suiteRunFrom({ killed: true, stdout: "  × SC-001 broke", code: 143 }, 20);
    expect(run).toEqual({ exitCode: 1, output: "", error: "the scenario suite did not finish inside 20 minutes" });
    expect(acceptanceVerdict(spec(), run).failing).toEqual([]);
  });

  it("keeps both streams, and prefers stderr to the wrapper's own message", () => {
    expect(suiteRunFrom({ stdout: "out", stderr: "err", message: "spawn failed", code: 2 }, 20)).toEqual({ exitCode: 2, output: "out\nerr" });
  });

  it("falls back to the message when the runner wrote nothing to stderr", () => {
    expect(suiteRunFrom({ stderr: "", message: "sh: no such file", code: 127 }, 20)).toMatchObject({ exitCode: 127, output: "sh: no such file" });
  });

  /** A runner killed by a signal has no exit code, and is still a failure. */
  it("calls a death with no exit code a failure", () => {
    expect(suiteRunFrom({ message: "terminated" }, 20)).toMatchObject({ exitCode: 1 });
  });
});

describe("the scenarios a task is judged by", () => {
  const s = spec({
    scenarios: [scenario({ id: "SC-001" }), scenario({ id: "SC-002" }), scenario({ id: "SC-003", blocked: true })],
  });

  it("selects the task's own runnable scenarios", () => {
    expect(scenarioProbeCommand(s, ["SC-001", "SC-002"])).toBe('npx vitest run -t "SC-001|SC-002"');
  });

  /**
   * Every one of these reads as "this task has no scenario check". None of them
   * may read as "run everything": that would fail a task over work nobody has
   * started, which teaches a worker to go and edit somebody else's files.
   */
  it("has no command for a task with nothing to check", () => {
    expect(scenarioProbeCommand(null, ["SC-001"])).toBe("");
    expect(scenarioProbeCommand(s, [])).toBe("");
    expect(scenarioProbeCommand(s, ["SC-999"])).toBe("");
    expect(scenarioProbeCommand(s, ["SC-003"])).toBe("");
  });
});
