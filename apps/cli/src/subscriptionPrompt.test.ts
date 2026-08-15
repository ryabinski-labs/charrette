import { describe, expect, it, vi } from "vitest";

const { createInterfaceMock } = vi.hoisted(() => ({ createInterfaceMock: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: createInterfaceMock }));

import type { SubscriptionGate } from "@harness/core";
import { promptForAccount } from "./subscription.js";

/**
 * The terminal end of the subscription gate.
 *
 * What it owes the operator is the opposite default from the budget prompt's.
 * Raising a cap is agreeing to spend more of something you have; carrying on
 * here is agreeing to walk into a wall that reopens in days, taking every
 * session in flight with it — so the easy key is the safe one, and both ways
 * forward are typed on purpose.
 */

const GATE: SubscriptionGate = {
  window: "seven_day",
  percent: 96,
  resetsAt: Date.parse("2026-08-18T11:59:59Z"),
  pauseAtPercent: 95,
  summary: "96% of the weekly limit · resets Aug 18 at 10pm (Australia/Melbourne)",
  untilReset: "3d 4h",
  account: "personal",
  alternatives: ["work", "spare"],
};

const gate = (over: Partial<SubscriptionGate> = {}): SubscriptionGate => ({ ...GATE, ...over });

/** Feeds scripted answers and captures what the operator was shown and alerted with. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const shown: string[] = [];
  const alerts: string[] = [];
  let i = 0;
  return {
    asked,
    shown,
    alerts,
    ask: async (q: string) => {
      asked.push(q);
      return answers[i++] ?? "";
    },
    write: (s: string) => void shown.push(s),
    alert: (title: string, body: string) => void alerts.push(`${title}: ${body}`),
  };
}

const run = (io: ReturnType<typeof scripted>, g = gate()) => promptForAccount(g, io.ask, io.write, io.alert);

describe("terminal subscription gate", () => {
  it("parks the run on enter, because the wall it is about to hit lasts days", async () => {
    const io = scripted([""]);
    await expect(run(io)).resolves.toEqual({ action: "park" });
  });

  it("moves the run onto a named subscription", async () => {
    const io = scripted(["work"]);
    await expect(run(io)).resolves.toEqual({ action: "switch", account: "work" });
  });

  it("takes the name as it is remembered rather than as it was typed", async () => {
    // The operator is retyping a name they put in a config file weeks ago.
    const io = scripted(["WORK"]);
    await expect(run(io)).resolves.toEqual({ action: "switch", account: "work" });
  });

  it("carries on spending this one when that is the deliberate choice", async () => {
    const io = scripted(["c"]);
    await expect(run(io)).resolves.toEqual({ action: "continue" });
  });

  it("re-asks rather than reading an unknown name as anything at all", async () => {
    const io = scripted(["wrok", "work"]);
    await expect(run(io)).resolves.toEqual({ action: "switch", account: "work" });
    expect(io.shown.join("")).toMatch(/"wrok" is not one of the configured subscriptions \(work, spare\)/);
  });

  it("raises the alert before drawing the prompt, for the run that reaches this at 3am", async () => {
    const io = scripted([""]);
    await run(io);
    expect(io.alerts[0]).toMatch(/^Claude subscription nearly spent: 96% of the weekly limit/);
    // The alert is the whole value of stopping at 95% rather than at 100%: it
    // is what makes somebody able to choose at all.
    expect(io.alerts).toHaveLength(1);
  });

  it("says what was crossed, when it reopens, and what the run is spending", async () => {
    const io = scripted([""]);
    await run(io);
    const said = io.shown.join("");
    expect(said).toMatch(/96% of the weekly limit/);
    expect(said).toMatch(/past the 95% line/);
    expect(said).toMatch(/reopens in 3d 4h/);
    expect(said).toMatch(/spending "personal"/);
    expect(said).toMatch(/Other subscriptions configured: work, spare/);
  });

  it("tells an operator with nothing to switch to how to get something to switch to", async () => {
    // Otherwise "carry on or park" reads as a missing feature rather than as a
    // missing three lines of config.
    const io = scripted([""]);
    await run(io, gate({ alternatives: [], account: "" }));
    const said = io.shown.join("");
    expect(said).toMatch(/No other subscriptions are configured/);
    expect(said).toMatch(/subscription\.accounts/);
    expect(said).not.toMatch(/spending ""/);
    expect(io.asked[0]).not.toMatch(/<name>/);
  });

  it("does not offer a switch it cannot make, even when the operator types a name", async () => {
    const io = scripted(["work", "c"]);
    await expect(run(io, gate({ alternatives: [] }))).resolves.toEqual({ action: "continue" });
    expect(io.shown.join("")).toMatch(/"work" is not one of the configured subscriptions\./);
  });

  it("reads the terminal when it is given no other way to ask", async () => {
    // The default `ask` opens readline against the real stdin, which is how the
    // gate is wired everywhere except in these cases — so the wiring itself is
    // worth one test, closing the interface included: a run whose gate leaves
    // readline open holds the terminal for the rest of the run.
    const question = vi.fn(async () => "c");
    const close = vi.fn();
    createInterfaceMock.mockReturnValue({ question, close });
    // Left to write to the real stdout as well, for the same reason: this is
    // the shape the CLI actually constructs it in.
    await expect(promptForAccount(gate(), undefined, undefined, () => undefined)).resolves.toEqual({ action: "continue" });
    expect(close).toHaveBeenCalled();
  });
});
