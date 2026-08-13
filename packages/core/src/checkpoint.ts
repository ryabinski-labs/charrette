/**
 * Checkpoints: making an agent stop, say where it is, and ask before it drifts.
 *
 * This is the operator's own habit, mechanised. Working a long task by hand they
 * run `/compact` and then `/feedback-provider` after every turn: distil the
 * conversation down to what is actually established, then put the open
 * questions up as options with a recommendation and pick one. The reason it
 * works is not the summarising — it is that both halves happen *while the work
 * is still cheap to redirect*, on a cadence, rather than at the end when the
 * only thing left to do is judge what was built.
 *
 * An autonomous run had neither half. A worker gets one prompt and then runs to
 * a hundred and twenty turns with nobody reading it; the first checkpoint is a
 * pit stop, which fires on epic boundaries, spend and wall clock — run-level
 * triggers that can be tens of thousands of tokens away from the turn where the
 * agent quietly assumed the wrong thing. Every expensive failure in this repo's
 * history has the same shape: a correct decision made too late.
 *
 * So a checkpoint is one message, pushed into a live session on a turn cadence,
 * that asks for exactly those two things:
 *
 *   1. A digest — what is established, what was decided, what is left. This is
 *      the `/compact` half. Off the Anthropic transport it is not just written
 *      into the record, it *becomes* the record: `compact.fold` in compact.ts
 *      swaps the older narration and tool output for it, which is real context
 *      reclaimed rather than the elision that module does under pressure.
 *
 *   2. Questions with options and a recommendation. This is the
 *      `/feedback-provider` half, and it is deliberately non-blocking: the
 *      agent is told to proceed on its own recommendation. A run that stops
 *      dead every twenty turns waiting for a human is not a run — f338b5c8's
 *      budget gate sat unanswered for six hours and forty minutes with a worker
 *      slot idle. What the operator gets is the question on the dashboard, in
 *      time to answer it through the feedback channel that already exists, and
 *      the agent's own recommendation on the record when they do not.
 *
 * Why turns rather than money or wall clock: the thing a checkpoint protects
 * against is an agent losing the plot, and turns are what that is measured in.
 * A cadence in dollars fires at different points in the work depending on which
 * model answered.
 *
 * Why no role list: a checkpoint costs a turn, and on a short session that turn
 * is a meaningful fraction of the budget. Rather than maintain a list of which
 * roles are long enough to be worth it — which would be wrong the first time
 * anyone changed a `maxTurns` — the cadence is compared against the session's
 * own wrap-up point, and a session that would never reach the first checkpoint
 * simply never has one. Every role is in scope; arithmetic decides which
 * qualify. At the default cadence a worker (120 turns) checkpoints four times
 * and the two-turn repair role never does, with nothing to keep in sync.
 */

/**
 * Turns between checkpoints.
 *
 * Twenty is about the span over which a session's account of itself stops
 * matching what it is doing — far enough apart that four checkpoints cost a
 * worker under 4% of its turn budget, close enough that a wrong assumption is
 * caught inside one epic's worth of work rather than at the pit stop.
 */
export const DEFAULT_EVERY = 20;

/** One thing the agent wants decided, in the shape feedback-provider asks for. */
export interface CheckpointQuestion {
  question: string;
  /** Distinct, actionable choices. May be empty when the agent asked openly. */
  options: string[];
  /** The one it will act on if nobody answers. Empty when it did not commit to one. */
  recommended: string;
}

/** What an agent said when asked to stop and account for itself. */
export interface Checkpoint {
  /** The state of the work, in the agent's own words. The compaction half. */
  digest: string;
  questions: CheckpointQuestion[];
}

/** The tag the digest is wrapped in, lowercase; matching is case-insensitive. */
const OPEN = "<harness-checkpoint>";
const CLOSE = "</harness-checkpoint>";

/**
 * Is a checkpoint due on this turn?
 *
 * `wrapUpAt` is the turn where pool.ts asks for a final answer, and nothing is
 * pushed at or after it: those turns belong to the wrap-up, and a checkpoint
 * racing it would spend the session's last exchange describing the work instead
 * of reporting it. That is also what excludes every short-session role for
 * free — a session whose wrap-up lands before the first checkpoint has none.
 */
export function checkpointDue(turn: number, every: number, wrapUpAt: number): boolean {
  if (every <= 0) return false;
  if (turn <= 0 || turn >= wrapUpAt) return false;
  return turn % every === 0;
}

/**
 * The message pushed into the session.
 *
 * Written as an interruption rather than a question, because it is one: the
 * agent is mid-task and the worst outcome here is that it treats this as a
 * change of assignment and stops working. Hence the closing line — the whole
 * point is that the work continues.
 */
export function checkpointPrompt(turn: number, every: number): string {
  return [
    `[HARNESS] Checkpoint at turn ${turn}. This is a routine cadence, not a change of assignment — it fires every ${every} turns.`,
    "",
    "Two things, then carry straight on with what you were doing.",
    "",
    `1. Write the state of your work inside a ${OPEN} … ${CLOSE} block, in the format below.`,
    "   Write it for someone who will continue this task with ONLY that block and the original assignment —",
    "   no access to anything you have read or run so far. Established facts, decisions you have already made",
    "   and would not revisit, what is left. Be concrete: name files, symbols and commands rather than",
    "   describing them. Do not pad it, and do not claim anything you have not actually verified.",
    "",
    "2. In the same block, raise anything you would genuinely want a human to decide — an assumption you are",
    "   about to build on, a fork in the approach, a mismatch between the assignment and what the repo does.",
    "   Give each one two to four distinct options and mark the one you recommend. If nothing is genuinely",
    "   open, write no questions rather than inventing one.",
    "",
    "Format (repeat QUESTION/OPTIONS/RECOMMENDED per question; zero questions is a valid answer):",
    "",
    OPEN,
    "STATE: <what is established, decided, and still to do>",
    "QUESTION: <one line>",
    "OPTIONS: <option a> | <option b> | <option c>",
    "RECOMMENDED: <the option you will act on>",
    CLOSE,
    "",
    "Do NOT wait for an answer — nobody may be watching, and a stalled session is worse than a wrong turn",
    "that gets corrected. Act on your own recommendation and keep going. If the operator does answer, it",
    "will arrive as an ordinary message later in this conversation; treat it as authoritative when it does.",
  ].join("\n");
}

/**
 * Read back whatever the agent wrote, or null if it did not answer in the
 * format.
 *
 * Deliberately forgiving, and never throws. A checkpoint is an extra that the
 * real work does not depend on: an agent that writes a beautiful digest and
 * fumbles a pipe character should still have its digest recorded, and one that
 * ignores the whole instruction should cost nothing more than the turn. Nothing
 * downstream of this treats a null as a fault.
 */
export function parseCheckpoint(text: string): Checkpoint | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  const start = lower.indexOf(OPEN);
  if (start < 0) return null;
  const from = start + OPEN.length;
  const end = lower.indexOf(CLOSE, from);
  // An unclosed block is the normal shape of a truncated answer. Reading to the
  // end of the message keeps the digest that was written rather than discarding
  // it over the tag that was not.
  const body = text.slice(from, end < 0 ? undefined : end);

  const digest: string[] = [];
  const questions: CheckpointQuestion[] = [];
  let current: CheckpointQuestion | null = null;

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const field = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(line);
    const key = field?.[1]?.toUpperCase();
    const value = field?.[2]?.trim() ?? "";

    if (key === "QUESTION") {
      if (current) questions.push(current);
      current = { question: value, options: [], recommended: "" };
    } else if (key === "OPTIONS" && current) {
      current.options = value
        .split("|")
        .map((o) => o.trim())
        .filter(Boolean);
    } else if (key === "RECOMMENDED" && current) {
      current.recommended = value;
    } else if (key === "STATE") {
      digest.push(value);
    } else if (!current) {
      // Continuation of the digest. Agents wrap STATE over several lines far
      // more often than they keep it to one, and dropping those lines would
      // record a first sentence as though it were the whole account.
      digest.push(line);
    }
  }
  if (current) questions.push(current);

  const state = digest.join("\n").trim();
  // A block with neither a digest nor a question is not a checkpoint; treating
  // it as one would publish an empty card to the dashboard every cadence.
  if (!state && questions.length === 0) return null;
  return { digest: state, questions: questions.filter((q) => q.question) };
}

/**
 * Did the agent say nothing here except its checkpoint block?
 *
 * A checkpoint queued on the very turn an agent happens to finish buys it one
 * more exchange, so the session settles twice and the digest is the last thing
 * said. The digest is not the task's answer: what the session returns is parsed
 * downstream for evidence, PR numbers and verdicts, and a digest has none of
 * them — the session would look like it had done the work and reported nothing.
 * Callers use this to keep the answer that was already given.
 *
 * Only a bare block counts. An agent that writes its digest and then goes on to
 * answer properly in the same message has answered, and that answer is the one
 * that should stand.
 */
export function isCheckpointOnly(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const start = lower.indexOf(OPEN);
  if (start < 0) return false;
  const end = lower.indexOf(CLOSE, start + OPEN.length);
  const rest = text.slice(0, start) + (end < 0 ? "" : text.slice(end + CLOSE.length));
  return rest.trim() === "";
}

/** One line per question, for the run log and the dashboard feed. */
export function describeQuestions(questions: CheckpointQuestion[]): string[] {
  return questions.map((q) => {
    const opts = q.options.length ? `  [${q.options.join(" | ")}]` : "";
    const rec = q.recommended ? `  → proceeding with: ${q.recommended}` : "";
    return `${q.question}${opts}${rec}`;
  });
}
