import { normalizePath } from "./dispatchOrder.js";

/**
 * What the plan said a task would edit, against what it actually edited.
 *
 * `touchedPaths` has been in the plan schema from the start and only ever had
 * one reader: the scheduler, which uses it to keep two workers off the same
 * file. Nothing has ever compared it to the diff, so a task could declare five
 * files, change one, pass QA on criteria that only mentioned the one, and merge
 * — which is the shape of the Goal 8 failure in run da8325bd, where a task
 * scoped to remove a claim from the product's pricing surfaces removed it from
 * a single page and left it on twenty others.
 *
 * This is a signal, not a verdict, and it is deliberately given to QA rather
 * than used to fail a task. The planner's list is a guess written before anyone
 * read the code: a task that touches something undeclared is usually right, and
 * a task that skips a declared file is sometimes right too. What neither should
 * be is invisible. QA is the reader that can tell which it is, because QA is
 * the one holding the acceptance criteria.
 */
export interface PathDrift {
  /** Declared by the planner, and not in the diff. */
  missing: string[];
  /** In the diff, and not covered by anything the planner declared. */
  extra: string[];
}

/** Does `file` fall under `declared` — the same path, or something inside that directory? */
function covers(declared: string, file: string): boolean {
  return file === declared || file.startsWith(`${declared}/`);
}

/**
 * The gap between the plan's paths and the branch's, both directions.
 *
 * A declared directory is satisfied by any file inside it, so a task that says
 * `frontend/src/pages` and edits three pages under it has not drifted. Empty
 * declarations produce no drift at all: a planner that named nothing has said
 * nothing, and inventing a complaint from silence would put a warning on every
 * task in a plan whose planner did not fill the field in.
 */
export function pathDrift(declared: string[], changed: string[]): PathDrift {
  const want = [...new Set(declared.map(normalizePath).filter(Boolean))];
  const got = [...new Set(changed.map(normalizePath).filter(Boolean))];
  if (!want.length) return { missing: [], extra: [] };
  return {
    missing: want.filter((d) => !got.some((f) => covers(d, f))),
    extra: got.filter((f) => !want.some((d) => covers(d, f))),
  };
}

/** Whether there is anything here worth putting in front of a reviewer. */
export function hasDrift(drift: PathDrift): boolean {
  return drift.missing.length > 0 || drift.extra.length > 0;
}

/**
 * The paragraph QA reads. Empty when the diff matches the plan, because a note
 * that appears on every task is a note nobody reads by the third one.
 *
 * Framed as a question rather than a finding. QA's job here is to decide
 * whether the criteria are met, and the planner's file list is evidence about
 * that, not a rule that outranks it — a review that fails a task for editing an
 * undeclared file would reject most correct work.
 */
export function renderDrift(drift: PathDrift): string {
  if (!hasDrift(drift)) return "";
  const lines: string[] = ["What the plan expected this task to touch, against what it did:"];
  if (drift.missing.length) {
    lines.push(
      `- Declared in the plan and NOT changed: ${drift.missing.join(", ")}.`,
      `  Check this against the acceptance criteria before you pass it. A task that was scoped across several files and changed one of them is the most common way work merges half-done — the criteria are met as written, and the rest of the job is left behind with nothing recording that it was.`
    );
  }
  if (drift.extra.length) {
    lines.push(
      `- Changed and not declared in the plan: ${drift.extra.slice(0, 20).join(", ")}${drift.extra.length > 20 ? `, and ${drift.extra.length - 20} more` : ""}.`,
      `  Usually fine — the plan's list was written before anyone read the code. Worth a look only if something here belongs to another task.`
    );
  }
  return lines.join("\n");
}
