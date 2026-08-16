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

  it("bills thinking tokens, which Gemini reports outside the candidate count", async () => {
    // The numbers are a real gemini-3.6-flash reply: candidates and thoughts are
    // siblings summing into totalTokenCount, and Google charges both at the
    // output rate. Counting candidates alone books a reasoning model at under a
    // third of its cost — and since `models.reviewer` is pinned to Gemini, that
    // undercount would apply to every pit stop of every run, against the budget
    // cap that is supposed to be the thing that stops a runaway.
    const { impl } = stubFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: { promptTokenCount: 67, candidatesTokenCount: 20, thoughtsTokenCount: 43, totalTokenCount: 130 },
    });
    const turn = await googleClient("k", impl)({ model: "gemini-3.6-flash", system: "s", messages: [], tools: [], signal });
    expect(turn.usage).toEqual({ inputTokens: 67, outputTokens: 63, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("carries each thought signature back on the part it came from", async () => {
    // The whole of the reviewer outage: a Gemini 3.x model signs the reasoning
    // behind each function call and refuses the next turn without it —
    // "Function call is missing a thought_signature in functionCall parts", 400.
    // The first turn worked, the second never did, so every pit stop's staged
    // review died a few cents in and was reported as "on-track".
    const { impl } = stubFetch({
      candidates: [{
        content: {
          parts: [
            { text: "let me look", thoughtSignature: "sig-text" },
            { functionCall: { name: "Bash", args: { command: "git status" } }, thoughtSignature: "sig-call" },
          ],
        },
      }],
    });
    const first = await googleClient("k", impl)({ model: "gemini-3.7-flash", system: "s", messages: [], tools: [echoTool], signal });

    expect(first.signature).toBe("sig-text");
    expect(first.toolCalls).toEqual([{ id: "call_1", name: "Bash", input: { command: "git status" }, signature: "sig-call" }]);

    // Now the turn the model refused: its own call, handed back as history.
    const { impl: again, calls } = stubFetch(answer);
    await googleClient("k", again)({
      model: "gemini-3.7-flash",
      system: "s",
      messages: [
        { role: "user", text: "review it" },
        { role: "assistant", text: first.text, toolCalls: first.toolCalls, signature: first.signature },
        { role: "tool", callId: "call_1", name: "Bash", text: "clean" },
      ],
      tools: [echoTool],
      signal,
    });

    expect((calls[0]!.body.contents as Record<string, unknown>[])[1]).toEqual({
      role: "model",
      parts: [
        { text: "let me look", thoughtSignature: "sig-text" },
        { functionCall: { name: "Bash", args: { command: "git status" } }, thoughtSignature: "sig-call" },
      ],
    });
  });

  it("sends no signature for a provider turn that carried none", async () => {
    // Every other provider, and Gemini's own non-thinking replies. An empty
    // `thoughtSignature` key is not the same as no key, and the API validates it.
    const { impl, calls } = stubFetch(answer);
    await googleClient("k", impl)({
      model: "gemini-3.5-flash-lite",
      system: "s",
      messages: [{ role: "assistant", text: "ok", toolCalls: [{ id: "call_0", name: "Read", input: {} }] }],
      tools: [],
      signal,
    });

    expect((calls[0]!.body.contents as Record<string, unknown>[])[0]).toEqual({
      role: "model",
      parts: [{ text: "ok" }, { functionCall: { name: "Read", args: {} } }],
    });
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

/** A fetch that answers differently per call, for paths that need two attempts. */
function stubSequence(replies: { status?: number; text?: string; body?: unknown }[]) {
  let n = 0;
  const impl = (async () => {
    const reply = replies[Math.min(n++, replies.length - 1)]!;
    const status = reply.status ?? 200;
    return { ok: status < 400, status, statusText: "", json: async () => reply.body ?? {}, text: async () => reply.text ?? "" };
  }) as unknown as Fetch;
  return { impl, calls: () => n };
}

/**
 * Retrying the vendor being briefly unwell.
 *
 * This is the resilience the Anthropic transport got for free from the Agent
 * SDK and this one never had. It went from harmless to load-bearing when
 * `models.reviewer` was pinned to Google: a pit stop fires every lens at the
 * same endpoint at the same moment, and `runLens` turns a reviewer that died
 * into `verdict: "on-track"` — so one overloaded minute used to buy a silent
 * pass on the judgment the pit stop is there to make.
 */
describe("a vendor that is briefly unable rather than refusing", () => {
  const ok = { candidates: [{ content: { parts: [{ text: "fine" }] } }] };
  const req = { model: "gemini-3.6-flash", system: "s", messages: [], tools: [], signal };

  it("tries again when the model is overloaded, and answers", async () => {
    const slept: number[] = [];
    const { impl, calls } = stubSequence([{ status: 503, text: "The model is overloaded." }, { body: ok }]);

    const turn = await googleClient("k", impl, undefined, async (ms) => void slept.push(ms))(req);

    expect(turn.text).toBe("fine");
    expect(calls()).toBe(2);
    expect(slept).toEqual([1_000]);
  });

  it("gives up after two retries rather than hiding an outage in a long pause", async () => {
    const slept: number[] = [];
    const { impl, calls } = stubSequence([{ status: 503, text: "overloaded" }]);

    await expect(googleClient("k", impl, undefined, async (ms) => void slept.push(ms))(req)).rejects.toThrow(/google API 503/);
    expect(calls()).toBe(3);
    expect(slept).toEqual([1_000, 4_000]);
  });

  it("retries on the OpenAI transport too, which shares the request path", async () => {
    const slept: number[] = [];
    const { impl, calls } = stubSequence([{ status: 502 }, { body: { choices: [{ message: { content: "fine" } }] } }]);

    const turn = await openaiClient("sk", impl, undefined, async (ms) => void slept.push(ms))({ ...req, model: "gpt-5.6-terra" });

    expect(turn.text).toBe("fine");
    expect(calls()).toBe(2);
  });

  it("does not retry a 429, because the pool waits that one out properly", async () => {
    // Two more requests against the wall that just refused one, and three
    // seconds later the pool would do the right thing anyway — sleep until the
    // quota window reopens, keeping the session. See usageLimit.ts.
    const slept: number[] = [];
    const { impl, calls } = stubSequence([{ status: 429, text: "quota" }]);

    await expect(googleClient("k", impl, undefined, async (ms) => void slept.push(ms))(req)).rejects.toThrow(/google API 429/);
    expect(calls()).toBe(1);
    expect(slept).toEqual([]);
  });

  it("waits on a real clock when nothing injects one", async () => {
    // Every case above hands in its own sleep, which would leave the only
    // thing that actually pauses production untested — and a backoff that
    // never sleeps is a retry storm, not a retry.
    vi.useFakeTimers();
    try {
      const { impl, calls } = stubSequence([{ status: 503 }, { body: ok }]);
      const pending = googleClient("k", impl)(req);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).text).toBe("fine");
      expect(calls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a request the vendor will refuse identically forever", async () => {
    const { impl, calls } = stubSequence([{ status: 400, text: "bad tool schema" }]);
    await expect(googleClient("k", impl)(req)).rejects.toThrow(/google API 400/);
    expect(calls()).toBe(1);
  });

  it("keeps enough of the body for the vendor's own retry hint to survive", async () => {
    // Google states `RetryInfo` *after* a `QuotaFailure` block that is itself
    // several hundred characters. Truncating the body at 500 dropped the one
    // field in the reply that says when to come back, so every Gemini quota
    // wall fell back to a flat one-minute probe.
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://ai.google.dev/gemini-api/docs/rate-limits.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [
              {
                quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
                quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
                quotaDimensions: { model: "gemini-3.6-flash", location: "global" },
                quotaValue: "10",
              },
            ],
          },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "38s" },
        ],
      },
    });
    expect(body.length).toBeGreaterThan(500);
    const { impl } = stubSequence([{ status: 429, text: body }]);

    await expect(googleClient("k", impl)(req)).rejects.toThrow(/retryDelay/);
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
