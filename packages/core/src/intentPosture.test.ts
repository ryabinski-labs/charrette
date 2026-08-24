/**
 * The header's second meter is a claim about whether the run is delivering what
 * it was asked for, and the only way that claim earns its place is by being
 * unable to overstate itself. These tests are almost all about the ways it
 * could: an unmeasured run reading as a passing one, a stale PASS reading as a
 * current one, a cancelled or parked task reading as work in flight.
 */

import { describe, expect, it } from "vitest";
import { intentPosture, type IntentFixTask, type IntentInput, type IntentTask } from "./intentPosture.js";

const GAP_A = "The disbursement worker is built and tested and scheduled nowhere.\nSecond line, ignored.";
const GAP_B = "JSONL to SQLite ingestion is completely absent.";

function fix(over: Partial<IntentFixTask> & Pick<IntentFixTask, "title">): IntentFixTask {
  return { id: "intent-fix-1-1", state: "WORKING", ...over };
}

function titleFor(gap: string): string {
  return "Close intent gap: " + gap.split("\n")[0]!.slice(0, 80).trim();
}

function task(id: string, epicId: string, state: IntentTask["state"]): IntentTask {
  return { id, epicId, state, title: id };
}

function input(over: Partial<IntentInput> = {}): IntentInput {
  return { intent: null, plan: null, fixes: [], staleMerges: 0, roundsUsed: 0, roundsAllowed: 1, tasks: [], epics: [], ...over };
}

describe("intentPosture", () => {
  it("says nothing has measured the run rather than drawing it as zero", () => {
    const p = intentPosture(input());
    expect(p.stance).toBe("unjudged");
    expect(p.judged).toBe("nothing");
    // The whole point: null, not 0. An empty bar reads as "no progress" and the
    // truth is "no measurement", which is not the run's fault and not a score.
    expect(p.gapProgress).toBeNull();
    expect(p.verdict).toBeNull();
  });

  it("shows the plan's verdict before anything merges, labelled as being about the plan", () => {
    const p = intentPosture(input({ plan: { verdict: "FAIL", gaps: [GAP_A, GAP_B] } }));
    expect(p.stance).toBe("plan-only");
    expect(p.judged).toBe("plan");
    expect(p.gaps).toHaveLength(2);
    // A plan verdict says nothing about a tree, so it gets no fraction.
    expect(p.gapProgress).toBeNull();
    expect(p.headline).toContain("nothing built has been checked");
  });

  it("prefers the tree's verdict over the plan's once one exists", () => {
    const p = intentPosture(
      input({ intent: { verdict: "PASS", gaps: [] }, plan: { verdict: "FAIL", gaps: [GAP_A] } })
    );
    expect(p.stance).toBe("met");
    expect(p.judged).toBe("tree");
    expect(p.gaps).toEqual([]);
    // Nothing missing is not a fraction of a gap list, because there is none.
    expect(p.gapProgress).toBeNull();
  });

  it("will not call a stale pass a current one", () => {
    const fresh = intentPosture(input({ intent: { verdict: "PASS", gaps: [] } }));
    expect(fresh.headline).not.toContain("ago");

    const stale = intentPosture(input({ intent: { verdict: "PASS", gaps: [] }, staleMerges: 23 }));
    expect(stale.stance).toBe("met");
    expect(stale.staleMerges).toBe(23);
    expect(stale.headline).toContain("23 merges ago with nothing re-read since");
  });

  it("counts a gap closed only when the task carrying it merged", () => {
    const p = intentPosture(
      input({
        intent: { verdict: "FAIL", gaps: [GAP_A, GAP_B] },
        fixes: [fix({ title: titleFor(GAP_A), state: "MERGED" }), fix({ id: "intent-fix-1-2", title: titleFor(GAP_B) })],
      })
    );
    expect(p.closed).toBe(1);
    expect(p.inFlight).toBe(1);
    expect(p.gapProgress).toBe(50);
    expect(p.stance).toBe("closing");
    expect(p.gaps.map((g) => g.status)).toEqual(["closed", "in-flight"]);
    expect(p.gaps[1]!.taskId).toBe("intent-fix-1-2");
  });

  it("does not accept a cancelled task as an owner", () => {
    const p = intentPosture(
      input({ intent: { verdict: "FAIL", gaps: [GAP_A] }, fixes: [fix({ title: titleFor(GAP_A), state: "CANCELLED" })] })
    );
    expect(p.unowned).toBe(1);
    expect(p.gaps[0]!.status).toBe("unowned");
    expect(p.gaps[0]!.taskId).toBeNull();
    expect(p.stance).toBe("unowned");
  });

  it("keeps a parked gap out of the in-flight count and names it separately", () => {
    const p = intentPosture(
      input({ intent: { verdict: "FAIL", gaps: [GAP_A] }, fixes: [fix({ title: titleFor(GAP_A), state: "NEEDS_HUMAN" })] })
    );
    expect(p.parked).toBe(1);
    expect(p.inFlight).toBe(0);
    // Owned but going nowhere is not "closing" — that reading is the exact
    // failure this indicator exists to stop.
    expect(p.stance).toBe("unowned");
    expect(p.headline).toContain("parked and waiting on you");
  });

  it("keeps a merged gap closed when a later round duplicated and cancelled it", () => {
    const p = intentPosture(
      input({
        intent: { verdict: "FAIL", gaps: [GAP_A] },
        fixes: [
          fix({ id: "intent-fix-1-1", title: titleFor(GAP_A), state: "MERGED" }),
          fix({ id: "intent-fix-2-1", title: titleFor(GAP_A), state: "CANCELLED" }),
        ],
      })
    );
    expect(p.closed).toBe(1);
    expect(p.gaps[0]!.taskId).toBe("intent-fix-1-1");
  });

  it("says so when the gaps have no owner and the run has no rounds left to give them one", () => {
    const p = intentPosture(
      input({ intent: { verdict: "FAIL", gaps: [GAP_A, GAP_B] }, staleMerges: 23, roundsUsed: 1, roundsAllowed: 1 })
    );
    expect(p.stance).toBe("unowned");
    expect(p.unowned).toBe(2);
    expect(p.gapProgress).toBe(0);
    expect(p.roundsLeft).toBe(0);
    expect(p.headline).toContain("nothing in the run is moving on them");
    expect(p.headline).toContain("spent every gap-closing round");
  });

  it("does not promise more rounds than the config allows", () => {
    expect(intentPosture(input({ roundsUsed: 3, roundsAllowed: 1 })).roundsLeft).toBe(0);
    expect(intentPosture(input({ roundsUsed: 0, roundsAllowed: 3 })).roundsLeft).toBe(3);
  });

  it("draws no fraction for a failure that named nothing", () => {
    const p = intentPosture(input({ intent: { verdict: "FAIL", gaps: [] } }));
    expect(p.gapProgress).toBeNull();
    expect(p.verdict).toBe("FAIL");
    expect(p.headline).toContain("without naming what is missing");
  });

  it("matches a gap to its task on the first line alone, as queueIntentFixes titles it", () => {
    // The task title truncates at 80 characters of the first line; a gap whose
    // detail continues past that must still find its own task.
    const long = "a".repeat(120) + "\nmore detail";
    const p = intentPosture(
      input({ intent: { verdict: "FAIL", gaps: [long] }, fixes: [fix({ title: "Close intent gap: " + "a".repeat(80) })] })
    );
    expect(p.gaps[0]!.status).toBe("in-flight");
  });
});

/**
 * The other half of the meter, and the one that must never be moved by the
 * check beside it. A run can build every task the plan named and still be
 * missing the thing that was asked for; a percentage that quietly absorbed the
 * gap list would hide exactly that, which is the failure this pair exists to
 * make visible.
 */
describe("intentPosture, the completion half", () => {
  const EPICS = [
    { id: "engine", title: "M1: rule compiler and evaluation" },
    { id: "ui", title: "M2/M4: operator UI" },
  ];

  it("measures delivery in merged tasks against the milestones the plan was built from", () => {
    const p = intentPosture(
      input({
        epics: EPICS,
        tasks: [
          task("e1", "engine", "MERGED"),
          task("e2", "engine", "MERGED"),
          task("u1", "ui", "MERGED"),
          task("u2", "ui", "WORKING"),
        ],
      })
    );
    expect(p.delivered).toBe(3);
    expect(p.total).toBe(4);
    expect(p.percent).toBe(75);
    expect(p.milestonesDone).toBe(1);
    expect(p.milestones.map((m) => [m.id, m.done, m.total, m.percent])).toEqual([
      ["engine", 2, 2, 100],
      ["ui", 1, 2, 50],
    ]);
  });

  it("drops cancelled tasks from the denominator rather than counting them as undelivered", () => {
    // 94 of run bc691359's 145 tasks were cancelled, nearly all superseded by a
    // re-plan. Counting them would peg the run at a third delivered forever.
    const p = intentPosture(
      input({
        epics: EPICS,
        tasks: [task("e1", "engine", "MERGED"), task("e2", "engine", "CANCELLED"), task("e3", "engine", "CANCELLED")],
      })
    );
    expect(p.total).toBe(1);
    expect(p.percent).toBe(100);
    expect(p.milestones[0]!.total).toBe(1);
  });

  it("leaves out a milestone the re-plan emptied, rather than drawing it as owed and never delivered", () => {
    const p = intentPosture(
      input({ epics: EPICS, tasks: [task("e1", "engine", "MERGED"), task("u1", "ui", "CANCELLED")] })
    );
    expect(p.milestones.map((m) => m.id)).toEqual(["engine"]);
  });

  it("counts a parked task as undelivered and says which milestone is holding it", () => {
    const p = intentPosture(
      input({ epics: EPICS, tasks: [task("u1", "ui", "MERGED"), task("u2", "ui", "NEEDS_HUMAN")] })
    );
    expect(p.percent).toBe(50);
    expect(p.milestones[0]!.parked).toBe(1);
    expect(p.milestonesDone).toBe(0);
  });

  it("draws nothing before there is a plan to measure against", () => {
    expect(intentPosture(input()).percent).toBeNull();
  });

  it("does not let the intent check move the completion number, in either direction", () => {
    const tasks = [task("e1", "engine", "MERGED"), task("e2", "engine", "MERGED")];
    const clean = intentPosture(input({ epics: EPICS, tasks }));
    const failing = intentPosture(
      input({ epics: EPICS, tasks, intent: { verdict: "FAIL", gaps: [GAP_A, GAP_B] } })
    );
    // Every task the plan named is merged. The check still says two things the
    // assignment asked for are missing. Both statements are true and neither is
    // allowed to edit the other.
    expect(clean.percent).toBe(100);
    expect(failing.percent).toBe(100);
    expect(failing.unowned).toBe(2);
    expect(failing.stance).toBe("unowned");
  });
});

/**
 * The copy is read by one person, once, under pressure, and "1 things you asked
 * for are still missing" is the sentence that makes them stop trusting the rest
 * of the panel. Each of these pins one singular form.
 */
describe("intentPosture, speaking about one of something", () => {
  const ONE_EPIC = [{ id: "bench", title: "Measurement: one authorised Tier 1 session" }];

  it("says one milestone has work outstanding, not have", () => {
    const p = intentPosture(
      input({ epics: ONE_EPIC, tasks: [task("b1", "bench", "MERGED"), task("b2", "bench", "WORKING")] })
    );
    expect(p.deliveryHeadline).toBe(
      "1 of 2 tasks the plan asked for is merged, across 1 milestone \u2014 1 milestone still has work outstanding."
    );
  });

  it("names a single parked task in the singular", () => {
    const p = intentPosture(input({ epics: ONE_EPIC, tasks: [task("b1", "bench", "NEEDS_HUMAN")] }));
    expect(p.deliveryHeadline).toContain("and 1 task is parked and waiting on you");
  });

  it("says a plan that covers the assignment covers it, rather than listing nothing", () => {
    const p = intentPosture(input({ plan: { verdict: "PASS", gaps: ["ignored once it passed"] } }));
    expect(p.verdict).toBe("PASS");
    expect(p.gaps).toEqual([]);
    expect(p.headline).toBe("The plan covers what you asked for; nothing built has been checked against it yet.");
  });

  it("says one thing the plan asks for was not in it, not were", () => {
    const p = intentPosture(input({ plan: { verdict: "FAIL", gaps: [GAP_A] } }));
    expect(p.headline).toBe(
      "The plan was read against your assignment and 1 thing it asks for was not in it; nothing built has been checked yet."
    );
  });

  it("says one thing is still missing and nothing is moving on it, not them", () => {
    const p = intentPosture(
      input({ intent: { verdict: "FAIL", gaps: [GAP_A] }, roundsUsed: 1, roundsAllowed: 1 })
    );
    expect(p.headline).toBe(
      "1 thing you asked for is still missing and nothing in the run is moving on it." +
        " The run has spent every gap-closing round it is allowed (1), so it will not queue work for it on its own."
    );
  });

  it("says one gap is closed with one task parked against another, in the singular throughout", () => {
    const p = intentPosture(
      input({
        intent: { verdict: "FAIL", gaps: [GAP_A, GAP_B, "A third thing nobody took."] },
        fixes: [
          fix({ title: titleFor(GAP_A), state: "MERGED" }),
          fix({ id: "intent-fix-1-2", title: titleFor(GAP_B), state: "WORKING" }),
        ],
      })
    );
    expect(p.stance).toBe("closing");
    expect(p.headline).toBe(
      "1 of 3 gaps the last check found is closed and 1 more in flight, 1 with nothing moving on it."
    );
  });

  it("says several milestones have work outstanding, in the plural", () => {
    const p = intentPosture(
      input({
        epics: [
          { id: "engine", title: "M1: the engine" },
          { id: "ui", title: "M2/M4: operator UI" },
        ],
        tasks: [task("e1", "engine", "WORKING"), task("u1", "ui", "WORKING")],
      })
    );
    expect(p.deliveryHeadline).toBe(
      "0 of 2 tasks the plan asked for are merged, across 2 milestones \u2014 2 milestones still have work outstanding."
    );
  });

  it("says two tasks are parked, in the plural", () => {
    const p = intentPosture(
      input({
        epics: [{ id: "bench", title: "Measurement" }],
        tasks: [task("b1", "bench", "NEEDS_HUMAN"), task("b2", "bench", "NEEDS_HUMAN")],
      })
    );
    expect(p.deliveryHeadline).toContain("and 2 tasks are parked and waiting on you");
  });

  it("says two gaps are closed with two nothing is moving on, in the plural throughout", () => {
    const p = intentPosture(
      input({
        intent: { verdict: "FAIL", gaps: [GAP_A, GAP_B, "A third.", "A fourth.", "A fifth."] },
        fixes: [
          fix({ title: titleFor(GAP_A), state: "MERGED" }),
          fix({ id: "intent-fix-1-2", title: titleFor(GAP_B), state: "MERGED" }),
          fix({ id: "intent-fix-1-3", title: titleFor("A third."), state: "WORKING" }),
        ],
      })
    );
    expect(p.stance).toBe("closing");
    expect(p.headline).toBe(
      "2 of 5 gaps the last check found are closed and 1 more in flight, 2 with nothing moving on them."
    );
  });

  it("does not warn about spent rounds while the run still has one to spend", () => {
    const p = intentPosture(
      input({ intent: { verdict: "FAIL", gaps: [GAP_A] }, roundsUsed: 0, roundsAllowed: 3 })
    );
    expect(p.roundsLeft).toBe(3);
    expect(p.headline).toBe("1 thing you asked for is still missing and nothing in the run is moving on it.");
  });

  it("says two tasks against gaps are parked, in the plural", () => {
    const p = intentPosture(
      input({
        intent: { verdict: "FAIL", gaps: [GAP_A, GAP_B] },
        fixes: [
          fix({ title: titleFor(GAP_A), state: "NEEDS_HUMAN" }),
          fix({ id: "intent-fix-1-2", title: titleFor(GAP_B), state: "NEEDS_HUMAN" }),
        ],
      })
    );
    expect(p.headline).toContain("2 tasks against gaps are parked and waiting on you");
  });
});
