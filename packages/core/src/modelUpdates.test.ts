import { describe, expect, it, vi } from "vitest";
import { isPriced } from "./budget.js";
import { listModels, modelFamily, modelRecommendations, newerModel, newerModelBanner } from "./modelUpdates.js";
import type { Fetch } from "./providerClients.js";

/** A fetch that answers each URL prefix with a body, and records what it was asked. */
function fakeFetch(bodies: Record<string, unknown>, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = Object.keys(bodies).find((k) => url.startsWith(k));
    if (!key) throw new Error(`unexpected ${url}`);
    return { ok: status < 400, status, json: async () => bodies[key] } as Response;
  }) as unknown as Fetch;
  return { fetchImpl, calls };
}

const ANTHROPIC = "https://api.anthropic.com/v1/models";
const GOOGLE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI = "https://api.openai.com/v1/models";

describe("what a model id says about its family and version", () => {
  it("reads Claude ids with and without a minor version or a date", () => {
    expect(modelFamily("claude-sonnet-5")).toEqual({ provider: "anthropic", family: "sonnet", version: [5, 0] });
    expect(modelFamily("claude-opus-5-5")).toEqual({ provider: "anthropic", family: "opus", version: [5, 5] });
    expect(modelFamily("claude-haiku-4-5-20251001")).toEqual({ provider: "anthropic", family: "haiku", version: [4, 5] });
    expect(modelFamily("anthropic/claude-fable-5-2")).toEqual({ provider: "anthropic", family: "fable", version: [5, 2] });
  });

  it("reads Gemini's tier as the family, so Flash and Flash-Lite never cross", () => {
    expect(modelFamily("gemini-3.8-flash")).toEqual({ provider: "google", family: "flash", version: [3, 8] });
    expect(modelFamily("gemini-3.5-flash-lite")).toEqual({ provider: "google", family: "flash-lite", version: [3, 5] });
  });

  it("reads GPT ids with and without a tier name", () => {
    expect(modelFamily("gpt-5.6-terra")).toEqual({ provider: "openai", family: "terra", version: [5, 6] });
    expect(modelFamily("gpt-5")).toEqual({ provider: "openai", family: "", version: [5] });
  });

  it("has nothing to say about ids with no comparable version", () => {
    // DeepSeek serves its current checkpoint behind the unversioned name.
    expect(modelFamily("deepseek-flash")).toBeUndefined();
    expect(modelFamily("claude-instant")).toBeUndefined();
    expect(modelFamily("gemini-pro-latest")).toBeUndefined();
    expect(modelFamily("gpt-image")).toBeUndefined();
  });
});

describe("the newest model in the same family", () => {
  const listed = ["claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-4-6"];

  it("finds the newer one, and only in the same family", () => {
    expect(newerModel("claude-sonnet-5", listed)).toBe("claude-sonnet-5-5");
    expect(newerModel("claude-opus-5", listed)).toBe("claude-opus-5-5");
  });

  it("never recommends across tiers, which keeps a judge above its floor", () => {
    expect(newerModel("claude-sonnet-5-5", listed)).toBeUndefined();
    expect(newerModel("gemini-3.8-flash", ["gemini-3.9-flash-lite", "gemini-4.0-pro"])).toBeUndefined();
  });

  it("picks the newest of several, and the undated alias over a dated id of the same version", () => {
    expect(newerModel("gemini-3.6-flash", ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.10-flash"])).toBe("gemini-3.10-flash");
    expect(newerModel("claude-haiku-4-5-20251001", ["claude-haiku-5-5-20261101", "claude-haiku-5-5"])).toBe("claude-haiku-5-5");
    expect(newerModel("claude-haiku-4-5-20251001", ["claude-haiku-5-5", "claude-haiku-5-5-20261101"])).toBe("claude-haiku-5-5");
  });

  it("compares versions of different lengths as if padded with zeros", () => {
    expect(newerModel("gpt-5", ["gpt-5.1"])).toBe("gpt-5.1");
    expect(newerModel("gpt-5.1", ["gpt-5", "gpt-5.0"])).toBeUndefined();
  });

  it("says nothing for a model it cannot place", () => {
    expect(newerModel("deepseek-flash", ["deepseek-flash-2"])).toBeUndefined();
    expect(newerModel("claude-sonnet-5", ["not-a-model", "gemini-9.9-sonnet"])).toBeUndefined();
  });
});

describe("the recommendation an operator reads", () => {
  it("groups the roles on one model into one line, with both ways to switch", () => {
    const lines = modelRecommendations(
      { intake: "claude-opus-5", prod: "claude-opus-5", qa: "claude-sonnet-5-5", worker: "deepseek-flash" },
      { anthropic: ["claude-opus-5-5", "claude-sonnet-5-5"] }
    );
    expect(lines).toEqual([
      'claude-opus-5-5 is newer than claude-opus-5 (intake, prod). To switch: --model intake=claude-opus-5-5 --model prod=claude-opus-5-5, or "models": { "intake": "claude-opus-5-5", "prod": "claude-opus-5-5" } in charrette.config.json.',
    ]);
  });

  it("warns when the newer model is not priced yet", () => {
    expect(isPriced("claude-sonnet-6")).toBe(false);
    const [line] = modelRecommendations({ qa: "claude-sonnet-5-5" }, { anthropic: ["claude-sonnet-6"] });
    expect(line).toContain("bills it at the $10/$50 fallback");
  });

  it("skips a vendor it has no list for", () => {
    expect(modelRecommendations({ planner: "gemini-3.6-flash" }, {})).toEqual([]);
  });
});

describe("asking each vendor what it serves", () => {
  it("asks Anthropic with the API key when there is one", async () => {
    const { fetchImpl, calls } = fakeFetch({ [ANTHROPIC]: { data: [{ id: "claude-opus-5-5" }, { nope: 1 }] } });
    expect(await listModels("anthropic", { env: { ANTHROPIC_API_KEY: "sk" }, fetchImpl })).toEqual(["claude-opus-5-5"]);
    expect(calls[0]!.headers["x-api-key"]).toBe("sk");
  });

  it("reads the installed SDK's table for an operator signed in without a key", async () => {
    const sdkModels = vi.fn(async () => ["claude-sonnet-5-5"]);
    expect(await listModels("anthropic", { env: {}, sdkModels })).toEqual(["claude-sonnet-5-5"]);
  });

  it("falls back to the SDK the charrette has installed when nothing is injected", async () => {
    const list = await listModels("anthropic", { env: {} });
    // Whatever this checkout's SDK lists; the point is that it is read, not empty.
    expect(list === undefined || list.some((id) => id.startsWith("claude-"))).toBe(true);
  });

  it("asks Google with its key in a header and strips the resource prefix", async () => {
    const { fetchImpl, calls } = fakeFetch({ [GOOGLE]: { models: [{ name: "models/gemini-3.9-flash" }] } });
    expect(await listModels("google", { env: { GEMINI_API_KEY: "g" }, fetchImpl })).toEqual(["gemini-3.9-flash"]);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("g");
    expect(calls[0]!.url).not.toContain("g&");
  });

  it("asks OpenAI with a bearer token", async () => {
    const { fetchImpl, calls } = fakeFetch({ [OPENAI]: { data: [{ id: "gpt-5.7-terra" }] } });
    expect(await listModels("openai", { env: { OPENAI_API_KEY: "o" }, fetchImpl })).toEqual(["gpt-5.7-terra"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer o");
  });

  it("does not ask without a key, and never asks DeepSeek", async () => {
    const { fetchImpl, calls } = fakeFetch({});
    expect(await listModels("google", { env: {}, fetchImpl })).toBeUndefined();
    expect(await listModels("deepseek", { env: { DEEPSEEK_API_KEY: "d" }, fetchImpl })).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("is silent about a refusal, a network failure or an unexpected shape", async () => {
    expect(await listModels("google", { env: { GEMINI_API_KEY: "g" }, fetchImpl: fakeFetch({ [GOOGLE]: {} }, 403).fetchImpl })).toBeUndefined();
    expect(await listModels("openai", { env: { OPENAI_API_KEY: "o" }, fetchImpl: fakeFetch({}).fetchImpl })).toBeUndefined();
    expect(await listModels("openai", { env: { OPENAI_API_KEY: "o" }, fetchImpl: fakeFetch({ [OPENAI]: { data: "?" } }).fetchImpl })).toBeUndefined();
  });

  it("uses the process environment and global fetch when none are given", async () => {
    const before = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(await listModels("openai")).toBeUndefined();
    } finally {
      if (before !== undefined) process.env.OPENAI_API_KEY = before;
    }
  });
});

describe("the startup banner", () => {
  const models = { qa: "claude-sonnet-5", planner: "gemini-3.6-flash", worker: "deepseek-flash" };
  const env = { GEMINI_API_KEY: "g" };
  const { fetchImpl } = fakeFetch({ [GOOGLE]: { models: [{ name: "models/gemini-3.8-flash" }] } });
  const sdkModels = async () => ["claude-sonnet-5-5"];

  it("asks every vendor in use and lists each move under one heading", async () => {
    const lines = await newerModelBanner(models, { env, fetchImpl, sdkModels });
    expect(lines[0]).toMatch(/^newer {6}claude-sonnet-5-5 is newer than claude-sonnet-5 \(qa\)/);
    expect(lines[1]).toMatch(/^ {11}gemini-3.8-flash is newer than gemini-3.6-flash \(planner\)/);
    expect(lines[2]).toContain("CHARRETTE_MODEL_CHECK=0");
  });

  it("is empty when everything is current", async () => {
    expect(await newerModelBanner({ qa: "claude-sonnet-5-5" }, { env, fetchImpl, sdkModels })).toEqual([]);
  });

  it("can be switched off", async () => {
    const off = vi.fn(async () => ["claude-sonnet-5-5"]);
    expect(await newerModelBanner(models, { env: { CHARRETTE_MODEL_CHECK: "0" }, sdkModels: off })).toEqual([]);
    expect(off).not.toHaveBeenCalled();
  });

  it("reads the process environment when none is given", async () => {
    const before = process.env.CHARRETTE_MODEL_CHECK;
    process.env.CHARRETTE_MODEL_CHECK = "0";
    try {
      expect(await newerModelBanner(models)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.CHARRETTE_MODEL_CHECK;
      else process.env.CHARRETTE_MODEL_CHECK = before;
    }
  });
});
