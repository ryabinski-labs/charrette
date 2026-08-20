import type { Store } from "./store.js";

/**
 * What one run proved about a repository, kept for the next run.
 *
 * The shape is borrowed from Hermes' memory provider
 * (github.com/NousResearch/hermes-agent): facts are prefetched into a session
 * rather than rediscovered, and written at the moments they become known rather
 * than reconstructed afterwards. What is deliberately *not* borrowed is the
 * extraction step. Hermes asks a model what was learned; nothing here does.
 *
 * The reason is asymmetry. A memory is written once and read by every later run
 * in that repository, and a wrong one never announces itself — it just quietly
 * makes every future plan worse, and the operator has no reason to suspect the
 * thing that is supposed to be helping. So only observations are stored: a
 * command that was watched to pass, a command that was watched to fail. Nothing
 * inferred, nothing summarised, nothing a model claimed. That rules out whole
 * categories of useful fact ("the tests need Postgres on 5432") and is worth it
 * until there is a measurement saying otherwise.
 *
 * The database already lives at `<repo>/.harness/harness.db`, so these rows are
 * scoped to one repository by construction — there is no repo key here because
 * there is no way for two repositories to share a table.
 */

/**
 * What was observed. The vocabulary is small on purpose: each value has to mean
 * one thing an operator can act on.
 *
 *   - `passed`  — the command ran green in a worktree of this repository.
 *   - `failed`  — the command was already failing on a run's integration base,
 *                 before any task touched it. This is the one that parks an
 *                 entire run: every task inherits it, every task is blamed for
 *                 it, and none of them can fix it.
 *   - `flaky`   — the command failed and then passed on a re-run of the same
 *                 tree. Not a defect in the tree; a defect in the check.
 */
export type Verdict = "passed" | "failed" | "flaky";

export interface Observation {
  kind: string;
  subject: string;
  verdict: Verdict;
  /** One line of evidence — the first line of output for a failure, empty otherwise. */
  detail: string;
  runId: string;
  observedAt: number;
  /** How many times this exact thing has been seen. One sighting is an anecdote. */
  observations: number;
}

/** Longest line of evidence kept. A failure's first line is the actionable part. */
const DETAIL_CHARS = 300;

/**
 * Record something a run watched happen.
 *
 * Seeing the same thing again updates the timestamp and the count rather than
 * adding a row, so the table stays the size of the repository's check suite
 * however many runs pass through it. A subject can hold one row per verdict at
 * once — `pnpm test` that usually passes and failed on one base is honestly
 * described by both rows and their two dates, and by neither alone.
 */
export function observe(store: Store, o: Omit<Observation, "observedAt" | "observations">, now = Date.now()): void {
  store.db
    .prepare(
      `INSERT INTO memory (kind, subject, verdict, detail, runId, observedAt, observations)
       VALUES (?,?,?,?,?,?,1)
       ON CONFLICT(kind, subject, verdict) DO UPDATE SET
         detail = excluded.detail,
         runId = excluded.runId,
         observedAt = excluded.observedAt,
         observations = observations + 1`
    )
    .run(o.kind, o.subject, o.verdict, o.detail.split("\n")[0]!.slice(0, DETAIL_CHARS), o.runId, now);
}

/**
 * Write down what one task's check run proved about the repository.
 *
 * Three of the four outcomes are facts about the repository and outlive the
 * run. The fourth is not, and it is the reason this rule lives here rather than
 * at the call site: a check that failed in this worktree and passes on the
 * integration base is *this task's own bug*. Remembering it would teach every
 * later run in the repository that the test suite is broken, on the evidence of
 * one worker's mistake — a memory store making things worse than no memory at
 * all. So `failures` is not a parameter. There is nothing to pass.
 */
export function observeChecks(
  store: Store,
  run: {
    runId: string;
    /** Every check this run is configured to run. */
    configured: string[];
    /** The ones that came back red in the task's worktree, whoever's fault they are. */
    failed: string[];
    /** Of those, the ones already failing on the integration base — the repository's problem. */
    inherited: { command: string; signatures: string[] }[];
    /** The ones that failed and then passed on a re-run of the same tree. */
    flaky: string[];
  },
  now = Date.now()
): void {
  const red = new Set(run.failed);
  for (const subject of run.configured) {
    if (!red.has(subject)) observe(store, { kind: "check", subject, verdict: "passed", detail: "", runId: run.runId }, now);
  }
  // The signatures rather than the raw output: they name the individual things
  // that were already failing, which is what the operator has to go and look at,
  // and they fit on the line the banner gives them.
  for (const f of run.inherited) {
    observe(store, { kind: "check", subject: f.command, verdict: "failed", detail: f.signatures.join(" · "), runId: run.runId }, now);
  }
  for (const subject of run.flaky) observe(store, { kind: "check", subject, verdict: "flaky", detail: "", runId: run.runId }, now);
}

/**
 * Record the individual failures a check run watched fail and then pass.
 *
 * The `check` rows above remember that a *command* was flaky, which is the
 * right grain for the banner and the wrong one for charging: `cargo test
 * --workspace` names three thousand tests, and one timing assertion among them
 * being weather does not make the other 2999 unreliable. These rows remember
 * the failure itself — the normalized signature line — so a later task that
 * meets the same signature twice in a row can be told "this repository has
 * watched that one come and go before" instead of being charged for it.
 *
 * Same discipline as everything else in this file: only what was watched. A
 * signature lands here when it failed and then passed on the same tree, never
 * because anything judged it flaky-looking.
 */
export function observeFlakySignatures(store: Store, runId: string, signatures: string[], now = Date.now()): void {
  for (const subject of signatures) observe(store, { kind: "signature", subject, verdict: "flaky", detail: "", runId }, now);
}

/**
 * The failure signatures this repository has watched fail-then-pass at least
 * `minObservations` times. Two by default: one sighting is an anecdote, and a
 * signature excused on an anecdote is a real defect waved through on one.
 */
export function knownFlakySignatures(store: Store, minObservations = 2): Set<string> {
  return new Set(
    recall(store, "signature")
      .filter((o) => o.verdict === "flaky" && o.observations >= minObservations)
      .map((o) => o.subject)
  );
}

/** Everything this repository has been observed to do, most recent first. */
export function recall(store: Store, kind: string): Observation[] {
  return store.db
    .prepare("SELECT kind, subject, verdict, detail, runId, observedAt, observations FROM memory WHERE kind = ? ORDER BY observedAt DESC")
    .all(kind) as unknown as Observation[];
}

/**
 * What the repository already knows about the checks this run is about to rely
 * on, as banner lines — empty when it knows nothing, which is every first run.
 *
 * Only the checks actually configured for *this* run are reported. A command
 * remembered from a run that used a different suite is not news; it is noise at
 * the one moment the operator is reading carefully.
 *
 * The claim is always in the past tense and always carries its date and run.
 * "`pnpm test` was failing on the base of run 40da9337" is a fact. "`pnpm test`
 * is broken" is a guess about a repository that has had commits since, and the
 * operator is the one who can tell which.
 */
export function checkMemoryBanner(store: Store, checks: string[], now = Date.now()): string[] {
  if (!checks.length) return [];
  const known = new Map<string, Observation[]>();
  for (const o of recall(store, "check")) {
    if (!checks.includes(o.subject)) continue;
    const seen = known.get(o.subject);
    if (seen) seen.push(o);
    else known.set(o.subject, [o]);
  }
  if (!known.size) return [];

  const out: string[] = [];
  for (const command of checks) {
    // Newest first out of recall(), so the head of each list is the last thing
    // that happened to this command.
    const seen = known.get(command);
    if (!seen) continue;
    const latest = seen[0]!;
    if (latest.verdict === "passed") continue; // Nothing to warn about, and saying so is noise.
    const when = ago(latest.observedAt, now);
    const line =
      latest.verdict === "failed"
        ? `$ ${command} was already failing on the base of run ${latest.runId} (${when}) — a check that is red before any task starts parks every task in the run`
        : `$ ${command} failed and then passed on a re-run in run ${latest.runId} (${when}) — its failures are confirmed twice before a task is charged for them`;
    out.push(line);
    if (latest.detail) out.push(`  ${latest.detail}`);
  }
  if (!out.length) return [];
  return ["memory     what earlier runs in this repo watched happen:", ...out.map((l) => `           ${l}`)];
}

/** Human-scale age. Days is the resolution that matters for "is this still true?". */
function ago(then: number, now: number): string {
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
