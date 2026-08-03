import { modelId, providerFor, type Provider } from "@harness/shared";
import type { LocalTool } from "./agentTools.js";

/**
 * The two non-Anthropic APIs the harness can drive, behind one small interface.
 *
 * Deliberately raw `fetch` rather than each vendor's SDK. Two reasons, in
 * order: the request the harness sends is the request a test can assert on, so
 * "does the guard reach the shell before the model does" is provable without a
 * network or a mock framework; and a vendor SDK is another dependency in the
 * path that spawns agents, which is the path where a surprise costs money.
 *
 * Not streamed. Deltas would buy nothing here — pool.ts books usage and
 * publishes text per whole assistant message, never per token — and a
 * non-streamed round trip has one failure mode instead of three.
 */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LoopMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; text: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ProviderTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export interface TurnRequest {
  model: string;
  system: string;
  messages: LoopMessage[];
  tools: LocalTool[];
  maxOutputTokens?: number;
  signal: AbortSignal;
}

export type ProviderClient = (req: TurnRequest) => Promise<ProviderTurn>;

/** Injected in tests; `globalThis.fetch` in production. */
export type Fetch = typeof globalThis.fetch;

/** Where each vendor's key is read from, in the order the vendor documents. */
const KEY_VARS: Record<Provider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

/** The API key for a provider, or undefined when the operator has not set one. */
export function apiKeyFor(provider: Provider, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of KEY_VARS[provider]) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

/** The variable an operator should set, named for the error message. */
export function keyVarFor(provider: Provider): string {
  return KEY_VARS[provider][0]!;
}

/**
 * Providers a routing table needs a key for and does not have, one sentence
 * each, naming the roles that would have failed.
 *
 * Checked at `harness run`, beside the routing policy, because the alternative
 * is finding out at the first dispatch of that role — which for `demo` is at
 * the first pit stop, after every worker in the epic has been paid for.
 */
export function missingKeys(models: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string[] {
  const affected = new Map<Provider, string[]>();
  for (const [role, model] of Object.entries(models)) {
    const provider = providerFor(model);
    if (provider === "anthropic" || apiKeyFor(provider, env)) continue;
    const roles = affected.get(provider) ?? [];
    roles.push(`${role} (${model})`);
    affected.set(provider, roles);
  }
  return [...affected].map(([provider, roles]) => `${keyVarFor(provider)} is not set, but ${roles.join(" and ")} ${roles.length === 1 ? "is" : "are"} routed to ${provider}.`);
}

async function post(fetchImpl: Fetch, url: string, init: RequestInit, provider: Provider): Promise<unknown> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // The status is the diagnosable part — 401 is a key, 429 is a cap, 400 is
    // usually a tool schema — so it goes in the message rather than the log.
    throw new Error(`${provider} API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as unknown;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** OpenAI Chat Completions. */
export function openaiClient(apiKey: string, fetchImpl: Fetch = globalThis.fetch, baseUrl = "https://api.openai.com/v1"): ProviderClient {
  return async (req) => {
    const messages: Record<string, unknown>[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.text });
      else if (m.role === "assistant") {
        messages.push({
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls.length
            ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
            : {}),
        });
      } else messages.push({ role: "tool", tool_call_id: m.callId, content: m.text });
    }

    const body = await post(
      fetchImpl,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        signal: req.signal,
        body: JSON.stringify({
          model: modelId(req.model),
          messages,
          ...(req.tools.length
            ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
            : {}),
          ...(req.maxOutputTokens ? { max_completion_tokens: req.maxOutputTokens } : {}),
        }),
      },
      "openai"
    );

    const choice = (body as { choices?: { message?: Record<string, unknown> }[] }).choices?.[0]?.message ?? {};
    const usage = (body as { usage?: Record<string, unknown> }).usage ?? {};
    const cached = toNumber((usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens);
    const rawCalls = Array.isArray(choice.tool_calls) ? (choice.tool_calls as Record<string, unknown>[]) : [];
    return {
      text: typeof choice.content === "string" ? choice.content : "",
      toolCalls: rawCalls.map((c, i) => {
        const fn = (c.function ?? {}) as { name?: unknown; arguments?: unknown };
        return {
          id: typeof c.id === "string" ? c.id : `call_${i}`,
          name: typeof fn.name === "string" ? fn.name : "",
          input: parseArgs(fn.arguments),
        };
      }),
      usage: {
        // OpenAI's prompt_tokens includes the cached ones; the ledger prices
        // them separately, so subtract rather than book them at full rate.
        inputTokens: Math.max(0, toNumber(usage.prompt_tokens) - cached),
        outputTokens: toNumber(usage.completion_tokens),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  };
}

/**
 * Tool arguments arrive as a JSON *string*, and a model occasionally emits one
 * that does not parse. An empty object lets the tool answer "missing argument",
 * which the agent can fix; throwing here would kill the session instead.
 */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Google Gemini generateContent. */
export function googleClient(
  apiKey: string,
  fetchImpl: Fetch = globalThis.fetch,
  baseUrl = "https://generativelanguage.googleapis.com/v1beta"
): ProviderClient {
  return async (req) => {
    const contents: Record<string, unknown>[] = [];
    for (const m of req.messages) {
      if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.text }] });
      else if (m.role === "assistant") {
        const parts: Record<string, unknown>[] = [];
        if (m.text) parts.push({ text: m.text });
        for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.input } });
        // Gemini rejects a content block with no parts at all.
        contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      } else {
        contents.push({ role: "user", parts: [{ functionResponse: { name: m.name, response: { result: m.text } } }] });
      }
    }

    const body = await post(
      fetchImpl,
      `${baseUrl}/models/${encodeURIComponent(modelId(req.model))}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        signal: req.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents,
          ...(req.tools.length
            ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }
            : {}),
          ...(req.maxOutputTokens ? { generationConfig: { maxOutputTokens: req.maxOutputTokens } } : {}),
        }),
      },
      "google"
    );

    const parts = ((body as { candidates?: { content?: { parts?: unknown } }[] }).candidates?.[0]?.content?.parts ?? []) as Record<string, unknown>[];
    const meta = (body as { usageMetadata?: Record<string, unknown> }).usageMetadata ?? {};
    const cached = toNumber(meta.cachedContentTokenCount);
    const toolCalls: ToolCall[] = [];
    let text = "";
    for (const [i, part] of parts.entries()) {
      if (typeof part.text === "string") text += part.text;
      const call = part.functionCall as { name?: unknown; args?: unknown } | undefined;
      if (call && typeof call.name === "string") {
        toolCalls.push({
          // Gemini does not issue call ids; the loop needs one to pair results.
          id: `call_${i}`,
          name: call.name,
          input: call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {},
        });
      }
    }
    return {
      text,
      toolCalls,
      usage: {
        inputTokens: Math.max(0, toNumber(meta.promptTokenCount) - cached),
        outputTokens: toNumber(meta.candidatesTokenCount),
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      },
    };
  };
}

/** The client for a model, or throws with the variable the operator should set. */
export function clientFor(provider: Provider, env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = globalThis.fetch): ProviderClient {
  const key = apiKeyFor(provider, env);
  if (!key) throw new Error(`no API key for ${provider}: set ${keyVarFor(provider)}`);
  if (provider === "openai") return openaiClient(key, fetchImpl);
  if (provider === "google") return googleClient(key, fetchImpl);
  // Anthropic runs on the SDK transport and never arrives here. Saying so out
  // loud beats returning something plausible if that ever stops being true.
  throw new Error(`${provider} does not use the harness tool loop`);
}
