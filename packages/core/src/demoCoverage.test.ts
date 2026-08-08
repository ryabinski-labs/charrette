import { describe, expect, it } from "vitest";
import { demoCoverage } from "./evidence.js";

/**
 * Whether a demo established anything, measured against what it said it would.
 *
 * The rule exists because the demo agent runs on the cheap tier and a thin demo
 * reads exactly like a thorough one once it has been summarised — so these tests
 * are mostly about the ways an agent could make itself look complete.
 */

const full = {
  started: true,
  plannedJourneys: ["Sign in", "Buy a pack"],
  journeys: [
    { name: "Sign in", result: "worked" as const },
    { name: "Buy a pack", result: "worked" as const },
  ],
  artifacts: [{ file: "signin.png", shows: "the signed-in home page" }],
  commands: [],
};

describe("a demo that did what it planned", () => {
  it("is demonstrated when every planned journey was reached with proof", () => {
    const c = demoCoverage(full);

    expect(c.status).toBe("demonstrated");
    expect(c).toMatchObject({ planned: 2, reached: 2, firstBlocked: "" });
  });

  it("counts a journey it drove until it broke as reached", () => {
    // A journey driven to failure is the most useful thing a demo produces.
    // Scoring it as a miss would push the agent towards only attempting what it
    // already expects to work.
    const c = demoCoverage({
      ...full,
      journeys: [
        { name: "Sign in", result: "worked" },
        { name: "Buy a pack", result: "broken" },
      ],
    });

    expect(c.status).toBe("demonstrated");
    expect(c.reached).toBe(2);
  });

  it("is only partial when nothing it claimed survived the evidence gate", () => {
    // Every journey reached and no artifact or command left standing: the claims
    // may be true, but nothing here lets anyone check them.
    const c = demoCoverage({ ...full, artifacts: [], commands: [] });

    expect(c.status).toBe("partial");
    expect(c.why).toContain("no artifact or command");
  });
});

describe("a demo that fell short", () => {
  it("is partial when it reached some of the plan, and names where it stopped", () => {
    const c = demoCoverage({ ...full, journeys: [{ name: "Sign in", result: "worked" }] });

    expect(c.status).toBe("partial");
    expect(c).toMatchObject({ planned: 2, reached: 1, firstBlocked: "Buy a pack" });
  });

  it("is inconclusive when it reached none of them", () => {
    const c = demoCoverage({
      ...full,
      journeys: [
        { name: "Sign in", result: "not-reachable" },
        { name: "Buy a pack", result: "not-reachable" },
      ],
    });

    expect(c.status).toBe("inconclusive");
  });

  it("is inconclusive when the product never started", () => {
    expect(demoCoverage({ ...full, started: false }).status).toBe("inconclusive");
  });
});

describe("the ways a demo could grade itself generously", () => {
  it("refuses to call an unplanned demo complete", () => {
    // The loophole: coverage measured against a plan written afterwards is
    // always 100%. Planning nothing has to be the worst outcome, not the best.
    const c = demoCoverage({
      ...full,
      plannedJourneys: [],
      journeys: [{ name: "Something I thought of later", result: "worked" }],
    });

    expect(c.status).toBe("inconclusive");
    expect(c.why).toContain("never said which journeys");
  });

  it("does not let journeys it never planned pay for the ones it did", () => {
    // Three journeys driven, none of them the two that were promised.
    const c = demoCoverage({
      ...full,
      journeys: [
        { name: "Load the homepage", result: "worked" },
        { name: "Open the docs", result: "worked" },
        { name: "Read the changelog", result: "worked" },
      ],
    });

    expect(c.status).toBe("inconclusive");
    expect(c.reached).toBe(0);
  });

  it("counts a partially-delivered plan against the plan, not against what it tried", () => {
    const c = demoCoverage({
      ...full,
      journeys: [
        { name: "Sign in", result: "worked" },
        { name: "Load the homepage", result: "worked" },
      ],
    });

    expect(c.reached).toBe(1);
    expect(c.status).toBe("partial");
  });
});
