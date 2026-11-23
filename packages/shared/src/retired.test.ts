import { describe, expect, it } from "vitest";
import { RunConfig } from "./config.js";
import { routingViolations } from "./providers.js";
import { RETIRED_MODELS, currentModel, retireModels, retiredMoves } from "./retired.js";

describe("retired models", () => {
  it("reads a retired id as its replacement, keeping a provider prefix", () => {
    expect(currentModel("claude-opus-5")).toBe("claude-opus-5-5");
    expect(currentModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-5-5");
    expect(currentModel("anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5-5");
    expect(currentModel("gemini-3.6-flash")).toBe("gemini-3.8-flash");
  });

  it("leaves current and unknown ids alone", () => {
    for (const m of ["claude-opus-5-5", "deepseek-flash", "gpt-5.6-terra", "gemini-3.5-flash-lite", "some-future-model"]) {
      expect(currentModel(m)).toBe(m);
    }
  });

  it("never replaces a model with another retired one, so a rewrite is final", () => {
    for (const to of Object.values(RETIRED_MODELS)) expect(RETIRED_MODELS[to]).toBeUndefined();
  });

  it("keeps every replacement inside the pin its role had", () => {
    // Same vendor, same tier: a judge upgraded off a retired model is still a
    // judge the routing rules accept.
    for (const [from, to] of Object.entries(RETIRED_MODELS)) {
      if (from.startsWith("claude-haiku")) continue; // below the floor before and after
      const role = from.startsWith("gemini") ? "reviewer" : "qa";
      expect(routingViolations({ [role]: to })).toEqual([]);
    }
  });

  it("lists each role that moves, and skips values that are not model ids", () => {
    expect(retiredMoves({ worker: "deepseek-flash", workerUi: "claude-opus-5", qa: "claude-sonnet-5", n: 3 })).toEqual([
      { role: "workerUi", from: "claude-opus-5", to: "claude-opus-5-5" },
      { role: "qa", from: "claude-sonnet-5", to: "claude-sonnet-5-5" },
    ]);
    expect(retiredMoves({ worker: "deepseek-flash" })).toEqual([]);
  });

  it("rewrites a routing table and passes anything else through", () => {
    expect(retireModels({ planner: "claude-fable-5-1", n: 3 })).toEqual({ planner: "claude-fable-5-2", n: 3 });
    expect(retireModels(undefined)).toBeUndefined();
    expect(retireModels("x")).toBe("x");
    const list = ["claude-opus-5"];
    expect(retireModels(list)).toBe(list);
  });

  it("does not retire 3.8 Flash, so a config naming it keeps it", () => {
    expect(RETIRED_MODELS).not.toHaveProperty(["gemini-3.8-flash"]);
    const roles = { planner: "gemini-3.8-flash", spec: "gemini-3.8-flash", workerHeavy: "gemini-3.8-flash", reviewer: "gemini-3.8-flash", pm: "gemini-3.8-flash" };
    expect(RunConfig.parse({ models: roles }).models).toMatchObject(roles);
  });

  it("is applied wherever a run config is parsed", () => {
    const config = RunConfig.parse({ models: { workerUi: "claude-opus-5", qa: "claude-sonnet-5", reviewer: "gemini-3.7-flash" } });
    expect(config.models.workerUi).toBe("claude-opus-5-5");
    expect(config.models.qa).toBe("claude-sonnet-5-5");
    expect(config.models.reviewer).toBe("gemini-3.8-flash");
  });
});
