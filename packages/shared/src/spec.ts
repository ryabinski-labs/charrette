import { z } from "zod";

/**
 * The run's executable specification: what was promised, and the scenario that
 * would catch it if the promise were broken.
 *
 * Every gate in this harness before now judged prose against prose. The
 * planner's acceptance criteria are sentences, QA reads a diff and decides
 * whether the sentences are satisfied, and the intent check reads the merged
 * whole and decides whether it matches the assignment. All three are the same
 * mechanism, and it fails the same way each time: "the unenforced claim is
 * removed from the pricing surfaces" is a true statement about a job that is
 * one twenty-first done, and run da8325bd merged exactly that, correctly,
 * against a criterion that said exactly that.
 *
 * A scenario is that criterion in a form that cannot be partially satisfied,
 * and — unlike `completionProbe`, which is one command a planner thought of —
 * it comes from a systematic pass over the brief before anyone is paid to build
 * anything. The skill that derives it is `prd-to-tdd`; this is the shape the
 * harness keeps, and the vocabulary the plan, QA, the acceptance gate and the
 * completion report all speak.
 *
 * Parsed from the spec agent's JSON rather than from the artifact's YAML. The
 * artifact is the skill's format and the skill owns it; re-implementing its
 * schema here would give the harness a second opinion about what a scenario is,
 * and the two would drift.
 */

export const ScenarioLevel = z.enum(["unit", "integration", "contract", "acceptance"]);
export type ScenarioLevel = z.infer<typeof ScenarioLevel>;

/**
 * `P0` and `P1` are what the acceptance gate holds the run to. `P2`/`P3` are
 * reported and never block: a run stopped by a nice-to-have is a run whose gate
 * the operator turns off.
 */
export const ScenarioPriority = z.enum(["P0", "P1", "P2", "P3"]);
export type ScenarioPriority = z.infer<typeof ScenarioPriority>;

export const SpecRequirement = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  priority: ScenarioPriority.default("P1"),
  /** Open questions that must be answered before this can be built honestly. */
  blockedBy: z.array(z.string()).default([]),
});
export type SpecRequirement = z.infer<typeof SpecRequirement>;

export const SpecScenario = z.object({
  id: z.string().min(1),
  /** The requirement this scenario would falsify. */
  requirement: z.string().default(""),
  title: z.string().default(""),
  level: ScenarioLevel.default("unit"),
  priority: ScenarioPriority.default("P1"),
  /** The observable check that decides pass/fail. Prose here is a bug. */
  oracle: z.string().default(""),
  /** `path::test name`, when the red-phase scaffold wrote one. */
  testRef: z.string().default(""),
  /**
   * Scaffolded but deliberately not runnable: it depends on an open question
   * nobody has answered. Never counted against the run — an unanswerable test
   * parked in CI teaches everyone to ignore a red bar.
   */
  blocked: z.boolean().default(false),
});
export type SpecScenario = z.infer<typeof SpecScenario>;

/**
 * A question the specification could not answer from the brief.
 *
 * The most valuable field in this file. Run 40da9337 spent 37 hours and $773
 * building six of seven integrations as fail-closed stubs, because it was
 * interrupted one question into "real vendor accounts, sandbox adapters, or
 * fakes only?" and resumed straight past it. `prd-to-tdd` refuses to invent an
 * oracle for exactly that kind of gap and records it instead — which makes its
 * open questions and the harness's intake questions the same object, asked at
 * the same moment, of the same person.
 */
export const SpecOpenQuestion = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  /** What in the brief makes this worth asking. */
  detail: z.string().default(""),
  /** Requirement ids that cannot be specified until this is answered. */
  blocks: z.array(z.string()).default([]),
});
export type SpecOpenQuestion = z.infer<typeof SpecOpenQuestion>;

/**
 * How the scenario suite is run in this repository.
 *
 * `all` is what the acceptance gate runs against the merged whole. `byId`
 * carries `{{ids}}` and is what a single task is judged by — a worker that has
 * built one task should not be held to scenarios nobody has started.
 *
 * Both come from the spec agent, which detected the frameworks, rather than
 * from a guess here: a repo may be pytest, vitest, go test and playwright at
 * once, and the command that runs "the scenarios" is a fact about the repo.
 */
export const SpecCommands = z.object({
  all: z.string().default(""),
  byId: z.string().default(""),
});
export type SpecCommands = z.infer<typeof SpecCommands>;

/**
 * The shortest sequence a real user performs that makes the product worth
 * having. ledger-app: connect a Stripe account, ingest, produce a return. waf:
 * install on a cluster, send an attack, get a 403.
 *
 * Named at intake, from the brief, before any code exists — for the same
 * reason the scenarios are. It is what the live-exercise gate drives at the
 * end of the run, from a clean checkout, by the repository's own documented
 * start: across five runs and $4,763 on those two products, nothing ever
 * started the product and used it, and both were internally coherent and
 * neither one ran (issue #116). Empty when the spec agent could not name one,
 * which the gate reports as "never exercised" rather than as a pass.
 */
export const CriticalPath = z.object({
  /** What the path is, in one line: "connect a Stripe account and produce a return". */
  name: z.string().default(""),
  /** The steps a user takes, in order, each observable on its own. */
  steps: z.array(z.string().min(1)).default([]),
});
export type CriticalPath = z.infer<typeof CriticalPath>;

export const RunSpec = z.object({
  feature: z.string().default(""),
  /** Repo-relative path to the artifact the skill wrote, e.g. `tdd/checkout.tdd.yaml`. */
  artifactPath: z.string().default(""),
  /** What the brief was hashed as, so drift against it is detectable later. */
  sourceSha256: z.string().default(""),
  requirements: z.array(SpecRequirement).default([]),
  scenarios: z.array(SpecScenario).default([]),
  openQuestions: z.array(SpecOpenQuestion).default([]),
  commands: SpecCommands.default({}),
  criticalPath: CriticalPath.default({}),
  /** What the spec agent could not derive, in its own words. */
  notCovered: z.array(z.string()).default([]),
});
export type RunSpec = z.infer<typeof RunSpec>;

/** Whether the specification names a critical path the live-exercise gate can drive. */
export function hasCriticalPath(spec: RunSpec | null): spec is RunSpec & { criticalPath: { name: string; steps: [string, ...string[]] } } {
  return spec !== null && spec.criticalPath.steps.length > 0;
}

/** The scenarios the acceptance gate is allowed to stop a run over. */
export function gating(spec: RunSpec): SpecScenario[] {
  return spec.scenarios.filter((s) => !s.blocked && (s.priority === "P0" || s.priority === "P1"));
}

/** The open questions that must be answered before the plan is worth writing. */
export function blockingQuestions(spec: RunSpec): SpecOpenQuestion[] {
  const gatingReqs = new Set(spec.requirements.filter((r) => r.priority === "P0" || r.priority === "P1").map((r) => r.id));
  // A question that blocks nothing named is still asked: the spec agent raised
  // it against the brief, and "it blocks nothing I could name" is not the same
  // as "it does not matter". Only a question whose every blocked requirement is
  // a nice-to-have is allowed to wait.
  return spec.openQuestions.filter((q) => !q.blocks.length || q.blocks.some((id) => gatingReqs.has(id)));
}
