import { repeatable } from "./evidence.js";

/**
 * A task's own definition of done, as one command the harness runs.
 *
 * The probe exists for the criterion that cannot be written as prose without
 * losing its meaning. "The unenforced claim is removed from the pricing
 * surfaces" is a true statement about a job that is only half done, so a
 * reviewer holding it as the standard passes work that changed one file out of
 * twenty-one — which is what run da8325bd merged, correctly, against criteria
 * that said exactly that. `! rg -q "Multi-agent priority" frontend/src` has no
 * half-satisfied reading.
 *
 * It is written by the planner, which makes it the one command in this system
 * an agent hands the harness to run with nothing in between — and the harness
 * runs it in the worktree, once per QA iteration, until the task passes. So the
 * question it has to survive is not merely "is this safe once?" but "may the
 * harness run this again?", which is the question `repeatable` already answers
 * for the commands a demo agent offers as evidence. It is asked here rather
 * than asked a second, slightly different way: two guards answering the same
 * question is how they come to disagree, which is why the shell lexer these
 * both sit on was made shared in the first place.
 *
 * `npm install && npm test` is the probe a planner writes for "the suite
 * passes" without a second thought, and it is exactly the shape that must not
 * run repeatedly — it rewrites the tree the operator is about to review.
 *
 * A probe that does not survive is discarded rather than corrected: the task
 * keeps its criteria and is judged the way tasks were judged before probes
 * existed, which is a weaker check and not a dangerous one.
 */
export function usableProbe(probe: string): string {
  const command = probe.trim();
  if (!command) return "";
  return repeatable(command).ok ? command : "";
}
