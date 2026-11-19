import { describe, expect, it } from "vitest";
import { RunConfig } from "./config.js";
import { modelId, providerFor, routingViolations, splitModel } from "./providers.js";

/**
 * The DeepSeek routing surface: the default, the vendor inference, and the
 * policy that still refuses it on a pinned role.
 */

describe("REQ-001 — a run config that omits the worker models defaults worker and workerLight to deepseek-flash", () => {
  it("SC-001-a an empty models object defaults both regular worker tiers to DeepSeek", () => {
    const config = RunConfig.parse({});

    expect(config.models.worker).toBe("deepseek-flash");
    expect(config.models.workerLight).toBe("deepseek-flash");
  });

  it("keeps the interface and heavy tiers on their Anthropic models", () => {
    // The two rungs this change deliberately does not move. They are separate
    // bets: interface quality comes from the visual feedback loop, and the
    // heavy rung is the ceiling a rejected task climbs to.
    const models = RunConfig.parse({}).models;

    expect(models.workerUi).toBe("claude-opus-5");
    expect(models.workerHeavy).toBe("claude-fable-5-1");
  });

  it("lets a run override the DeepSeek default without touching the rest", () => {
    const models = RunConfig.parse({ models: { worker: "claude-sonnet-5" } }).models;

    expect(models.worker).toBe("claude-sonnet-5");
    expect(models.workerLight).toBe("deepseek-flash");
  });
});

describe("REQ-002 — a deepseek- name resolves to the deepseek provider, and an explicit prefix is stripped", () => {
  it("SC-002-a the deepseek family is read from the model name", () => {
    expect(providerFor("deepseek-flash")).toBe("deepseek");
    // The legacy id still routes to the V4.1 Flash checkpoint at the vendor.
    expect(providerFor("deepseek-v4-flash")).toBe("deepseek");
  });

  it("SC-002-b an explicit deepseek prefix is split and stripped", () => {
    expect(splitModel("deepseek/deepseek-flash")).toEqual({ provider: "deepseek", id: "deepseek-flash" });
    expect(splitModel("deepseek:deepseek-v4-flash")).toEqual({ provider: "deepseek", id: "deepseek-v4-flash" });
    expect(modelId("deepseek/deepseek-flash")).toBe("deepseek-flash");
  });

  it("does not steal a name outside the family", () => {
    // The family rule is anchored at the start of the name, so a string that
    // merely mentions DeepSeek later is still an Anthropic fallback rather than
    // a silent route to a vendor that was never asked for.
    expect(providerFor("my-deepseek-adapter")).toBe("anthropic");
  });
});

describe("REQ-015 — the routing policy refuses DeepSeek on a pinned judging role and allows it on workers", () => {
  it("SC-015-a a pinned judging role may not run on DeepSeek", () => {
    const violations = routingViolations({ qa: "deepseek-flash" });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("models.qa");
    expect(violations[0]).toContain("pinned to Anthropic");
    expect(violations[0]).toContain("(deepseek)");
  });

  it("SC-015-b the regular worker roles may run on DeepSeek", () => {
    expect(routingViolations({ worker: "deepseek-flash", workerLight: "deepseek-flash" })).toEqual([]);
  });

  it("refuses a DeepSeek reviewer as it refuses any non-Google reviewer", () => {
    const violations = routingViolations({ reviewer: "deepseek-flash" });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("pinned to Google");
  });

  it("still parses the shipped default table without a violation", () => {
    // The pin and the default have to agree, or every run without a models
    // block would refuse at parse time.
    expect(() => RunConfig.parse({})).not.toThrow();
    expect(routingViolations(RunConfig.parse({}).models)).toEqual([]);
  });
});
