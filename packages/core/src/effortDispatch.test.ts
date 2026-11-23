import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRole, ModelRoutingShape, RunConfig, effortLevels } from "@charrette/shared";

const { queryMock, reapUnderMock } = vi.hoisted(() => ({ queryMock: vi.fn(), reapUnderMock: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("./reaper.js", () => ({ reapUnder: reapUnderMock }));

import { Bus } from "./bus.js";
import { messageChars } from "./compact.js";
import { AgentPool, type AgentSpec } from "./pool.js";
import { googleClient, openaiClient, deepseekClient, patientFetch, type Fetch, type LoopMessage } from "./providerClients.js";
import { Store } from "./store.js";
import { toolLoop } from "./toolLoop.js";

/**
 * A role that silently ignores its effort setting is the failure this file
 * exists for. It looks like a working run at the wrong price or the wrong depth,
 * and nothing ever reports it. So the setting is checked at the last place it
 * can be seen: the options handed to the SDK and the body put on the wire.
 */

type Body = Record<string, unknown>;

let store: Store;
let pool: AgentPool;
let requests: { url: string; body: Body }[];

const SPEC: AgentSpec = {
  runId: "run1",
  role: "worker",
  model: "claude-opus-5-5",
  systemPrompt: "you are a worker",
  prompt: "build the thing",
  cwd: "/tmp/worktree",
  tools: [],
};
const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({ ...SPEC, ...over });

const RESULT = { type: "result", session_id: "sdk-1", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };
const sdkAnswers = (...runs: Record<string, unknown>[][]) => {
  let nth = 0;
  queryMock.mockImplementation(() => {
    const messages = runs[Math.min(nth++, runs.length - 1)]!;
    return (async function* () {
      for (const m of messages) yield m;
    })();
  });
};
const sdkOptions = (nth = 0) => (queryMock.mock.calls[nth]![0] as { options: { effort?: string; env: Record<string, string> } }).options;

/** Answers every vendor's wire format from one stub. */
function stubVendors(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) as Body });
      const reply = String(url).endsWith("/responses")
        ? { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: { input_tokens: 1, output_tokens: 1 } }
        : String(url).includes("generateContent")
          ? { candidates: [{ content: { parts: [{ text: "done" }] } }] }
          : { choices: [{ message: { content: "done" } }] };
      return { ok: true, status: 200, statusText: "OK", json: async () => reply, text: async () => "" };
    })
  );
}

function open(config: Record<string, unknown>): void {
  store = new Store(":memory:");
  store.createRun({
    id: "run1", repoPath: "/tmp/repo", assignment: "a", state: "CREATED", prdPath: null, planHash: null,
    integrationBranch: "charrette/run1/main", config: RunConfig.parse(config),
  });
  pool = new AgentPool(store, new Bus(store), async () => undefined);
}

beforeEach(() => {
  queryMock.mockReset();
  reapUnderMock.mockReset().mockResolvedValue([]);
  requests = [];
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.stubEnv("GEMINI_API_KEY", "gem-test");
  vi.stubEnv("DEEPSEEK_API_KEY", "ds-test");
  vi.stubEnv("CHARRETTE_RTK", "off");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("every dispatch carries the model's effort", () => {
  const roles = AgentRole.options;

  it.each(roles)("the %s role on Anthropic", async (role) => {
    open({ effort: { "claude-opus-5-5": "xhigh" } });
    sdkAnswers([RESULT]);
    await pool.run(spec({ role }));
    expect(sdkOptions().effort).toBe("xhigh");
    expect(sdkOptions().env.CLAUDE_CODE_EFFORT_LEVEL).toBe("xhigh");
  });

  it.each(roles)("the %s role on Google", async (role) => {
    open({ effort: { "gemini-4-neon": "xhigh" } });
    stubVendors();
    await pool.run(spec({ role, model: "gemini-4-neon" }));
    expect(requests[0]!.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "xhigh" } });
  });

  it.each(roles)("the %s role on DeepSeek", async (role) => {
    open({ effort: { "deepseek-flash": "max" } });
    stubVendors();
    await pool.run(spec({ role, model: "deepseek-flash" }));
    expect(requests[0]!.body.reasoning_effort).toBe("max");
  });

  it.each(roles)("the %s role on OpenAI", async (role) => {
    open({ effort: { "gpt-5.6-terra": "high" } });
    stubVendors();
    await pool.run(spec({ role, model: "gpt-5.6-terra" }));
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]!.body.reasoning).toEqual({ effort: "high" });
  });

  /**
   * The guard on the claim above. Every role reaches a vendor through
   * `AgentPool.run`, because that is the only code that opens a session. A new
   * path around it would pass every case above while ignoring the setting.
   */
  it("has no way to reach a model except through the pool", () => {
    const here = import.meta.dirname;
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const calling = (pattern: RegExp) => sources.filter((f) => pattern.test(readFileSync(path.join(here, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
    expect(calling(/(?<![.\w])query\(\{/)).toEqual(["pool.ts"]);
    expect(calling(/\btoolLoop\(\{/)).toEqual(["pool.ts"]);
    expect(calling(/\bclientFor\(/).filter((f) => f !== "providerClients.ts")).toEqual(["toolLoop.ts"]);
  });
});

describe("a model with nothing set", () => {
  it("sends nothing to Anthropic", async () => {
    open({ effort: { "claude-sonnet-5-5": "high" } });
    sdkAnswers([RESULT]);
    await pool.run(spec());
    expect(sdkOptions()).not.toHaveProperty("effort");
    expect(sdkOptions().env).not.toHaveProperty("CLAUDE_CODE_EFFORT_LEVEL");
  });

  it("leaves Google's request as it always was", async () => {
    open({});
    stubVendors();
    await pool.run(spec({ model: "gemini-4-neon" }));
    expect(requests[0]!.body).not.toHaveProperty("generationConfig");
  });

  it("leaves DeepSeek's request as it always was", async () => {
    open({});
    stubVendors();
    await pool.run(spec({ model: "deepseek-flash" }));
    expect(requests[0]!.body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps OpenAI on Chat Completions", async () => {
    open({});
    stubVendors();
    await pool.run(spec({ model: "gpt-5.6-terra" }));
    expect(requests[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]!.body).not.toHaveProperty("reasoning_effort");
    expect(requests[0]!.body).not.toHaveProperty("reasoning");
  });

  it("ignores a level a caller put on the spec: the run's table decides", async () => {
    open({});
    sdkAnswers([RESULT]);
    await pool.run(spec({ effort: "max" }));
    expect(sdkOptions()).not.toHaveProperty("effort");
  });
});

describe("when the setting changes", () => {
  it("the next session uses the new level", async () => {
    open({ effort: { "claude-opus-5-5": "low" } });
    sdkAnswers([RESULT]);
    await pool.run(spec());
    store.patchRunConfig("run1", { effort: { "claude-opus-5-5": "max" } });
    await pool.run(spec());
    expect(sdkOptions(0).effort).toBe("low");
    expect(sdkOptions(1).effort).toBe("max");
  });

  /** A wait for a usage limit continues one session, so it keeps that session's level. */
  it("a session continued after a usage limit keeps the level it started with", async () => {
    open({ effort: { "claude-opus-5-5": "low" } });
    const limited = { ...RESULT, is_error: true, result: "You've hit your session limit, try again in 5 minutes" };
    let nth = 0;
    queryMock.mockImplementation(() => {
      const first = nth++ === 0;
      if (first) store.patchRunConfig("run1", { effort: { "claude-opus-5-5": "max" } });
      return (async function* () {
        yield first ? limited : RESULT;
      })();
    });
    await pool.run(spec());
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(sdkOptions(1).effort).toBe("low");
  });
});

describe("the tool loop", () => {
  it("keeps the level on the wrap-up turn at the turn limit", async () => {
    const seen: (string | undefined)[] = [];
    const prompts = ["go"];
    const loop = toolLoop({
      spec: { model: "gemini-4-neon", systemPrompt: "s", cwd: "/tmp", maxTurns: 1, effort: "high" },
      prompts: { next: async () => prompts.shift() ?? null, drain: () => [] },
      signal: new AbortController().signal,
      toolsOverride: [{ name: "Bash", description: "d", parameters: {}, run: async () => "ok" }],
      client: async (req) => {
        seen.push(req.effort);
        return { text: "", toolCalls: seen.length === 1 ? [{ id: "c1", name: "Bash", input: {} }] : [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    });
    for await (const _ of loop) void _;
    expect(seen).toEqual(["high", "high"]);
  });

  it("replays OpenAI's items with the tool result they led to", async () => {
    const items = [{ type: "reasoning", id: "rs_1", encrypted_content: "opaque" }, { type: "function_call", call_id: "c1", name: "Bash", arguments: "{}" }];
    const sent: LoopMessage[][] = [];
    const prompts = ["go"];
    const loop = toolLoop({
      spec: { model: "gpt-5.6-terra", systemPrompt: "s", cwd: "/tmp", effort: "high" },
      prompts: { next: async () => prompts.shift() ?? null, drain: () => [] },
      signal: new AbortController().signal,
      toolsOverride: [{ name: "Bash", description: "d", parameters: {}, run: async () => "ok" }],
      client: async (req) => {
        sent.push([...req.messages]);
        const first = sent.length === 1;
        return { text: first ? "" : "done", toolCalls: first ? [{ id: "c1", name: "Bash", input: {} }] : [], items: first ? items : [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
      },
    });
    for await (const _ of loop) void _;
    expect(sent[1]![1]).toMatchObject({ role: "assistant", items });
  });
});

describe("what each vendor's client puts on the wire", () => {
  const signal = new AbortController().signal;
  const tool = { name: "Bash", description: "run", parameters: { type: "object", properties: {} }, run: async () => "" };

  function wire(reply: unknown, status = 200) {
    const calls: { url: string; body: Body }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Body });
      return { ok: status < 400, status, statusText: "x", json: async () => reply, text: async () => JSON.stringify(reply) };
    }) as unknown as Fetch;
    return { impl, calls };
  }
  const turn = (over: Record<string, unknown> = {}) => ({ model: "gpt-5.6-sol", system: "sys", messages: [{ role: "user", text: "hi" }] as LoopMessage[], tools: [], signal, effort: "high" as const, ...over });

  it("Google: keeps the output ceiling beside the thinking level", async () => {
    const { impl, calls } = wire({ candidates: [] });
    await googleClient("k", impl)(turn({ model: "gemini-4-neon", maxOutputTokens: 500 }));
    expect(calls[0]!.body.generationConfig).toEqual({ maxOutputTokens: 500, thinkingConfig: { thinkingLevel: "high" } });
  });

  it("Google: sends the ceiling alone when no level is set", async () => {
    const { impl, calls } = wire({ candidates: [] });
    await googleClient("k", impl)(turn({ model: "gemini-4-neon", maxOutputTokens: 500, effort: undefined }));
    expect(calls[0]!.body.generationConfig).toEqual({ maxOutputTokens: 500 });
  });

  it("DeepSeek: sends reasoning_effort on Chat Completions", async () => {
    const { impl, calls } = wire({ choices: [] });
    await deepseekClient("k", impl)(turn({ model: "deepseek-flash", effort: "low" }));
    expect(calls[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0]!.body.reasoning_effort).toBe("low");
  });

  it("OpenAI: sends the whole conversation in the Responses shape", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "opaque" };
    const call = { type: "function_call", call_id: "c1", name: "Bash", arguments: "{}" };
    const { impl, calls } = wire({ status: "completed", output: [] });
    const messages: LoopMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "Bash", input: {} }], items: [reasoning, call] },
      { role: "tool", callId: "c1", name: "Bash", text: "a.ts" },
      { role: "assistant", text: "[Checkpoint digest]", toolCalls: [] },
    ];
    await openaiClient("k", impl)(turn({ messages, tools: [tool], maxOutputTokens: 900, effort: "xhigh" }));
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]!.body).toEqual({
      model: "gpt-5.6-sol",
      instructions: "sys",
      input: [
        { role: "user", content: "go" },
        reasoning,
        call,
        { type: "function_call_output", call_id: "c1", output: "a.ts" },
        { role: "assistant", content: "[Checkpoint digest]" },
      ],
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "xhigh" },
      tools: [{ type: "function", name: "Bash", description: "run", parameters: tool.parameters, strict: false }],
      max_output_tokens: 900,
    });
  });

  it("OpenAI: reads text, calls and usage, with reasoning inside the output tokens", async () => {
    const output = [
      { type: "reasoning", id: "rs_1" },
      { type: "message", content: [{ type: "output_text", text: "a" }, { type: "refusal", refusal: "no" }, { type: "output_text", text: "b" }, { type: "output_text" }] },
      { type: "message", content: "not a list" },
      { type: "function_call", call_id: "c9", name: "Bash", arguments: '{"command":"ls"}' },
      { type: "function_call", arguments: "not json" },
    ];
    const { impl } = wire({ status: "completed", output, usage: { input_tokens: 100, output_tokens: 70, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 50 } } });
    const out = await openaiClient("k", impl)(turn());
    expect(out.text).toBe("ab");
    expect(out.toolCalls).toEqual([{ id: "c9", name: "Bash", input: { command: "ls" } }, { id: "call_4", name: "", input: {} }]);
    expect(out.usage).toEqual({ inputTokens: 60, outputTokens: 70, cacheReadTokens: 40, cacheWriteTokens: 0 });
    expect(out.items).toEqual(output);
  });

  it("OpenAI: copes with a reply that has no output or usage", async () => {
    const { impl } = wire({ status: "completed" });
    const out = await openaiClient("k", impl)(turn());
    expect(out).toEqual({ text: "", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, items: [] });
  });

  it("OpenAI: a reply cut off keeps its prose and drops the half-written call", async () => {
    const output = [
      { type: "reasoning", id: "rs_1" },
      { type: "message", content: [{ type: "output_text", text: "partial" }] },
      { type: "function_call", call_id: "c1", name: "Bash", arguments: '{"comm', status: "incomplete" },
    ];
    const { impl } = wire({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output, usage: { input_tokens: 5, output_tokens: 9 } });
    const out = await openaiClient("k", impl)(turn());
    expect(out.text).toBe("partial");
    expect(out.toolCalls).toEqual([]);
    expect(out.items).toEqual([{ role: "assistant", content: "partial" }]);
    expect(out.usage.outputTokens).toBe(9);
  });

  it("OpenAI: a reply cut off before any prose leaves nothing to replay", async () => {
    const { impl } = wire({ status: "incomplete", output: [{ type: "reasoning", id: "rs_1" }] });
    const out = await openaiClient("k", impl)(turn());
    expect(out.items).toEqual([]);
  });

  it("OpenAI: a failed response is an error, not an empty answer", async () => {
    const { impl } = wire({ status: "failed", error: { code: "server_error", message: "boom" } });
    await expect(openaiClient("k", impl)(turn())).rejects.toThrow("openai API failed server_error: boom");
  });

  it("OpenAI: a failed response with no detail still says so", async () => {
    const { impl } = wire({ status: "failed", error: null });
    await expect(openaiClient("k", impl)(turn())).rejects.toThrow("openai API failed unknown: the response failed");
  });

  it("OpenAI: a rate limit inside a failed response keeps the envelope the wait logic reads", async () => {
    const { impl } = wire({ status: "failed", error: { code: "rate_limit_exceeded", message: "slow down" } });
    await expect(openaiClient("k", impl)(turn())).rejects.toThrow(/^Error: openai API 429 |openai API 429 rate_limit_exceeded/);
  });

  it("counts OpenAI's items toward the context budget, since they go back in full", () => {
    const items = [{ type: "reasoning", encrypted_content: "x".repeat(1000) }];
    expect(messageChars({ role: "assistant", text: "", toolCalls: [], items })).toBe(JSON.stringify(items).length);
  });
});

describe("waiting on a long turn", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      s.close();
    }
  });

  async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("delivers the method, headers, body and answer", async () => {
    const seen: { method?: string; auth?: string; body: string } = { body: "" };
    const url = await serve((req, res) => {
      seen.method = req.method;
      seen.auth = req.headers.authorization;
      req.on("data", (c) => (seen.body += String(c)));
      req.on("end", () => {
        res.statusCode = 201;
        res.statusMessage = "Made";
        res.end('{"fine":true}');
      });
    });
    const res = await patientFetch(url, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(seen).toEqual({ method: "POST", auth: "Bearer t", body: "{}" });
    expect([res.status, res.statusText, res.ok]).toEqual([201, "Made", true]);
    expect(await res.json()).toEqual({ fine: true });
  });

  it("carries a status with no body", async () => {
    const url = await serve((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    expect((await patientFetch(url)).status).toBe(204);
  });

  it("reports a connection that fails", async () => {
    const url = await serve((_req, res) => res.destroy());
    await expect(patientFetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
  });

  it("stops when the watchdog aborts it", async () => {
    const url = await serve(() => undefined);
    const abort = new AbortController();
    const pending = patientFetch(url, { method: "POST", body: "{}", signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("is what a session with a level set uses, and one without stays on fetch", async () => {
    let hits = 0;
    const url = await serve((_req, res) => {
      hits++;
      res.setHeader("content-type", "application/json");
      res.end('{"candidates":[]}');
    });
    const request = { model: "gemini-4-neon", system: "s", messages: [{ role: "user" as const, text: "hi" }], tools: [], signal: new AbortController().signal };
    await googleClient("k", undefined, url)({ ...request, effort: "high" });
    expect(hits).toBe(1);

    const spy = vi.fn(globalThis.fetch);
    await googleClient("k", spy as Fetch, url)({ ...request, effort: "high" });
    await googleClient("k", spy as Fetch, url)(request);
    // An injected transport is always honoured.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("a recorded run whose effort no longer holds", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A database with one run, its stored config rewritten as an older charrette left it. */
  function recorded(edit: (config: Record<string, unknown>) => unknown): string {
    const dir = mkdtempSync(path.join(tmpdir(), "charrette-effort-"));
    dirs.push(dir);
    const file = path.join(dir, "state.db");
    const first = new Store(file);
    first.createRun({ id: "old", repoPath: "/r", assignment: "a", state: "EXECUTING", prdPath: null, planHash: null, integrationBranch: "b", config: RunConfig.parse({}) });
    const row = first.db.prepare("SELECT config FROM runs WHERE id = 'old'").get() as { config: string };
    const next = edit(JSON.parse(row.config) as Record<string, unknown>);
    first.db.prepare("UPDATE runs SET config = ? WHERE id = 'old'").run(typeof next === "string" ? next : JSON.stringify(next));
    first.db.close();
    return file;
  }

  it("stays readable, drops the level, and says which", () => {
    const store = new Store(recorded((c) => ({ ...c, effort: { "gemini-3.6-flash": "minimal", "gemini-4-neon": "high" } })));
    expect(store.getRun("old")!.config.effort).toEqual({ "gemini-4-neon": "high" });
    expect(store.effortDroppedAtOpen("old")).toEqual(["gemini-3.6-flash=minimal"]);
    store.db.close();
  });

  it("moves a retired key to its replacement without calling it dropped", () => {
    const store = new Store(recorded((c) => ({ ...c, effort: { "claude-opus-5": "max" } })));
    expect(store.getRun("old")!.config.effort).toEqual({ "claude-opus-5-5": "max" });
    expect(store.effortDroppedAtOpen("old")).toEqual([]);
    store.db.close();
  });

  it("leaves a run from before effort existed exactly as it was", () => {
    const file = recorded((c) => {
      const { effort: _gone, ...rest } = c;
      return rest;
    });
    const store = new Store(file);
    const raw = store.db.prepare("SELECT config FROM runs WHERE id = 'old'").get() as { config: string };
    expect(JSON.parse(raw.config)).not.toHaveProperty("effort");
    expect(store.getRun("old")!.config.effort).toEqual({});
    store.db.close();
  });

  it("does not rewrite a block that is already right", () => {
    const store = new Store(recorded((c) => ({ ...c, effort: { "gemini-4-neon": "high" } })));
    expect(store.effortDroppedAtOpen("old")).toEqual([]);
    expect(store.getRun("old")!.config.effort).toEqual({ "gemini-4-neon": "high" });
    store.db.close();
  });

  it("survives a row it cannot read", () => {
    const store = new Store(recorded(() => "{ not json"));
    expect(store.effortDroppedAtOpen("old")).toEqual([]);
    store.db.close();
  });
});

describe("the table against the models a run can route to", () => {
  it("covers every default role's model", () => {
    for (const model of Object.values(ModelRoutingShape.parse({}))) expect(effortLevels(model).length).toBeGreaterThan(0);
  });
});
