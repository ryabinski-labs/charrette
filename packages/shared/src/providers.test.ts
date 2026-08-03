import { describe, expect, it } from "vitest";
import { ModelRouting, ModelRoutingShape } from "./config.js";
import { PINNED_ROLES, modelId, providerFor, routingViolations, splitModel } from "./providers.js";

describe("which vendor answers for a model name", () => {
  it("reads the family out of the name, so existing configs keep working", () => {
    expect(providerFor("claude-opus-5")).toBe("anthropic");
    expect(providerFor("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(providerFor("gpt-5.6-terra")).toBe("openai");
    expect(providerFor("o3-mini")).toBe("openai");
    expect(providerFor("gemini-3.5-flash-lite")).toBe("google");
  });

  it("treats an unrecognised name as Anthropic, which is what every run before this did", () => {
    expect(providerFor("some-future-model")).toBe("anthropic");
    expect(modelId("some-future-model")).toBe("some-future-model");
  });

  it("accepts an explicit prefix for a name that does not announce its family", () => {
    expect(splitModel("openai/some-codename")).toEqual({ provider: "openai", id: "some-codename" });
    expect(splitModel("google:experimental-1")).toEqual({ provider: "google", id: "experimental-1" });
    // The id sent on the wire never carries the prefix.
    expect(modelId("openai/gpt-5.6-terra")).toBe("gpt-5.6-terra");
  });

  it("does not mistake a slash inside a model name for a provider prefix", () => {
    // Vendors ship names like this; `ft:` and unknown heads must stay intact.
    expect(splitModel("ft:gpt-5.6-terra:acme")).toEqual({ provider: "anthropic", id: "ft:gpt-5.6-terra:acme" });
    expect(splitModel("/leading-slash")).toEqual({ provider: "anthropic", id: "/leading-slash" });
  });
});

describe("the roles that may not leave Anthropic", () => {
  it("passes an all-Anthropic routing table", () => {
    expect(routingViolations({ worker: "claude-sonnet-5", qa: "claude-sonnet-5" })).toEqual([]);
  });

  it("allows the working roles to be pointed at another vendor", () => {
    expect(routingViolations({ worker: "gpt-5.6-terra", integrator: "gemini-3.5-flash-lite", demo: "gpt-5.6-luna" })).toEqual([]);
  });

  it("names the role, the model, the vendor and the reason when a judge is moved", () => {
    const [message, ...rest] = routingViolations({ qa: "gemini-3.5-flash-lite" });
    expect(rest).toEqual([]);
    expect(message).toContain("models.qa");
    expect(message).toContain("gemini-3.5-flash-lite");
    expect(message).toContain("google");
    expect(message).toContain("decides whether a task merges");
  });

  it("reports every pinned role that was moved, not just the first", () => {
    const violations = routingViolations({
      qa: "gpt-5.6-terra",
      reviewer: "gpt-5.6-terra",
      prod: "gemini-3.5-flash-lite",
      intake: "gpt-5.6-luna",
      worker: "gpt-5.6-terra",
    });
    expect(violations).toHaveLength(4);
    expect(violations.some((v) => v.includes("models.worker"))).toBe(false);
  });

  it("ignores a role the table does not mention", () => {
    expect(routingViolations({})).toEqual([]);
  });

  it("pins intake for a capability reason, not a policy one", () => {
    // If this ever stops being true the tool loop grew an ask-the-operator
    // tool, and the pin should be reconsidered rather than quietly kept.
    expect(PINNED_ROLES.intake).toContain("in-process tool");
  });
});

describe("the run config refuses a routing it cannot honour", () => {
  it("parses a table that moves only the working roles", () => {
    const parsed = ModelRouting.parse({ worker: "gpt-5.6-terra", demo: "gemini-3.5-flash-lite" });
    expect(parsed.worker).toBe("gpt-5.6-terra");
    // Everything unset still falls back to the Anthropic defaults.
    expect(parsed.qa).toBe("claude-sonnet-5");
    expect(parsed.prod).toBe("claude-opus-5");
  });

  it("rejects the whole config when a judging role is moved off Anthropic", () => {
    const result = ModelRouting.safeParse({ qa: "gpt-5.6-terra" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("pinned to Anthropic");
  });

  it("still applies the defaults, so an empty table is the all-Anthropic one", () => {
    const parsed = ModelRouting.parse({});
    expect(providerFor(parsed.worker)).toBe("anthropic");
    expect(Object.keys(ModelRoutingShape.shape)).toContain("reviewer");
  });
});
