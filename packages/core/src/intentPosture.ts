import type { TaskState } from "@harness/shared";

/**
 * How far this run is from the thing it was asked to build, while it can still
 * change course.
 *
 * The header answers one question today — what has this cost — and an operator
 * watching a run for four days is asking two. The second one has an answer
 * already: `validateIntent` re-reads the whole merged tree against the original
 * assignment after every merge and publishes `run.intent_verdict` with a gap
 * list, and `queueIntentFixes` turns those gaps into tasks. Both were only ever
 * read at the end, by `postmortem`, which is the one moment the information can
 * no longer be acted on.
 *
 * Run bc691359 is the case that made this worth building. Its newest verdict
 * named four things the assignment asked for that the tree does not do, twenty
 * three merges ago; its `intentFixRounds` was spent on the *first* verdict, so
 * nothing in the run was queued against any of the four. From the dashboard it
 * read as `EXECUTING · $1538 of $3000` and nothing else — a run spending real
 * money with a standing, unowned list of what it is failing to deliver.
 *
 * Two numbers, never mixed into one.
 *
 * `percent` is how much of the assignment's work is delivered, measured off the
 * milestones the plan was built from. `gaps` is what the intent check says is
 * missing from the tree that work produced. Folding them together would produce
 * a single figure that is wrong in both directions — a plan can be fully built
 * and still not be the thing that was asked for, which is the whole reason the
 * intent check exists. So the bar answers "how much of this is built" and the
 * count beside it answers "and is that enough", and neither is allowed to move
 * the other.
 *
 * Pure. The caller reads the store; this decides what it means.
 */

/**
 * What the run's relationship to its own intent currently is.
 *
 * Ordered by how much is known, not by how good it is: `unjudged` is not a
 * pass, and it must never draw like one. `met` is the only stance that claims
 * the tree does what was asked, and it claims it only about the tree the check
 * actually read — see `staleMerges`.
 */
export type IntentStance =
  /** Nothing has read this run against the assignment yet. */
  | "unjudged"
  /** Only the *plan* was read. Says nothing about what has been built. */
  | "plan-only"
  /** The last read of the merged tree found nothing missing. */
  | "met"
  /** It found gaps, and the run has work moving against at least one. */
  | "closing"
  /** It found gaps and nothing in the run is moving on any of them. */
  | "unowned";

/**
 * What is happening to one gap.
 *
 * `parked` is separate from `unowned` on purpose. Both mean the gap will not
 * close on its own, and they are different asks: an unowned gap needs the run
 * pointed at it, a parked one needs the operator to answer something. Folding
 * them together would hide which of those two the number is asking for.
 */
export type GapStatus = "closed" | "in-flight" | "parked" | "unowned";

export interface IntentGap {
  text: string;
  status: GapStatus;
  /** The task carrying it, when one exists. */
  taskId: string | null;
}

export interface IntentFixTask {
  id: string;
  title: string;
  state: TaskState;
}

/** One task, for the completion half. */
export interface IntentTask {
  id: string;
  title: string;
  epicId: string;
  state: TaskState;
}

/**
 * One thing the assignment asked for, and how much of it exists.
 *
 * The unit is the epic, because that is the only level of the plan that was
 * written in the assignment's own vocabulary — "M3: config canon, CRDs, Helm
 * and standalone parity" is a thing the operator asked for; the forty tasks
 * under it are how the planner chose to get there.
 */
export interface IntentMilestone {
  id: string;
  title: string;
  /** Tasks merged into the integration branch. */
  done: number;
  /** Tasks still to deliver, cancelled ones excluded. */
  total: number;
  /** Of the outstanding ones, how many stopped and are waiting on the operator. */
  parked: number;
  percent: number;
}

export interface IntentInput {
  /** The newest `run.intent_verdict` — a read of the merged tree. */
  intent: { verdict: "PASS" | "FAIL"; gaps: string[] } | null;
  /** The newest `run.plan_intent_verdict` — a read of the plan, before any code. */
  plan: { verdict: string; gaps: string[] } | null;
  /** Every `intent-fix-*` task in the run, whichever round queued it. */
  fixes: IntentFixTask[];
  /** `git.merged` events since the newest intent verdict was taken. */
  staleMerges: number;
  /** Rounds of gap-closing work already queued. */
  roundsUsed: number;
  /** `config.intentFixRounds` — how many the run is allowed. */
  roundsAllowed: number;
  /** Every task in the run, for the completion half. */
  tasks: IntentTask[];
  /** The plan's epics, in plan order. */
  epics: { id: string; title: string }[];
}

export interface IntentPosture {
  /**
   * How much of the asked-for work is delivered, 0–100, or null before the plan
   * exists. Weighted by task, because "how far through the work are we" is a
   * question about work; the per-milestone shape is in `milestones`.
   */
  percent: number | null;
  /** Tasks merged, across every milestone. */
  delivered: number;
  /** Tasks to deliver, cancelled ones excluded — see `countable`. */
  total: number;
  /** Milestones with everything under them merged. */
  milestonesDone: number;
  milestones: IntentMilestone[];

  stance: IntentStance;
  /** The newest verdict's own word, or null before one ran. */
  verdict: "PASS" | "FAIL" | null;
  /** What that verdict actually read. `nothing` is not a passing grade. */
  judged: "tree" | "plan" | "nothing";
  /**
   * The newest verdict's gaps — the current truth, never an accumulation.
   * Each check re-reads the whole tree, so a gap that is still real is still
   * listed and one that was closed is simply gone.
   */
  gaps: IntentGap[];
  /** Gaps already merged shut. */
  closed: number;
  /** Gaps with a task actually moving on them. */
  inFlight: number;
  /** Gaps whose task stopped and is waiting on the operator. */
  parked: number;
  /** Gaps nothing in the run is working on. This is the number that hurts. */
  unowned: number;
  /** Merges since the verdict. A verdict is only about the tree it read. */
  staleMerges: number;
  /** Further rounds of gap-closing the run may still queue. */
  roundsLeft: number;
  /**
   * How much of the *gap list* is closed, 0–100, or null when there is no gap
   * list to be a fraction of. Distinct from `percent`, which is about the work.
   */
  gapProgress: number | null;
  /** One sentence about the work delivered. Never mentions the gaps. */
  deliveryHeadline: string;
  /** One sentence about the check, in the second person, claiming no more than the above. */
  headline: string;
}

/**
 * What links a gap to the task closing it.
 *
 * `queueIntentFixes` builds the title as `Close intent gap: ${first line, 80}`,
 * so the gap text itself is the key and no round bookkeeping is needed. That
 * matters, because rounds cannot be attributed to verdicts reliably — a PASS
 * queues nothing, so the round numbers and the verdict numbers drift apart.
 *
 * A gap re-stated in different words across two checks will not match its own
 * older task and reads as unowned. That is the safe direction to be wrong in:
 * it under-claims work rather than inventing an owner for a gap nobody has.
 */
function gapKey(gap: string): string {
  return TITLE_PREFIX + gap.split("\n")[0]!.slice(0, 80).trim();
}

/**
 * The same key, read back off a task title.
 *
 * `queueIntentFixes` slices the gap's first line at 80 characters and stores it
 * untrimmed, so whenever that cut lands on whitespace — or the gap's first line
 * opens with a space — the title and `gapKey` differ by exactly that
 * whitespace. The gap then reads as unowned: the dashboard paints the red meter
 * and says nothing in the run is moving on it, while an IN_PROGRESS task is
 * working it. Both sides normalise here so the two cannot drift apart again,
 * and titles already written with the stray space still match.
 */
function titleKey(title: string): string {
  const body = title.startsWith(TITLE_PREFIX) ? title.slice(TITLE_PREFIX.length) : title;
  return TITLE_PREFIX + body.trim();
}

const TITLE_PREFIX = "Close intent gap: ";

/**
 * The best thing happening to this gap, when more than one task claims it.
 *
 * Rounds repeat: a gap the first round failed to close comes back in the
 * second verdict with the same wording and gets a second task. Ranking rather
 * than taking the newest means a gap that *was* merged shut does not re-read as
 * unowned because a later duplicate was cancelled.
 */
const RANK: Record<GapStatus, number> = { closed: 3, "in-flight": 2, parked: 1, unowned: 0 };

function statusOf(state: TaskState): GapStatus {
  if (state === "MERGED") return "closed";
  if (state === "NEEDS_HUMAN") return "parked";
  // A cancelled task is not an owner. Nothing will come of it, and counting it
  // would put a gap in the "someone has this" column with nobody behind it.
  if (state === "CANCELLED") return "unowned";
  return "in-flight";
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** ", N merges ago with nothing re-read since" — only when that is true. */
function staleClause(staleMerges: number): string {
  if (!staleMerges) return "";
  return `, ${plural(staleMerges, "merge")} ago with nothing re-read since`;
}

function attribute(gaps: string[], fixes: IntentFixTask[]): IntentGap[] {
  const best = new Map<string, IntentFixTask>();
  for (const f of fixes) {
    const key = titleKey(f.title);
    const prior = best.get(key);
    if (!prior || RANK[statusOf(f.state)] > RANK[statusOf(prior.state)]) best.set(key, f);
  }
  return gaps.map((text) => {
    const owner = best.get(gapKey(text));
    const status = owner ? statusOf(owner.state) : "unowned";
    return { text, status, taskId: status === "unowned" ? null : owner!.id };
  });
}

/**
 * Whether a task still counts toward what has to be delivered.
 *
 * Cancelled tasks are dropped from the denominator, not counted as failures.
 * A run re-plans: 94 of run bc691359's 145 tasks were cancelled, most of them
 * superseded by a task that did the same job better. Counting them would peg
 * the run at a third delivered forever and the number would never move, which
 * is worse than not drawing it.
 */
function countable(t: IntentTask): boolean {
  return t.state !== "CANCELLED";
}

function milestonesOf(tasks: IntentTask[], epics: { id: string; title: string }[]): IntentMilestone[] {
  const out: IntentMilestone[] = [];
  for (const e of epics) {
    const mine = tasks.filter((t) => t.epicId === e.id && countable(t));
    if (!mine.length) continue; // an epic the re-plan emptied is not a thing still owed
    const done = mine.filter((t) => t.state === "MERGED").length;
    out.push({
      id: e.id,
      title: e.title,
      done,
      total: mine.length,
      parked: mine.filter((t) => t.state === "NEEDS_HUMAN").length,
      percent: Math.round((done / mine.length) * 100),
    });
  }
  return out;
}

export function intentPosture(input: IntentInput): IntentPosture {
  const roundsLeft = Math.max(0, input.roundsAllowed - input.roundsUsed);
  const milestones = milestonesOf(input.tasks, input.epics);
  const live = input.tasks.filter(countable);
  const delivered = live.filter((t) => t.state === "MERGED").length;
  const outstanding = milestones.filter((m) => m.done < m.total);
  const parkedTasks = live.filter((t) => t.state === "NEEDS_HUMAN").length;
  const base = {
    deliveryHeadline: !live.length
      ? "There is no plan yet, so there is nothing to measure the work against."
      : `${delivered} of ${plural(live.length, "task")} the plan asked for ${delivered === 1 ? "is" : "are"} merged, across ${plural(milestones.length, "milestone")} \u2014 ${
          outstanding.length
            ? `${plural(outstanding.length, "milestone")} still ${outstanding.length === 1 ? "has" : "have"} work outstanding`
            : "every one of them is complete"
        }${parkedTasks ? `, and ${plural(parkedTasks, "task")} ${parkedTasks === 1 ? "is" : "are"} parked and waiting on you` : ""}.`,
    percent: live.length ? Math.round((delivered / live.length) * 100) : null,
    delivered,
    total: live.length,
    milestonesDone: milestones.filter((m) => m.done === m.total).length,
    milestones,
    staleMerges: input.staleMerges,
    roundsLeft,
    closed: 0,
    inFlight: 0,
    parked: 0,
    unowned: 0,
  };

  if (!input.intent) {
    // Before the first merge there is nothing built to read, and the plan gate's
    // verdict is the only thing that has looked at the assignment at all. It is
    // worth showing and it is not the same claim, so it is labelled as the plan.
    if (!input.plan) {
      return {
        ...base,
        stance: "unjudged",
        verdict: null,
        judged: "nothing",
        gaps: [],
        gapProgress: null,
        headline: "Nothing has read this run against what you asked for yet — the first check runs once something merges.",
      };
    }
    const passed = input.plan.verdict === "PASS";
    const gaps: IntentGap[] = passed ? [] : input.plan.gaps.map((text) => ({ text, status: "unowned" as const, taskId: null }));
    return {
      ...base,
      stance: "plan-only",
      verdict: passed ? "PASS" : "FAIL",
      judged: "plan",
      gaps,
      unowned: gaps.length,
      gapProgress: null,
      headline: gaps.length
        ? `The plan was read against your assignment and ${plural(gaps.length, "thing")} it asks for ${gaps.length === 1 ? "was" : "were"} not in it; nothing built has been checked yet.`
        : "The plan covers what you asked for; nothing built has been checked against it yet.",
    };
  }

  if (input.intent.verdict === "PASS") {
    return {
      ...base,
      stance: "met",
      verdict: "PASS",
      judged: "tree",
      gaps: [],
      gapProgress: null,
      headline: `The last check read the merged tree against what you asked for and found nothing missing${staleClause(input.staleMerges)}.`,
    };
  }

  const gaps = attribute(input.intent.gaps, input.fixes);
  const count = (s: GapStatus) => gaps.filter((g) => g.status === s).length;
  const closed = count("closed");
  const inFlight = count("in-flight");
  const parked = count("parked");
  const unowned = count("unowned");

  // A FAIL with no gap list is a check that disagreed without saying what about.
  // It is still a FAIL and still worth the operator's attention; what it is not
  // is a fraction, so nothing is drawn for it.
  const gapProgress = gaps.length ? Math.round((closed / gaps.length) * 100) : null;
  // "Closing" is about movement, not ownership. A gap whose only task is parked
  // has an owner and is going nowhere, and reading that as progress is the
  // failure this whole indicator exists to stop.
  const stance: IntentStance = inFlight > 0 ? "closing" : "unowned";

  const stuck = parked + unowned;
  const roundNote =
    unowned && !roundsLeft
      ? ` The run has spent every gap-closing round it is allowed (${input.roundsAllowed}), so it will not queue work for ${unowned === 1 ? "it" : "them"} on its own.`
      : "";
  const parkedNote = parked ? ` ${plural(parked, "task")} against ${parked === 1 ? "a gap is" : "gaps are"} parked and waiting on you.` : "";

  const headline = !gaps.length
    ? `The last check read the merged tree against what you asked for and disagreed, without naming what is missing${staleClause(input.staleMerges)}.`
    : stance === "closing"
      ? `${closed} of ${plural(gaps.length, "gap")} the last check found ${closed === 1 ? "is" : "are"} closed and ${inFlight} more in flight${stuck ? `, ${stuck} with nothing moving on ${stuck === 1 ? "it" : "them"}` : ""}${staleClause(input.staleMerges)}.${parkedNote}${roundNote}`
      : `${plural(gaps.length, "thing")} you asked for ${gaps.length === 1 ? "is" : "are"} still missing and nothing in the run is moving on ${gaps.length === 1 ? "it" : "them"}${staleClause(input.staleMerges)}.${parkedNote}${roundNote}`;

  return {
    ...base,
    stance,
    verdict: "FAIL",
    judged: "tree",
    gaps,
    closed,
    inFlight,
    parked,
    unowned,
    gapProgress,
    headline,
  };
}
