import { PlannedTask } from "@charrette/shared";
import { describe, expect, it } from "vitest";
import { renderIntegrations, scanIntegrations } from "./integrationScan.js";

/**
 * The fixtures here are the real acceptance criteria run 40da9337's planner
 * wrote, copied out of `billing-app/.charrette/charrette.db`. That run merged all 36
 * tasks, passed every QA verdict, and shipped six of seven vendors as
 * `throw liveProviderNotConfigured(...)` — so the question these tests answer is
 * whether the plan gate would have said anything about it.
 */
const task = (over: Partial<PlannedTask>): PlannedTask =>
  PlannedTask.parse({
    id: "t",
    epicId: "e",
    title: "T",
    spec: "s",
    acceptanceCriteria: ["it works"],
    dependsOn: [],
    touchedPaths: [],
    estimatedSize: "M",
    ...over,
  });

describe("what a plan intends to actually talk to", () => {
  it("flags the criteria that shipped six of seven vendors as stubs", () => {
    const found = scanIntegrations([
      task({
        id: "provider-layer",
        title: "Provider layer",
        spec: "Create `src/providers/index.ts` exposing providers resolved by `config.providerMode`.",
        acceptanceCriteria: [
          "`providers` resolves to mocks whenever `NODE_ENV=test`, regardless of other env values",
          "All seven vendor categories have an interface and a deterministic mock",
        ],
      }),
      task({
        id: "plaid-integration",
        title: "Plaid integration",
        spec: "Link a bank account through Plaid.",
        acceptanceCriteria: [
          "Exchange creates a funding source with `type: 'plaid_ach'`, mask and verification status",
          "The suite makes no outbound HTTP call",
        ],
      }),
    ]);

    expect(found.map((f) => [f.id, f.verdict])).toEqual([
      ["provider-layer", "silent-fake"],
      ["plaid-integration", "silent-fake"],
    ]);
    // The operator gets the exact sentence, so the judgment is theirs and checkable.
    expect(found[1]!.evidence).toBe("The suite makes no outbound HTTP call");
  });

  it("flags an integration task whose criteria say nothing either way", () => {
    // ach-origination: every criterion is about local state, so a worker that
    // writes `throw notConfigured()` for the vendor call satisfies all of them.
    const [found] = scanIntegrations([
      task({
        id: "ach-origination",
        title: "ACH origination",
        spec: "Implement `src/providers/ach/*`: `originateDebit` (SEC code WEB), `originateCredit`, `getTransferStatus`.",
        acceptanceCriteria: [
          "A debit without completed account validation is rejected 422 before any provider call",
          "Origination uses a deterministic idempotency key from the funding attempt id",
        ],
      }),
    ]);

    expect(found!.verdict).toBe("undeclared");
  });

  it("says nothing about a task that pins a real sandbox", () => {
    expect(
      scanIntegrations([
        task({
          id: "stripe",
          title: "Stripe integration",
          spec: "Charge a card.",
          acceptanceCriteria: [
            "A charge against the Stripe sandbox returns a payment intent id",
            "The unit suite runs against a deterministic mock",
          ],
        }),
      ])
    ).toEqual([]);
  });

  it("accepts a deliberate scope decision, and carries the reason to the gate", () => {
    const [found] = scanIntegrations([
      task({
        id: "ofac",
        title: "Sanctions screening",
        spec: "Screen payees. Live is out of scope because the operator has no OFAC vendor contract yet. Ship the interface and a fake.",
        acceptanceCriteria: ["A hit blocks the payee", "The fake returns a deterministic verdict"],
      }),
    ]);

    expect(found!.verdict).toBe("declared-fake");
    expect(found!.evidence).toContain("no OFAC vendor contract yet");
  });

  it("leaves ordinary tasks alone", () => {
    expect(
      scanIntegrations([
        task({ id: "ledger", title: "Double-entry ledger", spec: "Post debits and credits.", acceptanceCriteria: ["The trial balance nets to zero"] }),
      ])
    ).toEqual([]);
  });

  it("reads a live criterion as settling it even when a fake sits beside it", () => {
    // Mocks for the unit suite plus one sandbox test is a well-built integration,
    // and flagging it would train the operator to skip this section.
    expect(
      scanIntegrations([
        task({
          id: "lob",
          title: "Lob check vendor",
          spec: "Mail checks.",
          acceptanceCriteria: ["Every unit test uses the stub", "One contract test runs against recorded fixtures of real Lob responses"],
        }),
      ])
    ).toEqual([]);
  });
});

describe("what the operator reads at the gate", () => {
  it("prints nothing when the plan builds the real thing", () => {
    expect(renderIntegrations([])).toBe("");
  });

  it("groups by verdict and says what to do about it", () => {
    const text = renderIntegrations([
      { id: "a", title: "A", verdict: "silent-fake", evidence: "The suite makes no outbound HTTP call" },
      { id: "b", title: "B", verdict: "undeclared", evidence: "it works" },
      { id: "c", title: "C", verdict: "declared-fake", evidence: "Live is out of scope because there is no account." },
    ]);

    expect(text).toContain("Built as a test double");
    expect(text).toContain("Says neither");
    expect(text).toContain("Deliberately not live, and the plan says why");
    expect(text).toContain("reject the plan and say so");
  });

  it("omits a heading no task fell under", () => {
    const text = renderIntegrations([{ id: "a", title: "A", verdict: "silent-fake", evidence: "x" }]);

    expect(text).toContain("Built as a test double");
    expect(text).not.toContain("Deliberately not live");
  });

  it("truncates a criterion long enough to bury the rest of the gate", () => {
    const text = renderIntegrations([{ id: "a", title: "A", verdict: "silent-fake", evidence: "m".repeat(400) }]);

    expect(text).toContain("m".repeat(160));
    expect(text).not.toContain("m".repeat(161));
  });

  it("falls back to a plain sentence when the declaration has no full stop", () => {
    const [found] = scanIntegrations([
      task({ id: "sms-vendor", title: "SMS", spec: "Live is out of scope because", acceptanceCriteria: ["the stub answers"] }),
    ]);

    expect(found!.evidence).toBe("live is out of scope");
  });
});
