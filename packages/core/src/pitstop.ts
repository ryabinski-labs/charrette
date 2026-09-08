import type { PitStopEvery, TaskState } from "@harness/shared";
import type { ArtifactClaim, CommandClaim, CoverageReading } from "./evidence.js";

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
  /**
   * What the operator asked, when they are the reason this stop is happening.
   *
   * Empty for every trigger in `pitStopDue` below — a stop nobody asked for has
   * no question — and set only by `RunController.pitStopReason` from the
   * request event. It reaches the demo agent and the decider, so the stop
   * answers the thing that was worth interrupting a run for rather than taking
   * the same generic look the automatic stops take.
   */
  question?: string;
  /**
   * When that question was asked — the request event's `ts`.
   *
   * Carried through to `run.pitstop_opened` so the stop retires the request it
   * is actually answering and not one that arrived while its demo was running.
   * Undefined for every trigger that nobody asked for.
   */
  askedAt?: number;
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
  /**
   * The journeys the demo agent said it would drive, named before it drove
   * them. Its half of a contract; `journeys` below is the delivery, and
   * `coverage` is the comparison.
   *
   * It exists because the demo runs on the cheap tier and a thin demo is
   * indistinguishable from a thorough one once it has been summarised. See
   * `demoCoverage` in evidence.ts for why the comparison is made in code and
   * not left to whoever reads the report.
   */
  plannedJourneys: string[];
  journeys: { name: string; result: "worked" | "broken" | "not-reachable"; evidence: string }[];
  /**
   * What the harness made of the two lists above. Derived, never agent-authored
   * — an agent that grades its own thoroughness grades it "thorough".
   */
  coverage: CoverageReading;
  /**
   * What it could not exercise, and why. The single most valuable field in a
   * pit stop: run ec40b527's validator was right about a broken seam *and*
   * right that it had not checked for more of the same, and the second half is
   * what nobody read.
   */
  couldNotReach: string[];
  /**
   * Files written under the pit stop's artifact directory, each with the claim
   * it backs. A file without a claim is not evidence — the operator who opened
   * a bare `01-marketing-home-desktop.png` could not say what it was for — and
   * neither is a file the harness inspected and found blank. Both are struck
   * before this is rendered; see evidence.ts.
   */
  artifacts: ArtifactClaim[];
  /**
   * Commands the demo offered as proof, each with what passing it settles. The
   * harness runs every repeatable one again before the operator sees it; the
   * ones that fail, and the ones that cannot safely be repeated, are moved to
   * `couldNotReach`. See evidence.ts — this is the same rule as `artifacts`,
   * applied to the claims that are not files.
   */
  commands: CommandClaim[];
  summary: string;
}

/**
 * A demo report before the harness has scored it.
 *
 * The shape the agent actually returns, and the shape the evidence gate strikes
 * claims out of. `coverage` is attached last, from what survived — see
 * `runDemo` — which is why it cannot be part of the type those steps operate on.
 */
export type DemoFindings = Omit<DemoReport, "coverage">;

/** One named lens's answer to "is this still the thing the operator asked for?". */
export interface ReviewReport {
  lens: string;
  verdict: "on-track" | "drifting" | "off-track";
  findings: string[];
  /** The one question this lens would put to the operator. May be empty. */
  question: string;
  /**
   * False when the session died before it reached a verdict.
   *
   * Such a report carries `verdict: "on-track"` because there is no honest
   * verdict to carry, and for a while that was only half-told: `runReviews`
   * threaded this into the second-pass decision but dropped it on the way to
   * the renderer, which reads the heading off the verdict alone. So pit stop 26
   * of ledger-app a8df0107 printed three lenses that had died with `TypeError:
   * fetch failed` as three headings saying "on track", and an operator scanning
   * headings saw four endorsements where there was one. That stop was the only
   * one of 26 that paid for the deep lenses.
   *
   * Optional so stops recorded before it existed still parse; absent means
   * finished, which is what every one of them was assumed to be anyway.
   */
  finished?: boolean;
}

/** Everything the operator is shown when a pit stop opens. */
export interface PitStop {
  runId: string;
  /** 1-based: the nth pit stop of this run. */
  number: number;
  reason: string;
  /**
   * Null when the stop was opened without running the product — the one that
   * `harness resume` opens on a parked run. That stop exists to show the
   * operator the queue and let them change it, and charging them for a demo
   * and four reviewers before they have decided whether to spend anything at
   * all is how a checkpoint becomes a thing people route around.
   */
  demo: DemoReport | null;
  reviews: ReviewReport[];
  /**
   * Lenses the config asked for that this stop did not buy, because the first
   * pass agreed the run was on track. See `runReviews`.
   *
   * Rendered rather than dropped. The reviewer list is a promise the operator
   * configured — "these four perspectives will look at my product" — and a stop
   * that shows two of them without saying so has quietly changed that promise.
   * Empty on every stop that ran them all, which is the usual case.
   */
  skippedReviewers: string[];
  /** One line per task merged since the last pit stop. */
  merged: string[];
  /** Tasks not started yet, in the order they would be dispatched. */
  upcoming: string[];
  /** Tasks parked for a human since the last pit stop. */
  parked: string[];
  /**
   * Tasks the run cancelled, each with the reason it was cancelled for.
   *
   * Here because run 6fe4ba37 dropped 39 tasks at a re-plan and then showed
   * the operator a queue of 3, with nothing anywhere saying the other 39 had
   * ever existed. Work that left the plan is exactly what someone deciding
   * "is this run still going to build what I asked for?" has to be shown.
   */
  cancelled: string[];
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
  intent: { verdict: "PASS" | "FAIL" | "UNKNOWN"; gaps: string[]; unchecked?: string[]; summary: string } | null;
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
  /**
   * For a `stop` a skill decided: which of the four things only an operator can
   * settle it is waiting on. Absent when the operator stopped their own run —
   * they owe nobody a category — and absent on every other action.
   */
  blockedOn?: "money" | "scope" | "access" | "direction";
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

  const demo = stop.demo;
  if (demo) {
    lines.push(
      demo.started
        ? `**It runs.** ${demo.howStarted}`
        : `**It does not run.** ${demo.howStarted || "The demo agent could not start the product."}`,
      ""
    );
    if (demo.summary) lines.push(demo.summary, "");

    // Before anything the demo claims, how much of its own plan it got through.
    // Placed here rather than in a footnote because everything below is read in
    // the light of it: "the checkout is broken" from a demo that drove one of
    // six journeys is a different sentence from the same words after a full run.
    const c = demo.coverage;
    const badge =
      c.status === "demonstrated" ? "**DEMONSTRATED**" : c.status === "partial" ? "**PARTIAL**" : "**INCONCLUSIVE**";
    lines.push(
      `${badge} — ${c.why}. (${c.reached}/${c.planned} planned journeys, ${c.proof} piece(s) of surviving proof.)`,
      ""
    );
    if (c.status === "inconclusive") {
      lines.push(
        "> Treat everything below as unverified. This demo did not establish that the product does what it says — not that it doesn't.",
        ""
      );
    }

    if (demo.journeys.length) {
      lines.push("## What it did", "");
      for (const j of demo.journeys) {
        const mark = j.result === "worked" ? "✓" : j.result === "broken" ? "✗" : "–";
        lines.push(`- ${mark} **${j.name}** — ${j.evidence}`);
      }
      lines.push("");
    }
    // Always rendered, even when empty: "nothing was left unchecked" and "nobody
    // said what was left unchecked" have to look different.
    lines.push("## What it could NOT check", "");
    lines.push(...(demo.couldNotReach.length ? demo.couldNotReach.map((c) => `- ${c}`) : ["- (nothing — it reached everything it set out to)"]));
    lines.push("");
  } else {
    // Said plainly rather than left to inference. An operator who has read six
    // pit stops backed by a demo must not read the seventh as "it still runs".
    lines.push(
      "**Nothing was run for this stop.** It opened because you resumed a parked run, so it costs nothing and shows only what the run's own records say.",
      ""
    );
  }

  if (stop.reviews.length) {
    lines.push("## What the reviewers think", "");
    for (const r of stop.reviews) {
      // A transport error must never be typographically indistinguishable from
      // an opinion. `finished === false` is the only case where the verdict
      // beside it is a placeholder rather than a judgment.
      lines.push(`### ${r.lens} — ${r.finished === false ? "DID NOT FINISH" : VERDICT_MARK[r.verdict]}`);
      for (const f of r.findings) lines.push(`- ${f}`);
      if (r.question) lines.push("", `> ${r.question}`);
      lines.push("");
    }
    if (stop.skippedReviewers.length) {
      lines.push(
        `Not run: ${stop.skippedReviewers.join(", ")}. The reviewers above agreed the run is on track with nothing outstanding, ` +
          "so the remaining lenses were not bought. Nothing has looked at this product through them — a later stop will only " +
          "do so if its own first pass finds something.",
        ""
      );
    }
  }

  if (stop.intent) {
    lines.push(
      "## Intent check",
      "",
      stop.intent.verdict === "PASS"
        ? `PASS — ${stop.intent.summary}`
        : stop.intent.verdict === "UNKNOWN"
          ? `**UNKNOWN** — ${stop.intent.summary || "the validator ran out of turns before it could judge the tree"}; not checked:`
          : `**FAIL** — ${stop.intent.summary || "the merged result does not deliver what was asked"}`,
      ...(stop.intent.verdict === "UNKNOWN" ? (stop.intent.unchecked ?? []) : stop.intent.gaps).map((g) => `- ${g}`),
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
  if (stop.cancelled.length) {
    list("Cancelled — in the plan once, not any more", stop.cancelled, "nothing");
    // The one sentence that would have saved run 6fe4ba37. `resume` alone puts
    // none of this back; only re-planning does, and an operator who does not
    // know that reads a short queue as "nearly done" rather than "gutted".
    lines.push("`harness resume` does not bring these back. Re-planning at a pit stop is what queues this work again — say `replan` and describe what you still want.", "");
  }

  if (demo && (demo.artifacts.length || demo.commands.length)) {
    // Never a bare filename: the operator opens these to settle a question, and
    // a list of names does not say which question each one settles.
    lines.push("## Evidence", "");
    if (demo.artifacts.length) lines.push(...demo.artifacts.map((a) => `- \`${a.file}\` — ${a.shows}`), "");
    if (demo.commands.length) {
      // Everything printed here was run twice: once by the demo agent and once
      // by the harness. A claim that survived only the first is not in this
      // list — it is under what the pit stop could not check.
      lines.push("Re-run by the harness and confirmed:", "", ...demo.commands.map((c) => `- \`${c.command}\` — ${c.shows}`), "");
    }
    lines.push(`All of it: ${stop.artifactsDir}`, "");
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
    plannedJourneys: [],
    journeys: [],
    coverage: {
      status: "inconclusive",
      planned: 0,
      reached: 0,
      proof: 0,
      firstBlocked: "",
      why: `the demo agent did not finish: ${why}`,
    },
    couldNotReach: ["everything — there is no demo for this pit stop, so nothing below was verified by running it"],
    artifacts: [],
    commands: [],
    summary: "",
  };
}
