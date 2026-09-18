import { describe, expect, it } from "vitest";
import type { TaskState } from "@charrette/shared";
import { demoUnavailable, pitStopDue, renderPitStop, type DemoReport, type PitStop, type PitStopHistory } from "./pitstop.js";

/**
 * When a pit stop fires, and what the operator reads when one does. The half of
 * the feature with no I/O in it — see pitstopRun.test.ts for the dispatching.
 */

const EPICS = [
  { id: "epic-auth", title: "Sign-in" },
  { id: "epic-map", title: "The map" },
];

const task = (id: string, epicId: string, state: TaskState) => ({ id, epicId, title: id, state });

const FRESH: PitStopHistory = { count: 0, demoedEpics: [], mergedAt: 0, spentAt: 0, atMs: 1_000 };
const ctx = (over: Partial<{ spentUsd: number; nowMs: number; mergedCount: number }> = {}) => ({
  spentUsd: 0,
  nowMs: 1_000,
  mergedCount: 0,
  ...over,
});

describe("every epic", () => {
  it("fires when every task in an epic has landed", () => {
    const tasks = [task("a", "epic-auth", "MERGED"), task("b", "epic-auth", "MERGED"), task("c", "epic-map", "PENDING")];

    expect(pitStopDue("epic", EPICS, tasks, ctx({ mergedCount: 2 }), FRESH)).toEqual({
      reason: 'the "Sign-in" epic is finished',
      epicIds: ["epic-auth"],
    });
  });

  it("does not fire while one task in the epic is still running", () => {
    const tasks = [task("a", "epic-auth", "MERGED"), task("b", "epic-auth", "QA")];

    expect(pitStopDue("epic", EPICS, tasks, ctx({ mergedCount: 1 }), FRESH)).toBeNull();
  });

  it("counts a parked task as finished — the epic is as done as it is going to get", () => {
    const tasks = [task("a", "epic-auth", "MERGED"), task("b", "epic-auth", "NEEDS_HUMAN")];

    expect(pitStopDue("epic", EPICS, tasks, ctx({ mergedCount: 1 }), FRESH)).not.toBeNull();
  });

  it("skips an epic where nothing merged at all", () => {
    // Every task cancelled as unreachable is a plan collapsing, not a product to
    // look at: there is nothing for a demo agent to start, and the operator is
    // told about parked work through the task gate instead.
    const tasks = [task("a", "epic-auth", "CANCELLED"), task("b", "epic-auth", "NEEDS_HUMAN")];

    expect(pitStopDue("epic", EPICS, tasks, ctx(), FRESH)).toBeNull();
  });

  it("never fires twice for the same epic", () => {
    const tasks = [task("a", "epic-auth", "MERGED")];
    const seen = { ...FRESH, count: 1, demoedEpics: ["epic-auth"] };

    expect(pitStopDue("epic", EPICS, tasks, ctx({ mergedCount: 1 }), seen)).toBeNull();
  });

  it("moves on to the next epic once the first has been demoed", () => {
    const tasks = [task("a", "epic-auth", "MERGED"), task("b", "epic-map", "MERGED")];
    const seen = { ...FRESH, count: 1, demoedEpics: ["epic-auth"] };

    expect(pitStopDue("epic", EPICS, tasks, ctx({ mergedCount: 2 }), seen)?.epicIds).toEqual(["epic-map"]);
  });

  it("ignores an epic with no tasks at all", () => {
    expect(pitStopDue("epic", EPICS, [task("a", "epic-map", "MERGED")], ctx({ mergedCount: 1 }), FRESH)?.epicIds).toEqual(["epic-map"]);
  });
});

describe("the other intervals", () => {
  it("never fires when they are switched off", () => {
    const tasks = [task("a", "epic-auth", "MERGED")];

    expect(pitStopDue("never", EPICS, tasks, ctx({ mergedCount: 99, spentUsd: 1e6, nowMs: 9e9 }), FRESH)).toBeNull();
  });

  it("counts merged tasks since the last stop, not since the run began", () => {
    const history = { ...FRESH, count: 1, mergedAt: 4 };

    expect(pitStopDue({ tasks: 3 }, EPICS, [], ctx({ mergedCount: 6 }), history)).toBeNull();
    expect(pitStopDue({ tasks: 3 }, EPICS, [], ctx({ mergedCount: 7 }), history)).toEqual({
      reason: "3 more tasks merged",
      epicIds: [],
    });
  });

  it("says 'task' rather than 'tasks' when only one landed", () => {
    expect(pitStopDue({ tasks: 1 }, EPICS, [], ctx({ mergedCount: 1 }), FRESH)?.reason).toBe("1 more task merged");
  });

  it("measures spend from the last stop", () => {
    const history = { ...FRESH, count: 1, spentAt: 100 };

    expect(pitStopDue({ usd: 50 }, EPICS, [], ctx({ spentUsd: 149.99 }), history)).toBeNull();
    expect(pitStopDue({ usd: 50 }, EPICS, [], ctx({ spentUsd: 152.5 }), history)?.reason).toBe("$52.50 more spent");
  });

  it("measures the clock from the last stop", () => {
    const history = { ...FRESH, count: 1, atMs: 60_000 };

    expect(pitStopDue({ minutes: 90 }, EPICS, [], ctx({ nowMs: 60_000 + 89 * 60_000 }), history)).toBeNull();
    expect(pitStopDue({ minutes: 90 }, EPICS, [], ctx({ nowMs: 60_000 + 90 * 60_000 }), history)?.reason).toBe(
      "90 minutes since the last look"
    );
  });
});

const DEMO: DemoReport = {
  started: true,
  howStarted: "`pnpm dev` on :5173",
  summary: "Sign-in works end to end against the real database.",
  plannedJourneys: ["Sign in", "Download a pack", "The map"],
  // Written out rather than computed, so a change to the coverage rule shows up
  // as a failing coverage test and not as a mysteriously different report.
  coverage: {
    status: "partial",
    planned: 3,
    reached: 2,
    proof: 3,
    firstBlocked: "The map",
    why: 'it reached 2 of the 3 journeys it planned, stopping at "The map"',
  },
  journeys: [
    { name: "Sign in", result: "worked", evidence: "302 to /home; session row written (signin.png)" },
    { name: "Download a pack", result: "broken", evidence: "GET /v1/pack/current → 404 (pack-404.png)" },
    { name: "The map", result: "not-reachable", evidence: "no route renders it" },
  ],
  couldNotReach: ["payments — no Stripe test keys on this machine"],
  artifacts: [
    { file: "signin.png", shows: "the signed-in home page with the session's own name in the header" },
    { file: "pack-404.png", shows: "the pack screen's error state — the 404 body, verbatim" },
  ],
  commands: [{ command: "pnpm test", shows: "the suite is green on this branch" }],
};

const STOP: Omit<PitStop, "markdown"> = {
  // Null is the honest default for a mid-run stop: the live-exercise gate runs
  // once, at the end, against the finished tree.
  live: null,
  runId: "run1",
  number: 2,
  reason: 'the "Sign-in" epic is finished',
  demo: DEMO,
  skippedReviewers: [],
  reviews: [
    { lens: "product-manager", verdict: "drifting", findings: ["The pack screen has no content behind it"], question: "Is the map still in scope?" },
    { lens: "qa-agent", verdict: "on-track", findings: [], question: "" },
  ],
  merged: ["Sign-in (task-a)"],
  upcoming: ["The map (task-c)"],
  parked: ["Entitlements (task-b) — the check needs DynamoDB running"],
  cancelled: [],
  spentUsd: 41.5,
  capUsd: 120,
  stopCostUsd: 3.75,
  projectedUsd: 98.25,
  intent: null,
  artifactsDir: "/repo/.charrette/run1/pitstops/2",
};

describe("the report the operator reads", () => {
  it("leads with whether the thing actually runs", () => {
    const md = renderPitStop(STOP);

    expect(md.split("\n")[0]).toBe('# Pit stop 2 — the "Sign-in" epic is finished');
    expect(md).toContain("**It runs.** `pnpm dev` on :5173");
  });

  it("says so in the first line when it could not be started", () => {
    const md = renderPitStop({ ...STOP, demo: { ...DEMO, started: false, howStarted: "no dev script and the build fails" } });

    expect(md).toContain("**It does not run.** no dev script and the build fails");
  });

  it("falls back to plain words when the demo said nothing about why", () => {
    const md = renderPitStop({ ...STOP, demo: { ...DEMO, started: false, howStarted: "" } });

    expect(md).toContain("**It does not run.** The demo agent could not start the product.");
  });

  it("marks each journey by what happened, not by what was claimed", () => {
    const md = renderPitStop(STOP);

    expect(md).toContain("- ✓ **Sign in**");
    expect(md).toContain("- ✗ **Download a pack**");
    expect(md).toContain("- – **The map**");
  });

  it("always prints what was not checked, even when nothing was left", () => {
    // "Nothing was left unchecked" and "nobody said what was left unchecked"
    // have to look different — the second is the whole failure this fixes.
    const md = renderPitStop({ ...STOP, demo: { ...DEMO, couldNotReach: [] } });

    expect(md).toContain("## What it could NOT check");
    expect(md).toContain("(nothing — it reached everything it set out to)");
  });

  it("gives each reviewer its verdict, its findings and its question", () => {
    const md = renderPitStop(STOP);

    expect(md).toContain("### product-manager — DRIFTING");
    expect(md).toContain("- The pack screen has no content behind it");
    expect(md).toContain("> Is the map still in scope?");
    expect(md).toContain("### qa-agent — on track");
  });

  it("shows an off-track verdict as loudly as a drifting one", () => {
    const md = renderPitStop({ ...STOP, reviews: [{ lens: "critical-challenger", verdict: "off-track", findings: ["x"], question: "" }] });

    expect(md).toContain("### critical-challenger — OFF TRACK");
  });

  it("prints the intent verdict when one has been recorded", () => {
    const md = renderPitStop({ ...STOP, intent: { verdict: "FAIL", gaps: ["the pack endpoint is singular on one side"], summary: "" } });

    expect(md).toContain("**FAIL** — the merged result does not deliver what was asked");
    expect(md).toContain("- the pack endpoint is singular on one side");
  });

  /**
   * Above the intent check on purpose: an operator deciding what a run does
   * next is better served by "the payment step returns 500" than by any number
   * of agreeing opinions about the source.
   */
  it("prints what happened when someone used the product, above the readings of it", () => {
    const md = renderPitStop({
      ...STOP,
      live: {
        verdict: "broken",
        path: "take a payment",
        steps: [
          { step: "open the checkout", result: "worked" },
          { step: "pay with a test card", result: "broken" },
          { step: "see the receipt", result: "not-reached" },
        ],
        why: "1 of 3 step(s) worked; it broke at \"pay with a test card\" — POST /pay returned 500",
        artifactsDir: "/r/.charrette/run1/live",
      },
      intent: { verdict: "PASS", gaps: [], summary: "everything asked for is there" },
    });

    expect(md).toContain("## Using the product");
    expect(md).toContain("**The critical path is broken.**");
    expect(md).toContain("- **BROKE** — pay with a test card");
    expect(md).toContain("- not reached — see the receipt");
    expect(md).toContain("What it captured: /r/.charrette/run1/live");
    expect(md.indexOf("## Using the product")).toBeLessThan(md.indexOf("## Intent check"));
  });

  it("says a working path worked, and one nothing drove was never exercised", () => {
    const worked = renderPitStop({ ...STOP, live: { verdict: "worked", path: "", steps: [], why: "all 3 step(s) worked", artifactsDir: "" } });
    expect(worked).toContain("**The critical path works.** all 3 step(s) worked");
    expect(worked).not.toContain("The path:");

    const never = renderPitStop({ ...STOP, live: { verdict: "not-run", path: "p", steps: [], why: "it did not start", artifactsDir: "" } });
    expect(never).toContain("**Nothing exercised the product.** it did not start");
  });

  it("prints an abstaining intent verdict as what was not checked, never as a pass", () => {
    const md = renderPitStop({ ...STOP, intent: { verdict: "UNKNOWN", gaps: [], unchecked: ["whether the poller is scheduled"], summary: "" } });

    expect(md).toContain("**UNKNOWN** — the validator ran out of turns before it could judge the tree; not checked:");
    expect(md).toContain("- whether the poller is scheduled");
    expect(md).not.toContain("PASS");
    // A stop recorded before `unchecked` existed still renders.
    expect(renderPitStop({ ...STOP, intent: { verdict: "UNKNOWN", gaps: [], summary: "" } })).toContain("**UNKNOWN**");
  });

  it("prints a passing intent verdict with its summary", () => {
    const md = renderPitStop({ ...STOP, intent: { verdict: "PASS", gaps: [], summary: "everything asked for is there" } });

    expect(md).toContain("PASS — everything asked for is there");
  });

  it("shows the money against the cap and where the plan is heading", () => {
    const md = renderPitStop(STOP);

    expect(md).toContain("Spent **$41.50** of $120.00; the whole plan projects to about **$98.25**");
  });

  it("says what the checkpoint itself cost", () => {
    // A price the operator cannot see is one they cannot decide against, and
    // `{"pitStop":{"every":"never"}}` is the decision.
    expect(renderPitStop(STOP)).toContain("This pit stop cost $3.75 of that");
  });

  it("says how parked work gets the words, since it does not restart on its own", () => {
    expect(renderPitStop(STOP)).toContain("`charrette resume` asks about each one");
  });

  it("drops the projection when there is nothing left to project", () => {
    const md = renderPitStop({ ...STOP, projectedUsd: 41.5 });

    expect(md).toContain("Spent **$41.50** of $120.00\n");
    expect(md).not.toContain("projects to");
  });

  it("lists what is about to be built, so 'stop before you build X' is sayable", () => {
    const md = renderPitStop(STOP);

    expect(md).toContain("### Not built yet, in this order");
    expect(md).toContain("- The map (task-c)");
    expect(md).toContain("### Parked, waiting on you");
  });

  it("says plainly when nothing merged and nothing is left", () => {
    const md = renderPitStop({ ...STOP, merged: [], upcoming: [], parked: [] });

    expect(md).toContain("### Merged since the last look\n\n- nothing");
    expect(md).toContain("- nothing — this is the whole plan");
    expect(md).not.toContain("Parked, waiting on you");
  });

  it("points at the evidence directory when there is evidence", () => {
    expect(renderPitStop(STOP)).toContain("All of it: /repo/.charrette/run1/pitstops/2");
  });

  /**
   * Run 6fe4ba37 dropped 39 tasks at a re-plan and then showed its operator a
   * queue of 3, with nothing on the report saying the other 39 had ever been
   * planned. They read the short queue as "nearly finished" and only found out
   * by reading the event log by hand, days later.
   */
  it("names the work that left the plan, and says what brings it back", () => {
    const md = renderPitStop({
      ...STOP,
      cancelled: ["The engine (task-d) — replaced when you re-planned at a pit stop"],
    });

    expect(md).toContain("### Cancelled — in the plan once, not any more");
    expect(md).toContain("- The engine (task-d) — replaced when you re-planned at a pit stop");
    // The sentence is the point: `resume` alone puts none of it back.
    expect(md).toContain("`charrette resume` does not bring these back");
  });

  it("says nothing about cancelled work when none was cancelled", () => {
    expect(renderPitStop(STOP)).not.toContain("Cancelled — in the plan once");
  });

  /**
   * The stop `charrette resume` opens runs no demo, because a checkpoint that
   * costs a demo and four reviewers to open is one an operator at their budget
   * cap cannot afford to look at — and that operator is exactly who needs it.
   */
  it("says outright that nothing was run, rather than letting it read as still working", () => {
    const md = renderPitStop({ ...STOP, demo: null, reviews: [] });

    expect(md).toContain("**Nothing was run for this stop.**");
    expect(md).not.toContain("**It runs.**");
    expect(md).not.toContain("**It does not run.**");
    // The sections that only a demo can fill are absent, not empty-and-alarming.
    expect(md).not.toContain("## What it could NOT check");
    expect(md).not.toContain("## Evidence");
    // What the run knows without running anything is still all there.
    expect(md).toContain("### Not built yet, in this order");
    expect(md).toContain("- The map (task-c)");
    expect(md).toContain("Spent **$41.50** of $120.00");
  });

  it("says what each file is for, because a filename settles nothing", () => {
    // An operator opened a pit stop's `01-marketing-home-desktop.png`, saw a
    // homepage, and could not say what it was supposed to tell them. A list of
    // names is not evidence; a name plus the claim it backs is.
    const md = renderPitStop(STOP);

    expect(md).toContain("- `signin.png` — the signed-in home page with the session's own name in the header");
    expect(md).toContain("- `pack-404.png` — the pack screen's error state — the 404 body, verbatim");
  });

  it("leaves the evidence section out when the demo captured nothing", () => {
    expect(renderPitStop({ ...STOP, demo: { ...DEMO, artifacts: [], commands: [] } })).not.toContain("## Evidence");
  });

  /**
   * Only commands the charrette ran a second time and agreed with reach this
   * list, so the heading can say so — and an operator who reads "the suite is
   * green" here is reading a fact, not an agent's sentence about one.
   */
  it("says of a confirmed command that the charrette re-ran it", () => {
    const md = renderPitStop({ ...STOP, demo: { ...DEMO, artifacts: [] } });

    expect(md).toContain("## Evidence");
    expect(md).toContain("Re-run by the charrette and confirmed:");
    expect(md).toContain("- `pnpm test` — the suite is green on this branch");
  });

  it("marks a reviewer that died as one that died, not as one that approved", () => {
    // Pit stop 26 of ledger-app a8df0107. Three of four lenses died within eleven
    // seconds with `TypeError: fetch failed`; each carried the placeholder
    // verdict `on-track`, because there is no honest verdict for a session that
    // never reached one — and the heading was rendered from that verdict alone.
    // An operator scanning headings saw four endorsements. It was the one stop
    // out of twenty-six that had paid for the deep lenses.
    const md = renderPitStop({
      ...STOP,
      reviews: [
        { lens: "product-manager", verdict: "on-track", findings: [], question: "" },
        {
          lens: "critical-challenger",
          verdict: "on-track",
          findings: ["(this reviewer did not finish: Error: TypeError: fetch failed)"],
          question: "",
          finished: false,
        },
      ],
    });

    expect(md).toContain("### product-manager — on track");
    expect(md).toContain("### critical-challenger — DID NOT FINISH");
    expect(md).not.toContain("### critical-challenger — on track");
  });

  it("reads a report with no `finished` field as one that finished", () => {
    // Stops recorded before the field existed. Absent is not false.
    expect(renderPitStop(STOP)).toContain("### qa-agent — on track");
  });

  it("leaves the reviewer section out when nobody reviewed", () => {
    expect(renderPitStop({ ...STOP, reviews: [] })).not.toContain("## What the reviewers think");
  });

  it("leaves the journey section out when nothing was driven", () => {
    expect(renderPitStop({ ...STOP, demo: { ...DEMO, journeys: [], summary: "" } })).not.toContain("## What it did");
  });
});

describe("a demo that never reported", () => {
  it("becomes a finding rather than a silence", () => {
    const report = demoUnavailable("Error: max turns");

    expect(report.started).toBe(false);
    expect(report.howStarted).toContain("max turns");
    // The pit stop still happens: a checkpoint that quietly does not happen is
    // the exact failure the feature exists to fix.
    expect(report.couldNotReach[0]).toContain("there is no demo for this pit stop");
  });
});
