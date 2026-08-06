import { PlannedTask } from "@harness/shared";

/**
 * Whether this plan builds the pipeline that will judge it — read off the plan,
 * before a worker is paid.
 *
 * Run 3ae58e02 was asked for a production insurance platform. It merged 60
 * tasks, opened PR #62 with 543 files, and the repo reported `state: "none",
 * total: 0` — no workflow, no check, nothing that would ever run. Every task had
 * passed its own QA in its own worktree, and not one of those worktrees was the
 * merged branch. The operator's first signal was opening the pull request and
 * finding the checks list empty.
 *
 * Two things went wrong and both were free to prevent here:
 *
 *   no workflow   `productionScan`'s deploy probe is satisfied by the word
 *                 "dockerfile", and the plan had "Docker Compose stack,
 *                 .env.example and README". A container image is a thing to run;
 *                 it is not a thing that checks. The deploy gap never fired.
 *   no floor      Sixty tasks wrote tests. Nothing in the plan said how much of
 *                 the tree they had to reach, so "the suite passes" was true of
 *                 a suite covering any fraction of it.
 *
 * Unlike `productionScan`, this is NOT demand-driven. There is no brief that
 * asks for CI and no brief that excuses it — a parser, a library and a bank all
 * need something that runs the tests on the merge rather than on the author's
 * laptop. So this fires on every plan that does not have one, and the operator
 * who genuinely wants none approves past it, which is one keystroke and a
 * decision they made on purpose.
 *
 * This reads text. It is a prompt for the operator's judgment, not a verdict,
 * and it never blocks a plan. The gate that does refuse to call a run finished
 * is `awaitChecks`, which asks the repo itself.
 */

/** What the plan is missing. */
export type CiGap = "workflow" | "coverage";

export interface CiFinding {
  gap: CiGap;
  /** The sentence the operator reads. */
  says: string;
}

/**
 * A task that owns a pipeline definition, in any of the forms one comes in.
 *
 * Deliberately generous, and read across the whole plan: the cost of a false
 * negative is that this stays quiet on a plan that has CI under a name not
 * listed here, and the cost of a false positive is an operator who stops
 * believing the section.
 */
const WORKFLOW =
  /\.github\/workflows|\bgithub actions?\b|\bworkflow file\b|\bci workflow\b|\bci pipeline\b|\bci\/cd pipeline\b|\bcontinuous integration\b|\.gitlab-ci\.yml|\bgitlab ci\b|\bcircleci\b|\.circleci|\bbuildkite\b|\bjenkinsfile\b|azure-pipelines|\bteamcity\b|\bdrone\.yml\b|\bwoodpecker\b/i;

/**
 * A coverage number the build can fail on.
 *
 * The word "coverage" alone is not supply. "The suite reports coverage" is
 * satisfied by a run that prints 11% and exits zero, which is the shape of
 * every coverage criterion that has ever been written and never enforced. What
 * counts is a floor: a percentage, a threshold, or a tool invoked in the mode
 * where falling under one is a non-zero exit.
 */
const COVERAGE_FLOOR =
  /\b(coverage|covered lines|cov)\b[^.\n]{0,80}?(\d{2,3}\s?%|\bthreshold\b|\bfloor\b|\bminimum\b|\bat least\b|\bfails? (?:the )?(?:build|ci|check)\b|\bbelow\b|\bgate\b)|(\d{2,3}\s?%)[^.\n]{0,40}\bcoverage\b|--cov-fail-under|\bfail[-_ ]under\b|coverageThreshold|check-coverage|\bcodecov\b|\bjacoco\b.{0,40}\b(?:limit|rule)\b|\bsonar\b.{0,40}\bquality gate\b/i;

/**
 * The floors this harness asks a plan to enforce, and where they come from.
 *
 * 80% on the lines a change touches is the number Codecov's default patch
 * status and SonarQube's "clean as you code" both land on, and it is the one
 * that matters most here: a harness run is almost entirely new code, so patch
 * coverage and project coverage are nearly the same measurement on the first
 * run and diverge into "the old parts rot" on every one after.
 *
 * 75% overall is the industry's own middle — measured averages sit at 74-76%,
 * Google's internal rubric calls 60% acceptable and 75% commendable, and the
 * SEI's finding that cost per point climbs sharply past ~85% is why this stops
 * well short of 90 and further short of 100. A floor nobody can hold is a floor
 * that gets deleted from the workflow in the first week.
 */
export const PATCH_COVERAGE_FLOOR = 80;
export const PROJECT_COVERAGE_FLOOR = 75;

/**
 * The pipeline gaps in a plan. Empty is the answer this should give on a plan
 * that already has CI, which is why the paragraph is worth reading when it is
 * not empty.
 */
export function scanCi(tasks: PlannedTask[]): CiFinding[] {
  // The whole plan is one haystack: it does not matter which task owns the
  // workflow, only that some task does. Touched paths count — the planner is
  // told to name the workflow file there, and a task called "Build pipeline"
  // whose only mention of it is `.github/workflows/ci.yml` owns it.
  const plan = tasks
    .map((t) => `${t.title} ${t.spec} ${t.acceptanceCriteria.join(" ")} ${t.touchedPaths.join(" ")} ${t.completionProbe}`)
    .join("\n");

  const findings: CiFinding[] = [];
  if (!WORKFLOW.test(plan)) {
    findings.push({
      gap: "workflow",
      says:
        "No task builds a CI pipeline. Every check this run makes is a check in a worktree the merged branch never was: the pull request will open with an empty checks list, and the first thing to run the suite on the merge will be whoever merges it.",
    });
  }
  if (!COVERAGE_FLOOR.test(plan)) {
    findings.push({
      gap: "coverage",
      says: `No task enforces a coverage floor. "The suite passes" is true of a suite that reaches a tenth of the tree, so name the number the build fails under — ${PATCH_COVERAGE_FLOOR}% of the lines a change touches, ${PROJECT_COVERAGE_FLOOR}% overall — in the pipeline task's acceptance criteria.`,
    });
  }
  return findings;
}

/**
 * The plan-gate paragraph. It is deliberately separate from the production
 * shape section: that one reports what the operator asked for and did not get,
 * and this one reports the thing nobody has to ask for.
 */
export function renderCi(findings: CiFinding[]): string {
  if (!findings.length) return "";
  return [
    "Continuous integration — the plan does not build what will judge it:",
    ...findings.map((f) => `  ${f.gap}\n    ${f.says}`),
    "",
    "A pipeline is one small task and it is the only check that ever sees the merged branch.",
    "If this repository is checked somewhere else, or deliberately has no CI, approve and it stays that way.",
  ].join("\n");
}
