/**
 * Work a run is about to pay for twice.
 *
 * rust-service paid three separate tasks for one body parser. `seclang ast types` merged
 * twice under two ids; the multipart, JSON and XML body parsers were each
 * planned and merged twice; and the run then paid for a third task,
 * *"Consolidate duplicate body parsers into one per format"*, to clean up after
 * itself. This is not a subtle planning failure — it is visible in the task
 * titles, and nothing was looking at them.
 *
 * It happens because a re-plan is written against a *description* of the run
 * rather than against the run. The planner is handed what merged as a list of
 * titles, and a fresh session with a large plan to write does not reliably
 * notice that the thing it is about to plan is the thing at line 40 of that
 * list. Asking it to try harder is not a mechanism; comparing the two lists is.
 *
 * What this is not: a judgment about whether the second task is worthwhile.
 * Plenty of real work touches a file that has already been touched, and a
 * repeat is sometimes exactly what the operator asked for. So nothing here
 * cancels anything — the finding goes to the pit stop that is approving the
 * re-plan, beside the coverage that re-plan drops, and the decision is the
 * operator's (issue #128).
 *
 * Pure and I/O-free, like `skeleton` and `scopeLedger`: the caller supplies the
 * two lists, so the rule is testable without a run.
 */

/** Just enough of a task to compare it. Both `TaskRow` and `PlannedTask` satisfy this. */
export interface ComparableTask {
  id: string;
  title: string;
  /** What the planner expects it to edit. Empty means it did not say. */
  touchedPaths: string[];
}

/**
 * Words that carry no signal about what a task is for.
 *
 * Every plan is full of them — "add the X", "implement Y", "wire up Z" — and a
 * comparison that counts them matches every task against every other. What is
 * left after they go is the subject: `seclang ast types`, `multipart body
 * parser`.
 */
const NOISE = new Set([
  "a", "an", "and", "the", "to", "for", "of", "in", "on", "with", "into", "from", "at", "by", "per", "its", "it",
  "add", "adds", "added", "implement", "implements", "build", "builds", "create", "creates", "make", "makes",
  "wire", "wires", "up", "write", "writes", "support", "supports", "handle", "handles", "new", "task", "then",
]);

/** The words of a title that say what it is about, lowercased and deduped. */
export function subjectWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      // Anything that is not a letter or a digit separates words: `src/api.ts`,
      // `body-parser` and `body parser` are all the same three ideas.
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !NOISE.has(w))
  );
}

/**
 * How many subject words two titles must share before one is read as the other.
 *
 * Two is the floor that makes this usable: one shared word matches "the parser"
 * against "the plan parser" against "parser tests", and a gate that fires on
 * every third task is one nobody reads by the fourth. `seclang ast types` and
 * `multipart body parser` each clear it comfortably.
 */
const MIN_SHARED = 2;

/**
 * Is the shorter title's whole subject contained in the longer one's?
 *
 * Containment rather than similarity, because that is the shape the real cases
 * take: `Body parser: multipart` and `Implement the multipart body parser` are
 * the same work described at two lengths, and neither is a typo of the other.
 */
export function titleRepeats(a: string, b: string): boolean {
  const left = subjectWords(a);
  const right = subjectWords(b);
  if (left.size < MIN_SHARED || right.size < MIN_SHARED) return false;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  return [...small].every((w) => large.has(w));
}

/** Trim the spellings of one path that mean the same file. Mirrors `dispatchOrder`. */
const normalize = (p: string): string => p.trim().replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * Does everything the proposed task says it will edit already belong to the
 * merged one?
 *
 * One-directional on purpose. A new task that touches a file the merged task
 * owned *and nothing else* is very likely the same work again; a merged task
 * whose paths happen to sit inside a larger new one is the ordinary case of a
 * feature growing, and flagging it would make this noise.
 */
export function pathsRepeat(proposed: string[], merged: string[]): boolean {
  const mine = proposed.map(normalize).filter(Boolean);
  const theirs = merged.map(normalize).filter(Boolean);
  // A planner that named no paths has told us nothing, and "nothing" is
  // contained in everything — which would make every silent task a repeat.
  if (!mine.length || !theirs.length) return false;
  return mine.every((p) => theirs.some((t) => p === t || p.startsWith(`${t}/`)));
}

export interface PlanRepeat {
  /** The task about to be dispatched. */
  taskId: string;
  title: string;
  /** The merged task it repeats. */
  mergedId: string;
  mergedTitle: string;
  /** Which comparison matched, in the operator's language. */
  why: string;
}

/**
 * Every proposed task that looks like work this run already merged.
 *
 * Each proposed task is reported at most once, against the first merged task
 * that matches it: an operator who is told the same thing three ways stops
 * reading on the second.
 */
export function planRepeats(merged: ComparableTask[], proposed: ComparableTask[]): PlanRepeat[] {
  const found: PlanRepeat[] = [];
  for (const p of proposed) {
    // A task that keeps its own id across a re-plan is the same task, not a
    // repeat of itself — `replan` reuses ids for exactly that.
    const hit = merged.find((m) => m.id !== p.id && (titleRepeats(p.title, m.title) || pathsRepeat(p.touchedPaths, m.touchedPaths)));
    if (!hit) continue;
    found.push({
      taskId: p.id,
      title: p.title,
      mergedId: hit.id,
      mergedTitle: hit.title,
      why: titleRepeats(p.title, hit.title) ? "the titles describe the same work" : "every path it names is one that task already changed",
    });
  }
  return found;
}

/** How many repeats travel in the sentence. Enough to see the pattern, few enough to read. */
const SHOWN = 5;

/**
 * What to put to the operator about it, if anything.
 *
 * Empty for a plan that repeats nothing. Phrased as what was noticed rather
 * than as a verdict: the charrette is comparing two lists of words, and the
 * question of whether the second task is worth paying for is not one a word
 * comparison can answer.
 */
export function planRepeatsNote(repeats: PlanRepeat[]): string {
  if (!repeats.length) return "";
  const shown = repeats.slice(0, SHOWN).map((r) => `${r.taskId} ("${r.title}") repeats ${r.mergedId} ("${r.mergedTitle}") — ${r.why}`);
  return (
    `${repeats.length} task(s) in this plan look like work this run has already merged: ${shown.join("; ")}` +
    (repeats.length > shown.length ? `, +${repeats.length - shown.length} more` : "") +
    `. This is a comparison of titles and paths, not a judgment about the work — a second pass over the same ground is sometimes exactly what you asked for. ` +
    `One run paid for three separate body parsers this way and then paid a fourth task to consolidate them.`
  );
}
