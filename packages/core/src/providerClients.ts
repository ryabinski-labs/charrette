import { modelId, providerFor, type Provider } from "@charrette/shared";
import type { LocalTool } from "./agentTools.js";

/**
 * The two non-Anthropic APIs the charrette can drive, behind one small interface.
 *
 * Deliberately raw `fetch` rather than each vendor's SDK. Two reasons, in
 * order: the request the charrette sends is the request a test can assert on, so
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
  /**
   * An opaque token the provider attached to this call and requires back,
   * unchanged, when the call is replayed as history.
   *
   * Google's alone so far: a Gemini 3.x model signs the reasoning behind each
   * function call, and rejects the next turn outright if the signature does not
   * come back with it. Kept here rather than in the Google client because the
   * loop owns the transcript — the client is handed a list of messages and has
   * no memory of the turn it produced them from.
   */
  signature?: string;
}

export type LoopMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; signature?: string }
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
  /** As `ToolCall.signature`, for the turn's own text part. */
  signature?: string;
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
 * Checked at `charrette run`, beside the routing policy, because the alternative
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

/** Waits between attempts. Injected in tests, `setTimeout` in production. */
export type Sleep = (ms: number) => Promise<void>;

const sleepMs: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The vendor is briefly unable, rather than refusing.
 *
 * 429 is deliberately absent. A rate limit is not transient in seconds — it is
 * a quota window, and the charrette already has a mechanism for one that is
 * better than anything this loop could do: `usageLimitOf` recognises it and
 * `AgentPool.run` sleeps until it lifts, keeping the session, its ledger row
 * and its handle for operator feedback, and saying so on the bus. Retrying a
 * 429 here would spend two more requests against the wall that just refused
 * one, and delay reaching the code that handles it properly.
 */
const TRANSIENT = new Set([500, 502, 503, 504]);

/**
 * How long to wait before trying a transient failure again. Two retries, both
 * quick: this is for the seconds-long blip ("The model is overloaded, please
 * try again later" — Gemini's 503, which it serves under ordinary load), not
 * for an outage, which the stall watchdog and the caller's own retries own.
 */
const TRANSIENT_BACKOFF_MS = [1_000, 4_000];

/**
 * One request, retried while the vendor is merely unwell.
 *
 * The Anthropic transport never needed this: the Agent SDK retries a 5xx
 * internally, so every role in the charrette had that resilience without anyone
 * writing it. Roles on this transport had none — which cost nothing while it
 * carried only what an operator had deliberately moved, and started costing on
 * the day `models.reviewer` was pinned to Google. A pit stop's reviewers all
 * fire at once against the same endpoint, so one overloaded minute took all
 * three lenses, and `runLens` degrades a dead reviewer to `verdict: "on-track"`
 * — a transient 503 bought a quiet pass on the judgment the pit stop exists for.
 */
async function post(fetchImpl: Fetch, url: string, init: RequestInit, provider: Provider, sleep: Sleep = sleepMs): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, init);
    if (res.ok) return (await res.json()) as unknown;
    const body = await res.text().catch(() => "");
    if (TRANSIENT.has(res.status) && attempt < TRANSIENT_BACKOFF_MS.length) {
      await sleep(TRANSIENT_BACKOFF_MS[attempt]!);
      continue;
    }
    // The status is the diagnosable part — 401 is a key, 429 is a cap, 400 is
    // usually a tool schema — so it goes in the message rather than the log.
    //
    // The body is kept long enough to carry the vendor's own retry hint:
    // Google's 429 states its `RetryInfo` after a `QuotaFailure` block that is
    // itself several hundred characters, and `usageLimitOf` reads that hint to
    // decide how long to wait. Truncating at 500 dropped the one field in the
    // reply that says when to come back.
    throw new Error(`${provider} API ${res.status} ${res.statusText}: ${body.slice(0, 1500)}`);
  }
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** OpenAI Chat Completions. */
export function openaiClient(apiKey: string, fetchImpl: Fetch = globalThis.fetch, baseUrl = "https://api.openai.com/v1", sleep: Sleep = sleepMs): ProviderClient {
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
      "openai",
      sleep
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
  baseUrl = "https://generativelanguage.googleapis.com/v1beta",
  sleep: Sleep = sleepMs
): ProviderClient {
  return async (req) => {
    const contents: Record<string, unknown>[] = [];
    for (const m of req.messages) {
      if (m.role === "user") contents.push({ role: "user", parts: [{ text: m.text }] });
      else if (m.role === "assistant") {
        const parts: Record<string, unknown>[] = [];
        // A Gemini 3.x model signs the reasoning behind what it emits and
        // requires the signature back with the part it came from. Dropping it
        // does not degrade the next turn, it ends the session: "Function call is
        // missing a thought_signature in functionCall parts", 400, every time —
        // so the first turn worked, and the second, which is the first to carry
        // a tool call back as history, never did. `models.reviewer` runs here on
        // every pit stop, and a reviewer that cannot start is reported as
        // "on-track" rather than as broken, so the run bought a rubber stamp.
        if (m.text) parts.push({ text: m.text, ...(m.signature ? { thoughtSignature: m.signature } : {}) });
        for (const c of m.toolCalls) {
          parts.push({ functionCall: { name: c.name, args: c.input }, ...(c.signature ? { thoughtSignature: c.signature } : {}) });
        }
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
      "google",
      sleep
    );

    const parts = ((body as { candidates?: { content?: { parts?: unknown } }[] }).candidates?.[0]?.content?.parts ?? []) as Record<string, unknown>[];
    const meta = (body as { usageMetadata?: Record<string, unknown> }).usageMetadata ?? {};
    const cached = toNumber(meta.cachedContentTokenCount);
    const toolCalls: ToolCall[] = [];
    let text = "";
    let signature: string | undefined;
    for (const [i, part] of parts.entries()) {
      // Per part, not per turn: the model signs each thing it emits, and each
      // has to go back attached to the part it belongs to.
      const sig = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
      if (typeof part.text === "string") {
        text += part.text;
        signature = signature ?? sig;
      }
      const call = part.functionCall as { name?: unknown; args?: unknown } | undefined;
      if (call && typeof call.name === "string") {
        toolCalls.push({
          // Gemini does not issue call ids; the loop needs one to pair results.
          id: `call_${i}`,
          name: call.name,
          input: call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {},
          ...(sig ? { signature: sig } : {}),
        });
      }
    }
    return {
      text,
      toolCalls,
      ...(signature ? { signature } : {}),
      usage: {
        inputTokens: Math.max(0, toNumber(meta.promptTokenCount) - cached),
        // `thoughtsTokenCount` is *not* inside `candidatesTokenCount` — the two
        // are siblings that sum into `totalTokenCount` — and Google bills
        // thinking at the output rate. Reading candidates alone is the whole
        // spend of a reasoning model minus its reasoning: a live 3.6-flash call
        // answered 20 candidate tokens against 43 thought tokens, so the ledger
        // would have booked under a third of what the call cost. Gemini 3.x
        // thinks by default, and `models.reviewer` runs here on every pit stop,
        // so this is every run. (OpenAI needs no such addition: its
        // `completion_tokens` already contains `reasoning_tokens`.)
        outputTokens: toNumber(meta.candidatesTokenCount) + toNumber(meta.thoughtsTokenCount),
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
  throw new Error(`${provider} does not use the charrette tool loop`);
}
