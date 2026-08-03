import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { RunController } from "./runController.js";
import { Store } from "./store.js";
import { RunConfig } from "@harness/shared";

/** A pool that replays canned planner outputs instead of calling the API. */
function fakePool(outputs: string[], outcome: AgentResult["outcome"] = "done", errorDetail?: string) {
  const specs: AgentSpec[] = [];
  let i = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const resultText = outputs[Math.min(i, outputs.length - 1)]!;
      i++;
      return { sessionId: `s${i}`, resultText, costUsd: 0, turns: 1, outcome, errorDetail };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, calls: () => i };
}

function harness(outputs: string[], outcome?: AgentResult["outcome"], errorDetail?: string) {
  const repo = mkdtempSync(path.join(tmpdir(), "harness-plan-"));
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: { type: string; reason?: string }[] = [];
  bus.subscribe(({ event }) => events.push(event as { type: string; reason?: string }));
  const { pool, specs, calls } = fakePool(outputs, outcome, errorDetail);
  const controller = new RunController(
    store,
    bus,
    pool,
    new GitHubAdapter(undefined, undefined),
    { async resolvePlanGate() { return { approved: true, feedback: "" }; }, async resolveBudgetGate() { return null; } },
    repo
  );
  return { repo, store, controller, events, specs, calls };
}

const CONFIG = RunConfig.parse({});
const attemptsDir = (repo: string, runId: string) => path.join(repo, ".harness", runId);

/** A well-formed phase-A answer, so phase B is the thing under test. */
const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nuse vitest\n</conventions>";
const dagJson = (dependsOn: string[] = []) =>
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [{ id: "task-a", epicId: "epic-e", title: "A", spec: "s", acceptanceCriteria: ["x"], dependsOn, touchedPaths: [], estimatedSize: "S" }],
  }) +
  "\n```";

describe("planning failure diagnostics", () => {
  it("names the reason in the thrown error instead of a bare 'planning failed'", async () => {
    const { controller } = harness([DOCS, "I could not complete this task."]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(
      /planner attempts rejected — the breakdown JSON could not be read: no JSON object found/
    );
  });

  it("records the reason on the run so `status` and the dashboard can show it", async () => {
    const { controller, store } = harness([DOCS, "no json here"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    expect(store.getRun(runId)!.state).toBe("FAILED");
    const failure = store
      .eventsSince(runId, 0, 100)
      .map((e) => e.event)
      .find((e) => e.type === "run.state_changed" && e.to === "FAILED");
    expect((failure as { reason: string }).reason).toMatch(/no JSON object found/);
  });

  it("persists every rejected attempt verbatim for post-mortem", async () => {
    const { controller, repo, store } = harness([DOCS, "garbage one", "garbage two", "garbage three"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    const dir = attemptsDir(repo, runId);
    // Both planning phases leave their raw output behind, named for the phase.
    expect(readdirSync(dir).sort()).toEqual([
      "planner-attempt-dag-1.txt",
      "planner-attempt-dag-2.txt",
      "planner-attempt-dag-3.txt",
      "planner-attempt-docs-1.txt",
    ]);
    expect(readFileSync(path.join(dir, "planner-attempt-dag-2.txt"), "utf8")).toBe("garbage two");
  });

  it("emits a plan_attempt_failed event per rejection, not just at the end", async () => {
    const { controller, events } = harness([DOCS, "nope"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const failures = events.filter((e) => e.type === "run.plan_attempt_failed");
    expect(failures).toHaveLength(3);
  });

  it("tells the planner what was wrong with its previous attempt", async () => {
    const { controller, specs } = harness([DOCS, "nope"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    expect(specs[1]!.prompt).not.toMatch(/rejected/);
    expect(specs[2]!.prompt).toMatch(/rejected: the breakdown JSON could not be read/);
  });

  it("surveys the repository exactly once, however many times the DAG is rejected", async () => {
    const { controller, specs } = harness([DOCS, "I thought about it but forgot the JSON."]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);

    // Phase A is the only call that may read anything.
    expect(specs[0]!.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(specs[0]!.maxTurns).toBe(40);
    for (const later of specs.slice(1)) {
      // `tools: []` genuinely removes the built-ins; `allowedTools` only auto-approves.
      expect(later.tools).toEqual([]);
      expect(later.maxTurns).toBeLessThanOrEqual(4); // and no room to wander
    }
    // A retry repairs the previous JSON rather than re-deriving the decomposition.
    expect(specs[2]!.prompt).toContain("I thought about it but forgot the JSON.");
    expect(specs[2]!.prompt).toMatch(/do not read it again/);
  });

  it("restates the PRD when the previous attempt returned nothing to repair", async () => {
    const { controller, specs } = harness([DOCS, ""]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    // Nothing to hand back, so the retry gets the documents again, not an empty quote.
    expect(specs[2]!.prompt).toContain("# PRD");
  });

  it("surfaces an abnormal session end alongside the parse failure", async () => {
    const { controller } = harness([DOCS], "error", "error_max_turns");
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(
      /session also ended abnormally: error_max_turns/
    );
  });

  it("reports a DAG violation as such rather than as a parse failure", async () => {
    const { controller } = harness([DOCS, dagJson(["ghost"])]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(/not a valid DAG/);
  });

  it("accepts a PRD that embeds json fences — the case that failed in production", async () => {
    const prd = ["# PRD", "```json", '{"posts":[]}', "```"].join("\n");
    const docs = `<prd>\n${prd}\n</prd>\n<conventions>\nuse vitest\n</conventions>`;
    const { controller, repo, store, calls } = harness([docs, dagJson()]);
    // The subject here is that the PRD parses; the plan-intent check would add a
    // third agent call and make the count say nothing about that.
    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;

    expect(calls()).toBe(2); // accepted first time in both phases — no wasted Opus call
    expect(store.listTasks(runId).map((t) => t.id)).toEqual(["task-a"]);
    // Markdown never round-trips through a JSON string, so a fence inside it is inert.
    expect(readFileSync(path.join(attemptsDir(repo, runId), "PRD.md"), "utf8")).toBe(prd);
  });
});

describe("planner output truncation", () => {
  // The failure that killed a real run: a plan too long for one message comes back
  // as unparseable text, indistinguishable from bad JSON unless it is looked for.
  const CUT_OFF = "API Error: Claude's response exceeded the 32000 output token maximum.";

  it("splits planning in two so neither half has to carry the other", async () => {
    const { controller, specs } = harness([DOCS, dagJson()]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    // Phase A emits markdown, not JSON — no PRD is ever escaped into the DAG object.
    expect(specs[0]!.systemPrompt).toMatch(/<prd>/);
    expect(specs[0]!.systemPrompt).not.toMatch(/prdMarkdown/);
    expect(specs[1]!.systemPrompt).toMatch(/"epics"/);
    expect(specs[1]!.systemPrompt).not.toMatch(/prdMarkdown/);
  });

  it("names truncation as the reason when the documents are cut off", async () => {
    const { controller } = harness([CUT_OFF]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(
      /ran past the output-token limit and were cut off/
    );
  });

  it("names truncation as the reason when the DAG is cut off", async () => {
    const { controller } = harness([DOCS, CUT_OFF]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(
      /ran past the output-token limit and was cut off mid-JSON/
    );
  });

  it("asks for a shorter breakdown on retry, not the same one again", async () => {
    const { controller, specs } = harness([DOCS, CUT_OFF]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    expect(specs[2]!.prompt).toMatch(/Emit the breakdown again, SHORTER/);
    // The instruction that guarantees a repeat truncation must be absent.
    expect(specs[2]!.prompt).not.toMatch(/Do not abbreviate/);
  });

  it("still tells a merely malformed breakdown to re-emit in full", async () => {
    const { controller, specs } = harness([DOCS, "here is my analysis, no json though"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    expect(specs[2]!.prompt).toMatch(/Do not abbreviate/);
    expect(specs[2]!.prompt).not.toMatch(/SHORTER/);
  });

  it("raises the planner's output ceiling above the default that truncated it", async () => {
    const { controller, specs } = harness(["nope"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    expect(specs[0]!.maxOutputTokens).toBeGreaterThan(32_000);
  });
});

describe("agent confinement", () => {
  it("gives the planner read-only tools — allowedTools alone does not restrict", async () => {
    const { controller, specs } = harness(["nope"]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    expect(specs[0]!.tools).toEqual(["Read", "Glob", "Grep"]);
    for (const t of ["Bash", "Edit", "Write"]) {
      expect(specs[0]!.tools).not.toContain(t);
    }
  });
});

/**
 * The cap was the only cost signal a run had, and a cap is not an estimate: it
 * says where the run stops, not what it needs. Run 40da9337 was approved against
 * a $61 cap and cost $774, interrupting the operator nine times to double it —
 * every one of those a surprise, because nobody had ever been shown a number to
 * set the cap against.
 */
describe("what the operator is shown before they approve a plan", () => {
  function planGateHarness(dag = dagJson()) {
    const repo = mkdtempSync(path.join(tmpdir(), "harness-estimate-"));
    const store = new Store(":memory:");
    const summaries: string[] = [];
    const { pool } = fakePool([DOCS, dag]);
    const controller = new RunController(
      store,
      new Bus(store),
      pool,
      new GitHubAdapter(undefined, undefined),
      {
        async resolvePlanGate(_prd, summary) {
          summaries.push(summary);
          return { approved: false, feedback: "" }; // stop at the gate; the plan is the subject
        },
        async resolveBudgetGate() {
          return null;
        },
      },
      repo
    );
    return { controller, store, summaries };
  }

  it("prices the plan next to the cap, and says where the number came from", async () => {
    const { controller, summaries } = planGateHarness();
    // Rejecting sends it back to the planner, which runs out of canned answers
    // and throws. The first summary — the one under test — is already recorded.
    await controller.startRun("do a thing", RunConfig.parse({ budget: { runCapUsd: 500 } })).catch(() => undefined);

    expect(summaries[0]).toContain("[task-a] A");
    expect(summaries[0]).toMatch(/Estimated cost: \$\d/);
    expect(summaries[0]).toContain("against a cap of $500");
    expect(summaries[0]).toContain("no finished run in this repository yet");
  });

  it("says plainly when the cap cannot cover what the plan looks like", async () => {
    const { controller, summaries } = planGateHarness();
    await controller.startRun("do a thing", RunConfig.parse({ budget: { runCapUsd: 1 } })).catch(() => undefined);

    expect(summaries[0]).toContain("The cap is below the estimate");
  });

  it("shows which integrations the plan intends to fake, using 40da9337's own criteria", async () => {
    // These two tasks are copied out of run 40da9337's plan. They were approved
    // at this gate, built, QA-passed and merged — and they are the reason the
    // delivered product cannot debit a payer or mail a check. Nothing about them
    // was visible here before, which is what made the approval uninformed.
    const dag =
      "```json\n" +
      JSON.stringify({
        epics: [{ id: "epic-e", title: "E", summary: "s" }],
        tasks: [
          {
            id: "provider-layer",
            epicId: "epic-e",
            title: "Provider layer",
            spec: "Create `src/providers/index.ts` resolved by `config.providerMode`.",
            acceptanceCriteria: ["All seven vendor categories have an interface and a deterministic mock"],
            dependsOn: [],
            touchedPaths: [],
            estimatedSize: "M",
          },
          {
            id: "plaid-integration",
            epicId: "epic-e",
            title: "Plaid integration",
            spec: "Link a bank account.",
            acceptanceCriteria: ["The suite makes no outbound HTTP call"],
            dependsOn: [],
            touchedPaths: [],
            estimatedSize: "M",
          },
        ],
      }) +
      "\n```";
    const { controller, summaries } = planGateHarness(dag);
    await controller.startRun("fully implement this, including all the integrations", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).toContain("External services");
    expect(summaries[0]).toContain("Built as a test double");
    expect(summaries[0]).toContain("provider-layer");
    expect(summaries[0]).toContain("plaid-integration");
    expect(summaries[0]).toContain("The suite makes no outbound HTTP call");
    expect(summaries[0]).toContain("reject the plan and say so");
  });

  it("stays quiet about integrations when the plan has none to worry about", async () => {
    // A gate that prints the same warning every time is a gate nobody reads.
    const { controller, summaries } = planGateHarness();
    await controller.startRun("do a thing", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).not.toContain("External services");
  });

  it("names what the brief asked for that no task in the plan owns", async () => {
    // The other half of how 40da9337 came out short: not a dimension defined as
    // a mock, but a dimension nobody was ever assigned. `dagJson()` is one
    // task-a that does a thing; the brief below asks for four more.
    const { controller, summaries } = planGateHarness();
    await controller
      .startRun("A production web app with sign-in, a designed responsive UI, and alerting.", RunConfig.parse({}))
      .catch(() => undefined);

    expect(summaries[0]).toContain("Production shape");
    expect(summaries[0]).toContain("deploy");
    expect(summaries[0]).toContain("security");
    expect(summaries[0]).toContain("design");
    expect(summaries[0]).toContain("observability");
    expect(summaries[0]).toContain("If one is deliberately out of scope, approve and it stays out.");
  });

  it("stays quiet about production shape when the brief never asked for any of it", async () => {
    const { controller, summaries } = planGateHarness();
    await controller.startRun("do a thing", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).not.toContain("Production shape");
  });
});
