import type { PitStopEvery, TaskState } from "@harness/shared";

/**
 * Pit stops: the checkpoint between "approve this plan" and "here is the diff".
 *
 * This module is the part with no I/O in it — when a pit stop is due, and what
 * the operator reads when one opens. The dispatching of the demo and review
 * agents lives in the run controller, because that is where the worktree, the
 * pool and the budget are.
 *
 * See docs/PITSTOP.md for why this exists at all.
 */

const TERMINAL: TaskState[] = ["MERGED", "NEEDS_HUMAN", "CANCELLED"];

export interface PitStopTaskView {
  id: string;
  epicId: string;
  title: string;
  state: TaskState;
}

/**
 * What the run's own history says about pit stops so far. Every field is read
 * back out of the event log rather than held in memory, so a run resumed in a
 * new process picks up its cadence exactly where it left off.
 */
export interface PitStopHistory {
  /** How many have already opened; the next one is this plus one. */
  count: number;
  /** Epics already demoed — the whole of the epic trigger's memory. */
  demoedEpics: string[];
  /** Merged tasks, spend and wall clock as of the last stop (or the run's start). */
  mergedAt: number;
  spentAt: number;
  atMs: number;
}

export interface PitStopDue {
  /** Why it fired, in the operator's language — it is printed to them verbatim. */
  reason: string;
  /** Epics this stop covers. Only the epic trigger fills it. */
  epicIds: string[];
}

/**
 * Is a pit stop due?
 *
 * Deliberately total and pure: every trigger is a comparison against what the
 * history recorded at the last stop, so the same inputs always give the same
 * answer and nothing here can fire twice for one boundary.
 */
export function pitStopDue(
  every: PitStopEvery,
  epics: { id: string; title: string }[],
  tasks: PitStopTaskView[],
  ctx: { spentUsd: number; nowMs: number; mergedCount: number },
  history: PitStopHistory
): PitStopDue | null {
  if (every === "never") return null;
  if (every === "epic") {
    const done = new Set(history.demoedEpics);
    for (const epic of epics) {
      if (done.has(epic.id)) continue;
      const own = tasks.filter((t) => t.epicId === epic.id);
      // An epic nobody has finished is not a boundary; nor is one whose every
      // task was cancelled as unreachable, which is a plan collapsing rather
      // than a product to look at. At least one task has to have merged.
      if (!own.length || !own.every((t) => TERMINAL.includes(t.state))) continue;
      if (!own.some((t) => t.state === "MERGED")) continue;
      return { reason: `the "${epic.title}" epic is finished`, epicIds: [epic.id] };
    }
    return null;
  }
  if ("tasks" in every) {
    const since = ctx.mergedCount - history.mergedAt;
    return since >= every.tasks ? { reason: `${since} more task${since === 1 ? "" : "s"} merged`, epicIds: [] } : null;
  }
  if ("usd" in every) {
    const since = ctx.spentUsd - history.spentAt;
    return since >= every.usd ? { reason: `$${since.toFixed(2)} more spent`, epicIds: [] } : null;
  }
  const minutes = Math.floor((ctx.nowMs - history.atMs) / 60_000);
  return minutes >= every.minutes ? { reason: `${minutes} minutes since the last look`, epicIds: [] } : null;
}

/** What the demo agent found when it tried to run the half-built product. */
export interface DemoReport {
  /** Did the product actually start? The first line of the report either way. */
  started: boolean;
  /** The commands that started it, or the reason none of them did. */
  howStarted: string;
  journeys: { name: string; result: "worked" | "broken" | "not-reachable"; evidence: string }[];
  /**
   * What it could not exercise, and why. The single most valuable field in a
   * pit stop: run ec40b527's validator was right about a broken seam *and*
   * right that it had not checked for more of the same, and the second half is
   * what nobody read.
   */
  couldNotReach: string[];
  /** Files written under the pit stop's artifact directory. */
  artifacts: string[];
  summary: string;
}

/** One named lens's answer to "is this still the thing the operator asked for?". */
export interface ReviewReport {
  lens: string;
  verdict: "on-track" | "drifting" | "off-track";
  findings: string[];
  /** The one question this lens would put to the operator. May be empty. */
  question: string;
}

/** Everything the operator is shown when a pit stop opens. */
export interface PitStop {
  runId: string;
  /** 1-based: the nth pit stop of this run. */
  number: number;
  reason: string;
  demo: DemoReport;
  reviews: ReviewReport[];
  /** One line per task merged since the last pit stop. */
  merged: string[];
  /** Tasks not started yet, in the order they would be dispatched. */
  upcoming: string[];
  /** Tasks parked for a human since the last pit stop. */
  parked: string[];
  spentUsd: number;
  capUsd: number;
  /**
   * What this pit stop itself cost — the demo session plus the reviewers.
   *
   * Shown because it is spent out of the same cap as the work, and because a
   * checkpoint whose price is invisible is one the operator cannot decide to
   * turn off. `{"pitStop":{"every":"never"}}` is the answer to a number they
   * do not like, and they can only reach for it if they can see the number.
   */
  stopCostUsd: number;
  /** What the whole plan looks like it will cost at the current rate. */
  projectedUsd: number;
  intent: { verdict: "PASS" | "FAIL"; gaps: string[]; summary: string } | null;
  artifactsDir: string;
  /** The report as markdown — what a terminal prints and a browser renders. */
  markdown: string;
}

/**
 * What the operator decided.
 *
 * `redirect` attaches their words to every task that has not run yet;
 * `replan` sends the remaining work back to the planner with those words and
 * the built tree as context; `stop` parks the run for `harness resume`.
 */
export interface PitStopDecision {
  action: "continue" | "redirect" | "replan" | "stop";
  feedback: string;
}

const VERDICT_MARK: Record<ReviewReport["verdict"], string> = {
  "on-track": "on track",
  drifting: "DRIFTING",
  "off-track": "OFF TRACK",
};

/**
 * Render the pit stop as markdown.
 *
 * Ordered by what the operator has to decide with, not by what the harness
 * found first: whether the thing runs, then what the lenses think is wrong,
 * then what it cost, then what is about to be built — because "stop before you
 * build X" is only sayable by someone who has been shown X.
 */
export function renderPitStop(stop: Omit<PitStop, "markdown">): string {
  const lines: string[] = [`# Pit stop ${stop.number} — ${stop.reason}`, ""];

  lines.push(
    stop.demo.started
      ? `**It runs.** ${stop.demo.howStarted}`
      : `**It does not run.** ${stop.demo.howStarted || "The demo agent could not start the product."}`,
    ""
  );
  if (stop.demo.summary) lines.push(stop.demo.summary, "");

  if (stop.demo.journeys.length) {
    lines.push("## What it did", "");
    for (const j of stop.demo.journeys) {
      const mark = j.result === "worked" ? "✓" : j.result === "broken" ? "✗" : "–";
      lines.push(`- ${mark} **${j.name}** — ${j.evidence}`);
    }
    lines.push("");
  }
  // Always rendered, even when empty: "nothing was left unchecked" and "nobody
  // said what was left unchecked" have to look different.
  lines.push("## What it could NOT check", "");
  lines.push(...(stop.demo.couldNotReach.length ? stop.demo.couldNotReach.map((c) => `- ${c}`) : ["- (nothing — it reached everything it set out to)"]));
  lines.push("");

  if (stop.reviews.length) {
    lines.push("## What the reviewers think", "");
    for (const r of stop.reviews) {
      lines.push(`### ${r.lens} — ${VERDICT_MARK[r.verdict]}`);
      for (const f of r.findings) lines.push(`- ${f}`);
      if (r.question) lines.push("", `> ${r.question}`);
      lines.push("");
    }
  }

  if (stop.intent) {
    lines.push(
      "## Intent check",
      "",
      stop.intent.verdict === "PASS"
        ? `PASS — ${stop.intent.summary}`
        : `**FAIL** — ${stop.intent.summary || "the merged result does not deliver what was asked"}`,
      ...stop.intent.gaps.map((g) => `- ${g}`),
      ""
    );
  }

  lines.push(
    "## Where the run is",
    "",
    `- Spent **$${stop.spentUsd.toFixed(2)}** of $${stop.capUsd.toFixed(2)}` +
      (stop.projectedUsd > stop.spentUsd ? `; the whole plan projects to about **$${stop.projectedUsd.toFixed(2)}**` : ""),
    `- This pit stop cost $${stop.stopCostUsd.toFixed(2)} of that`,
    ""
  );
  const list = (title: string, items: string[], empty: string) => {
    lines.push(`### ${title}`, "");
    lines.push(...(items.length ? items.map((i) => `- ${i}`) : [`- ${empty}`]));
    lines.push("");
  };
  list("Merged since the last look", stop.merged, "nothing");
  if (stop.parked.length) {
    list("Parked, waiting on you", stop.parked, "nothing");
    // Anything written here reaches a parked task, but only when it starts
    // again — and only `harness resume` starts it. Saying so is the difference
    // between an operator who reopens them and one who assumes this did.
    lines.push("These do not restart on their own: `harness resume` asks about each one, and anything you write here is waiting for them when it does.", "");
  }
  list("Not built yet, in this order", stop.upcoming, "nothing — this is the whole plan");

  if (stop.demo.artifacts.length) {
    lines.push("## Evidence", "", ...stop.demo.artifacts.map((a) => `- ${a}`), "", `All of it: ${stop.artifactsDir}`, "");
  }
  return lines.join("\n").trimEnd();
}

/**
 * A demo agent that crashed, or answered with something other than the JSON it
 * was asked for, still has to produce a pit stop — a checkpoint that silently
 * does not happen is the failure this whole feature exists to fix. So the
 * absence is reported as the finding it is.
 */
export function demoUnavailable(why: string): DemoReport {
  return {
    started: false,
    howStarted: `The demo agent did not finish: ${why}`,
    journeys: [],
    couldNotReach: ["everything — there is no demo for this pit stop, so nothing below was verified by running it"],
    artifacts: [],
    summary: "",
  };
}
