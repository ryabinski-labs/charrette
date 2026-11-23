import { describe, expect, it } from "vitest";
import { RunConfig } from "./config.js";
import { EffortConfig, MODEL_EFFORTS, effortFor, effortKey, effortLevels, effortProblem, mergeEfforts, settleEfforts } from "./effort.js";

describe("the levels each model takes", () => {
  /**
   * Held to the vendors' pages, read 2026-11-23. A wrong row is either a 400
   * mid-run or a level the operator is never offered.
   */
  it("matches what each vendor documents", () => {
    const claude = ["low", "medium", "high", "xhigh", "max"];
    const gpt = ["none", "low", "medium", "high", "xhigh", "max"];
    expect(MODEL_EFFORTS).toEqual({
      "claude-fable-5-2": claude,
      "claude-opus-5-5": claude,
      "claude-sonnet-5-5": claude,
      "claude-haiku-5-5": claude,
      "gpt-5.6-sol": gpt,
      "gpt-5.6-terra": gpt,
      "gpt-5.6-luna": gpt,
      "gemini-4-carbon": ["low", "medium", "high"],
      "gemini-4-neon": ["low", "medium", "high", "xhigh"],
      "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
      "gemini-3.8-flash": ["low", "medium", "high"],
      "gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
      "deepseek-flash": ["low", "high", "max"],
      "deepseek-v4-flash": ["low", "high", "max"],
    });
  });

  it("reads a provider prefix and a retired id as the model that runs", () => {
    expect(effortKey("anthropic/claude-opus-5")).toBe("claude-opus-5-5");
    expect(effortLevels("google:gemini-4-neon")).toEqual(MODEL_EFFORTS["gemini-4-neon"]);
    expect(effortLevels("gemini-3.6-flash")).toEqual(MODEL_EFFORTS["gemini-3.8-flash"]);
  });

  it("offers nothing for a model it does not know", () => {
    expect(effortLevels("gemini-9-mystery")).toEqual([]);
    expect(effortLevels("constructor")).toEqual([]);
  });

  it("offers nothing when a prefix sends a model to a vendor that does not serve it", () => {
    expect(effortLevels("openai/claude-opus-5-5")).toEqual([]);
  });
});

describe("refusing a level", () => {
  it("accepts a level the model takes", () => {
    expect(effortProblem("gemini-4-neon", "xhigh")).toBeNull();
  });

  it("names the valid levels in one line", () => {
    expect(effortProblem("gemini-4-carbon", "xhigh")).toBe('gemini-4-carbon does not support effort "xhigh"; use one of: low, medium, high.');
  });

  it("says which model a retired id became, since that is whose levels apply", () => {
    expect(effortProblem("gemini-3.6-flash", "minimal")).toBe('gemini-3.6-flash (now gemini-3.8-flash) does not support effort "minimal"; use one of: low, medium, high.');
  });

  it("says when a model has no setting at all", () => {
    expect(effortProblem("mystery-model", "high")).toBe("mystery-model has no effort setting.");
  });
});

describe("the level to send", () => {
  it("is the model's setting, however the model is spelled", () => {
    const table = { "claude-opus-5-5": "xhigh" };
    expect(effortFor(table, "claude-opus-5-5")).toBe("xhigh");
    expect(effortFor(table, "anthropic/claude-opus-5-5")).toBe("xhigh");
    expect(effortFor(table, "claude-opus-5")).toBe("xhigh");
  });

  it("is nothing for an unset model, a missing table, or a level it no longer takes", () => {
    expect(effortFor({}, "gemini-4-neon")).toBeUndefined();
    expect(effortFor(undefined, "gemini-4-neon")).toBeUndefined();
    expect(effortFor({ "gemini-4-carbon": "xhigh" }, "gemini-4-carbon")).toBeUndefined();
  });
});

describe("the effort block of a config", () => {
  it("defaults to empty, so a run sends nothing", () => {
    expect(RunConfig.parse({}).effort).toEqual({});
  });

  it("stores each setting under the model that actually runs", () => {
    expect(EffortConfig.parse({ "claude-opus-5": "max", "google/gemini-4-neon": "high" })).toEqual({ "claude-opus-5-5": "max", "gemini-4-neon": "high" });
  });

  it("survives being parsed again, as every read of a run does", () => {
    const once = RunConfig.parse({ effort: { "claude-opus-5": "max" } });
    expect(RunConfig.parse(once).effort).toEqual({ "claude-opus-5-5": "max" });
  });

  it("refuses a level the model does not take when the config is parsed", () => {
    const parsed = RunConfig.safeParse({ effort: { "gemini-4-carbon": "xhigh" } });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.message).toBe('gemini-4-carbon does not support effort "xhigh"; use one of: low, medium, high.');
  });

  it("refuses a retired model at a level its replacement lacks", () => {
    expect(EffortConfig.safeParse({ "gemini-3.6-flash": "minimal" }).success).toBe(false);
  });

  it("refuses two spellings of one model at different levels", () => {
    const parsed = EffortConfig.safeParse({ "claude-opus-5": "low", "claude-opus-5-5": "max" });
    expect(parsed.error!.issues[0]!.message).toBe("claude-opus-5-5 is set twice, to low and max; keep one.");
  });

  it("accepts two spellings of one model at the same level", () => {
    expect(EffortConfig.parse({ "claude-opus-5": "max", "claude-opus-5-5": "max" })).toEqual({ "claude-opus-5-5": "max" });
  });
});

describe("laying one effort table over another", () => {
  it("overrides by model, whatever the spelling", () => {
    expect(mergeEfforts({ "claude-opus-5": "low", "gemini-4-neon": "high" }, { "anthropic/claude-opus-5-5": "max" })).toEqual({ "claude-opus-5-5": "max", "gemini-4-neon": "high" });
  });

  it("treats `default` as removing the setting", () => {
    expect(mergeEfforts({ "gemini-4-neon": "high" }, { "gemini-4-neon": "default" })).toEqual({});
  });
});

describe("a recorded run under today's table", () => {
  it("keeps what is still valid, under the current name", () => {
    expect(settleEfforts({ "claude-opus-5": "max" })).toEqual({ effort: { "claude-opus-5-5": "max" }, dropped: [] });
  });

  it("drops a level the model no longer takes, and says which", () => {
    expect(settleEfforts({ "gemini-3.6-flash": "minimal", "gemini-4-neon": "high" })).toEqual({
      effort: { "gemini-4-neon": "high" },
      dropped: ["gemini-3.6-flash=minimal"],
    });
  });

  it("drops an unknown model, a value that is not a level, and the second of two conflicting spellings", () => {
    const out = settleEfforts({ gone: "high", "gemini-4-neon": 3, "claude-opus-5": "low", "claude-opus-5-5": "max" });
    expect(out.effort).toEqual({ "claude-opus-5-5": "low" });
    expect(out.dropped).toEqual(["gone=high", "gemini-4-neon=3", "claude-opus-5-5=max"]);
  });

  it("reads anything that is not a table as empty", () => {
    for (const raw of [null, "high", 3, ["high"]]) expect(settleEfforts(raw)).toEqual({ effort: {}, dropped: [] });
  });
});
