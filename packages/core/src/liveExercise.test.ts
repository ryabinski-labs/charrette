import { describe, expect, it } from "vitest";
import { RunSpec, hasCriticalPath } from "@harness/shared";
import { liveVerdict, type LiveFindings } from "./evidence.js";

/**
 * How one live exercise is read as a verdict on the run.
 *
 * The scoring exists because the failure it guards against is not a lie. Both
 * products in issue #115 were internally coherent, well-tested and honestly
 * documented, and neither ran: what was missing was never a claim that turned
 * out false, it was that nothing had ever checked. So these cases are mostly
 * about the shapes that would let "it works" through on the strength of an
 * agent having typed it.
 */

const findings = (over: Partial<LiveFindings> = {}): LiveFindings => ({
  started: true,
  howStarted: "docker compose up && pnpm dev",
  documentedStart: "README quickstart",
  steps: [],
  couldNotReach: [],
  artifacts: [{ file: "01-return.png", shows: "the produced return" }],
  commands: [],
  summary: "",
  ...over,
});

const STEPS = ["connect a Stripe account", "ingest a month of transactions", "produce a return"];
const drove = (results: ("worked" | "broken" | "not-reached")[], observed = "") =>
  STEPS.map((step, i) => ({ step, result: results[i]!, observed: i === results.findIndex((r) => r !== "worked") ? observed : "" }));

describe("reading one live exercise", () => {
  it("passes a path whose every step worked and left surviving proof", () => {
    const v = liveVerdict(STEPS, findings({ steps: drove(["worked", "worked", "worked"]) }));
    expect(v.verdict).toBe("worked");
    expect(v.steps.map((s) => s.result)).toEqual(["worked", "worked", "worked"]);
    expect(v.why).toBe("all 3 step(s) worked, with 1 piece(s) of surviving proof");
  });

  /**
   * The claim is free and the proof is not, which is the whole asymmetry this
   * gate exists to correct. A report of six green steps with every screenshot
   * struck as blank is a report of nothing.
   */
  it("refuses a path that worked with nothing left to show for it", () => {
    const v = liveVerdict(STEPS, findings({ steps: drove(["worked", "worked", "worked"]), artifacts: [], commands: [] }));
    expect(v.verdict).toBe("broken");
    expect(v.why).toContain("nothing it offered as proof survived checking");
  });

  it("names the step that broke and what was seen there", () => {
    const v = liveVerdict(STEPS, findings({ steps: drove(["worked", "broken", "not-reached"], "POST /ingest returned 500: no such column idempotency_key") }));
    expect(v.verdict).toBe("broken");
    expect(v.why).toBe('1 of 3 step(s) worked; it broke at "ingest a month of transactions" — POST /ingest returned 500: no such column idempotency_key');
    expect(v.steps.map((s) => s.result)).toEqual(["worked", "broken", "not-reached"]);
  });

  it("says a step was never got to when the agent said only that", () => {
    const v = liveVerdict(STEPS, findings({ steps: drove(["worked", "not-reached", "not-reached"]) }));
    expect(v.why).toContain('it never got at "ingest a month of transactions"');
  });

  /**
   * The path is what the specification says it is. An agent that answered
   * about the two easy steps has not driven three, and reading its silence as
   * absence rather than as failure is how a thin exercise passes.
   */
  it("counts a step the agent never mentioned as not reached", () => {
    const v = liveVerdict(STEPS, findings({ steps: [{ step: STEPS[0]!, result: "worked", observed: "" }] }));
    expect(v.verdict).toBe("broken");
    expect(v.steps).toEqual([
      { step: STEPS[0], result: "worked" },
      { step: STEPS[1], result: "not-reached" },
      { step: STEPS[2], result: "not-reached" },
    ]);
  });

  /** And the mirror: a path cannot be quietly rewritten into an easier one. */
  it("ignores a step the specification never named", () => {
    const v = liveVerdict(STEPS, findings({ steps: [...drove(["worked", "worked", "worked"]), { step: "read the README", result: "worked", observed: "" }] }));
    expect(v.verdict).toBe("worked");
    expect(v.steps).toHaveLength(3);
  });

  it("reads a product that never started as not run, and says what was tried", () => {
    const v = liveVerdict(STEPS, findings({ started: false, howStarted: "pnpm dev exits immediately: cannot find module ./dist/main.js" }));
    expect(v.verdict).toBe("not-run");
    expect(v.why).toBe("pnpm dev exits immediately: cannot find module ./dist/main.js");
    expect(v.steps.every((s) => s.result === "not-reached")).toBe(true);
  });

  it("says so plainly when a product that did not start explained nothing", () => {
    expect(liveVerdict(STEPS, findings({ started: false, howStarted: "" })).why).toBe("the product did not start, and the agent did not say what it tried");
  });

  it("counts a re-run command as proof, not only a file", () => {
    const v = liveVerdict(STEPS, findings({ steps: drove(["worked", "worked", "worked"]), artifacts: [], commands: [{ command: "curl -s localhost:3000/health", shows: "the service answers" }] }));
    expect(v.verdict).toBe("worked");
    expect(v.why).toContain("1 piece(s) of surviving proof");
  });
});

describe("whether a specification names a path to drive", () => {
  const spec = (over: Record<string, unknown> = {}) => RunSpec.parse({ feature: "f", ...over });

  it("is false for a run with no specification at all", () => {
    expect(hasCriticalPath(null)).toBe(false);
  });

  it("is false for a specification that named no steps", () => {
    expect(hasCriticalPath(spec())).toBe(false);
    expect(hasCriticalPath(spec({ criticalPath: { name: "checkout", steps: [] } }))).toBe(false);
  });

  it("is true once there is a step to drive", () => {
    expect(hasCriticalPath(spec({ criticalPath: { name: "checkout", steps: ["pay"] } }))).toBe(true);
  });
});
