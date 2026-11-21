import { describe, expect, it } from "vitest";
import { RunConfig } from "@charrette/shared";
import { costUsd } from "./budget.js";
import { budgetFor } from "./compact.js";
import { tierModel, workerModelFor } from "./modelTier.js";
import {
  apiKeyFor,
  clientFor,
  deepseekClient,
  keyVarFor,
  missingKeys,
  openaiClient,
  type Fetch,
  type LoopMessage,
} from "./providerClients.js";
import { usageLimitOf } from "./usageLimit.js";

/**
 * The DeepSeek transport, pricing and routing. The client tests use a recording
 * fetch, never a live vendor call; the integration-level proof that a worker
 * session runs on this transport lives in poolTransport.test.ts.
 */

const signal = new AbortController().signal;

const echoTool = {
  name: "Bash",
  description: "run a command",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  run: async () => "",
};

type Reply = { status?: number; body?: unknown; text?: string };

/** A fetch that records every request and answers from a script. */
function scriptedFetch(replies: Reply[]): {
  impl: Fetch;
  calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[];
} {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let i = 0;
  const impl = (async (url: string, opts: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(opts.body)) as Record<string, unknown>, headers: opts.headers as Record<string, string> });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 401 ? "Unauthorized" : status === 503 ? "Service Unavailable" : "OK",
      json: async () => reply.body ?? {},
      text: async () => reply.text ?? "",
    };
  }) as unknown as Fetch;
  return { impl, calls };
}

const usage = { prompt_tokens: 100, completion_tokens: 50 };

const said = (text: string, extra: Record<string, unknown> = {}) => ({
  choices: [{ message: { content: text, ...extra } }],
  usage,
});

const turn = (over: Record<string, unknown> = {}) => ({
  model: "deepseek-flash",
  system: "you are a worker",
  messages: [{ role: "user" as const, text: "build it" }],
  tools: [echoTool],
  signal,
  ...over,
});

describe("REQ-003 — the DeepSeek client speaks the OpenAI chat-completions shape to api.deepseek.com", () => {
  it("SC-003-a the DeepSeek request matches the OpenAI chat-completions shape", async () => {
    const { impl, calls } = scriptedFetch([{ body: said("done") }]);
    const messages: LoopMessage[] = [
      { role: "user", text: "build it" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "Bash", input: { command: "ls" } }] },
      { role: "tool", callId: "c1", name: "Bash", text: "a.ts" },
    ];

    await deepseekClient("sk-deepseek", impl)(turn({ messages }));

    const sent = calls[0]!;
    expect(sent.url).toBe("https://api.deepseek.com/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer sk-deepseek");
    expect(sent.body.model).toBe("deepseek-flash");
    const wire = sent.body.messages as Record<string, unknown>[];
    expect(wire[0]).toEqual({ role: "system", content: "you are a worker" });
    expect(wire[1]).toEqual({ role: "user", content: "build it" });
    expect((wire[2] as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0]!.function.arguments).toBe('{"command":"ls"}');
    expect(wire[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "a.ts" });
  });

  it("SC-003-b a response without cached-token details books zero cache reads", async () => {
    const { impl } = scriptedFetch([{ body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 100, completion_tokens: 10 } } }]);

    const out = await deepseekClient("k", impl)(turn({ tools: [] }));

    expect(out.usage.cacheReadTokens).toBe(0);
    expect(out.usage.inputTokens).toBe(100);
    expect(out.usage.outputTokens).toBe(10);
  });

  it("SC-003-c the chain of thought comes back on the next tool turn", async () => {
    // DeepSeek answers 400 — not a degraded reply — when a request that carries
    // tools omits the reasoning_content of an earlier assistant turn. The
    // loop's assistant message owns that field; the client owns the wire names.
    const { impl, calls } = scriptedFetch([
      {
        body: {
          choices: [
            {
              message: {
                content: "",
                reasoning_content: "I need a file list",
                tool_calls: [{ id: "c1", function: { name: "Bash", arguments: '{"command":"ls"}' } }],
              },
            },
          ],
          usage,
        },
      },
      { body: said("done") },
    ]);
    const client = deepseekClient("k", impl);

    const first = await client(turn());
    expect(first.reasoning).toBe("I need a file list");

    await client(
      turn({
        messages: [
          { role: "user", text: "build it" },
          { role: "assistant", text: first.text, toolCalls: first.toolCalls, reasoning: first.reasoning },
          { role: "tool", callId: "c1", name: "Bash", text: "a.ts" },
        ],
      })
    );

    const wire = calls[1]!.body.messages as Record<string, unknown>[];
    const assistant = wire.find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBe("I need a file list");
  });

  it("SC-003-d sends max_tokens, the field DeepSeek documents", async () => {
    const { impl, calls } = scriptedFetch([{ body: said("done") }]);

    await deepseekClient("k", impl)(turn({ maxOutputTokens: 64_000 }));

    expect(calls[0]!.body.max_tokens).toBe(64_000);
    expect(calls[0]!.body.max_completion_tokens).toBeUndefined();
  });

  it("does not send the DeepSeek-only reasoning field to OpenAI", async () => {
    // The shared client is one function; a field added for one vendor must not
    // leak onto a request the other vendor reads strictly.
    const { impl, calls } = scriptedFetch([{ body: said("done") }]);

    await openaiClient("sk-openai", impl)({
      ...turn({ model: "gpt-5.6-terra" }),
      messages: [{ role: "assistant", text: "done", toolCalls: [], reasoning: "private thought" }],
    });

    const wire = calls[0]!.body.messages as Record<string, unknown>[];
    expect(wire.find((m) => m.role === "assistant")?.reasoning_content).toBeUndefined();
  });
});

describe("REQ-005 — the light-tier rule still decides and reports its tier when both regular tiers name DeepSeek", () => {
  const eligible = {
    title: "Rename the status word in the log line",
    spec: "The CLI's progress line says 'Running'. Change it to 'In progress' and update the snapshot.",
    acceptanceCriteria: ["The log line reads 'In progress'"],
    touchedPaths: ["src/status.ts", "src/status.test.ts"],
    completionProbe: "rg -q 'In progress' src/status.ts",
    estimatedSize: "S" as const,
  };

  it("SC-005-a a light task is still decided light when both regular tiers name DeepSeek", () => {
    const models = RunConfig.parse({}).models;
    const out = workerModelFor(eligible, models);

    expect(out.decision.tier).toBe("light");
    expect(out.model).toBe("deepseek-flash");
  });
});

describe("REQ-006 — UI and heavy tasks keep their own tier models", () => {
  it("SC-006-a a UI task stays on the UI tier model", () => {
    expect(tierModel("ui", RunConfig.parse({}).models)).toBe("claude-opus-5-5");
  });

  it("SC-006-b a heavy task stays on the heavy tier model", () => {
    expect(tierModel("heavy", RunConfig.parse({}).models)).toBe("gemini-3.8-flash");
  });

  it("sends an interface task to the UI rung even when the regular worker is DeepSeek", () => {
    const models = RunConfig.parse({}).models;
    const out = workerModelFor(
      {
        title: "Restyle the settings page",
        spec: "Make the settings screen match the new design system.",
        acceptanceCriteria: ["The page renders the new tokens"],
        touchedPaths: ["src/pages/Settings.vue"],
        completionProbe: "rg -q 'new-token' src/pages/Settings.vue",
        estimatedSize: "M" as const,
      },
      models
    );

    expect(out.decision.tier).toBe("ui");
    expect(out.model).toBe("claude-opus-5-5");
  });
});

describe("REQ-007 — DeepSeek usage is priced at 0.30 input and 1.20 output per MTok, cache reads at 0.1 times input", () => {
  const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("SC-007-a one million input and one million output tokens cost 1.50 USD", () => {
    const charge = costUsd("deepseek-flash", { ...none, inputTokens: 1_000_000, outputTokens: 1_000_000 });

    expect(charge).toBeCloseTo(1.5, 6);
  });

  it("SC-007-b one million cache-read tokens cost 0.03 USD", () => {
    const charge = costUsd("deepseek-flash", { ...none, cacheReadTokens: 1_000_000 });

    expect(charge).toBeCloseTo(0.03, 6);
  });

  it("prices the prefixed spelling as the same model", () => {
    expect(costUsd("deepseek/deepseek-flash", { ...none, inputTokens: 1_000_000 })).toBeCloseTo(0.3, 6);
  });

  it("prices an unknown DeepSeek id at the top tier rather than underestimating it", () => {
    // The table's stated failure direction: a model without a row is charged at
    // Fable's rate, which stops a run early rather than letting it run past the
    // cap the operator set.
    expect(costUsd("deepseek-v9-imaginary", { ...none, inputTokens: 1_000_000 })).toBeCloseTo(10, 6);
  });
});

describe("REQ-008 — a DeepSeek route is refused without DEEPSEEK_API_KEY and accepted with it", () => {
  it("SC-008-a a missing DeepSeek key is reported against the role and model", () => {
    expect(missingKeys({ worker: "deepseek-flash" }, {})).toEqual([
      "DEEPSEEK_API_KEY is not set, but worker (deepseek-flash) is routed to deepseek.",
    ]);
  });

  it("SC-008-b a present DeepSeek key produces no violation", () => {
    expect(missingKeys({ worker: "deepseek-flash" }, { DEEPSEEK_API_KEY: "sk-test" })).toEqual([]);
  });

  it("names both keys when two vendors are missing, one sentence each", () => {
    const violations = missingKeys({ worker: "deepseek-flash", reviewer: "gemini-3.8-flash" }, {});

    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.startsWith("DEEPSEEK_API_KEY"))).toBe(true);
    expect(violations.some((v) => v.startsWith("GEMINI_API_KEY"))).toBe(true);
  });

  it("reads the key and the variable name the operator needs", () => {
    expect(apiKeyFor("deepseek", { DEEPSEEK_API_KEY: "  sk-test  " })).toBe("sk-test");
    expect(apiKeyFor("deepseek", {})).toBeUndefined();
    expect(keyVarFor("deepseek")).toBe("DEEPSEEK_API_KEY");
  });
});

describe("REQ-010 — a rejected DeepSeek key fails with the vendor status and body, without retrying", () => {
  it("SC-010-a a rejected key surfaces the vendor status and body", async () => {
    const { impl, calls } = scriptedFetch([{ status: 401, text: "bad key" }]);

    await expect(deepseekClient("k", impl)(turn())).rejects.toThrow("deepseek API 401 Unauthorized: bad key");
    expect(calls).toHaveLength(1);
  });
});

describe("REQ-011 — a DeepSeek 429 is recognised as a quota wall", () => {
  it("SC-011-a a DeepSeek 429 is read as a usage limit", () => {
    const limit = usageLimitOf("deepseek API 429 Too Many Requests: You exceeded your current quota", 1_000);

    expect(limit).not.toBeNull();
    expect(limit!.said).toContain("deepseek API 429");
  });

  it("still refuses to read an agent's prose about a 429 as a quota wall", () => {
    // The vendor envelope is what makes this line safe. An agent editing a
    // retry policy writes the same words all day.
    expect(usageLimitOf("I fixed the handler that returns 429 when the quota is exceeded", 1_000)).toBeNull();
  });
});

describe("REQ-012 — a transient DeepSeek failure is retried at one and four seconds", () => {
  it("SC-012-a a transient DeepSeek failure is retried at one and four seconds", async () => {
    const { impl, calls } = scriptedFetch([
      { status: 503, text: "overloaded" },
      { status: 503, text: "overloaded" },
      { body: said("done") },
    ]);
    const sleeps: number[] = [];

    const out = await deepseekClient("k", impl, undefined, async (ms) => {
      sleeps.push(ms);
    })(turn());

    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1_000, 4_000]);
    expect(out.text).toBe("done");
  });

  it("gives up after the two retries rather than looping", async () => {
    const { impl, calls } = scriptedFetch([{ status: 503, text: "overloaded" }]);

    await expect(deepseekClient("k", impl, undefined, async () => undefined)(turn())).rejects.toThrow(/deepseek API 503/);
    expect(calls).toHaveLength(3);
  });
});

describe("REQ-016 — DeepSeek compaction starts at 1,000,000 characters", () => {
  it("SC-016-a the DeepSeek context budget is one million characters", () => {
    expect(budgetFor("deepseek-flash")).toBe(1_000_000);
  });
});

describe("client construction", () => {
  it("builds the DeepSeek client from DEEPSEEK_API_KEY", async () => {
    const { impl, calls } = scriptedFetch([{ body: said("done") }]);
    const client = clientFor("deepseek", { DEEPSEEK_API_KEY: "sk-test" }, impl);

    await client(turn({ tools: [] }));

    expect(calls[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-test");
  });

  it("refuses to build one without a key, naming the variable", () => {
    expect(() => clientFor("deepseek", {})).toThrow(/no API key for deepseek: set DEEPSEEK_API_KEY/);
  });
});
