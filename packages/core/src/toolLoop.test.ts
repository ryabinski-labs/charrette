import { describe, expect, it, vi } from "vitest";
import type { LocalTool } from "./agentTools.js";
import type { ProviderClient, ProviderTurn, TurnRequest } from "./providerClients.js";
import { toolLoop, unsupportedSpec, type PromptSource } from "./toolLoop.js";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
const say = (text: string): ProviderTurn => ({ text, toolCalls: [], usage });
const call = (name: string, input: Record<string, unknown> = {}, id = "c1"): ProviderTurn => ({ text: "", toolCalls: [{ id, name, input }], usage });

/** A client that replays a fixed list of turns and records what it was sent. */
function scriptedClient(turns: ProviderTurn[]): { client: ProviderClient; seen: TurnRequest[] } {
  const seen: TurnRequest[] = [];
  let i = 0;
  const client: ProviderClient = async (req) => {
    // The loop mutates its own message array, so snapshot it per call.
    seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    return turns[Math.min(i++, turns.length - 1)]!;
  };
  return { client, seen };
}

/** A prompt source that hands over a fixed list and then ends the session. */
function prompts(first: string, queued: string[] = []): PromptSource {
  let sent = false;
  return {
    next: async () => {
      if (sent) return null;
      sent = true;
      return first;
    },
    drain: () => queued.splice(0),
  };
}

const spec = { model: "gpt-5.6-terra", systemPrompt: "you are a worker", cwd: "/tmp/nowhere" };
const signal = new AbortController().signal;

async function collect(gen: AsyncGenerator<Record<string, unknown>>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

const noTools: LocalTool[] = [];

describe("keeping a long session inside the context window", () => {
  /** A tool whose output is far larger than the budget under test. */
  const bigTool = (chars: number): LocalTool[] => [
    {
      name: "Bash",
      description: "run a command",
      parameters: { type: "object", properties: {} },
      run: async () => "x".repeat(chars),
    } as unknown as LocalTool,
  ];

  it("sends the whole transcript untouched while it still fits", async () => {
    const { client, seen } = scriptedClient([call("Bash"), say("done")]);
    const messages = await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(100), contextBudget: 1_000_000 })
    );

    expect(messages.map((m) => m.type)).toEqual(["assistant", "assistant", "result"]);
    expect((seen[1]!.messages[2] as { text: string }).text).toHaveLength(100);
  });

  it("compacts before the request rather than letting the provider refuse it", async () => {
    // 20k per result is the realistic scale — agentTools clamps a single tool
    // result at 30k — so the three protected exchanges leave room to get under.
    const rounds = Array.from({ length: 8 }, (_, i) => call("Bash", {}, `c${i}`));
    const { client, seen } = scriptedClient([...rounds, say("done")]);
    await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(20_000), contextBudget: 100_000 })
    );

    const lastSent = seen[seen.length - 1]!.messages;
    const chars = lastSent.reduce((n, m) => n + ("text" in m ? m.text.length : 0), 0);
    expect(chars).toBeLessThanOrEqual(100_000);
    // Without compaction this session would have sent 8 x 20k of tool output.
    expect(chars).toBeLessThan(160_000);
  });

  it("tells the operator their agent is working from an abridged record", async () => {
    const { client } = scriptedClient([call("Bash", {}, "c1"), call("Bash", {}, "c2"), call("Bash", {}, "c3"), call("Bash", {}, "c4"), call("Bash", {}, "c5"), say("done")]);
    const messages = await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(60_000), contextBudget: 100_000 })
    );

    const notes = messages.filter((m) => m.type === "charrette_note");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]).toMatchObject({ text: expect.stringMatching(/compacted \d+ characters of older tool output/) });
  });

  it("says plainly when compaction was not enough to get under the budget", async () => {
    const { client } = scriptedClient([call("Bash", {}, "c1"), call("Bash", {}, "c2"), call("Bash", {}, "c3"), say("done")]);
    const messages = await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(60_000), contextBudget: 1_000 })
    );

    const notes = messages.filter((m) => m.type === "charrette_note") as { text: string }[];
    expect(notes.some((n) => /STILL over the 1000-character budget/.test(n.text))).toBe(true);
  });

  it("never compacts what the operator wrote", async () => {
    const instruction = "use the existing retry helper, do not add a new one";
    const { client, seen } = scriptedClient([call("Bash", {}, "c1"), call("Bash", {}, "c2"), call("Bash", {}, "c3"), call("Bash", {}, "c4"), say("done")]);
    await collect(
      toolLoop({ spec, prompts: prompts(instruction), signal, client, toolsOverride: bigTool(60_000), contextBudget: 5_000 })
    );

    const lastSent = seen[seen.length - 1]!.messages;
    expect(lastSent.filter((m) => m.role === "user").map((m) => (m as { text: string }).text)).toEqual([instruction]);
  });

  it("compacts before the wrap-up turn, which is the one that must not be refused", async () => {
    const { client, seen } = scriptedClient([call("Bash", {}, "c1"), call("Bash", {}, "c2"), say("here is what I found")]);
    const messages = await collect(
      toolLoop({
        spec: { ...spec, maxTurns: 2 },
        prompts: prompts("go"),
        signal,
        client,
        toolsOverride: bigTool(60_000),
        contextBudget: 50_000,
      })
    );

    expect(messages.some((m) => m.type === "charrette_note")).toBe(true);
    expect(messages[messages.length - 1]).toMatchObject({ type: "result", subtype: "error_max_turns" });
    const wrapUp = seen[seen.length - 1]!.messages;
    expect(wrapUp.filter((m) => m.role === "user").map((m) => (m as { text: string }).text)).toContain(
      "[CHARRETTE] You have reached this session's turn limit. Stop calling tools and give your final answer now, in exactly the output format you were asked for."
    );
  });
});

describe("the loop the charrette runs for non-Anthropic providers", () => {
  it("yields the message shapes pool.ts already knows how to read", async () => {
    const { client } = scriptedClient([say("all done")]);
    const messages = await collect(toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: noTools }));

    expect(messages.map((m) => m.type)).toEqual(["assistant", "result"]);
    const assistant = messages[0] as { message: { content: unknown[]; usage: Record<string, number> } };
    expect(assistant.message.content).toEqual([{ type: "text", text: "all done" }]);
    // The usage keys are the SDK's, because that is what the ledger reads.
    expect(assistant.message.usage).toEqual({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(messages[1]).toMatchObject({ type: "result", subtype: "success", result: "all done" });
  });

  it("carries the system prompt and the operator's message into the first turn", async () => {
    const { client, seen } = scriptedClient([say("done")]);
    await collect(toolLoop({ spec, prompts: prompts("build the thing"), signal, client, toolsOverride: noTools }));
    expect(seen[0]!.system).toBe("you are a worker");
    expect(seen[0]!.messages).toEqual([{ role: "user", text: "build the thing" }]);
  });

  it("runs a requested tool and feeds the result back", async () => {
    const ran: Record<string, unknown>[] = [];
    const tool: LocalTool = {
      name: "Read",
      description: "read",
      parameters: { type: "object", properties: {} },
      run: async (input) => {
        ran.push(input);
        return "file contents";
      },
    };
    const { client, seen } = scriptedClient([call("Read", { file_path: "a.ts" }), say("I read it")]);
    const messages = await collect(toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: [tool] }));

    expect(ran).toEqual([{ file_path: "a.ts" }]);
    // The tool call reaches the bus as a tool_use block, same as on the SDK.
    expect((messages[0] as { message: { content: { type: string; name: string }[] } }).message.content[0]).toMatchObject({ type: "tool_use", name: "Read" });
    expect(seen[1]!.messages[2]).toEqual({ role: "tool", callId: "c1", name: "Read", text: "file contents" });
  });

  it("hands a throwing tool back as a result the agent can act on, not a dead session", async () => {
    const tool: LocalTool = {
      name: "Read",
      description: "read",
      parameters: { type: "object", properties: {} },
      run: async () => {
        throw new Error("ENOENT: no such file");
      },
    };
    const { client, seen } = scriptedClient([call("Read"), say("I will try another path")]);
    const messages = await collect(toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: [tool] }));
    expect((seen[1]!.messages[2] as { text: string }).text).toContain("ENOENT");
    expect(messages.at(-1)).toMatchObject({ subtype: "success" });
  });

  it("tells the model when it asks for a tool that does not exist", async () => {
    const tool: LocalTool = { name: "Read", description: "read", parameters: {}, run: async () => "x" };
    const { client, seen } = scriptedClient([call("WebSearch"), say("ok, without it then")]);
    await collect(toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: [tool] }));
    expect((seen[1]!.messages[2] as { text: string }).text).toContain("no tool named WebSearch");
    expect((seen[1]!.messages[2] as { text: string }).text).toContain("Available: Read");
  });

  it("says so plainly when a role has no tools at all", async () => {
    // A read-only role that hallucinates a shell should be told there is none,
    // not handed an empty list it will read as a transient failure.
    const { client, seen } = scriptedClient([call("Bash"), say("understood, no tools here")]);
    await collect(toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: noTools }));
    expect((seen[1]!.messages[2] as { text: string }).text).toContain("Available: (none)");
  });

  it("books each turn's usage on its own message and the total on the result", async () => {
    // pool.ts accumulates per-turn usage so a session that dies mid-flight still
    // books what it spent, then replaces that with the result's total. Both
    // numbers have to be right or the run is billed twice or not at all.
    const { client } = scriptedClient([call("Read"), say("done")]);
    const tool: LocalTool = { name: "Read", description: "r", parameters: {}, run: async () => "x" };
    const messages = await collect(toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: [tool] }));
    const totals = messages.map((m) => (m as { message?: { usage?: { output_tokens: number } }; usage?: { output_tokens: number } }).message?.usage ?? (m as { usage: { output_tokens: number } }).usage);
    expect(totals[0]!.output_tokens).toBe(5);
    expect(totals[1]!.output_tokens).toBe(5);
    // The result carries the sum of both turns, not a third charge.
    expect(totals[2]!.output_tokens).toBe(10);
  });
});

describe("mid-flight operator feedback", () => {
  it("joins the conversation between tool rounds, without waiting for the agent to finish", async () => {
    // The whole point of PromptStream: the operator can redirect a running
    // agent. On the SDK the CLI does this; here the loop has to do it.
    const queued = ["actually, use the sandbox client"];
    const tool: LocalTool = { name: "Read", description: "r", parameters: {}, run: async () => "x" };
    const { client, seen } = scriptedClient([call("Read"), say("understood")]);
    await collect(toolLoop({ spec, prompts: prompts("go", queued), signal, client, toolsOverride: [tool] }));

    expect(seen[1]!.messages.at(-1)).toEqual({ role: "user", text: "actually, use the sandbox client" });
  });

  it("keeps answering while the operator keeps talking", async () => {
    const remaining = ["first message", "second message"];
    const source: PromptSource = { next: async () => remaining.shift() ?? null, drain: () => [] };
    const { client, seen } = scriptedClient([say("a"), say("b")]);
    const messages = await collect(toolLoop({ spec, prompts: source, signal, client, toolsOverride: noTools }));
    expect(messages.filter((m) => m.type === "result")).toHaveLength(2);
    // The second exchange still has the first one in front of it.
    expect(seen[1]!.messages).toHaveLength(3);
  });
});

describe("the turn ceiling", () => {
  it("asks for a final answer and reports error_max_turns, like the SDK does", async () => {
    const tool: LocalTool = { name: "Read", description: "r", parameters: {}, run: async () => "x" };
    // A model that will never stop asking for tools.
    const client: ProviderClient = async (req) => (req.tools.length === 0 ? say("here is what I found") : call("Read"));
    const messages = await collect(toolLoop({ spec: { ...spec, maxTurns: 2 }, prompts: prompts("go"), signal, client, toolsOverride: [tool] }));

    const result = messages.at(-1) as { subtype: string; result: string };
    expect(result.subtype).toBe("error_max_turns");
    expect(result.result).toBe("here is what I found");
  });

  it("sends the wrap-up ask with no tools, so the model cannot keep calling them", async () => {
    const tool: LocalTool = { name: "Read", description: "r", parameters: {}, run: async () => "x" };
    const seen: TurnRequest[] = [];
    const client: ProviderClient = async (req) => {
      seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      return req.tools.length === 0 ? say("final") : call("Read");
    };
    await collect(toolLoop({ spec: { ...spec, maxTurns: 1 }, prompts: prompts("go"), signal, client, toolsOverride: [tool] }));
    expect(seen.at(-1)!.tools).toEqual([]);
    expect((seen.at(-1)!.messages.at(-1) as { text: string }).text).toContain("turn limit");
  });

  it("still ends the session when the model answers the wrap-up with nothing", async () => {
    const tool: LocalTool = { name: "Read", description: "r", parameters: {}, run: async () => "x" };
    const client: ProviderClient = async (req) => (req.tools.length === 0 ? say("") : call("Read"));
    const messages = await collect(toolLoop({ spec: { ...spec, maxTurns: 1 }, prompts: prompts("go"), signal, client, toolsOverride: [tool] }));
    expect((messages.at(-2) as { message: { content: unknown[] } }).message.content).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ subtype: "error_max_turns", result: "" });
  });

  it("stops when the session is aborted", async () => {
    const abort = new AbortController();
    const tool: LocalTool = { name: "Read", description: "r", parameters: {}, run: async () => "x" };
    const client: ProviderClient = async () => {
      abort.abort();
      return call("Read");
    };
    const messages = await collect(toolLoop({ spec, prompts: prompts("go"), signal: abort.signal, client, toolsOverride: [tool] }));
    // The turn that was already in flight is reported; nothing after it is.
    expect(messages.filter((m) => m.type === "result")).toHaveLength(0);
  });
});

describe("specs this transport cannot honour", () => {
  it("accepts an ordinary worker spec", () => {
    expect(unsupportedSpec({ ...spec, tools: ["Bash", "Read", "Write", "Edit"] })).toBeNull();
    expect(unsupportedSpec(spec)).toBeNull();
  });

  it("refuses a role that needs in-process MCP tools", () => {
    // intake asks the operator questions through an SDK-only tool. Without it
    // the agent would invent the answers instead of asking — which is the
    // failure that shipped fakes in run 40da9337.
    expect(unsupportedSpec({ ...spec, mcpServers: { charrette_intake: {} } })).toContain("in-process MCP tools");
  });

  it("ignores an empty mcpServers object", () => {
    expect(unsupportedSpec({ ...spec, mcpServers: {} })).toBeNull();
  });

  it("names a tool it has no implementation for", () => {
    expect(unsupportedSpec({ ...spec, tools: ["Read", "WebSearch"] })).toContain("WebSearch");
  });
});

describe("building the client from the environment", () => {
  it("uses the vendor the model name points at", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: { content: "hi" } }] }),
      text: async () => "",
    })) as unknown as typeof globalThis.fetch;

    await collect(
      toolLoop({
        spec: { ...spec, model: "gpt-5.6-terra" },
        prompts: prompts("go"),
        signal,
        env: { OPENAI_API_KEY: "sk", CHARRETTE_RTK: "off" },
        fetchImpl,
        toolsOverride: noTools,
      })
    );
    expect(String((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])).toContain("api.openai.com");
  });

  it("derives its tools from the spec when none are injected", async () => {
    const { client, seen } = scriptedClient([say("done")]);
    await collect(
      toolLoop({ spec: { ...spec, tools: ["Read", "Glob"] }, prompts: prompts("go"), signal, client, env: { CHARRETTE_RTK: "off" } })
    );
    expect(seen[0]!.tools.map((t) => t.name)).toEqual(["Read", "Glob"]);
  });
});

describe("folding the transcript into the agent's own checkpoint digest", () => {
  const bigTool = (chars: number): LocalTool[] => [
    {
      name: "Bash",
      description: "run a command",
      parameters: { type: "object", properties: {} },
      run: async () => "x".repeat(chars),
    } as unknown as LocalTool,
  ];

  const digestTurn = (state: string): ProviderTurn => ({
    text: `<charrette-checkpoint>\nSTATE: ${state}\n</charrette-checkpoint>`,
    toolCalls: [{ id: "next", name: "Bash", input: {} }],
    usage,
  });

  /** Eight rounds of 20k tool output, a checkpoint answer, then more work. */
  const script = (): ProviderTurn[] => [
    ...Array.from({ length: 8 }, (_, i) => call("Bash", {}, `c${i}`)),
    digestTurn("read eight files; the retry helper already exists in src/util/retry.ts"),
    say("done"),
  ];

  const charsOf = (messages: { text?: string }[]): number =>
    messages.reduce((n, m) => n + (typeof m.text === "string" ? m.text.length : 0), 0);

  it("replaces the older transcript with the digest when the agent writes one", async () => {
    // Measured against the same session with folding off, because that is the
    // only number that says what folding bought: the three most recent
    // exchanges are protected either way, so the saving is what is behind them.
    const run = async (foldOnCheckpoint: boolean) => {
      const { client, seen } = scriptedClient(script());
      await collect(
        toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(20_000), contextBudget: 1_000_000, foldOnCheckpoint })
      );
      return seen[seen.length - 1]!.messages;
    };

    const folded = await run(true);
    const unfolded = await run(false);
    expect(charsOf(folded)).toBeLessThan(charsOf(unfolded) / 2);
    expect(folded.some((m) => "text" in m && m.text.includes("Checkpoint digest"))).toBe(true);
    expect(folded.some((m) => "text" in m && m.text.includes("src/util/retry.ts"))).toBe(true);
  });

  it("keeps the assignment the digest was derived from", async () => {
    const { client, seen } = scriptedClient(script());
    await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(20_000), contextBudget: 1_000_000, foldOnCheckpoint: true })
    );

    const users = seen[seen.length - 1]!.messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(users).toContain("go");
  });

  it("reports the fold, because the agent is now working from its own summary", async () => {
    const { client } = scriptedClient(script());
    const messages = await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(20_000), contextBudget: 1_000_000, foldOnCheckpoint: true })
    );
    const notes = messages.filter((m) => m.type === "charrette_note");
    expect(notes.some((n) => /folded \d+ characters .* checkpoint digest/.test(String(n.text)))).toBe(true);
  });

  it("leaves the transcript alone when folding is off", async () => {
    const { client, seen } = scriptedClient(script());
    await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(20_000), contextBudget: 1_000_000 })
    );
    expect(charsOf(seen[seen.length - 1]!.messages)).toBeGreaterThan(120_000);
  });

  it("reports no fold when there was nothing behind the protected tail to fold", async () => {
    // An agent that checkpoints on its first answer has written a digest of
    // almost nothing. The three most recent exchanges are protected either way,
    // so there is no older material to replace — and claiming a fold that saved
    // zero characters would put a line in the operator's log for work that did
    // not happen.
    const { client } = scriptedClient([digestTurn("nothing read yet; starting on the retry helper"), say("done")]);
    const messages = await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(20_000), contextBudget: 1_000_000, foldOnCheckpoint: true })
    );

    expect(messages.filter((m) => m.type === "charrette_note" && /folded \d+ characters/.test(String(m.text)))).toEqual([]);
  });

  it("does nothing on an ordinary turn that mentions no checkpoint", async () => {
    const { client, seen } = scriptedClient([
      ...Array.from({ length: 8 }, (_, i) => call("Bash", {}, `c${i}`)),
      { text: "still reading things", toolCalls: [{ id: "n", name: "Bash", input: {} }], usage },
      say("done"),
    ]);
    await collect(
      toolLoop({ spec, prompts: prompts("go"), signal, client, toolsOverride: bigTool(20_000), contextBudget: 1_000_000, foldOnCheckpoint: true })
    );
    expect(charsOf(seen[seen.length - 1]!.messages)).toBeGreaterThan(120_000);
  });
});
