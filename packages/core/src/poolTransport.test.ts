import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunConfig } from "@harness/shared";
import type { HarnessEvent } from "@harness/shared";

const { queryMock, reapUnderMock } = vi.hoisted(() => ({ queryMock: vi.fn(), reapUnderMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("./reaper.js", () => ({ reapUnder: reapUnderMock }));

import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { AgentPool, PromptStream, type AgentSpec } from "./pool.js";

/**
 * `AgentPool.run` against a non-Anthropic provider, with nothing stubbed below
 * the HTTP call.
 *
 * The store is a real database and the ledger is the real ledger, because the
 * claim being tested is that moving a role to another vendor changes *what
 * answers* and nothing else: the same session row, the same usage booking, the
 * same events on the bus. A mocked tool loop would have proved only that the
 * pool calls a function.
 */

let store: Store;
let bus: Bus;
let pool: AgentPool;
let events: HarnessEvent[];
let requests: { url: string; body: Record<string, unknown> }[];

/** An OpenAI that answers each request from a script. */
function stubOpenAI(replies: Record<string, unknown>[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, opts: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(opts.body)) as Record<string, unknown> });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => replies[Math.min(i++, replies.length - 1)]!,
        text: async (): Promise<string> => "",
      };
    })
  );
}

const said = (text: string, usage = { prompt_tokens: 100, completion_tokens: 50 }) => ({
  choices: [{ message: { content: text } }],
  usage,
});

const SPEC: AgentSpec = {
  runId: "run1",
  taskId: "task1",
  role: "worker",
  model: "gpt-5.6-terra",
  systemPrompt: "you are a worker",
  prompt: "build the thing",
  cwd: "/tmp/worktree",
  tools: [],
};

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ ...SPEC, ...over });

beforeEach(() => {
  queryMock.mockReset();
  reapUnderMock.mockReset().mockResolvedValue([]);
  requests = [];
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("GEMINI_API_KEY", "gem-test");
  // Keep rtk out of it; whether the operator has it installed is not this test's
  // subject, and it is covered on its own in rtk.test.ts.
  vi.stubEnv("HARNESS_RTK", "off");
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("running a session on OpenAI", () => {
  it("never calls the Anthropic SDK", async () => {
    stubOpenAI([said("built it")]);
    await pool.run(spec());
    expect(queryMock).not.toHaveBeenCalled();
    expect(requests[0]!.url).toContain("api.openai.com");
    expect(requests[0]!.body.model).toBe("gpt-5.6-terra");
  });

  it("returns the same result shape the Anthropic path returns", async () => {
    stubOpenAI([said("built it")]);
    const out = await pool.run(spec());
    expect(out.resultText).toBe("built it");
    expect(out.outcome).toBe("done");
    expect(out.turns).toBe(1);
  });

  it("books usage into the ledger at that model's price", async () => {
    stubOpenAI([said("built it")]);
    const out = await pool.run(spec());
    const rows = store.db.prepare("SELECT * FROM ledger WHERE sessionId = ?").all(out.sessionId) as Record<string, number>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(100);
    expect(rows[0]!.outputTokens).toBe(50);
    // gpt-5.6-terra is $2/MTok in and $12/MTok out: 100*2 + 50*12 over a million.
    expect(rows[0]!.costUsd).toBeCloseTo(0.0008, 6);
    expect(out.costUsd).toBeCloseTo(0.0008, 6);
  });

  it("writes the session row and closes it, exactly as the SDK path does", async () => {
    stubOpenAI([said("built it")]);
    const out = await pool.run(spec());
    const row = store.db.prepare("SELECT * FROM sessions WHERE id = ?").get(out.sessionId) as Record<string, unknown>;
    expect(row.state).toBe("done");
    expect(row.model).toBe("gpt-5.6-terra");
    expect(row.turns).toBe(1);
    expect(row.endedAt).toBeTruthy();
  });

  it("puts the agent's text and tool calls on the bus", async () => {
    stubOpenAI([
      { choices: [{ message: { content: "looking", tool_calls: [{ id: "c1", function: { name: "Glob", arguments: '{"pattern":"*.ts"}' } }] } }] },
      said("done"),
    ]);
    await pool.run(spec({ tools: ["Glob"], cwd: process.cwd() }));
    expect(events.filter((e) => e.type === "agent.log").some((e) => (e as { text: string }).text === "looking")).toBe(true);
    const toolUse = events.filter((e) => e.type === "agent.tool_use") as { tool: string }[];
    expect(toolUse[0]!.tool).toBe("Glob");
  });

  it("reports a provider error as a failed session rather than a silent one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, statusText: "Unauthorized", json: async () => ({}), text: async () => "bad key" }))
    );
    await expect(pool.run(spec())).rejects.toThrow(/openai API 401/);
    const row = store.db.prepare("SELECT * FROM sessions WHERE runId = 'run1'").get() as Record<string, unknown>;
    expect(row.state).toBe("interrupted");
  });
});

describe("running a session on Google", () => {
  it("routes a gemini model to Google and books it at that price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(opts.body)) as Record<string, unknown> });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "reviewed" }] } }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000 },
          }),
          text: async (): Promise<string> => "",
        };
      })
    );
    const out = await pool.run(spec({ model: "gemini-3.5-flash-lite" }));
    expect(requests[0]!.url).toContain("generativelanguage.googleapis.com");
    expect(out.resultText).toBe("reviewed");
    // $0.30/MTok in, $2.50/MTok out.
    expect(out.costUsd).toBeCloseTo(0.0028, 6);
  });
});

describe("a session that outgrows its context window", () => {
  it("tells the operator on the bus, and does not book it as a model turn", async () => {
    // A budget of 1 character forces compaction on the very first request, which
    // is what a real session hits after tens of thousands of characters of tool
    // output. What matters is that the operator hears about it.
    stubOpenAI([said("done")]);
    const result = await pool.run(spec({ contextBudget: 1 }));

    const logs = events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log");
    expect(logs.some((l) => /over the 1-character budget/.test(l.text))).toBe(true);
    // The note is bookkeeping, not a turn: one model call, one turn.
    expect(result.turns).toBe(1);
    expect(result.outcome).toBe("done");
  });

  it("stays silent when the transcript fits, which is the ordinary case", async () => {
    stubOpenAI([said("done")]);
    await pool.run(spec());

    const logs = events.filter((e): e is HarnessEvent & { text: string } => e.type === "agent.log");
    expect(logs.some((l) => /context budget|characters of older tool output/.test(l.text))).toBe(false);
  });
});

describe("the pairings the harness refuses outright", () => {
  it("will not start a role whose tools this transport cannot provide", async () => {
    await expect(pool.run(spec({ tools: ["Read", "WebSearch"] }))).rejects.toThrow(/cannot run on gpt-5.6-terra.*WebSearch/s);
    // Nothing was spent and no session was opened.
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("will not start a role that needs in-process MCP tools", async () => {
    await expect(pool.run(spec({ mcpServers: { harness_intake: {} } as never }))).rejects.toThrow(/in-process MCP tools/);
  });

  it("points the operator at the setting they need to change", async () => {
    await expect(pool.run(spec({ role: "demo", tools: ["WebFetch"] }))).rejects.toThrow(/models\.demo/);
  });

  it("leaves the Anthropic path alone, whatever the spec asks for", async () => {
    queryMock.mockImplementation(() => (async function* () {
      yield { type: "result", subtype: "success", result: "ok", usage: {} };
    })());
    // WebSearch has no local implementation, but the SDK provides it.
    const out = await pool.run(spec({ model: "claude-sonnet-5", tools: ["WebSearch"], mcpServers: { x: {} } as never }));
    expect(out.resultText).toBe("ok");
  });
});

describe("a re-dispatched worker on a stateless provider", () => {
  it("says out loud that it is starting cold instead of silently losing the context", async () => {
    stubOpenAI([said("starting over")]);
    await pool.run(spec({ resume: "earlier-session-id" }));
    const logs = events.filter((e) => e.type === "agent.log") as { text: string }[];
    expect(logs.some((l) => l.text.includes("starting cold"))).toBe(true);
  });

  it("says nothing when the same spec resumes on Anthropic, where resuming works", async () => {
    queryMock.mockImplementation(() => (async function* () {
      yield { type: "result", subtype: "success", result: "ok", usage: {} };
    })());
    await pool.run(spec({ model: "claude-opus-5", resume: "earlier-session-id" }));
    const logs = events.filter((e) => e.type === "agent.log") as { text: string }[];
    expect(logs.some((l) => l.text.includes("starting cold"))).toBe(false);
  });
});

describe("the operator speaking to a live non-Anthropic session", () => {
  it("delivers a mid-flight message into the running conversation", async () => {
    // The agent asks for a tool on its first turn, which is the window in which
    // the operator's note has to land — the same guarantee the SDK path gives.
    let turn = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(opts.body)) as Record<string, unknown> });
        turn++;
        if (turn === 1) {
          pool.inject("run1", "task1", "use the sandbox client, not a mock");
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "Glob", arguments: '{"pattern":"*.md"}' } }] } }] }),
            text: async (): Promise<string> => "",
          };
        }
        return { ok: true, status: 200, statusText: "OK", json: async () => said("understood"), text: async (): Promise<string> => "" };
      })
    );

    const out = await pool.run(spec({ tools: ["Glob"], cwd: process.cwd() }));
    expect(out.resultText).toBe("understood");
    const second = requests[1]!.body.messages as { role: string; content?: string }[];
    expect(second.some((m) => m.role === "user" && m.content === "use the sandbox client, not a mock")).toBe(true);
  });
});

describe("the prompt stream, read the way the tool loop reads it", () => {
  it("hands over the first prompt, then whatever the operator adds", async () => {
    const stream = new PromptStream("first");
    const source = stream.asSource();
    expect(await source.next()).toBe("first");
    stream.push("second");
    expect(await source.next()).toBe("second");
  });

  it("blocks until there is something to deliver", async () => {
    const stream = new PromptStream("first");
    const source = stream.asSource();
    await source.next();
    const pending = source.next();
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    stream.push("later");
    expect(await pending).toBe("later");
  });

  it("ends the session when the stream closes", async () => {
    const stream = new PromptStream("first");
    const source = stream.asSource();
    await source.next();
    const pending = source.next();
    stream.close();
    expect(await pending).toBeNull();
    expect(await source.next()).toBeNull();
  });

  it("drains what is queued without blocking, and leaves nothing behind", () => {
    const stream = new PromptStream("first");
    const source = stream.asSource();
    expect(source.drain()).toEqual([]);
    stream.push("a");
    stream.push("b");
    expect(source.drain()).toEqual(["a", "b"]);
    expect(source.drain()).toEqual([]);
  });

  it("delivers the first prompt once, whichever reader asks for it", async () => {
    const stream = new PromptStream("first");
    const messages: unknown[] = [];
    for await (const m of stream.stream()) {
      messages.push(m);
      stream.close();
    }
    expect(messages).toHaveLength(1);
    // The generator already took it, so the source does not repeat it.
    expect(await stream.asSource().next()).toBeNull();
  });
});
