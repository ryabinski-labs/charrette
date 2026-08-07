import { Store } from "./store.js";

/**
 * Why a run produced what it produced.
 *
 * Working out why run 40da9337 delivered a product that could not move money
 * took an hour of ad-hoc SQL against `.harness/harness.db`: counting
 * `intake.question` against `intake.answered`, reading acceptance criteria,
 * pulling the one `run.intent_verdict`, grouping errored-session spend by cause.
 * Every one of those is a fixed query. None was reachable from the CLI —
 * `harness status` answers "where is it and what has it cost", which is a
 * different question from "why is this what I got".
 *
 * The answer, that time, was a question the operator was asked and never
 * answered. Nothing in the product surfaced that, and it was two lines of SQL.
 */

export interface Postmortem {
  runId: string;
  state: string;
  assignment: string;
  /** Intake questions with no answer on record — the plan was made without them. */
  unanswered: string[];
  /** The plan-gate judgment, and whether the plan changed afterwards. */
  planIntent: { verdict: string; gaps: string[]; heeded: boolean; sentBackBy: string } | null;
  /** The end-of-run judgment, and whether its gaps became tasks. */
  intent: { verdict: string; gaps: string[]; queued: number } | null;
  /** Tasks whose acceptance criteria never require anything to leave the process. */
  selfContained: { id: string; title: string; criterion: string }[];
  /** Spend by how the session ended, worst first. */
  spend: { cause: string; sessions: number; usd: number }[];
  /** Total wall-clock the run spent waiting on the operator, in hours. */
  blockedHours: number;
  gates: number;
  /** Which harness build each session ran under, earliest first. */
  builds: { build: string; sessions: number; first: number; last: number }[];
}

/** Criteria that assert a double, or assert that nothing is called. */
const SELF_CONTAINED = /\b(mock|fake|stub|test double)\b|\bno (?:outbound|external|network) (?:http |api )?(?:call|request)/i;
const REACHES_OUT = /\b(sandbox|test mode|live|real (?:vendor|api|request)|recorded (?:fixture|response)|contract test)\b/i;

export function postmortem(store: Store, runId: string): Postmortem {
  const run = store.getRun(runId)!;
  const tasks = store.listTasks(runId);

  const unanswered = store
    .intakeTranscript(runId)
    .filter((q) => q.answer === null)
    .map((q) => q.question);

  const planVerdict = readVerdict(store, runId, "run.plan_intent_verdict");
  const planIntent = planVerdict && {
    verdict: planVerdict.verdict,
    gaps: planVerdict.gaps,
    // A re-plan after the verdict is somebody having acted on it. Approving
    // straight through is a legitimate choice, but it should be visible as one.
    heeded: store.lastEventSeq(runId, "run.plan_intent_verdict") < lastPlanRejection(store, runId),
    // And by whom. `planGate.decidedBy` means the gaps may have been sent back
    // by a skill before the operator ever saw them, and a run that corrected
    // its own plan should not read as one a person had to catch.
    sentBackBy: lastPlanGateDecider(store, runId),
  };

  const endVerdict = readVerdict(store, runId, "run.intent_verdict");
  const intent = endVerdict && {
    verdict: endVerdict.verdict,
    gaps: endVerdict.gaps,
    queued: tasks.filter((t) => t.id.startsWith("intent-fix-")).length,
  };

  const selfContained: Postmortem["selfContained"] = [];
  for (const t of tasks) {
    if (t.acceptanceCriteria.some((c) => REACHES_OUT.test(c))) continue;
    const criterion = t.acceptanceCriteria.find((c) => SELF_CONTAINED.test(c));
    if (criterion) selfContained.push({ id: t.id, title: t.title, criterion });
  }

  const spend = (
    store.db
      .prepare(
        `SELECT COALESCE(NULLIF(s.state,''),'unknown') AS cause, COUNT(*) AS sessions, COALESCE(SUM(s.costUsd),0) AS usd
         FROM sessions s WHERE s.runId = ? GROUP BY cause ORDER BY usd DESC`
      )
      .all(runId) as { cause: string; sessions: number; usd: number }[]
  ).filter((r) => r.usd > 0);

  const builds = store.db
    .prepare(
      `SELECT build, COUNT(*) AS sessions, MIN(startedAt) AS first, MAX(startedAt) AS last
       FROM sessions WHERE runId = ? GROUP BY build ORDER BY first`
    )
    .all(runId) as Postmortem["builds"];

  const gateRows = store.db
    .prepare(
      `SELECT o.ts AS opened,
         (SELECT r.ts FROM events r WHERE r.runId = o.runId AND r.taskId IS o.taskId
            AND r.type IN ('task.gate_resolved','run.gate_resolved') AND r.seq > o.seq ORDER BY r.seq LIMIT 1) AS closed,
         (SELECT r.payload FROM events r WHERE r.runId = o.runId AND r.taskId IS o.taskId
            AND r.type IN ('task.gate_resolved','run.gate_resolved') AND r.seq > o.seq ORDER BY r.seq LIMIT 1) AS by
       FROM events o WHERE o.runId = ? AND o.type IN ('task.gate_opened','run.gate_opened')`
    )
    .all(runId) as { opened: number; closed: number | null; by: string | null }[];
  // Only what actually waited on a person. A gate `taskGate.decidedBy`,
  // `planGate.decidedBy` or `budget.decidedBy` answered held the run for one
  // agent session, and reporting that back as "waiting on you" would credit the
  // operator with hours they were not part of — which is the exact number these
  // deciders exist to bring down, so it has to be measured honestly.
  const waitedOnAPerson = (g: { by: string | null }) =>
    !g.by || ((JSON.parse(g.by) as { decidedBy?: string }).decidedBy ?? "operator") === "operator";
  const blockedMs = gateRows.reduce((sum, g) => sum + (g.closed && waitedOnAPerson(g) ? g.closed - g.opened : 0), 0);

  return {
    runId,
    state: run.state,
    assignment: run.assignment,
    unanswered,
    planIntent,
    intent,
    selfContained,
    spend,
    blockedHours: Math.round((blockedMs / 3_600_000) * 10) / 10,
    gates: gateRows.length,
    builds,
  };
}

function readVerdict(store: Store, runId: string, type: string): { verdict: string; gaps: string[] } | null {
  const row = store.db
    .prepare("SELECT payload FROM events WHERE runId = ? AND type = ? ORDER BY seq DESC LIMIT 1")
    .get(runId, type) as { payload: string } | undefined;
  if (!row) return null;
  // Both verdict events default `gaps` in the event schema, so it is always there.
  const p = JSON.parse(row.payload) as { verdict: string; gaps: string[] };
  return { verdict: p.verdict, gaps: p.gaps };
}

/**
 * Sequence of the last time the plan was sent back, or 0 if it never was.
 *
 * Two phrasings, because there are now two things that can send it back: the
 * operator rejecting at the gate, and `planGate.decidedBy` vetoing the gaps
 * before they ever reach the gate. Matching only the first would report a run
 * whose adjudicator did exactly its job as one that approved the gaps anyway,
 * which is the opposite of what happened.
 */
function lastPlanRejection(store: Store, runId: string): number {
  const row = store.db
    .prepare(
      `SELECT MAX(seq) AS seq FROM events WHERE runId = ? AND type = 'run.state_changed'
       AND (payload LIKE '%plan rejected%' OR payload LIKE '%sent the plan back over the intent check%')`
    )
    .get(runId) as { seq: number | null };
  return row.seq ?? 0;
}

/** Who last sent the plan back at the gate — a skill name, "operator", or "". */
function lastPlanGateDecider(store: Store, runId: string): string {
  const row = store.db
    .prepare(
      `SELECT payload FROM events WHERE runId = ? AND type = 'run.gate_resolved'
       AND payload LIKE '%"kind":"plan"%' AND payload LIKE '%"resolution":"rejected"%' ORDER BY seq DESC LIMIT 1`
    )
    .get(runId) as { payload: string } | undefined;
  // Runs from before the plan gate was recorded at all have no such row, and
  // every rejection they carry was a person's.
  return row ? ((JSON.parse(row.payload) as { decidedBy?: string }).decidedBy ?? "operator") : "";
}

/** The report, for a terminal. Ordered by what most often explains the outcome. */
export function renderPostmortem(p: Postmortem): string {
  const out: string[] = [`Run ${p.runId} [${p.state}] — ${p.assignment.slice(0, 100).replace(/\n.*/s, "")}`, ""];

  if (p.unanswered.length) {
    out.push(
      `${p.unanswered.length} intake question(s) went unanswered, so the plan was made without them:`,
      ...p.unanswered.map((q) => `  - ${q}`),
      ""
    );
  }

  if (p.planIntent && p.planIntent.gaps.length) {
    out.push(
      `The plan gate said this plan would not deliver ${p.planIntent.gaps.length} thing(s) the assignment asked for` +
        (p.planIntent.heeded
          ? `, and ${p.planIntent.sentBackBy && p.planIntent.sentBackBy !== "operator" ? `${p.planIntent.sentBackBy} sent it` : "it was sent"} back to the planner:`
          : ", and it was approved anyway:"),
      ...p.planIntent.gaps.map((g) => `  - ${g.slice(0, 200)}`),
      ""
    );
  }

  if (p.intent) {
    out.push(
      p.intent.verdict === "PASS"
        ? "The finished run matched the assignment."
        : `The finished run did NOT match the assignment — ${p.intent.gaps.length} gap(s), ${p.intent.queued} queued as work:`,
      ...(p.intent.verdict === "PASS" ? [] : p.intent.gaps.map((g) => `  - ${g.slice(0, 200)}`)),
      ""
    );
  }

  if (p.selfContained.length) {
    out.push(
      `${p.selfContained.length} task(s) could pass without anything leaving the process:`,
      ...p.selfContained.map((t) => `  ${t.id} — ${t.title}\n    ${t.criterion.slice(0, 140)}`),
      "  A task is finished when its criteria are met. If one of these was meant to",
      "  integrate with something, it did not have to.",
      ""
    );
  }

  if (p.spend.length) {
    // Every row is filtered to a positive figure, so the total cannot be zero.
    const total = p.spend.reduce((s, r) => s + r.usd, 0);
    out.push("Spend by how the session ended:");
    for (const r of p.spend) {
      const share = Math.round((r.usd / total) * 100);
      out.push(`  ${r.cause.padEnd(12)} $${r.usd.toFixed(2).padStart(8)}  ${String(r.sessions).padStart(4)} session(s)  ${share}%`);
    }
    out.push("");
  }

  out.push(...renderBuilds(p.builds), `${p.gates} gate(s), ${p.blockedHours}h waiting on you.`);
  return out.join("\n");
}

/** `2026-08-02 14:33` in UTC — short enough to line up, precise enough to compare against a commit. */
function stamp(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Which harness ran this. One line when the answer is one build, and a table
 * when it is not — a run whose sessions carry two builds did not run one
 * harness, and every finding above it has to be read per-build.
 */
function renderBuilds(builds: Postmortem["builds"]): string[] {
  if (!builds.length) return [];
  if (builds.length === 1) {
    const only = builds[0]!;
    return [
      only.build
        ? `Ran under harness ${only.build} — all ${only.sessions} session(s).`
        : `The harness did not record its build for these ${only.sessions} session(s): the run predates the stamp, so which fixes it ran cannot be read off this record.`,
      "",
    ];
  }
  return [
    `This run spanned ${builds.length} harness builds. A fix reaches a session only if it was in the`,
    "build that session started under — the process loads its build once and cannot reload it:",
    ...builds.map(
      (b) => `  ${(b.build || "(not recorded)").padEnd(20)} ${String(b.sessions).padStart(4)} session(s)   ${stamp(b.first)} → ${stamp(b.last)}`
    ),
    "",
  ];
}
