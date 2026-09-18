import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@charrette/shared";
import type { CharretteEvent, IntakeQuestion } from "@charrette/shared";

/**
 * The `ask_user` half of intake.
 *
 * The tool the intake agent calls to put a question to the operator is defined
 * inside `runIntake` and handed to the SDK, so the only way to execute its
 * handler is to intercept the definition. `tool()` is stubbed to hand the
 * handler back, which is also what makes the question's validation and the
 * events either side of the answer testable at all.
 */
const { toolMock, createSdkMcpServerMock } = vi.hoisted(() => ({
  toolMock: vi.fn((name: string, description: string, schema: unknown, handler: unknown) => ({
    name,
    description,
    schema,
    handler,
  })),
  createSdkMcpServerMock: vi.fn((args: unknown) => ({ sdkServer: args })),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ tool: toolMock, createSdkMcpServer: createSdkMcpServerMock }));

import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { runIntake, type IntakeRequest } from "./intake.js";
import type { AgentPool, AgentResult, AgentSpec } from "./pool.js";

type AskArgs = {
  question: string;
  detail?: string;
  options?: { label: string; description?: string; recommended?: boolean }[];
};
type AskHandler = (args: AskArgs) => Promise<{ content: { type: string; text: string }[] }>;

const BRIEF = (over: Record<string, unknown> = {}) =>
  "```json\n" +
  JSON.stringify({ goal: "add rate limiting", context: "fastify app", decisions: [], outOfScope: [], openQuestions: [], ...over }) +
  "\n```";

let store: Store;
let bus: Bus;
let events: CharretteEvent[];

/** A pool whose session runs `body` while the intake tools are live. */
function poolThat(resultText: string, body?: (spec: AgentSpec) => Promise<void>): { pool: AgentPool; specs: AgentSpec[] } {
  const specs: AgentSpec[] = [];
  return {
    specs,
    pool: {
      async run(spec: AgentSpec): Promise<AgentResult> {
        specs.push(spec);
        await body?.(spec);
        return { sessionId: "intake-session", resultText, costUsd: 0, turns: 1, outcome: "done" };
      },
    } as unknown as AgentPool,
  };
}

function request(over: Partial<IntakeRequest> = {}): IntakeRequest {
  return {
    runId: "r1",
    seed: "add rate limiting",
    repoPath: "/repo",
    config: RunConfig.parse({}),
    ui: { async ask() { return ""; }, say() {} },
    budgetCheck: () => {},
    ...over,
  };
}

/** The handler `runIntake` registered for `ask_user` — by name, since it is not the only tool. */
const askHandler = (): AskHandler =>
  toolMock.mock.results
    .map((r) => r.value as { name: string; handler: AskHandler })
    .find((t) => t.name === "ask_user")!.handler;

beforeEach(() => {
  toolMock.mockClear();
  createSdkMcpServerMock.mockClear();
  store = new Store(":memory:");
  bus = new Bus(store);
  events = [];
  bus.subscribe(({ event }) => void events.push(event));
});

const typed = (type: string) => events.filter((e) => e.type === type);

describe("showing the operator that something is happening", () => {
  it("marks the wait, narrates the tool calls, and stops when it is their turn", async () => {
    const log: string[] = [];
    const ui = {
      ask: async () => "per API key",
      say: (t: string) => void log.push(`say:${t}`),
      working: (on: boolean) => void log.push(`working:${on}`),
      activity: (t: string) => void log.push(`activity:${t}`),
    };
    const { pool } = poolThat(BRIEF(), async (spec) => {
      bus.publish({ type: "agent.tool_use", runId: "r1", sessionId: spec.sessionId!, tool: "Read", summary: "package.json", ts: 1 });
      bus.publish({ type: "agent.log", runId: "r1", sessionId: spec.sessionId!, text: "Two ways to do this.", ts: 2 });
      await askHandler()({ question: "What is the limit keyed on?" });
    });

    await runIntake(pool, bus, request({ ui }));

    // The survey is a long silence with nothing on the screen otherwise, and
    // the answer going back to the agent starts another one.
    expect(log).toEqual([
      "working:true",
      "activity:Read package.json",
      "say:Two ways to do this.",
      "working:true",
      "working:false",
    ]);
  });

  it("ignores another session's traffic", async () => {
    const log: string[] = [];
    const ui = { ask: async () => "", say: () => undefined, activity: (t: string) => void log.push(t) };
    const { pool } = poolThat(BRIEF(), async () => {
      bus.publish({ type: "agent.tool_use", runId: "r1", sessionId: "some-worker", tool: "Bash", summary: "npm test", ts: 1 });
    });

    await runIntake(pool, bus, request({ ui }));

    expect(log).toEqual([]);
  });

  it("works just as well for a transport that has nowhere to show any of it", async () => {
    const { pool } = poolThat(BRIEF(), async (spec) => {
      bus.publish({ type: "agent.tool_use", runId: "r1", sessionId: spec.sessionId!, tool: "Read", summary: "x", ts: 1 });
    });

    await expect(runIntake(pool, bus, request())).resolves.toMatchObject({ goal: "add rate limiting" });
  });
});

describe("asking the operator a question", () => {
  it("puts the question, records the answer, and announces both", async () => {
    const asked: IntakeQuestion[] = [];
    const ui = {
      ask: async (q: IntakeQuestion) => {
        asked.push(q);
        return "per API key";
      },
      say: () => undefined,
    };
    let answer: string | undefined;
    const { pool } = poolThat(BRIEF(), async () => {
      const out = await askHandler()({
        question: "What is the limit keyed on?",
        detail: "The app has no auth middleware yet.",
        options: [
          { label: "per API key", description: "one bucket per client", recommended: true },
          { label: "per IP" },
        ],
      });
      answer = out.content[0]!.text;
    });

    await runIntake(pool, bus, request({ ui }));

    expect(asked[0]).toEqual({
      question: "What is the limit keyed on?",
      detail: "The app has no auth middleware yet.",
      options: [
        { label: "per API key", description: "one bucket per client", recommended: true },
        // The optional halves are filled in rather than left undefined, so the
        // transport never has to guess.
        { label: "per IP", description: "", recommended: false },
      ],
    });
    expect(answer).toBe("per API key");
    expect(typed("intake.question")[0]).toMatchObject({
      runId: "r1",
      question: "What is the limit keyed on?",
      options: ["per API key", "per IP"],
    });
    expect(typed("intake.answered")[0]).toMatchObject({ question: "What is the limit keyed on?", answer: "per API key" });
  });

  it("accepts an open question with no options and no detail", async () => {
    const ui = { ask: async () => "whatever the operator typed", say: () => undefined };
    const { pool } = poolThat(BRIEF(), async () => {
      await askHandler()({ question: "Anything else?" });
    });

    await runIntake(pool, bus, request({ ui }));

    expect(typed("intake.question")[0]).toMatchObject({ question: "Anything else?", options: [] });
  });

  it("truncates a very long answer on the event without truncating what the agent is told", async () => {
    const long = "x".repeat(900);
    let toolSaw: string | undefined;
    const { pool } = poolThat(BRIEF(), async () => {
      toolSaw = (await askHandler()({ question: "q" })).content[0]!.text;
    });

    await runIntake(pool, bus, request({ ui: { ask: async () => long, say: () => undefined } }));

    expect((typed("intake.answered")[0] as { answer: string }).answer).toHaveLength(500);
    // The agent gets the whole answer; only the event is bounded.
    expect(toolSaw).toHaveLength(900);
  });

  it("carries every answer into the brief when the agent's own JSON is unusable", async () => {
    const ui = { ask: async () => "per API key", say: () => undefined };
    const { pool } = poolThat("no json here at all", async () => {
      await askHandler()({ question: "What is the limit keyed on?" });
    });

    const brief = await runIntake(pool, bus, request({ ui }));

    // A degraded brief beats making the operator answer everything twice.
    expect(brief.goal).toBe("add rate limiting");
    expect(brief.decisions).toEqual([{ question: "What is the limit keyed on?", answer: "per API key", rationale: "" }]);
  });

  it("keeps the agent's brief when it is well-formed", async () => {
    const { pool } = poolThat(BRIEF({ goal: "add rate limiting per key", context: "fastify" }));

    const brief = await runIntake(pool, bus, request());

    expect(brief.goal).toBe("add rate limiting per key");
    expect(typed("intake.brief_ready")[0]).toMatchObject({ goal: "add rate limiting per key", decisions: 0 });
  });
});

describe("the agent's prose", () => {
  it("goes to the chat transport, not the generic event printer", async () => {
    const said: string[] = [];
    const ui = { ask: async () => "", say: (t: string) => void said.push(t) };
    const { pool } = poolThat(BRIEF(), async (spec) => {
      bus.publish({ type: "agent.log", runId: "r1", sessionId: spec.sessionId!, text: "Two ways to do this.", ts: Date.now() });
      bus.publish({ type: "agent.log", runId: "r1", sessionId: "some-other-session", text: "not mine", ts: Date.now() });
    });

    await runIntake(pool, bus, request({ ui }));

    expect(said).toEqual(["Two ways to do this."]);
  });

  it("stops listening once the conversation is over, even if it failed", async () => {
    const said: string[] = [];
    const ui = { ask: async () => "", say: (t: string) => void said.push(t) };
    const pool = {
      async run(spec: AgentSpec): Promise<AgentResult> {
        bus.publish({ type: "agent.log", runId: "r1", sessionId: spec.sessionId!, text: "before the crash", ts: Date.now() });
        throw new Error("the session died");
      },
    } as unknown as AgentPool;

    await expect(runIntake(pool, bus, request({ ui }))).rejects.toThrow("the session died");

    bus.publish({ type: "agent.log", runId: "r1", sessionId: "intake-session", text: "after", ts: Date.now() });
    expect(said).toEqual(["before the crash"]);
  });
});

describe("how the intake session is set up", () => {
  it("may read the repo and ask, and nothing else", async () => {
    const { pool, specs } = poolThat(BRIEF());

    await runIntake(pool, bus, request());

    const spec = specs[0]!;
    expect(spec.role).toBe("intake");
    expect(spec.cwd).toBe("/repo");
    expect(spec.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(spec.allowedTools).toEqual(["Read", "Glob", "Grep", "mcp__charrette_intake__ask_user"]);
    expect(spec.maxTurns).toBe(60);
    expect(spec.prompt).toContain("add rate limiting");
    expect(createSdkMcpServerMock).toHaveBeenCalledOnce();
  });
});

/**
 * The transcript has to be able to say who decided, because the answers in it
 * are what the planner, the specification and every task are then held to. A
 * brief that cannot distinguish "the operator said fakes only" from "a model
 * assumed fakes only" is a brief nobody can audit after the fact.
 */
describe("recording who answered", () => {
  it("attributes a bare string to the operator, as every answer before this was", async () => {
    const { pool } = poolThat(BRIEF(), async () => {
      await askHandler()({ question: "Keyed on what?" });
    });

    await runIntake(pool, bus, request({ ui: { async ask() { return "per API key"; }, say() {} } }));

    const answered = typed("intake.answered")[0] as { answer: string; decidedBy: string };
    expect(answered.answer).toBe("per API key");
    expect(answered.decidedBy).toBe("operator");
  });

  it("names the decider when one answered in the operator's place", async () => {
    const { pool } = poolThat(BRIEF(), async () => {
      await askHandler()({ question: "Real vendors or fakes?" });
    });
    const ui = {
      async ask() {
        return { answer: "Fakes only.", decidedBy: "product-manager" };
      },
      say() {},
    };

    await runIntake(pool, bus, request({ ui }));

    const answered = typed("intake.answered")[0] as { answer: string; decidedBy: string };
    expect(answered.answer).toBe("Fakes only.");
    expect(answered.decidedBy).toBe("product-manager");
  });

  it("hands the agent the words themselves, whichever form they arrived in", async () => {
    let handed = "";
    const { pool } = poolThat(BRIEF(), async () => {
      const out = await askHandler()({ question: "Which store?" });
      handed = out.content[0]!.text;
    });

    await runIntake(pool, bus, request({ ui: { async ask() { return { answer: "Postgres." }; }, say() {} } }));

    // The agent gets the answer, not the envelope it came in.
    expect(handed).toBe("Postgres.");
  });
});
