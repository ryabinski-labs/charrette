import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";

const { queryMock, reapUnderMock } = vi.hoisted(() => ({ queryMock: vi.fn(), reapUnderMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("./reaper.js", () => ({ reapUnder: reapUnderMock }));

import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { harnessBuild } from "./build.js";
import { AgentPool, PromptStream, type AgentSpec } from "./pool.js";

/**
 * Drives `AgentPool.run` against a scripted SDK.
 *
 * Everything below the query() call is real — the store is a real SQLite
 * database and the bus is the real one — because what is being tested is the
 * bookkeeping: which ledger rows get written, what the sessions table says
 * afterwards, and what the run is told happened. Mocking those would test the
 * mocks.
 */

type Message = Record<string, unknown>;

const assistant = (opts: { text?: string; tool?: string; usage?: Record<string, number>; content?: unknown; stop?: string } = {}): Message => ({
  type: "assistant",
  session_id: "sdk-session-1",
  message: {
    ...(opts.usage ? { usage: opts.usage } : {}),
    ...(opts.stop ? { stop_reason: opts.stop } : {}),
    content:
      opts.content !== undefined
        ? opts.content
        : [
            ...(opts.text ? [{ type: "text", text: opts.text }] : []),
            ...(opts.tool ? [{ type: "tool_use", name: opts.tool, input: { command: "ls" } }] : []),
          ],
  },
});

const result = (opts: Partial<{ subtype: string; errors: string[]; result: string; total_cost_usd: number; usage: Record<string, number> }> = {}): Message => ({
  type: "result",
  session_id: "sdk-session-1",
  subtype: opts.subtype ?? "success",
  ...(opts.errors ? { errors: opts.errors } : {}),
  result: opts.result ?? "the answer",
  ...(opts.total_cost_usd === undefined ? {} : { total_cost_usd: opts.total_cost_usd }),
  usage: opts.usage ?? { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
});

/** The SDK yields these messages, then ends the session cleanly. */
function scriptedSdk(messages: Message[]): void {
  queryMock.mockImplementation(() => (async function* () {
    for (const m of messages) yield m;
  })());
}

let store: Store;
let bus: Bus;
let pool: AgentPool;
let events: HarnessEvent[];

const SPEC: AgentSpec = {
  runId: "run1",
  taskId: "task1",
  role: "worker",
  model: "claude-opus-5",
  systemPrompt: "you are a worker",
  prompt: "build the thing",
  cwd: "/tmp/worktree",
};

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ ...SPEC, ...over });

/** The options object the pool handed the SDK. */
const optionsGiven = () => (queryMock.mock.calls.at(-1)![0] as { options: Record<string, unknown> }).options;

const sessionRow = (id: string) =>
  store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;

const ledgerFor = (id: string) =>
  store.db.prepare("SELECT * FROM ledger WHERE sessionId = ?").all(id) as Record<string, number>[];

beforeEach(() => {
  queryMock.mockReset();
  reapUnderMock.mockReset().mockResolvedValue([]);
  store = new Store(":memory:");
  store.createRun({
    id: "run1",
    repoPath: "/tmp/repo",
    assignment: "build a thing",
    state: "CREATED",
    prdPath: null,
    planHash: null,
    integrationBranch: "harness/run1/main",
    config: RunConfig.parse({}),
  });
  bus = new Bus(store);
  events = [];
  bus.subscribe(({ event }) => void events.push(event));
  pool = new AgentPool(store, bus);
});

afterEach(() => {
  vi.useRealTimers();
});

const typed = <T extends HarnessEvent["type"]>(type: T) => events.filter((e) => e.type === type);

describe("running an agent session", () => {
  it("returns the result, books the bill, and closes the session row", async () => {
    scriptedSdk([assistant({ text: "looking at the repo" }), result({ result: "done and dusted", total_cost_usd: 0.42 })]);

    const res = await pool.run(spec());

    expect(res).toMatchObject({
      sdkSessionId: "sdk-session-1",
      resultText: "done and dusted",
      costUsd: 0.42,
      turns: 1,
      outcome: "done",
    });
    expect(res.errorDetail).toBeUndefined();

    const row = sessionRow(res.sessionId)!;
    expect(row.state).toBe("done");
    expect(row.turns).toBe(1);
    expect(row.endedAt).toBeTypeOf("number");
    // The ledger is what pays, so the session row settles from it.
    expect(row.costUsd).toBeCloseTo(0.42, 5);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
    expect(row.cacheReadTokens).toBe(10);
    expect(row.cacheWriteTokens).toBe(5);
    // Which harness spawned it. A run outlives the process that started it, so
    // this is the only record of which fixes this session could have had.
    expect(row.build).toBe(harnessBuild());
    expect(row.build).not.toBe("");
  });

  it("announces the session, its output, its tool calls and its end", async () => {
    scriptedSdk([assistant({ text: "thinking out loud", tool: "Bash" }), result()]);

    const res = await pool.run(spec());

    expect(typed("agent.spawned")[0]).toMatchObject({ runId: "run1", taskId: "task1", role: "worker", model: "claude-opus-5" });
    expect(typed("agent.log")[0]).toMatchObject({ sessionId: res.sessionId, text: "thinking out loud" });
    expect(typed("agent.tool_use")[0]).toMatchObject({ tool: "Bash", summary: '{"command":"ls"}' });
    expect(typed("agent.usage")[0]).toMatchObject({ model: "claude-opus-5", inputTokens: 100 });
    expect(typed("agent.ended")[0]).toMatchObject({ outcome: "done" });
  });

  it("truncates a very long message and a very large tool input", async () => {
    scriptedSdk([
      assistant({ content: [{ type: "text", text: "x".repeat(5000) }, { type: "tool_use", name: "Write", input: { body: "y".repeat(5000) } }] }),
      result(),
    ]);

    await pool.run(spec());

    expect((typed("agent.log")[0] as { text: string }).text).toHaveLength(2000);
    expect((typed("agent.tool_use")[0] as { summary: string }).summary).toHaveLength(300);
  });

  it("names an unnamed tool rather than failing on it", async () => {
    scriptedSdk([assistant({ content: [{ type: "tool_use" }] }), result()]);

    await pool.run(spec());

    expect(typed("agent.tool_use")[0]).toMatchObject({ tool: "?", summary: "{}" });
  });

  it("counts a usage report that is missing its fields as zero, not NaN", async () => {
    scriptedSdk([assistant({ usage: {} }), result({ usage: {} })]);

    const res = await pool.run(spec());

    const row = sessionRow(res.sessionId)!;
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
    expect(row.cacheReadTokens).toBe(0);
    expect(row.cacheWriteTokens).toBe(0);
  });

  it("ignores content that is not a block list, and an assistant message with no usage", async () => {
    scriptedSdk([assistant({ content: "just a string" }), result()]);

    const res = await pool.run(spec());

    expect(res.turns).toBe(1);
    expect(typed("agent.log")).toHaveLength(0);
  });

  it("ignores a block type it has no event for", async () => {
    scriptedSdk([assistant({ content: [{ type: "thinking", thinking: "hmm" }] }), result()]);

    await pool.run(spec());

    expect(typed("agent.log")).toHaveLength(0);
    expect(typed("agent.tool_use")).toHaveLength(0);
  });

  it("prices the turn itself when the SDK reports no cost", async () => {
    scriptedSdk([assistant(), result({ total_cost_usd: undefined })]);

    const res = await pool.run(spec());

    // Derived from the model's rates rather than left at zero.
    expect(res.costUsd).toBeGreaterThan(0);
    expect(ledgerFor(res.sessionId)).toHaveLength(1);
  });

  it("books only the increment when a second result arrives, so a session is not double-billed", async () => {
    // `total_cost_usd` is session-cumulative while `usage` is per-turn, which is
    // what a session carrying injected operator feedback looks like.
    scriptedSdk([assistant(), result({ total_cost_usd: 0.5 }), assistant(), result({ total_cost_usd: 0.9 })]);

    const res = await pool.run(spec());

    expect(res.costUsd).toBeCloseTo(0.9, 5);
    const rows = ledgerFor(res.sessionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.costUsd).toBeCloseTo(0.5, 5);
    expect(rows[1]!.costUsd).toBeCloseTo(0.4, 5);
  });

  it("never books a negative increment when the reported total goes backwards", async () => {
    scriptedSdk([assistant(), result({ total_cost_usd: 0.9 }), assistant(), result({ total_cost_usd: 0.4 })]);

    const res = await pool.run(spec());

    expect(ledgerFor(res.sessionId)[1]!.costUsd).toBe(0);
    expect(res.costUsd).toBeCloseTo(0.4, 5);
  });

  it("carries a pre-allocated session id rather than inventing one", async () => {
    scriptedSdk([result()]);

    const res = await pool.run(spec({ sessionId: "chosen-by-the-caller" }));

    expect(res.sessionId).toBe("chosen-by-the-caller");
    expect(sessionRow("chosen-by-the-caller")).toBeDefined();
  });

  it("records a run-level agent with no task against the run alone", async () => {
    scriptedSdk([result()]);

    const res = await pool.run(spec({ taskId: undefined, role: "planner" }));

    expect(sessionRow(res.sessionId)!.taskId).toBeNull();
    expect(typed("agent.spawned")[0]).toMatchObject({ role: "planner", taskId: undefined });
  });
});

describe("what the session is configured with", () => {
  beforeEach(() => scriptedSdk([result()]));

  it("runs read-only roles with the tools they were given and nothing else", async () => {
    await pool.run(spec({ tools: [], allowedTools: ["Read"], disallowedTools: ["Write"], maxTurns: 40, resume: "prior-sdk-session" }));

    const options = optionsGiven();
    expect(options).toMatchObject({
      model: "claude-opus-5",
      cwd: "/tmp/worktree",
      systemPrompt: "you are a worker",
      maxTurns: 40,
      permissionMode: "bypassPermissions",
      tools: [],
      allowedTools: ["Read"],
      disallowedTools: ["Write"],
      resume: "prior-sdk-session",
      // The operator's own filesystem settings and skills must not leak in.
      settingSources: [],
    });
  });

  it("raises the Bash timeout floor for every session", async () => {
    await pool.run(spec());

    const env = optionsGiven().env as Record<string, string>;
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(30 * 60 * 1000));
    expect(env.BASH_MAX_TIMEOUT_MS).toBe(String(30 * 60 * 1000));
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
  });

  it("raises the per-message output ceiling when asked", async () => {
    await pool.run(spec({ maxOutputTokens: 64_000 }));

    expect((optionsGiven().env as Record<string, string>).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("64000");
  });

  it("layers the caller's environment over the inherited one, under the harness's own", async () => {
    await pool.run(spec({ env: { COMPOSE_PROJECT_NAME: "harness-task1", BASH_DEFAULT_TIMEOUT_MS: "1000" } }));

    const env = optionsGiven().env as Record<string, string>;
    expect(env.COMPOSE_PROJECT_NAME).toBe("harness-task1");
    expect(env.PATH).toBe(process.env.PATH);
    // A spec must not be able to hand an agent back the two-minute timeout.
    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe(String(30 * 60 * 1000));
  });

  it("registers the Bash guard hooks on every session", async () => {
    await pool.run(spec());

    const hooks = optionsGiven().hooks as { PreToolUse: { matcher: string }[] };
    expect(hooks.PreToolUse[0]!.matcher).toBe("Bash");
  });
});

describe("a session that ends abnormally", () => {
  it("says which wall it hit, and names the turn ceiling in words", async () => {
    scriptedSdk([assistant(), result({ subtype: "error_max_turns" })]);

    const res = await pool.run(spec({ maxTurns: 90 }));

    expect(res.outcome).toBe("error");
    expect(res.errorDetail).toBe("error_max_turns (hit the turn ceiling of 90)");
    expect(sessionRow(res.sessionId)!.state).toBe("error");
    expect(typed("agent.ended")[0]).toMatchObject({ outcome: "error" });
  });

  it("appends whatever errors came with the subtype", async () => {
    scriptedSdk([result({ subtype: "error_during_execution", errors: ["tool crashed", "and again"] })]);

    const res = await pool.run(spec());

    expect(res.errorDetail).toBe("error_during_execution: tool crashed; and again");
  });

  it("still returns whatever the session managed to say", async () => {
    scriptedSdk([result({ subtype: "error_max_turns", result: "a partial answer" })]);

    const res = await pool.run(spec());

    expect(res.resultText).toBe("a partial answer");
  });

  it("treats a result with no text as an empty answer", async () => {
    queryMock.mockImplementation(() => (async function* () {
      yield { type: "result", subtype: "success", usage: {} } as Message;
    })());

    const res = await pool.run(spec());

    expect(res.resultText).toBe("");
    expect(ledgerFor(res.sessionId)[0]!.inputTokens).toBe(0);
  });
});

describe("a session that dies before it reports", () => {
  it("books the turns it took, records why, and rethrows with the subprocess's own words", async () => {
    queryMock.mockImplementation((args: { options: { stderr: (d: string) => void } }) => (async function* () {
      yield assistant({ usage: { input_tokens: 1000, output_tokens: 200 } });
      args.options.stderr("Error: ENOSPC no space left on device");
      throw new Error("Claude Code process exited with code 1");
    })());

    await expect(pool.run(spec())).rejects.toThrow(/exited with code 1[\s\S]*ENOSPC/);

    const [row] = store.db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
    expect(row!.state).toBe("interrupted");
    // The turns since the last result are still real money; booking nothing for
    // them is what hid a quarter of a run's spend from the budget gate.
    expect(row!.turns).toBe(1);
    expect(Number(row!.costUsd)).toBeGreaterThan(0);
    expect(typed("agent.usage")).toHaveLength(1);
    expect(typed("agent.ended")[0]).toMatchObject({ outcome: "error" });
  });

  it("reports the failure alone when the subprocess said nothing on stderr", async () => {
    queryMock.mockImplementation(() => (async function* () {
      throw new Error("socket hang up");
      // eslint-disable-next-line no-unreachable
      yield result();
    })());

    await expect(pool.run(spec())).rejects.toThrow("Error: socket hang up");
    expect(typed("agent.usage")).toHaveLength(0);
  });

  it("keeps the original error as the cause", async () => {
    const original = new Error("the real one");
    queryMock.mockImplementation(() => (async function* () {
      throw original;
      // eslint-disable-next-line no-unreachable
      yield result();
    })());

    await expect(pool.run(spec())).rejects.toMatchObject({ cause: original });
  });

  it("keeps the answer when the session dies after giving it, and books it once", async () => {
    // SDK 0.3 delivers the result and then throws restating it, so a session
    // that hit its turn ceiling raises where it used to return. Propagating
    // that costs the caller a partial answer it can still use — for intake,
    // the whole conversation, since `parseBrief`'s fallback never runs.
    queryMock.mockImplementation(() => (async function* () {
      yield assistant();
      yield result({ subtype: "error_max_turns", errors: ["Reached maximum number of turns (1)"], result: "half an answer", total_cost_usd: 0.3 });
      throw new Error("Claude Code returned an error result: Reached maximum number of turns (1)");
    })());

    const res = await pool.run(spec());

    expect(res.resultText).toBe("half an answer");
    expect(res.outcome).toBe("error");
    expect(res.errorDetail).toContain("error_max_turns");
    // One ledger row: the result's. Nothing was pending when it died.
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM ledger").get()).toEqual({ n: 1 });
    expect(sessionRow(res.sessionId)).toMatchObject({ state: "error" });
    expect(typed("agent.log").map((e) => (e as { text: string }).text).join("\n")).toContain("had already answered");
  });

  it("still reports a session that died before it answered", async () => {
    // The distinction that makes the rule safe: nothing was delivered, so
    // there is nothing to keep and the caller has to hear about it.
    queryMock.mockImplementation(() => (async function* () {
      yield assistant();
      throw new Error("died before reporting");
    })());

    await expect(pool.run(spec())).rejects.toThrow("died before reporting");
    expect(sessionRow((store.db.prepare("SELECT id FROM sessions").get() as { id: string }).id)).toMatchObject({ state: "interrupted" });
  });
});

describe("the budget gate", () => {
  it("aborts the session, books what it spent, and marks it killed", async () => {
    const budgetCheck = vi.fn(() => {
      if (budgetCheck.mock.calls.length > 1) throw new Error("BudgetExceeded: run cap reached");
    });
    queryMock.mockImplementation(() => (async function* () {
      yield assistant({ usage: { input_tokens: 500, output_tokens: 100 } });
      yield assistant({ usage: { input_tokens: 500, output_tokens: 100 } });
      yield result();
    })());

    await expect(pool.run(spec({ budgetCheck }))).rejects.toThrow("BudgetExceeded");

    const [row] = store.db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
    expect(row!.state).toBe("killed");
    expect(typed("agent.ended")[0]).toMatchObject({ outcome: "killed" });
    expect(Number(row!.costUsd)).toBeGreaterThan(0);
  });

  it("lets an unblocked session through untouched", async () => {
    scriptedSdk([assistant(), result()]);

    const res = await pool.run(spec({ budgetCheck: async () => undefined }));

    expect(res.outcome).toBe("done");
  });
});

describe("the wrap-up message", () => {
  it("asks for the answer before the turn ceiling takes it away", async () => {
    // Cap 5 → wrap up at turn 4.
    const seen: string[] = [];
    queryMock.mockImplementation((args: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      // Drain the initial prompt, then run four turns.
      void (async () => {
        for await (const m of args.prompt) seen.push(m.message.content);
      })();
      for (let i = 0; i < 4; i++) yield assistant();
      // Let the queued wrap-up message reach the stream before finishing.
      await new Promise((r) => setImmediate(r));
      yield result();
    })());

    await pool.run(spec({ maxTurns: 5 }));

    expect(seen[0]).toBe("build the thing");
    expect(seen[1]).toMatch(/\[HARNESS\] You are near this session's turn limit/);
    expect(typed("agent.log").at(-1)).toMatchObject({ text: "approaching the turn limit (4/5) — asked for a final answer now" });
  });

  it("never reaches a session that finishes early", async () => {
    scriptedSdk([assistant(), result()]);

    await pool.run(spec({ maxTurns: 100 }));

    expect(typed("agent.log").filter((e) => (e as { text: string }).text.includes("turn limit"))).toHaveLength(0);
  });

  it("still leaves room to answer when the cap is tiny", async () => {
    // floor(1 * 0.8) is 0, which would fire before the first turn; the floor of
    // 1 is what keeps the message meaningful.
    queryMock.mockImplementation(() => (async function* () {
      yield assistant();
      await new Promise((r) => setImmediate(r));
      yield result();
    })());

    await pool.run(spec({ maxTurns: 1 }));

    expect(typed("agent.log").at(-1)).toMatchObject({ text: "approaching the turn limit (1/1) — asked for a final answer now" });
  });
});

describe("a turn cut off at the output ceiling", () => {
  /**
   * Run a session whose `turn`th message comes back at the ceiling, letting
   * anything queued reach the stream before the result settles it.
   */
  function truncatedAt(turn: number, sent: string[], before?: () => void): void {
    queryMock.mockImplementation((args: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      void (async () => {
        for await (const m of args.prompt) sent.push(m.message.content);
      })();
      for (let i = 1; i <= turn; i++) {
        if (i === turn) before?.();
        yield assistant(i === turn ? { text: "half a plan", stop: "max_tokens" } : {});
      }
      await new Promise((r) => setImmediate(r));
      yield result({ result: "half a plan" });
    })());
  }

  it("does not send the wrap-up message after it, which the API refuses to accept", async () => {
    // The production failure, exactly: a 4-turn cap wraps up at turn 3, and turn
    // 3 was the one that hit the ceiling. Appending anything to a turn that
    // stopped at `max_tokens` is a 400 — the thinking blocks of the latest
    // assistant message have to come back as they were, and a truncated turn's
    // cannot be — which exits the CLI and took a whole planning phase with it.
    const sent: string[] = [];
    truncatedAt(3, sent);

    await pool.run(spec({ maxTurns: 4 }));

    expect(sent).toEqual(["build the thing"]);
    expect(typed("agent.log").map((e) => (e as { text: string }).text).join("\n")).not.toContain("[HARNESS]");
  });

  it("still sends the wrap-up when the turn ended normally", async () => {
    // The guard must not cost the feature it sits inside: a session that is
    // merely near its ceiling is exactly who the wrap-up message is for.
    const sent: string[] = [];
    queryMock.mockImplementation((args: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      void (async () => {
        for await (const m of args.prompt) sent.push(m.message.content);
      })();
      for (let i = 0; i < 3; i++) yield assistant({ stop: "end_turn" });
      await new Promise((r) => setImmediate(r));
      yield result();
    })());

    await pool.run(spec({ maxTurns: 4 }));

    expect(sent[1]).toMatch(/\[HARNESS\] You are near this session's turn limit/);
  });

  it("reports the truncation, so a caller can tell it from a badly written answer", async () => {
    // Downstream the two are identical — both end in text that will not parse —
    // and they need opposite retries: one asks for better JSON, the other for a
    // shorter message. `outputTruncated` in runController reads this string.
    const res = await runTruncated();

    expect(res.outcome).toBe("error");
    expect(res.errorDetail).toContain("max_tokens");
    expect(res.resultText).toBe("half a plan");
  });

  it("keeps the SDK's own verdict when it had one", async () => {
    // A session that hit the turn ceiling *and* truncated is reported as the
    // turn ceiling, which is the wall the operator can actually raise.
    const sent: string[] = [];
    queryMock.mockImplementation(() => (async function* () {
      yield assistant({ text: "half", stop: "max_tokens" });
      await new Promise((r) => setImmediate(r));
      yield result({ subtype: "error_max_turns" });
    })());
    void sent;

    const res = await pool.run(spec({ maxTurns: 1 }));

    expect(res.errorDetail).toContain("error_max_turns");
  });

  it("does not call an errored session successful just because the subtype says so", async () => {
    // The shape SDK 0.3.222 actually returns when a message runs past the
    // ceiling, copied from a live probe: subtype "success", `is_error` set, and
    // the API's complaint sitting where the agent's answer should be. Read as a
    // clean result it becomes a planner attempt graded on the error text.
    scriptedSdk([
      assistant({ text: "half a plan" }),
      {
        type: "result",
        session_id: "sdk-session-1",
        subtype: "success",
        is_error: true,
        result: "API Error: Claude's response exceeded the 1024 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable",
        usage: { input_tokens: 2, output_tokens: 4096 },
      },
    ]);

    const res = await pool.run(spec());

    expect(res.outcome).toBe("error");
    expect(res.errorDetail).toContain("output token maximum");
  });

  it("refuses operator feedback afterwards, so it queues for the next session instead", async () => {
    // `inject` returning null is what makes the controller persist the feedback
    // rather than report it delivered to a session that can never read it.
    let injected: unknown = "not tried";
    const sent: string[] = [];
    queryMock.mockImplementation((args: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      void (async () => {
        for await (const m of args.prompt) sent.push(m.message.content);
      })();
      yield assistant({ text: "half a plan", stop: "max_tokens" });
      injected = pool.inject("run1", "task1", "also check the migrations");
      await new Promise((r) => setImmediate(r));
      yield result();
    })());

    await pool.run(spec());

    expect(injected).toBeNull();
    expect(sent).toEqual(["build the thing"]);
  });

  it("says what it could not deliver, rather than dropping it silently", async () => {
    // Feedback written a moment before the ceiling landed is feedback the
    // operator believes arrived. Whether it can still be recalled depends on
    // whether the transport had already picked it up — here it had not — but
    // when it can be, saying so beats a message that quietly went nowhere.
    queryMock.mockImplementation(() => (async function* () {
      pool.inject("run1", "task1", "also check the migrations");
      yield assistant({ text: "half a plan", stop: "max_tokens" });
      await new Promise((r) => setImmediate(r));
      yield result();
    })());

    await pool.run(spec());

    const logs = typed("agent.log").map((e) => (e as { text: string }).text);
    expect(logs.some((t) => t.includes("undelivered") && t.includes("also check the migrations"))).toBe(true);
    expect(logs.some((t) => t.includes("output ceiling") && t.includes("nothing more can be said"))).toBe(true);
  });

  async function runTruncated() {
    const sent: string[] = [];
    truncatedAt(1, sent);
    return pool.run(spec({ maxOutputTokens: 64_000 }));
  }
});

describe("the stall watchdog", () => {
  it("aborts a session that has gone silent, and says how long for", async () => {
    vi.useFakeTimers();
    queryMock.mockImplementation((args: { options: { abortController: AbortController } }) => (async function* () {
      yield assistant();
      await new Promise((_resolve, reject) => {
        args.options.abortController.signal.addEventListener("abort", () => reject(new Error("AbortError")));
      });
      yield result();
    })());

    const running = pool.run(spec());
    const assertion = expect(running).rejects.toThrow(/no output for 36 minutes, aborted as hung/);
    // The watchdog only looks every 30s, so the first look *past* the
    // 35-minute threshold (BASH_TIMEOUT_MS + the grace) is at 35m30s.
    await vi.advanceTimersByTimeAsync(36 * 60 * 1000);
    await assertion;

    const [row] = store.db.prepare("SELECT * FROM sessions").all() as Record<string, unknown>[];
    expect(row!.state).toBe("interrupted");
  });

  it("leaves a session that is still talking alone", async () => {
    vi.useFakeTimers();
    queryMock.mockImplementation(() => (async function* () {
      yield assistant();
      // A long tool call, but inside the Bash timeout the watchdog is derived from.
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      yield result();
    })());

    const res = await pool.run(spec());

    expect(res.outcome).toBe("done");
  });
});

describe("sweeping the worktree when a session ends", () => {
  it("kills what the session left running and says what it killed", async () => {
    scriptedSdk([result()]);
    reapUnderMock.mockResolvedValue([
      { pid: 4123, command: "node /very/long/path/to/vitest --watch", signal: "SIGKILL" },
      { pid: 4124, command: "docker compose up", signal: "SIGTERM" },
    ]);

    const res = await pool.run(spec({ reapOnEnd: true }));

    expect(reapUnderMock).toHaveBeenCalledWith("/tmp/worktree");
    expect(typed("agent.log").at(-1)).toMatchObject({
      sessionId: res.sessionId,
      text: "killed 2 processes left running in this worktree: 4123 node /very/long/path/to/vitest --watch (SIGKILL); 4124 docker compose up (SIGTERM)",
    });
  });

  it("uses the singular for one process", async () => {
    scriptedSdk([result()]);
    reapUnderMock.mockResolvedValue([{ pid: 1, command: "sleep 99", signal: "SIGKILL" }]);

    await pool.run(spec({ reapOnEnd: true }));

    expect((typed("agent.log").at(-1) as { text: string }).text).toContain("killed 1 process left running");
  });

  it("says nothing when there was nothing to kill", async () => {
    scriptedSdk([result()]);

    await pool.run(spec({ reapOnEnd: true }));

    expect(typed("agent.log")).toHaveLength(0);
  });

  it("never sweeps a directory it was not told to", async () => {
    scriptedSdk([result()]);

    await pool.run(spec());

    // The repo itself is the operator's working directory, not the harness's.
    expect(reapUnderMock).not.toHaveBeenCalled();
  });

  it("does not fail a finished session because the sweep failed", async () => {
    scriptedSdk([result()]);
    reapUnderMock.mockRejectedValue(new Error("ps: command not found"));

    await expect(pool.run(spec({ reapOnEnd: true }))).resolves.toMatchObject({ outcome: "done" });
  });

  it("still sweeps after a session that crashed", async () => {
    queryMock.mockImplementation(() => (async function* () {
      throw new Error("boom");
      // eslint-disable-next-line no-unreachable
      yield result();
    })());
    reapUnderMock.mockResolvedValue([{ pid: 9, command: "npm test", signal: "SIGKILL" }]);

    await expect(pool.run(spec({ reapOnEnd: true }))).rejects.toThrow("boom");

    expect(reapUnderMock).toHaveBeenCalledWith("/tmp/worktree");
  });
});

describe("speaking to a live session", () => {
  /** Holds a session open until `release` is called, so it can be spoken to. */
  function heldSession(): { release: () => void; done: Promise<unknown>; seen: string[] } {
    const seen: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    queryMock.mockImplementation((args: { prompt: AsyncGenerator<{ message: { content: string } }> }) => (async function* () {
      void (async () => {
        for await (const m of args.prompt) seen.push(m.message.content);
      })();
      yield assistant();
      await held;
      yield result();
    })());
    return { release, done: Promise.resolve(), seen };
  }

  it("delivers operator feedback into the running session", async () => {
    const { release, seen } = heldSession();
    const running = pool.run(spec());
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    const reached = pool.inject("run1", "task1", "the table is never created");

    expect(reached).toMatchObject({ role: "worker" });
    await vi.waitFor(() => expect(seen[1]).toBe("the table is never created"));
    release();
    await running;
  });

  it("reports nothing listening when no session is working that target", async () => {
    expect(pool.inject("run1", "task-nobody-is-on", "hello")).toBeNull();
  });

  it("addresses a run-level agent by its role", async () => {
    const { release, seen } = heldSession();
    const running = pool.run(spec({ taskId: undefined, role: "planner" }));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(pool.inject("run1", "@planner", "split that task")).toMatchObject({ role: "planner" });

    release();
    await running;
  });

  it("leaves the advisor unaddressable — feedback would race its own output", async () => {
    const { release } = heldSession();
    const running = pool.run(spec({ taskId: undefined, role: "advisor" }));

    expect(pool.inject("run1", "@advisor", "hello")).toBeNull();

    release();
    await running;
  });

  it("stops listening once the session is over", async () => {
    scriptedSdk([result()]);

    await pool.run(spec());

    expect(pool.inject("run1", "task1", "too late")).toBeNull();
  });

});

describe("the prompt stream", () => {
  it("yields the opening prompt, then whatever is pushed, then ends when closed", async () => {
    const stream = new PromptStream("the assignment");
    const seen: string[] = [];

    const draining = (async () => {
      for await (const m of stream.stream()) seen.push(m.message.content as string);
    })();
    await vi.waitFor(() => expect(seen).toEqual(["the assignment"]));

    stream.push("and one more thing");
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    stream.close();
    await draining;

    expect(seen).toEqual(["the assignment", "and one more thing"]);
  });

  /**
   * The registry entry outlives the stream for the moment between a result
   * settling it and the `finally` that removes the entry. Feedback arriving in
   * that window is reported as unreached — so the caller queues it for the
   * task's next session — rather than disappearing into a closed stream.
   */
  it("refuses a message once it has closed", () => {
    const stream = new PromptStream("first");
    expect(stream.push("while open")).toBe(true);

    stream.close();

    expect(stream.push("after close")).toBe(false);
  });

  it("closes on a result that finds nothing waiting", async () => {
    const stream = new PromptStream("first");
    const seen: string[] = [];
    const draining = (async () => {
      for await (const m of stream.stream()) seen.push(m.message.content as string);
    })();
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    stream.settle();

    await draining;
    expect(stream.push("too late")).toBe(false);
  });

  it("stays open for a result that arrives with a message still undelivered", async () => {
    const stream = new PromptStream("first");
    stream.push("queued before the result");

    stream.settle();

    expect(stream.push("still accepted")).toBe(true);
  });
});
