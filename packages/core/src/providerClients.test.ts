import { describe, expect, it, vi } from "vitest";
import type { LocalTool } from "./agentTools.js";
import { apiKeyFor, clientFor, googleClient, keyVarFor, missingKeys, openaiClient, type Fetch, type LoopMessage } from "./providerClients.js";

const signal = new AbortController().signal;

const echoTool: LocalTool = {
  name: "Bash",
  description: "run a command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  run: async () => "",
};

/** A fetch that records the request and answers with a canned body. */
function stubFetch(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, opts: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(opts.body)) as Record<string, unknown>, headers: opts.headers as Record<string, string> });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.status === 401 ? "Unauthorized" : "OK",
      json: async () => body,
      text: async () => init.text ?? "",
    };
  }) as unknown as Fetch;
  return { impl, calls };
}

describe("talking to OpenAI", () => {
  const answer = {
    choices: [{ message: { content: "done", tool_calls: [{ id: "c1", function: { name: "Bash", arguments: '{"command":"ls"}' } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
  };

  it("sends the system prompt, the conversation and the tool schemas", async () => {
    const { impl, calls } = stubFetch(answer);
    const messages: LoopMessage[] = [
      { role: "user", text: "build it" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "Bash", input: { command: "ls" } }] },
      { role: "tool", callId: "c1", name: "Bash", text: "a.ts" },
    ];
    await openaiClient("sk-test", impl)({ model: "gpt-5.6-terra", system: "you are a worker", messages, tools: [echoTool], signal });

    const sent = calls[0]!;
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer sk-test");
    expect(sent.body.model).toBe("gpt-5.6-terra");
    const wire = sent.body.messages as Record<string, unknown>[];
    expect(wire[0]).toEqual({ role: "system", content: "you are a worker" });
    expect(wire[1]).toEqual({ role: "user", content: "build it" });
    expect((wire[2] as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0]!.function.arguments).toBe('{"command":"ls"}');
    expect(wire[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "a.ts" });
    expect((sent.body.tools as { function: { name: string } }[])[0]!.function.name).toBe("Bash");
  });

  it("strips a provider prefix before it reaches the wire", async () => {
    const { impl, calls } = stubFetch(answer);
    await openaiClient("sk", impl)({ model: "openai/gpt-5.6-terra", system: "s", messages: [], tools: [], signal });
    expect(calls[0]!.body.model).toBe("gpt-5.6-terra");
    // No tools means no `tools` key at all — an empty array is a 400.
    expect(calls[0]!.body.tools).toBeUndefined();
  });

  it("books cached tokens separately, so the ledger does not charge them at full rate", async () => {
    const { impl } = stubFetch(answer);
    const turn = await openaiClient("sk", impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], signal });
    expect(turn.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0 });
    expect(turn.text).toBe("done");
    expect(turn.toolCalls).toEqual([{ id: "c1", name: "Bash", input: { command: "ls" } }]);
  });

  it("passes the output ceiling the planner needs", async () => {
    const { impl, calls } = stubFetch(answer);
    await openaiClient("sk", impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], maxOutputTokens: 64_000, signal });
    expect(calls[0]!.body.max_completion_tokens).toBe(64_000);
  });

  it("survives a model that emits unparseable tool arguments", async () => {
    // An empty object lets the tool answer "missing argument", which the agent
    // can fix; throwing here would kill the session over a malformed string.
    const { impl } = stubFetch({ choices: [{ message: { content: null, tool_calls: [{ id: "x", function: { name: "Bash", arguments: "{not json" } }] } }] });
    const turn = await openaiClient("sk", impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], signal });
    expect(turn.toolCalls[0]!.input).toEqual({});
    expect(turn.text).toBe("");
  });

  it("sends a plain assistant turn with no tool_calls key at all", async () => {
    // OpenAI rejects `tool_calls: []`, so a turn that called nothing must omit
    // the key rather than send an empty array.
    const { impl, calls } = stubFetch(answer);
    await openaiClient("sk", impl)({
      model: "gpt-5.6-terra",
      system: "s",
      messages: [{ role: "assistant", text: "just thinking out loud", toolCalls: [] }],
      tools: [],
      signal,
    });
    expect((calls[0]!.body.messages as Record<string, unknown>[])[1]).toEqual({ role: "assistant", content: "just thinking out loud" });
  });

  it("treats tool arguments that are not an object as no arguments", async () => {
    const { impl } = stubFetch({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "Bash", arguments: "[1,2]" } }] } }] });
    const turn = await openaiClient("sk", impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], signal });
    expect(turn.toolCalls[0]!.input).toEqual({});
  });

  it("copes with a tool call that has no function block", async () => {
    const { impl } = stubFetch({ choices: [{ message: { tool_calls: [{ id: "x" }] } }] });
    const turn = await openaiClient("sk", impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], signal });
    expect(turn.toolCalls).toEqual([{ id: "x", name: "", input: {} }]);
  });

  it("copes with a response that has no choices, usage or ids at all", async () => {
    const { impl } = stubFetch({ choices: [{ message: { tool_calls: [{ function: {} }] } }] });
    const turn = await openaiClient("sk", impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], signal });
    expect(turn.toolCalls).toEqual([{ id: "call_0", name: "", input: {} }]);
    expect(turn.usage.inputTokens).toBe(0);
  });

  it("puts the status in the error, because the status is the diagnosable part", async () => {
    const { impl } = stubFetch({}, { ok: false, status: 401, text: "bad key" });
    await expect(openaiClient("sk", impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], signal })).rejects.toThrow(
      /openai API 401 Unauthorized: bad key/
    );
  });
});

describe("talking to Google", () => {
  const answer = {
    candidates: [{ content: { parts: [{ text: "thinking" }, { functionCall: { name: "Read", args: { file_path: "a.ts" } } }] } }],
    usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 10, cachedContentTokenCount: 30 },
  };

  it("maps the conversation onto contents, with tool results as functionResponse", async () => {
    const { impl, calls } = stubFetch(answer);
    const messages: LoopMessage[] = [
      { role: "user", text: "read it" },
      { role: "assistant", text: "ok", toolCalls: [{ id: "call_0", name: "Read", input: { file_path: "a.ts" } }] },
      { role: "tool", callId: "call_0", name: "Read", text: "contents" },
    ];
    await googleClient("k", impl)({ model: "gemini-3.5-flash-lite", system: "you are a worker", messages, tools: [echoTool], signal });

    const sent = calls[0]!;
    expect(sent.url).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(sent.headers["x-goog-api-key"]).toBe("k");
    expect(sent.body.systemInstruction).toEqual({ parts: [{ text: "you are a worker" }] });
    const contents = sent.body.contents as Record<string, unknown>[];
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "read it" }] });
    expect(contents[1]).toEqual({ role: "model", parts: [{ text: "ok" }, { functionCall: { name: "Read", args: { file_path: "a.ts" } } }] });
    expect(contents[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "Read", response: { result: "contents" } } }] });
    expect((sent.body.tools as { functionDeclarations: { name: string }[] }[])[0]!.functionDeclarations[0]!.name).toBe("Bash");
  });

  it("never sends a model turn with no parts, which Gemini rejects", async () => {
    const { impl, calls } = stubFetch(answer);
    await googleClient("k", impl)({
      model: "gemini-3.5-flash-lite",
      system: "s",
      messages: [{ role: "assistant", text: "", toolCalls: [] }],
      tools: [],
      signal,
    });
    expect((calls[0]!.body.contents as Record<string, unknown>[])[0]).toEqual({ role: "model", parts: [{ text: "" }] });
  });

  it("gives each call an id, because Gemini does not issue one", async () => {
    const { impl } = stubFetch(answer);
    const turn = await googleClient("k", impl)({ model: "gemini-3.5-flash-lite", system: "s", messages: [], tools: [], signal });
    expect(turn.text).toBe("thinking");
    expect(turn.toolCalls).toEqual([{ id: "call_1", name: "Read", input: { file_path: "a.ts" } }]);
    expect(turn.usage).toEqual({ inputTokens: 60, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0 });
  });

  it("copes with an empty candidate and an argument-less call", async () => {
    const { impl } = stubFetch({ candidates: [{ content: { parts: [{ functionCall: { name: "Glob" } }] } }] });
    const turn = await googleClient("k", impl)({ model: "gemini-3.5-flash-lite", system: "s", messages: [], tools: [], signal });
    expect(turn.toolCalls).toEqual([{ id: "call_0", name: "Glob", input: {} }]);
    expect(turn.text).toBe("");
  });

  it("copes with a response carrying no candidates at all", async () => {
    const { impl } = stubFetch({});
    const turn = await googleClient("k", impl)({ model: "gemini-3.5-flash-lite", system: "s", messages: [], tools: [], signal });
    expect(turn).toEqual({ text: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  });

  it("passes the output ceiling", async () => {
    const { impl, calls } = stubFetch(answer);
    await googleClient("k", impl)({ model: "gemini-3.5-flash-lite", system: "s", messages: [], tools: [], maxOutputTokens: 32_000, signal });
    expect(calls[0]!.body.generationConfig).toEqual({ maxOutputTokens: 32_000 });
  });

  it("reports a failed request with its status", async () => {
    const { impl } = stubFetch({}, { ok: false, status: 429, text: "quota" });
    await expect(googleClient("k", impl)({ model: "gemini-3.5-flash-lite", system: "s", messages: [], tools: [], signal })).rejects.toThrow(/google API 429/);
  });
});

describe("finding the operator's API keys", () => {
  it("reads each vendor's documented variable", () => {
    expect(apiKeyFor("openai", { OPENAI_API_KEY: "sk-1" })).toBe("sk-1");
    expect(apiKeyFor("anthropic", { ANTHROPIC_API_KEY: "sk-a" })).toBe("sk-a");
  });

  it("accepts either name Google documents, preferring the newer one", () => {
    expect(apiKeyFor("google", { GOOGLE_API_KEY: "old" })).toBe("old");
    expect(apiKeyFor("google", { GEMINI_API_KEY: "new", GOOGLE_API_KEY: "old" })).toBe("new");
    expect(keyVarFor("google")).toBe("GEMINI_API_KEY");
  });

  it("treats an empty or blank variable as unset", () => {
    expect(apiKeyFor("openai", { OPENAI_API_KEY: "   " })).toBeUndefined();
    expect(apiKeyFor("openai", {})).toBeUndefined();
  });

  it("trims a key that was pasted with a trailing newline", () => {
    expect(apiKeyFor("openai", { OPENAI_API_KEY: "sk-1\n" })).toBe("sk-1");
  });
});

describe("the check that runs before a run starts", () => {
  it("passes an all-Anthropic table without needing any key", () => {
    expect(missingKeys({ worker: "claude-sonnet-5", qa: "claude-sonnet-5" }, {})).toEqual([]);
  });

  it("passes when the key for the routed vendor is set", () => {
    expect(missingKeys({ worker: "gpt-5.6-terra" }, { OPENAI_API_KEY: "sk" })).toEqual([]);
  });

  it("names the variable and every role that would have failed", () => {
    const [message, ...rest] = missingKeys({ worker: "gpt-5.6-terra", demo: "gpt-5.6-luna" }, {});
    expect(rest).toEqual([]);
    expect(message).toContain("OPENAI_API_KEY is not set");
    expect(message).toContain("worker (gpt-5.6-terra)");
    expect(message).toContain("demo (gpt-5.6-luna)");
    expect(message).toContain("are routed to openai");
  });

  it("reports one sentence per vendor and reads correctly for a single role", () => {
    const problems = missingKeys({ worker: "gpt-5.6-terra", demo: "gemini-3.5-flash-lite" }, {});
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("is routed to openai");
    expect(problems[1]).toContain("GEMINI_API_KEY");
  });
});

describe("choosing a client", () => {
  it("builds the right one for each vendor", async () => {
    const { impl, calls } = stubFetch({});
    await clientFor("openai", { OPENAI_API_KEY: "sk" }, impl)({ model: "gpt-5.6-terra", system: "s", messages: [], tools: [], signal });
    expect(calls[0]!.url).toContain("api.openai.com");
    await clientFor("google", { GEMINI_API_KEY: "k" }, impl)({ model: "gemini-3.5-flash-lite", system: "s", messages: [], tools: [], signal });
    expect(calls[1]!.url).toContain("generativelanguage.googleapis.com");
  });

  it("names the variable to set when the key is missing", () => {
    expect(() => clientFor("openai", {})).toThrow("set OPENAI_API_KEY");
  });

  it("refuses Anthropic, which belongs on the SDK transport", () => {
    expect(() => clientFor("anthropic", { ANTHROPIC_API_KEY: "sk" })).toThrow("does not use the harness tool loop");
  });

  it("defaults to the process environment and the global fetch", () => {
    // Only that it resolves the key from process.env — no request is made.
    vi.stubEnv("OPENAI_API_KEY", "sk-from-env");
    expect(typeof clientFor("openai")).toBe("function");
    vi.unstubAllEnvs();
  });
});
