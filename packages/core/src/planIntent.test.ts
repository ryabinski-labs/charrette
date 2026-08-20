import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunConfig } from "@harness/shared";
import { describe, expect, it } from "vitest";
import { Bus } from "./bus.js";
import { GitHubAdapter } from "./github.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";
import { planIntentPrompt, planIntentSystemPrompt } from "./prompts.js";
import { RunController, type GateHandler } from "./runController.js";
import { Store, type TaskRow } from "./store.js";

const DOCS = "<prd>\n# PRD\n</prd>\n<conventions>\nc\n</conventions>";

/** 40da9337's two load-bearing tasks, verbatim from its plan. */
const REAL_DAG =
  "```json\n" +
  JSON.stringify({
    epics: [{ id: "epic-e", title: "E", summary: "s" }],
    tasks: [
      {
        id: "provider-layer",
        epicId: "epic-e",
        title: "Provider layer",
        spec: "Create `src/providers/index.ts` exposing providers resolved by `config.providerMode`.",
        acceptanceCriteria: ["All seven vendor categories have an interface and a deterministic mock"],
        dependsOn: [],
        touchedPaths: [],
        estimatedSize: "M",
      },
      {
        id: "ach-origination",
        epicId: "epic-e",
        title: "ACH origination",
        spec: "Implement `src/providers/ach/*`: `originateDebit`, `originateCredit`, `getTransferStatus`.",
        acceptanceCriteria: ["A debit without completed account validation is rejected 422 before any provider call"],
        dependsOn: [],
        touchedPaths: [],
        estimatedSize: "M",
      },
    ],
  }) +
  "\n```";

const GAPS = [
  "provider-layer's only criterion asks for a deterministic mock for all seven vendor categories, and no task requires a call to any vendor. The assignment says 'including all the integrations'; this plan delivers seven interfaces.",
  "ach-origination is named for originating debits but every criterion is about local validation state, so `originateDebit` can throw and the task still passes.",
];
const FAIL = "```json\n" + JSON.stringify({ verdict: "FAIL", summary: "the plan promises less than the brief", gaps: GAPS }) + "\n```";
const PASS = '```json\n{"verdict":"PASS","summary":"every clause has a task"}\n```';

/**
 * Runs to the plan gate and stops there; `validator` is what the plan-intent
 * check answers. Rejecting keeps the run inside the planning loop, which is
 * where the feedback under test goes.
 */
function harness(validator: string | (() => AgentResult), approve = false, dag = REAL_DAG) {
  const repo = mkdtempSync(path.join(tmpdir(), "harness-plan-intent-"));
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const summaries: string[] = [];
  const feedback: string[] = [];
  const specs: AgentSpec[] = [];
  let planning = 0;
  const pool = {
    async run(spec: AgentSpec): Promise<AgentResult> {
      specs.push(spec);
      const base = { sessionId: `s${specs.length}`, costUsd: 0, turns: 1, outcome: "done" as const };
      if (spec.role === "planner") return { ...base, resultText: planning++ === 0 ? DOCS : dag };
      if (typeof validator === "function") return validator();
      if (spec.prompt.includes("<plan>")) feedback.push("checked");
      return { ...base, resultText: validator };
    },
  } as unknown as AgentPool;
  const gates: GateHandler = {
    async resolvePlanGate(_prd, summary) {
      summaries.push(summary);
      return { approved: approve, feedback: "I want the vendors real." };
    },
    async resolveBudgetGate() {
      return null;
    },
  };
  const controller = new RunController(store, bus, pool, new GitHubAdapter(undefined, undefined), gates, repo);
  return { controller, store, summaries, specs };
}

/**
 * Run 40da9337 spent $773.55 and 37 hours building a plan that could not have
 * satisfied its assignment. The mismatch was legible in the plan text: "all the
 * integrations" against a criterion asking for "an interface and a deterministic
 * mock". The harness asked exactly this question — at INTEGRATING, of the merged
 * result, once everything was already paid for.
 */
describe("asking whether the plan could deliver the assignment", () => {
  it("puts the shortfall in front of the operator before they approve", async () => {
    const { controller, summaries } = harness(FAIL);
    await controller
      .startRun("fully implement this product, including all the integrations", RunConfig.parse({}))
      .catch(() => undefined);

    expect(summaries[0]).toContain("What this plan would not deliver");
    expect(summaries[0]).toContain("deterministic mock for all seven vendor categories");
    expect(summaries[0]).toContain("`originateDebit` can throw and the task still passes");
    // Why the list matters, so it does not read as style advice.
    expect(summaries[0]).toContain("criteria are the whole contract");
  }, 30_000);

  it("sends the shortfall back to the planner when the operator rejects", async () => {
    // The operator may reject for their own reason; the finding still has to
    // reach the planner, or the re-plan reproduces the same gap.
    const { controller, specs } = harness(FAIL);
    await controller.startRun("fully implement this, including all the integrations", RunConfig.parse({})).catch(() => undefined);

    const replan = specs.filter((s) => s.role === "planner").at(-1)!;
    expect(replan.prompt).toContain("I want the vendors real.");
    expect(replan.prompt).toContain("deterministic mock for all seven vendor categories");
  }, 30_000);

  it("says nothing when the plan covers the assignment", async () => {
    const { controller, summaries } = harness(PASS, true);
    await controller.startRun("build a thing", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).not.toContain("What this plan would not deliver");
  }, 30_000);

  it("records the verdict so a postmortem can ask whether it was heeded", async () => {
    const { controller, store } = harness(FAIL);
    await controller.startRun("build a thing", RunConfig.parse({})).catch(() => undefined);

    const row = store.db.prepare("SELECT payload FROM events WHERE type = 'run.plan_intent_verdict'").get() as { payload: string };
    expect(JSON.parse(row.payload).verdict).toBe("FAIL");
    expect(JSON.parse(row.payload).gaps).toHaveLength(2);
  }, 30_000);

  it("spends nothing when the operator has turned it off", async () => {
    const { controller, specs, summaries } = harness(FAIL, true);
    await controller.startRun("build a thing", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);

    expect(specs.some((s) => s.role === "validator")).toBe(false);
    expect(summaries[0]).not.toContain("What this plan would not deliver");
  }, 30_000);

  it("says the check did not happen rather than implying it passed", async () => {
    // An unparseable verdict must not read as silence-means-fine: the operator
    // would take an unchecked plan for a checked one.
    const { controller, summaries } = harness(() => {
      throw new Error("session died");
    }, true);
    await controller.startRun("build a thing", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).toContain("did not complete, so nothing has compared this plan to your assignment");
  }, 30_000);

  it("reads a FAIL carrying no gaps as nothing to show", async () => {
    const { controller, summaries } = harness('```json\n{"verdict":"FAIL","summary":"vague misgivings","gaps":[]}\n```', true);
    await controller.startRun("build a thing", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).not.toContain("What this plan would not deliver");
  }, 30_000);
});

/**
 * The deterministic half of the same gate: run bc691359's
 * tier1-three-arm-capture required a committed teardown.log showing
 * `terraform destroy` completing — a command `infraGuardHook` denies to every
 * session — and three workers each spent their attempts rediscovering that.
 * The criterion named the command on the day the plan was written.
 */
describe("flagging the criteria no worker will be allowed to satisfy", () => {
  const INFRA_DAG =
    "```json\n" +
    JSON.stringify({
      epics: [{ id: "epic-e", title: "E", summary: "s" }],
      tasks: [
        {
          id: "tier1-capture",
          epicId: "epic-e",
          title: "Capture the three arms",
          spec: "Run the benchmark and commit the bundles.",
          acceptanceCriteria: ["teardown.log is committed and shows `terraform destroy` completing with the instances destroyed."],
          dependsOn: [],
          touchedPaths: [],
          estimatedSize: "M",
        },
      ],
    }) +
    "\n```";

  it("flags the criterion even with the model check turned off, spending nothing", async () => {
    const { controller, specs, summaries } = harness(FAIL, true, INFRA_DAG);
    await controller.startRun("benchmark it", RunConfig.parse({ planIntentCheck: false })).catch(() => undefined);

    expect(specs.some((s) => s.role === "validator")).toBe(false);
    expect(summaries[0]).toContain("What this plan would not deliver");
    expect(summaries[0]).toContain("`terraform destroy`");
    expect(summaries[0]).toContain("every agent session is denied");
  }, 30_000);

  it("keeps the flag when the model check passes — the two halves answer different questions", async () => {
    const { controller, summaries } = harness(PASS, true, INFRA_DAG);
    await controller.startRun("benchmark it", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).toContain("`terraform destroy`");
  }, 30_000);

  it("counts plural offenders as plural", async () => {
    const dag = INFRA_DAG.replace(
      '"acceptanceCriteria":["teardown.log is committed and shows `terraform destroy` completing with the instances destroyed."]',
      '"acceptanceCriteria":["`terraform apply` completes.","`terraform destroy` completes."]'
    );
    const store = new Store(":memory:");
    const logs: string[] = [];
    const bus = new Bus(store);
    bus.subscribe(({ event }) => void (event.type === "agent.log" && logs.push((event as { text: string }).text)));
    const repo2 = mkdtempSync(path.join(tmpdir(), "harness-plan-intent-"));
    let planning = 0;
    const agents = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        const base = { sessionId: "s", costUsd: 0, turns: 1, outcome: "done" as const };
        if (spec.role === "planner") return { ...base, resultText: planning++ === 0 ? DOCS : dag };
        return { ...base, resultText: PASS };
      },
    } as unknown as AgentPool;
    const gates: GateHandler = {
      async resolvePlanGate() {
        return { approved: true, feedback: "" };
      },
      async resolveBudgetGate() {
        return null;
      },
    };
    const controller = new RunController(store, bus, agents, new GitHubAdapter(undefined, undefined), gates, repo2);
    await controller.startRun("benchmark it", RunConfig.parse({})).catch(() => undefined);

    expect(logs.some((t) => t.startsWith("2 acceptance criteria name a command the infrastructure guard denies"))).toBe(true);
  }, 30_000);

  it("keeps the flag when the model check dies — the finding never depended on it", async () => {
    const { controller, summaries } = harness(() => {
      throw new Error("session died");
    }, true, INFRA_DAG);
    await controller.startRun("benchmark it", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).toContain("`terraform destroy`");
    expect(summaries[0]).toContain("did not complete, so nothing has compared this plan to your assignment");
  }, 30_000);

  it("lists the denied command alongside the model's own gaps", async () => {
    const { controller, summaries } = harness(FAIL, true, INFRA_DAG);
    await controller.startRun("benchmark it", RunConfig.parse({})).catch(() => undefined);

    expect(summaries[0]).toContain("`terraform destroy`");
    expect(summaries[0]).toContain("deterministic mock for all seven vendor categories");
  }, 30_000);
});

describe("what the plan-intent agent is asked", () => {
  const row = (over: Partial<TaskRow>): TaskRow =>
    ({ id: "t", title: "T", spec: "s", acceptanceCriteria: ["c"], ...over }) as TaskRow;

  it("is given the assignment, the PRD and every task's contract", () => {
    const text = planIntentPrompt("build all the integrations", "# PRD\nsome prose", [
      row({ id: "plaid-integration", title: "Plaid", acceptanceCriteria: ["The suite makes no outbound HTTP call"] }),
    ]);

    expect(text).toContain("<assignment>\nbuild all the integrations");
    expect(text).toContain("some prose");
    expect(text).toContain("### plaid-integration — Plaid");
    expect(text).toContain("- The suite makes no outbound HTTP call");
  });

  it("truncates a PRD long enough to cost more than the check saves", () => {
    expect(planIntentPrompt("a", "x".repeat(30_000), [row({})])).not.toContain("x".repeat(20_001));
  });

  it("is told this is entailment, not a code review", () => {
    const prompt = planIntentSystemPrompt();

    expect(prompt).toContain("would the operator have what they asked for?");
    expect(prompt).toContain("acceptance criteria are the contract");
    expect(prompt).toContain("Criteria that a hollow implementation satisfies");
    expect(prompt).toContain("The run-time nobody planned");
    // And told what not to say, because a gate that lists everything is unread.
    expect(prompt).toContain("Do NOT report");
    expect(prompt).toContain("their attention is the scarcest thing here");
  });
});
