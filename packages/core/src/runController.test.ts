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
import { BudgetExceeded } from "./budget.js";
import { tasksPerMessage } from "./prompts.js";

/** A pool that replays canned planner outputs instead of calling the API. */
function fakePool(outputs: string[], outcome: AgentResult["outcome"] = "done", errorDetail?: string, dies: (call: number) => Error | undefined = () => undefined) {
  const specs: AgentSpec[] = [];
  let i = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const death = dies(i);
      const resultText = outputs[Math.min(i, outputs.length - 1)]!;
      i++;
      if (death) throw death;
      return { sessionId: `s${i}`, resultText, costUsd: 0, turns: 1, outcome, errorDetail };
    },
  };
  return { pool: pool as unknown as AgentPool, specs, calls: () => i };
}

function harness(outputs: string[], outcome?: AgentResult["outcome"], errorDetail?: string, dies?: (call: number) => Error | undefined) {
  const repo = mkdtempSync(path.join(tmpdir(), "harness-plan-"));
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const events: { type: string; reason?: string }[] = [];
  bus.subscribe(({ event }) => events.push(event as { type: string; reason?: string }));
  const { pool, specs, calls } = fakePool(outputs, outcome, errorDetail, dies);
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

/**
 * A task's JSON costs about 500 tokens and a real plan runs to forty of them,
 * against a per-message ceiling the SDK picks by model and does not negotiate —
 * 32k for one it does not recognise, which today is every default planner. The
 * rule this replaced told the planner to emit "fewer, larger tasks" when the
 * plan would not fit, which pays for a channel limit with the only thing the DAG
 * exists for.
 */
describe("a DAG too big for one message", () => {
  const epic = { id: "epic-e", title: "E", summary: "s" };
  const task = (id: string, dependsOn: string[] = []) => ({
    id,
    epicId: "epic-e",
    title: id,
    spec: "s",
    acceptanceCriteria: ["x"],
    dependsOn,
    touchedPaths: [],
    estimatedSize: "S" as const,
  });
  const batch = (body: object) => "```json\n" + JSON.stringify(body) + "\n```";

  it("asks for the rest instead of settling for what fit in one message", async () => {
    const { controller, store } = harness([
      DOCS,
      batch({ epics: [epic], tasks: [task("task-a")], more: true }),
      batch({ tasks: [task("task-b")], more: false }),
    ]);
    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    expect(store.listTasks(runId).map((t) => t.id)).toEqual(["task-a", "task-b"]);
  });

  it("still takes a plan that fits in one message, in one message", async () => {
    // The continuation only happens when the planner says there is more, so a
    // small plan costs exactly what it did before this existed.
    const { controller, calls } = harness([DOCS, dagJson()]);
    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
    expect(calls()).toBe(2);
  });

  it("carries the ids already emitted into the continuation", async () => {
    // `dependsOn` has to point at ids from an earlier message. A continuation
    // that cannot see them invents an edge to a task under another name, which
    // validates as dangling and throws the whole plan away.
    const { controller, specs } = harness([
      DOCS,
      batch({ epics: [epic], tasks: [task("task-a")], more: true }),
      batch({ tasks: [task("task-b", ["task-a"])], more: false }),
    ]);
    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
    expect(specs[2]!.prompt).toContain("task-a (epic-e)");
    expect(specs[2]!.prompt).toContain("epic-e: E");
    expect(specs[2]!.prompt).not.toContain("<prd>"); // and not the documents a second time
  });

  it("judges the DAG once the whole plan is in, not one message at a time", async () => {
    // `task-b` depends on `task-a`, which arrived in an earlier message. Checked
    // per message this is a dangling edge; checked on the assembled plan it is
    // the ordinary case.
    const { controller, store } = harness([
      DOCS,
      batch({ epics: [epic], tasks: [task("task-a")], more: true }),
      batch({ tasks: [task("task-b", ["task-a"])], more: false }),
    ]);
    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    expect(store.getRun(runId)!.state).not.toBe("FAILED");
  });

  it("rejects a plan whose last message leaves it invalid", async () => {
    const { controller, events } = harness([
      DOCS,
      batch({ epics: [epic], tasks: [task("task-a")], more: true }),
      batch({ tasks: [task("task-b", ["ghost"])], more: false }),
    ]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    const first = events.find((e) => e.type === "run.plan_attempt_failed");
    expect(first!.reason).toMatch(/depends on unknown task ghost/);
  });

  it("rejects a plan that finishes with no epic to hang the tasks on", async () => {
    // The shape is only checkable on the assembled whole: a continuation message
    // legitimately carries no epics, and the first message is what must.
    const { controller } = harness([DOCS, batch({ tasks: [task("task-a")], more: false })]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(/does not match the required shape: epics/);
  });

  it("names the field when a message is JSON but not a batch", async () => {
    // Every field of a batch has a default, so an object is nearly always
    // readable — which makes the one thing that is not, a field of the wrong
    // type, worth naming rather than reporting as unparseable text.
    const { controller } = harness([DOCS, batch({ epics: [epic], tasks: "all of them" })]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(/does not match the required shape: tasks/);
  });

  it("stops after eight messages rather than paying for an endless plan", async () => {
    // A planner that keeps saying "more" is enumerating, not decomposing.
    const { controller, calls } = harness([DOCS, batch({ epics: [epic], tasks: [task("task-a")], more: true })]);
    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(/still unfinished after 8 messages/);
    expect(calls()).toBe(1 + 8 * 3); // phase A, then eight messages per attempt
  });

  it("keeps every message of the DAG on disk under its own name", async () => {
    const { controller, repo, store } = harness([
      DOCS,
      batch({ epics: [epic], tasks: [task("task-a")], more: true }),
      batch({ tasks: [task("task-b")], more: false }),
    ]);
    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);
    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    const files = readdirSync(attemptsDir(repo, runId));
    expect(files).toContain("planner-attempt-dag-1.txt");
    expect(files).toContain("planner-attempt-dag-1-2.txt");
  });

  it("tells the planner how many tasks it may put in one message, and asks for the room to write them", async () => {
    const { controller, specs } = harness([DOCS, dagJson()]);
    await controller.startRun("do a thing", CONFIG).catch(() => undefined);
    // Both numbers come from the SDK's own registry for this model, so they
    // cannot drift apart: the budget the message is given and the size the
    // planner is told to write for are the same figure. When the SDK could not
    // be read at all, both fall back to the harness's own 64000.
    const asked = specs[1]!.maxOutputTokens!;
    expect(asked).toBeGreaterThanOrEqual(64_000);
    expect(specs[1]!.systemPrompt).toContain(`AT MOST ${tasksPerMessage(asked)} tasks`);
  });
});

describe("what the operator is told about the output ceiling", () => {
  it("warns when the installed SDK has never heard of the planner's model", async () => {
    // The silent failure this exists for: the SDK hands an unlisted model 32k
    // however high the request, the message is cut off mid-JSON, and the retry
    // — with nothing to tell it otherwise — asks the planner to write less.
    const { controller, events } = harness([DOCS, dagJson()]);
    const config = RunConfig.parse({ planIntentCheck: false, models: { planner: "claude-opus-99-imaginary" } });

    await controller.startRun("do a thing", config).catch(() => undefined);

    const warning = events.find((e) => e.type === "agent.log" && (e as { text?: string }).text?.includes("output ceiling"));
    expect((warning as { text: string } | undefined)?.text).toMatch(/does not list claude-opus-99-imaginary/);
  });

  it("says nothing when the model is one the SDK knows", async () => {
    // Silence is the signal that the request was granted. A line printed every
    // run is a line nobody reads.
    const { controller, events } = harness([DOCS, dagJson()]);

    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);

    expect(events.some((e) => e.type === "agent.log" && (e as { text?: string }).text?.includes("output ceiling"))).toBe(false);
  });
});

describe("a planner session that dies before it answers", () => {
  /** How the CLI reports its own subprocess dying — the shape that killed run da8325bd. */
  const died = () => new Error("Claude Code process exited with code 1");

  it("costs the attempt, not the run", async () => {
    // The first phase-B message died; the retry is what the attempt loop is
    // for. Before this the throw went straight past three attempts, out of
    // `startRun`, and ended the run with `harness: fatal` — discarding an
    // intake and a PRD that had already been paid for.
    const { controller, store } = harness([DOCS, dagJson()], undefined, undefined, (call) => (call === 1 ? died() : undefined));

    // Planning is the subject; the run goes on to want a real git repo, which
    // this temp directory is not.
    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);

    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    expect(store.listTasks(runId).map((t) => t.id)).toEqual(["task-a"]);
  });

  it("costs the attempt in phase A too", async () => {
    // The pool answers by call number, so the dead first call still consumes
    // the first canned output: phase A's retry is the second DOCS.
    const { controller, store } = harness([DOCS, DOCS, dagJson()], undefined, undefined, (call) => (call === 0 ? died() : undefined));

    await controller.startRun("do a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);

    const runId = (store.db.prepare("SELECT id FROM runs").get() as { id: string }).id;
    expect(store.listTasks(runId)).toHaveLength(1);
  });

  it("says the session died, rather than blaming the plan it never wrote", async () => {
    // "the breakdown JSON could not be read" would send the next planner off to
    // write better JSON for a message that was never emitted.
    const { controller, events } = harness([DOCS, dagJson()], undefined, undefined, (call) => (call > 0 ? died() : undefined));

    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(/planner session died before it answered/);
    expect(events.filter((e) => e.type === "run.plan_attempt_failed")).toHaveLength(3);
  });

  it("does not retry the operator's budget cap, which was reached on purpose", async () => {
    // Three attempts against a cap the operator set would spend three times the
    // number they set. A budget stop is a decision, not a failure.
    const { controller } = harness([DOCS, dagJson()], undefined, undefined, (call) =>
      call === 1 ? new BudgetExceeded("run", 12, 10, "run1") : undefined
    );

    await expect(controller.startRun("do a thing", CONFIG)).rejects.toThrow(BudgetExceeded);
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
