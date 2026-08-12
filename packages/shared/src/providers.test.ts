import { describe, expect, it } from "vitest";
import { ModelRouting } from "./config.js";
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

describe("the roles whose vendor is not the operator's to choose", () => {
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

  it("refuses the small tier for a judging role, not only another vendor", () => {
    // The gap this closes: `PINNED_ROLES` exists because "a weaker judge does
    // not report that it judged worse, it reports PASS" — and until this check
    // it only stopped a judge changing *company*. Haiku is an Anthropic model,
    // so the vendor rule waved through the exact routing the pin was written
    // to prevent.
    const [message, ...rest] = routingViolations({ qa: "claude-haiku-4-5-20251001" });
    expect(rest).toEqual([]);
    expect(message).toContain("models.qa");
    expect(message).toContain("below the capability floor");
    expect(message).toContain("decides whether a task merges");
    expect(message).toContain("Sonnet or Opus");
  });

  it("refuses a Haiku that does not exist yet", () => {
    // Matched on the family rather than on today's ids, so the next one is
    // refused the day it ships rather than the day somebody updates a list.
    expect(routingViolations({ reviewer: "claude-haiku-9" })).toHaveLength(1);
    expect(routingViolations({ prod: "anthropic/claude-haiku-4-5-20251001" })).toHaveLength(1);
  });

  it("reports a moved judge once, for the vendor, rather than twice", () => {
    // A judge on another vendor's small model is one decision to reverse, and
    // two sentences saying so reads like two problems.
    const violations = routingViolations({ qa: "google/gemini-3.5-haiku-ish" });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("pinned to Anthropic");
  });

  it("leaves the working roles free to run on the small tier", () => {
    // demo and repair are pointed there by default — the floor is about the
    // roles whose verdict ends something, not about cheap models.
    expect(
      routingViolations({
        demo: "claude-haiku-4-5-20251001",
        repair: "claude-haiku-4-5-20251001",
        workerLight: "claude-haiku-4-5-20251001",
        worker: "claude-sonnet-5",
      })
    ).toEqual([]);
  });

  it("pins intake for a capability reason, not a policy one", () => {
    // If this ever stops being true the tool loop grew an ask-the-operator
    // tool, and the pin should be reconsidered rather than quietly kept.
    expect(PINNED_ROLES.intake?.why).toContain("in-process tool");
    expect(PINNED_ROLES.intake?.provider).toBe("anthropic");
  });

  it("pins the reviewer to Google, and says so when it is pointed back at Anthropic", () => {
    // The direction that matters. Every other pin refuses a move *away* from
    // Anthropic; this one refuses a move *back*, and the failure it prevents is
    // silent — an Opus reviewer works perfectly, it just shares the blind spots
    // of the Opus-family worker whose diff it is reviewing.
    expect(PINNED_ROLES.reviewer?.provider).toBe("google");
    const [message, ...rest] = routingViolations({ reviewer: "claude-opus-5" });
    expect(rest).toEqual([]);
    expect(message).toContain("models.reviewer");
    expect(message).toContain("pinned to Google");
    expect(message).toContain("anthropic");
    expect(message).toContain("uncorrelated");
  });

  it("applies the capability floor on the Gemini side too", () => {
    // The hole this closes is the exact one Haiku opened on the Anthropic side:
    // flash-lite is a Google model, so the vendor check alone waves through the
    // weak judge the pin exists to prevent.
    const [message, ...rest] = routingViolations({ reviewer: "gemini-3.5-flash-lite" });
    expect(rest).toEqual([]);
    expect(message).toContain("below the capability floor");
    expect(message).toContain("Flash or Pro");
  });

  it("does not mistake the reviewer's own Flash tier for the small tier", () => {
    // `lite` and not `flash`: Flash is where Gemini ships the judging-capable
    // model this role is pointed at, so a floor written as /flash/ would refuse
    // the default and stop every run.
    expect(routingViolations({ reviewer: "gemini-3.6-flash" })).toEqual([]);
    expect(routingViolations({ reviewer: "google/gemini-3.6-flash" })).toEqual([]);
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

  it("rejects the whole config when a judging role is dropped to the small tier", () => {
    const result = ModelRouting.safeParse({ qa: "claude-haiku-4-5-20251001" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("below the capability floor");
  });

  it("still applies the defaults, so an empty table is the working one", () => {
    const parsed = ModelRouting.parse({});
    expect(providerFor(parsed.worker)).toBe("anthropic");
    // Not all-Anthropic any more, and the default has to satisfy its own pin:
    // an empty table is what every run without a `models` block gets, so a
    // default that violated `routingViolations` would refuse every such run.
    expect(providerFor(parsed.reviewer)).toBe("google");
    expect(routingViolations(parsed)).toEqual([]);
  });

  it("ships the cheap tier on exactly the roles that were argued for it", () => {
    // Pinned because these defaults are what the operator actually pays, and a
    // change to one of them is invisible in a diff of anything else. The whole
    // suite passed unchanged when `workerLight` moved from Sonnet to Haiku,
    // which is how a default gets changed by accident.
    const d = ModelRouting.parse({});
    expect({ demo: d.demo, repair: d.repair, workerLight: d.workerLight }).toEqual({
      demo: "claude-haiku-4-5-20251001",
      repair: "claude-haiku-4-5-20251001",
      workerLight: "claude-haiku-4-5-20251001",
    });
    // And the judges are not among them — which the floor now also enforces.
    // `reviewer` is the one judge off Anthropic, and it is pinned there rather
    // than defaulted: see PINNED_ROLES for why a same-family reviewer is the
    // failure mode, and budget.ts for the row that prices this id.
    expect({ qa: d.qa, reviewer: d.reviewer, prod: d.prod, pm: d.pm, advisor: d.advisor }).toEqual({
      qa: "claude-sonnet-5",
      reviewer: "gemini-3.6-flash",
      prod: "claude-opus-5",
      pm: "claude-opus-5",
      advisor: "claude-sonnet-5",
    });
  });
});
