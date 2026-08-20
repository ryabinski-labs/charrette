import { describe, expect, it } from "vitest";
import type { TaskState } from "@harness/shared";
import { deliveryLedger, reachOf, type LedgerInput, type LedgerTask } from "./deliveryLedger.js";
import type { DarkSwitch } from "./darkSwitches.js";

const task = (over: Partial<LedgerTask> = {}): LedgerTask => ({
  id: "t1",
  title: "Checkout",
  state: "MERGED" as TaskState,
  acceptanceCriteria: ["A card charge succeeds end to end"],
  touchedPaths: ["src/checkout.ts"],
  prNumber: 7,
  unverified: [],
  why: "",
  runbook: null,
  blocking: [],
  ...over,
});

const input = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  runState: "DONE",
  tasks: [task()],
  merged: true,
  deploy: { state: "passing", failing: [] },
  prod: { url: "https://x.test", verdict: "PASS", findings: [] },
  ci: { state: "passing", failing: [] },
  intent: { verdict: "PASS", gaps: [] },
  switches: [],
  ...over,
});

const secret = (over: Partial<DarkSwitch> = {}): DarkSwitch => ({
  kind: "secret",
  name: "STRIPE_SECRET_KEY",
  where: "src/checkout.ts:12",
  why: "STRIPE_SECRET_KEY is not set anywhere.",
  steps: [{ do: "Seed it." }],
  ...over,
});

describe("how far the run's work actually travelled", () => {
  it("stops at the boundary the harness does not cross", () => {
    expect(reachOf({ merged: false, deploy: { state: "passing", failing: [] }, prod: null })).toBe("not-merged");
  });

  /**
   * Only green is green. A repo with no deploy workflow has not deployed
   * anything, and neither has one whose deploy is still running — and "none"
   * used to be the state that read like success because nothing was red.
   */
  it("treats a red, pending or absent deploy alike: merged, not shipped", () => {
    for (const state of ["failing", "pending", "none"] as const) {
      expect(reachOf({ merged: true, deploy: { state, failing: [] }, prod: null })).toBe("merged");
    }
    expect(reachOf({ merged: true, deploy: null, prod: null })).toBe("merged");
  });

  it("counts a production FAIL as a look that disagreed, never as verification", () => {
    expect(reachOf({ merged: true, deploy: { state: "passing", failing: [] }, prod: { url: "u", verdict: "FAIL", findings: ["broken"] } })).toBe("deployed");
    expect(reachOf({ merged: true, deploy: { state: "passing", failing: [] }, prod: null })).toBe("deployed");
    expect(reachOf({ merged: true, deploy: { state: "passing", failing: [] }, prod: { url: "u", verdict: "PASS", findings: [] } })).toBe("verified");
  });
});

describe("the rule that keeps the report honest", () => {
  /**
   * The single most important assertion in this file. Run 40da9337 merged 36
   * tasks against green QA and delivered a product that could not move money;
   * the failure was reporting per-task success as delivery. A feature cannot be
   * more on than the run that carried it, whatever its own tests said.
   */
  it("never reports a feature as live when nothing carried it anywhere", () => {
    const merged = deliveryLedger(input({ merged: false, deploy: null, prod: null }));
    expect(merged.entries[0]!.status).toBe("dark");
    expect(merged.counts.live).toBe(0);
    expect(merged.entries[0]!.why).toContain("nobody merged the pull request");
  });

  it("says which of the three ways a merged run failed to ship", () => {
    const red = deliveryLedger(input({ deploy: { state: "failing", failing: ["build", "e2e"] }, prod: null }));
    expect(red.entries[0]!.why).toContain("went red (build, e2e)");

    const none = deliveryLedger(input({ deploy: { state: "none", failing: [] }, prod: null }));
    expect(none.entries[0]!.why).toContain("nothing deploys this repository automatically");

    const pending = deliveryLedger(input({ deploy: { state: "pending", failing: [] }, prod: null }));
    expect(pending.entries[0]!.why).toContain("no deploy has been seen to go green");
  });

  it("calls a deployed feature nobody looked at unproven, not live and not broken", () => {
    const ledger = deliveryLedger(input({ prod: null }));
    expect(ledger.entries[0]!.status).toBe("unproven");
    expect(ledger.entries[0]!.why).toContain("not known to be broken and it is not known to work");
  });

  it("does not blame a feature for a production FAIL that never named it", () => {
    const ledger = deliveryLedger(input({ prod: { url: "u", verdict: "FAIL", findings: ["the login page 500s"] } }));
    expect(ledger.entries[0]!.status).toBe("unproven");
    expect(ledger.entries[0]!.why).toContain("genuinely unknown");
    expect(ledger.findings).toEqual(["the login page 500s"]);
  });

  it("reports live only when everything above it held", () => {
    const ledger = deliveryLedger(input());
    expect(ledger.entries[0]!.status).toBe("live");
    expect(ledger.counts).toEqual({ live: 1, dark: 0, unproven: 0, "not-delivered": 0 });
  });
});

describe("a switch outranks a green deploy", () => {
  it("marks a deployed feature dark when a switch in its own files is off", () => {
    const ledger = deliveryLedger(input({ switches: [secret()] }));
    expect(ledger.entries[0]!.status).toBe("dark");
    expect(ledger.entries[0]!.blockedBy).toEqual(["STRIPE_SECRET_KEY"]);
    expect(ledger.entries[0]!.runbook!.blocked).toContain("one switch it depends on is off");
    expect(ledger.entries[0]!.runbook!.sendBack).toContain("reachable in the running system");
  });

  it("folds several switches into one runbook and counts them in the sentence", () => {
    const ledger = deliveryLedger(input({ switches: [secret(), secret({ name: "OTHER_KEY", steps: [{ do: "Also seed it." }] })] }));
    expect(ledger.entries[0]!.runbook!.blocked).toContain("2 switches it depends on are off");
    expect(ledger.entries[0]!.runbook!.steps).toHaveLength(2);
  });

  /** `where` is `path:line` for some kinds and a bare path for others. */
  it("links a switch to a task by path, whatever the line number says", () => {
    const ledger = deliveryLedger(input({ switches: [secret({ where: "src/checkout.ts" })] }));
    expect(ledger.entries[0]!.blockedBy).toEqual(["STRIPE_SECRET_KEY"]);
  });

  it("links a migration set, whose `where` names several files at once", () => {
    const sw = secret({ kind: "migration", name: "2 migrations", where: "src/checkout.ts, db/002.sql" });
    expect(deliveryLedger(input({ switches: [sw] })).entries[0]!.blockedBy).toEqual(["2 migrations"]);
  });

  it("does not attach a switch to a task that touched nothing near it", () => {
    const ledger = deliveryLedger(input({ switches: [secret({ where: "infra/dns.tf" })] }));
    expect(ledger.entries[0]!.blockedBy).toEqual([]);
    expect(ledger.entries[0]!.status).toBe("live");
  });

  it("does not attach anything to a task with no recorded paths", () => {
    expect(deliveryLedger(input({ tasks: [task({ touchedPaths: [] })], switches: [secret()] })).entries[0]!.blockedBy).toEqual([]);
  });
});

describe("the work that was not delivered", () => {
  it("carries a parked task's own runbook through rather than inventing one", () => {
    const runbook = { blocked: "this needs a real deploy", steps: [{ do: "Run the workflow", command: "gh workflow run cd.yml" }], sendBack: "the output" };
    const ledger = deliveryLedger(input({ tasks: [task({ state: "NEEDS_HUMAN", why: "needs a real magic-link token", runbook })] }));
    expect(ledger.entries[0]!.status).toBe("not-delivered");
    expect(ledger.entries[0]!.why).toBe("needs a real magic-link token");
    expect(ledger.entries[0]!.runbook).toBe(runbook);
  });

  it("has a sentence for a parked task nobody wrote a reason for", () => {
    const ledger = deliveryLedger(input({ tasks: [task({ state: "NEEDS_HUMAN", why: "" })] }));
    expect(ledger.entries[0]!.why).toContain("stopped on something no agent could do");
  });

  it("says what a cancelled task was waiting behind", () => {
    const ledger = deliveryLedger(input({ tasks: [task({ state: "CANCELLED", blocking: ["Auth", "Sessions"] })] }));
    expect(ledger.entries[0]!.why).toBe("Never started — it was waiting on Auth, Sessions, which parked.");
  });

  it("falls back for a cancelled task with nothing recorded either way", () => {
    expect(deliveryLedger(input({ tasks: [task({ state: "CANCELLED" })] })).entries[0]!.why).toBe("Never started.");
    expect(deliveryLedger(input({ tasks: [task({ state: "CANCELLED", why: "the operator stopped it" })] })).entries[0]!.why).toBe("the operator stopped it");
  });

  it("reports work still in flight as not in the base branch", () => {
    expect(deliveryLedger(input({ tasks: [task({ state: "QA_FAILED" })] })).entries[0]!.why).toBe(
      "Still qa failed when the run ended — the work is not in the base branch."
    );
  });
});

describe("the sentence at the top", () => {
  it("leads with the weakest true statement, never the strongest", () => {
    expect(deliveryLedger(input({ merged: false, deploy: null, prod: null })).headline).toContain("Nothing from this run has shipped");
  });

  it("names red CI on an unmerged run, because it explains the unmerged part", () => {
    const ledger = deliveryLedger(input({ merged: false, deploy: null, prod: null, ci: { state: "failing", failing: ["build", "lint", "e2e", "types"] } }));
    expect(ledger.headline).toContain("its CI is red (build, lint, e2e)");
  });

  it("counts merged-and-not-shipped features", () => {
    expect(deliveryLedger(input({ deploy: { state: "failing", failing: [] }, prod: null })).headline).toBe(
      "Merged and not shipped: 1 merged feature sits in the base branch, and no green deploy has carried it anywhere."
    );
  });

  it("pluralises rather than printing 1 features", () => {
    const two = [task(), task({ id: "t2", title: "Refunds" })];
    expect(deliveryLedger(input({ tasks: two, deploy: { state: "failing", failing: [] }, prod: null })).headline).toContain("2 merged features sit");
  });

  it("leads with the disagreement when production disagreed", () => {
    const ledger = deliveryLedger(input({ prod: { url: "u", verdict: "FAIL", findings: ["a", "b"] } }));
    expect(ledger.headline).toBe("Deployed, and production disagreed: 2 findings came back against the running system.");
  });

  it("says deployed-and-unverified when nothing looked", () => {
    expect(deliveryLedger(input({ prod: null })).headline).toBe(
      "Deployed, unverified: 1 feature reached production and nothing has looked at it there."
    );
  });

  it("adds the switches that are still off to an unverified headline", () => {
    const ledger = deliveryLedger(input({ prod: null, tasks: [task(), task({ id: "t2", title: "Refunds", state: "NEEDS_HUMAN" })] }));
    expect(ledger.headline).toContain("1 thing is still switched off");
  });

  it("does not say 2 things is still switched off", () => {
    const ledger = deliveryLedger(
      input({ prod: null, tasks: [task(), task({ id: "t2", title: "Refunds", state: "NEEDS_HUMAN" }), task({ id: "t3", title: "Admin", state: "CANCELLED" })] })
    );
    expect(ledger.headline).toContain("2 things are still switched off");
  });

  it("celebrates only when there is nothing left to say", () => {
    expect(deliveryLedger(input()).headline).toBe("Everything this run built is live and confirmed in production.");
  });

  /**
   * `unproven` is only ever assigned at reach `deployed`, so a verified run has
   * sorted every merged feature into live or dark and can never carry one. The
   * celebration needs no caveat because there is no case that would earn it.
   */
  it("has nothing left unlooked-at once the run is verified", () => {
    const ledger = deliveryLedger(input({ tasks: [task(), task({ id: "t2", title: "Refunds", touchedPaths: ["src/refunds.ts"] })] }));
    expect(ledger.counts.unproven).toBe(0);
    expect(ledger.headline).toBe("Everything this run built is live and confirmed in production.");
  });

  it("does not say 2 features reached production and nothing has looked at it", () => {
    const two = [task(), task({ id: "t2", title: "Refunds", touchedPaths: ["src/refunds.ts"] })];
    expect(deliveryLedger(input({ tasks: two, prod: null })).headline).toBe(
      "Deployed, unverified: 2 features reached production and nothing has looked at them there."
    );
  });

  it("counts a live/dark split", () => {
    const ledger = deliveryLedger(
      input({ tasks: [task(), task({ id: "t2", title: "Refunds", state: "NEEDS_HUMAN" })] })
    );
    expect(ledger.headline).toBe("1 feature live and confirmed in production; 1 still dark.");
  });
});

describe("switches nothing claimed", () => {
  /**
   * A secret read by a file no task admits to touching is still off. Dropping
   * it because the join failed is exactly the silent narrowing this report
   * exists to prevent, so it counts toward what is dark even with no home.
   */
  it("still counts an orphaned switch as something that is off", () => {
    const ledger = deliveryLedger(input({ prod: null, switches: [secret({ where: "infra/nobody.tf" })] }));
    expect(ledger.entries[0]!.blockedBy).toEqual([]);
    expect(ledger.headline).toContain("1 thing is still switched off");
  });
});

describe("what the report carries through untouched", () => {
  it("keeps QA's own caveats and the intent check's gaps", () => {
    const ledger = deliveryLedger(
      input({ tasks: [task({ unverified: ["the refund path was never exercised"] })], intent: { verdict: "FAIL", gaps: ["no admin screen"] } })
    );
    expect(ledger.entries[0]!.unverified).toEqual(["the refund path was never exercised"]);
    expect(ledger.gaps).toEqual(["no admin screen"]);
  });

  it("carries no gaps when the intent check passed or never ran", () => {
    expect(deliveryLedger(input()).gaps).toEqual([]);
    expect(deliveryLedger(input({ intent: null })).gaps).toEqual([]);
    expect(deliveryLedger(input({ prod: null })).findings).toEqual([]);
  });

  it("handles a run with no tasks at all", () => {
    const ledger = deliveryLedger(input({ tasks: [] }));
    expect(ledger.entries).toEqual([]);
    expect(ledger.counts).toEqual({ live: 0, dark: 0, unproven: 0, "not-delivered": 0 });
  });
});
