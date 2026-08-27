import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  GateKind,
  Plan,
  PlanBatch,
  PlanBreakdown,
  PlannedEpic,
  PlannedTask,
  QaVerdict,
  RunConfig,
  RunSpec,
  TaskState,
  blockingQuestions,
  briefToAssignment,
  gating,
  validatePlanDag,
} from "@harness/shared";
import { indexSkills, matchSkills, verifyHash, type IndexedSkill } from "@harness/skills-mcp";
import { Bus } from "./bus.js";
import { BudgetExceeded } from "./budget.js";
import { seedWorktreeDeps } from "./deps.js";
import { coChangeIndex, coChangeNote } from "./coChange.js";
import { nextDispatch } from "./dispatchOrder.js";
import { git, pushRunBranch, repoFileList, WorktreeManager } from "./git.js";
import { GitHubAdapter, type PrRef } from "./github.js";
import { unsatisfiableCriteria } from "./infraGuard.js";
import { runIntake, type IntakeUi } from "./intake.js";
import { acquireRunLock, type RunLock } from "./runLock.js";
import { composeDown, isolationBlock, isolationEnv, taskIsolation } from "./isolation.js";
import { knownFlakySignatures, observeChecks, observeFlakySignatures } from "./memory.js";
import { parseRunbook, withRunbook, type Runbook } from "./operatorRunbook.js";
import { acceptanceVerdict, scenarioCommand, scenarioProbeCommand, suiteRunFrom, type AcceptanceVerdict } from "./acceptance.js";
import { standaloneReport } from "./completionReport.js";
import { assembleReport, reportPath } from "./reportRun.js";
import { ceilingNote, grantedTokens, requestTokens, sdkCeiling } from "./outputCeiling.js";
import { missingKeys } from "./providerClients.js";
import { reapUnder } from "./reaper.js";
import { AgentPool, type AgentResult, type AgentSpec } from "./pool.js";
import {
  demoUnavailable,
  pitStopDue,
  renderPitStop,
  type DemoFindings,
  type DemoReport,
  type PitStop,
  type PitStopDecision,
  type PitStopDue,
  type ReviewReport,
} from "./pitstop.js";
import {
  checkCommands,
  checkEvidence,
  demoCoverage,
  evidenceFaults,
  repeatable,
  retryableFaults,
  strikeCommands,
  strikeEvidence,
  type CommandCheck,
  type EvidenceCheck,
  type Rerun,
} from "./evidence.js";
import {
  type AdvisorCheck,
  advisorAnswer,
  advisorPrompt,
  advisorSystemPrompt,
  baseConflictPrompt,
  budgetDeciderPrompt,
  budgetDeciderSystemPrompt,
  conflictPrompt,
  demoEvidenceReaskPrompt,
  demoPrompt,
  demoSystemPrompt,
  emptyBranchPrompt,
  abandonedJobPrompt,
  extractJson,
  extractSection,
  operatorFeedbackMessage,
  pitStopDeciderPrompt,
  priorDecisionsBlock,
  pitStopDeciderSystemPrompt,
  planGateDeciderPrompt,
  planGateDeciderSystemPrompt,
  replanPrompt,
  reviewerPrompt,
  reviewerSystemPrompt,
  plannerBreakdownSystemPrompt,
  plannerContinuePrompt,
  plannerDocsSystemPrompt,
  plannerRepairPrompt,
  tasksPerMessage,
  qaSystemPrompt,
  qaTaskPrompt,
  skillsBlock,
  skillsmithPrompt,
  skillsmithSystemPrompt,
  prodValidatorPrompt,
  prodValidatorSystemPrompt,
  validatorPrompt,
  validatorSystemPrompt,
  planIntentPrompt,
  planIntentSystemPrompt,
  workerResumePrompt,
  workerSystemPrompt,
  workerTaskPrompt,
  specAnswersPrompt,
  specPlanBlock,
  specPrompt,
  specSystemPrompt,
} from "./prompts.js";
import {
  accountEnv,
  alternatives,
  describeReading,
  SubscriptionPaused,
  tripped,
  untilReset,
  type SubscriptionReading,
} from "./subscription.js";
import { usableProbe } from "./completionProbe.js";
import { foreignRepoPaths, validatePlanScope } from "./repoScope.js";
import { hasDrift, pathDrift, renderDrift } from "./pathDrift.js";
import { namedIamResources, renderDeployCapability, scanDeployCapability, type SourceFile } from "./deployCapability.js";
import { declaredResources, renderDeployOrder, scanDeployOrder } from "./deployOrder.js";
import { confirmFailures, runDeterministicChecks, splitInheritedFailures, type CheckResult } from "./qa.js";
import { estimatePlan, renderEstimate } from "./estimate.js";
import { renderIntegrations, scanIntegrations } from "./integrationScan.js";
import { renderCi, scanCi } from "./ciScan.js";
import { renderProduction, scanProduction } from "./productionScan.js";
import { detectToolbelt, toolbeltBlock } from "./toolbelt.js";
import { extendForged, forgeDir, installForged, SkillForgeDecision, validateDraft } from "./skillForge.js";
import { workerModelFor } from "./modelTier.js";
import { Store, TaskRow, type RunRow } from "./store.js";

const execFileP = promisify(execFile);

const FULL_TEXT_SKILL_TOKEN_LIMIT = 1500; // PERF-4
const MAX_FULL_TEXT_SKILLS = 2;

/**
 * Where tasks queued from a failing intent verdict live.
 *
 * Its own epic rather than the epic of whichever task left the gap: the gap is a
 * property of the merged whole, and a pit stop that groups by epic should show
 * these together as "what the intent check found" rather than scattered.
 */
const INTENT_FIX_EPIC = { id: "intent-gaps", title: "Gaps the intent check found" };

/** Where CI-fix tasks land on the board. */
const CI_FIX_EPIC = { id: "ci-red", title: "Checks the repo's CI failed" };

/**
 * Where acceptance-gate fixes land.
 *
 * Its own epic for the same reason the intent gaps have one: a failing scenario
 * is a property of the merged whole rather than of whichever task last touched
 * the file, and a pit stop grouping by epic should show them together as "the
 * promises this run has not kept".
 */
const SPEC_FIX_EPIC = { id: "spec-red", title: "Scenarios the specification says are unmet" };

/** A planner's task as it enters the store: everything it said, nothing started yet. */
function pendingRow(t: PlannedTask): Omit<TaskRow, "runId" | "unverified" | "scenarioIds" | "emptyDeliveries" | "conflictFixes" | "abandonedJobs"> & { scenarioIds: string[] } {
  return {
    id: t.id,
    epicId: t.epicId,
    title: t.title,
    spec: t.spec,
    acceptanceCriteria: t.acceptanceCriteria,
    dependsOn: t.dependsOn,
    state: "PENDING",
    branch: null,
    worktreePath: null,
    githubIssueNumber: null,
    prNumber: null,
    qaIterations: 0,
    respawns: 0,
    assignedSkills: [],
    errorSummary: null,
    touchedPaths: t.touchedPaths,
    estimatedSize: t.estimatedSize,
    completionProbe: usableProbe(t.completionProbe),
    // The promises this task is the one to make good on. See
    // `PlannedTask.scenarioIds` — empty is honest and common.
    scenarioIds: t.scenarioIds,
  };
}

/**
 * Extra query terms per role, appended to the task text before skill matching.
 * The harness is opinionated here: a QA session should reach for QA/testing/
 * security playbooks even when the task spec never says the word "test", and a
 * worker should match only on what the task itself is about. Skills stay
 * generic — a legal-review or branding skill reaches a worker whenever the
 * task's own text points at it.
 */
const ROLE_SKILL_LENS: Record<string, string> = {
  worker: "",
  // The two roles that decide *what* gets built rather than how. Their lens is
  // deliberately product-shaped: the assignment they match against is one line
  // of the operator's prose, which carries far less signal than a task spec.
  intake: "product scope requirements brief stakeholder user customer decision trade-off out of scope",
  planner: "product roadmap requirements PRD scope prioritisation user story acceptance criteria decomposition milestone",
  qa: "QA quality assurance verify verification testing test end-to-end e2e regression review evidence security",
  // The pit stop's two roles. The demo agent's job is to *run* the thing, so it
  // reaches for the same playbooks QA does; the reviewer's job is to judge what
  // the demo found against what the operator asked for.
  demo: "QA end-to-end e2e run demo screenshot browser evidence smoke start local verify user journey",
  reviewer: "product review critique scope user value quality risk evidence judgment",
  // Pulls the operator's own production-validation and QA playbooks in, so the
  // live check is run the way they would run it rather than improvised.
  prod: "production prod live deployed deployment validate validation smoke health monitoring uptime QA end-to-end e2e verify evidence release",
  // Matched against the brief, so the lens has to carry the vocabulary the
  // brief will not: an operator asking for a checkout flow never writes the
  // words "acceptance criteria" or "test level".
  spec: "TDD test-driven acceptance criteria requirements specification executable specification scenario oracle falsifiable BDD ATDD test plan red phase unit integration contract",
};

/**
 * Injection floor, above matchSkills' own permissive cutoff. Against a real
 * skill corpus a genuine match scores well above 1; incidental term overlap
 * lands under ~0.4. A session with no relevant skill should carry none.
 */
/**
 * The bar a *scored* skill must clear to be injected without the operator
 * having asked for it.
 *
 * Raised from 0.5, which admitted almost anything: on one run it let through
 * `cartographer` on a state machine and `play-store-publisher` on a credential
 * store. This is a volume control on noise, not a correctness mechanism —
 * measurement showed irrelevant skills outscoring relevant ones, so no value
 * here makes scoring trustworthy. `skillRouting` is where correctness lives.
 */
const SKILL_SCORE_FLOOR = 1;
/** Context budget: how many skills any one session's prompt will carry. */
const MAX_SKILLS_PER_ROLE = 4;
/**
 * How many times an accepted task's merge conflict goes back to its worker
 * before it goes to the operator. One: a worker that cannot resolve its own
 * conflict with the files in front of it will not do better on a second pass,
 * and each attempt costs a worker session and a QA session.
 */
const CONFLICT_FIX_ATTEMPTS = 1;
/**
 * How many times the run's own conflict with the base branch goes to an agent
 * before it goes to the operator.
 *
 * Two, where a task conflict gets one. The reasoning that bounds that one at a
 * single attempt — the worker already has every file and every piece of context
 * it will ever have — does not hold here. This conflict is against commits the
 * run has never seen, so the first attempt is partly spent reading what the base
 * did, and a second attempt starts from a genuinely better position. It is also
 * the last thing standing between a finished run and a reviewable pull request,
 * which makes one more session cheap against what is already spent.
 */
const BASE_CONFLICT_FIX_ATTEMPTS = 2;
/**
 * How long to wait for GitHub to say whether the pull request merges.
 *
 * Deliberately not `checkTimeoutMinutes`. That budget is sized for CI — a queue,
 * a runner, a test suite — and mergeability is none of those: GitHub computes it
 * in the background within a few seconds of a push, and an answer that has not
 * arrived in half a minute is not going to. Spending a twenty-minute CI budget
 * polling for it would stall every run that hits the one case this exists for.
 *
 * Short, but not zero: the first read after a push genuinely does return `null`,
 * and a single call would report "unconfirmed" on healthy runs.
 */
const MERGEABILITY_SETTLE_MINUTES = 0.5;

/**
 * How many times a task may come back with a branch that changes nothing
 * before it is parked, whatever the operator says.
 *
 * Every other bound in this loop is reset by an answer at the gate, because an
 * answer changes the conditions the previous failures happened under — a new
 * instruction really can make failing checks pass. An empty branch is the one
 * case where that reasoning does not hold: nothing was produced, so nothing
 * about the attempt can be different, and `askOrPark` resets both the
 * iteration count and the wall clock. An operator who keeps answering would
 * keep the task in a loop that no bound in this method can end.
 *
 * So this one is counted separately and never reset. Reaching it means the
 * task cannot commit to its own branch, which is not a question more attempts
 * answer.
 */
const EMPTY_DELIVERY_ATTEMPTS = 4;

/**
 * Empty deliveries the harness forgives because it caused them.
 *
 * A worker told to redirect a long command and poll for it — which is what the
 * background-shell denial recommends — can finish its turn while the command is
 * still going, and the teardown sweep kills it. The branch is then empty for a
 * reason that is nothing to do with the work, and the generic empty-branch
 * advice sends the worker looking for code that was never written.
 *
 * So the first attempts that end this way buy a re-dispatch with the
 * instruction that actually helps, and are not spent out of the budget above.
 * Bounded, and bounded low: two goes at "run it in the foreground and commit as
 * you learn things" is a worker that has been told plainly. A third means
 * something else is wrong, and the empty-delivery path — which ends at the
 * operator — is the right place for it.
 */
const ABANDONED_JOB_ATTEMPTS = 2;

/**
 * Turns the demo agent gets to repair its evidence, resumed with the product
 * still running. Enough to retake a handful of screenshots and look at them;
 * far too few to start driving the product again, which is the point — this
 * turn buys the picture the operator was about to be handed blank, not a
 * second demo.
 */
const EVIDENCE_REASK_TURNS = 12;

/** The validator's judgment of the merged whole against the operator's intent. */
const IntentVerdict = z.object({
  verdict: z.enum(["PASS", "FAIL"]),
  summary: z.string().default(""),
  gaps: z.array(z.string()).default([]),
});
/** The production validator's judgment of the deployed system against intent. */
const ProdVerdict = z.object({
  verdict: z.enum(["PASS", "FAIL"]),
  summary: z.string().default(""),
  findings: z.array(z.string()).default([]),
});
/**
 * What to ask for per planner message when the SDK will not say what the model
 * allows. Note this is a request, not a promise: the SDK clamps it to its own
 * per-model table, and a model it has never heard of falls through to 32k
 * however high this is set. That is why planning is split in two (see `plan`)
 * instead of relying on a bigger budget — the split works on any SDK version.
 *
 * When the table *can* be read, `plannerOutputTokens` asks for the model's real
 * ceiling instead, which on current models is twice this.
 */
const PLANNER_MAX_OUTPUT_TOKENS = 64_000;

/**
 * How many messages the DAG may take. At the smallest batch this module will
 * ask for, eight messages is several hundred tasks — far past the point where a
 * planner is decomposing rather than enumerating. It is a stop, not a target.
 */
const MAX_DAG_BATCHES = 8;

/** The first few schema complaints, named by field, for a planner to act on. */
function issueSummary(error: z.ZodError): string {
  return (
    error.issues
      .slice(0, 5)
      // `extractJson` has already guaranteed an object, so every issue has a key
      // to name; "(root)" is for a schema that grows a root-level rule.
      /* v8 ignore next */
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
  );
}

/**
 * Did the session die against the output-token ceiling rather than produce bad
 * JSON? The two look identical downstream — both end in unparseable text — but
 * they need opposite retries, so they must be told apart.
 */
function outputTruncated(resultText: string, errorDetail?: string): boolean {
  return /max_tokens|output token|response exceeded/i.test(`${errorDetail ?? ""}\n${resultText}`);
}

/**
 * Files that plausibly hold the command which deploys this repository.
 *
 * Read from a fixed list rather than searched for. The alternative — walking
 * the tree for anything containing `sam deploy` — reads every file in the
 * repository to answer a question about two of them, and the deploy command
 * has lived in a CI workflow or a script at the root of the repo for as long
 * as either has existed. Missing ones cost a failed `readFileSync` and nothing
 * else.
 */
const DEPLOYER_FILES = ["samconfig.toml", "Makefile", "makefile", "Jenkinsfile", "buildspec.yml", ".gitlab-ci.yml", "deploy.sh", "scripts/deploy.sh"];

/**
 * The QA note for a task that declared infrastructure its own pipeline cannot
 * create — see `deployCapability.ts` for what is being asked and why here is
 * the last place it can be asked.
 *
 * Reads nothing until the diff contains a template with a named IAM resource
 * in it, which is rare and cheap to rule out: a task that touched no YAML at
 * all costs one `filter` over the file list. Every read is tolerant, because
 * the changed-file list is what the diff says and a deleted file is a normal
 * entry in it.
 */
function deployCapabilityNote(worktree: string, changed: string[]): string {
  const read = (file: string): SourceFile => {
    try {
      return { path: file, text: readFileSync(path.join(worktree, file), "utf8") };
    } catch {
      return { path: file, text: "" };
    }
  };
  const templates = changed.filter((f) => /\.(ya?ml|json|template)$/i.test(f)).map(read);
  if (!templates.some((t) => namedIamResources(t.text).length)) return "";

  let workflows: string[] = [];
  try {
    workflows = readdirSync(path.join(worktree, ".github", "workflows"))
      .filter((f) => /\.ya?ml$/i.test(f))
      .map((f) => `.github/workflows/${f}`);
  } catch {
    // No workflows directory. The repo may still deploy from a script below,
    // and if it does not, this says nothing at all.
  }
  return renderDeployCapability(scanDeployCapability(templates, [...workflows, ...DEPLOYER_FILES].map(read)));
}

/**
 * The QA note for a task whose merge deploys it ahead of infrastructure the
 * merge will not have applied — see `deployOrder.ts` for what is being asked
 * and why here is the last place it can be asked.
 *
 * Reads nothing until the diff contains a `.tf` file with a resource in it,
 * which is rare and free to rule out: a task that touched no Terraform costs
 * one `filter` over the file list. The changed-file list is what the diff
 * says, so a deleted file reading as empty is the correct answer, not an
 * error — a resource that is gone declares nothing.
 */
function deployOrderNote(worktree: string, changed: string[]): string {
  const read = (file: string): SourceFile => {
    try {
      return { path: file, text: readFileSync(path.join(worktree, file), "utf8") };
    } catch {
      return { path: file, text: "" };
    }
  };
  const files = changed.map(read);
  if (!files.some((f) => declaredResources(f).length)) return "";

  let workflows: string[] = [];
  try {
    workflows = readdirSync(path.join(worktree, ".github", "workflows"))
      .filter((f) => /\.ya?ml$/i.test(f))
      .map((f) => `.github/workflows/${f}`);
  } catch {
    // No workflows directory, so no merge-triggered deploy to be ahead of.
  }
  return renderDeployOrder(scanDeployOrder(files, workflows.map(read)));
}

/**
 * A shell argument the operator can paste without reading it first. Probes are
 * full of quotes and pipes — `! rg -qi 'passkey|webauthn' src` is a real one —
 * and a suggested command that needs hand-repair before it runs is a suggestion
 * that does not get used.
 */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The sentence that tells whoever is reading this gate that they have read it
 * before. Empty on the first opening, which is every gate in a healthy run.
 *
 * A gate carries no memory of its own history: answering one resets
 * `qaIterations` to zero, so the next opening reports the same attempt count as
 * the first and reads as a fresh problem. Run 1e7d3df3 asked its operator about
 * one task fourteen times, eleven of them after its decider had run out of
 * answer rounds, and nothing in any of the fourteen questions said so. An
 * operator who cannot see that their last answer changed nothing has no reason
 * to try a different kind of answer.
 *
 * The way out is named explicitly rather than implied. By the third round the
 * useful move is usually not a better answer but a different bar, and `harness
 * probe` is the command for that — logged until now only into `agent.log`,
 * where nobody looking at a gate is looking.
 */
function repeatNote(repeats: number, taskId: string, runId: string, probe: string): string {
  if (repeats < 1) return "";
  const before = repeats === 1 ? "once before" : `${repeats} times before`;
  const answered = repeats === 1 ? "That answer did not" : "Those answers did not";
  return (
    `\n\nThis task has stopped for the same gate ${before}. ${answered} settle it, and the attempt count above ` +
    `restarted with each one, so it is not the whole story.` +
    (probe
      ? `\n\nIf another answer will not change the outcome, the bar itself may be what is wrong. This task is held to:\n` +
        `  ${probe}\n` +
        `To change it — a run in flight picks it up on the next iteration:\n` +
        `  harness probe ${taskId} ${shellQuote(probe)} --run ${runId} --why '...'\n` +
        `  harness probe ${taskId} --clear --run ${runId} --why '...'`
      : "")
  );
}

/**
 * A failure that is about the run rather than about the task that met it.
 *
 * Everywhere a task's crash is caught, parked and driven past, this is the
 * exception: both ceilings are reached by whichever session happened to be
 * running when they were reached, and neither is that session's fault or that
 * session's to survive. Parking one task and dispatching the next would spend
 * the same exhausted budget — or the same exhausted plan — on the same wall.
 *
 * Named rather than repeated as fifteen `instanceof` checks because that is
 * exactly how the second one gets forgotten: the subscription gate was the
 * second, and until this existed a park at 96% of the weekly window quietly
 * became one parked task and a run that carried on into the wall.
 */
/** The three ways a run stops as a whole rather than one task failing. */
type RunStop = BudgetExceeded | SubscriptionPaused | RunPaused;

function stopsTheRun(e: unknown): e is RunStop {
  return e instanceof BudgetExceeded || e instanceof SubscriptionPaused || e instanceof RunPaused;
}

/**
 * Thrown into every live session when the operator asks for the run to stop.
 *
 * The third sibling of `BudgetExceeded` and `SubscriptionPaused`, and
 * deliberately the same shape: all three mean "this run stops now, and nothing
 * about it is broken". What differs is what starts it again — money, a
 * subscription window, and here simply the operator coming back.
 *
 * It travels the path the other two already proved. `checkStops` is awaited on
 * every streamed message of every session, so a throw there reaches a worker
 * mid-turn, a QA agent mid-verdict and the planner alike, and each one ends
 * through the same accounting the budget cap uses: usage booked, session row
 * closed, worktree left with every commit it had made. Nothing is cancelled and
 * nothing is lost that was not already only in the model's head.
 */
export class RunPaused extends Error {
  constructor(public runId: string) {
    super(`paused by the operator — pick it up with: harness resume ${runId}`);
  }
}

/** What the operator is told when the run's budget cap is reached. Never carries secrets. */
export interface BudgetGate {
  spentUsd: number;
  capUsd: number;
}

/**
 * What the operator is told when the account's plan is nearly spent.
 *
 * Account *names* only. The credentials that make a switch work never leave
 * `subscription.ts`, and this payload goes to a dashboard, an event log and a
 * terminal — three places a subscription token must never appear.
 */
export interface SubscriptionGate {
  /** The plan's name for the window: `seven_day`, `seven_day_opus`, … */
  window: string;
  /** How much of it is spent, 0-100. */
  percent: number;
  /** Epoch ms it reopens, or null when the plan named no time. */
  resetsAt: number | null;
  /** The line that was crossed, so the UI can say why this opened. */
  pauseAtPercent: number;
  /** "82% of the weekly limit · resets Aug 18 at 10pm (Australia/Melbourne)". */
  summary: string;
  /** How long until it reopens, as an operator reads it: "3d 4h". */
  untilReset: string;
  /** The account being spent; empty is the operator's ambient login. */
  account: string;
  /** The other configured accounts, by name — what a switch can choose from. */
  alternatives: string[];
}

/**
 * What the operator decided at a subscription gate.
 *
 * `continue` is not "ignore": it is the operator saying the remaining few
 * percent is enough to finish, and the run carries on knowing the wall is
 * there — where `usageLimitWaitMinutes` takes over if it arrives.
 */
export type SubscriptionChoice =
  | { action: "continue" }
  | { action: "switch"; account: string }
  | { action: "park" };

/**
 * A task that hit a cap, presented to the operator before it is parked. The
 * caps exist to stop agents burning tokens in a loop — but most cap hits are
 * an environment or intent problem only the operator can resolve ("the test
 * suite needs DynamoDB running", "skip that flaky check", "you misread the
 * spec, do X"). One sentence from them un-sticks what three more iterations
 * of agents never would.
 */
export interface TaskGate {
  runId: string;
  taskId: string;
  title: string;
  /** Why the task stopped — the same text that would be its park reason. */
  why: string;
  /**
   * An advisor agent's draft of the answer, for the operator to accept, edit,
   * or ignore. Empty when the advisor failed or had nothing useful to say.
   */
  recommendation: string;
  iterations: number;
  branch: string | null;
  worktreePath: string | null;
}

export interface GateHandler {
  /** Present the plan; resolve with approval or rejection feedback. */
  resolvePlanGate(prdMarkdown: string, planSummary: string): Promise<{ approved: boolean; feedback: string }>;
  /**
   * A cap was reached mid-run. Return a new cap in USD to carry on, or null to
   * park the run. A cap that is not above `spentUsd` would trip again on the very
   * next check, so it is treated as a decline.
   */
  resolveBudgetGate(gate: BudgetGate): Promise<number | null>;
  /**
   * The account's plan is nearly spent (`subscription.pauseAtPercent`). Answer
   * with another subscription to move the run onto, `continue` to spend the
   * rest of the window, or `park` to stop here and resume later.
   *
   * Optional: a handler without it keeps going and leaves the alert on the
   * event log, which is the right default for a harness nobody is watching —
   * parking a run that has no operator to un-park it turns a warning into an
   * outage.
   */
  resolveSubscriptionGate?(gate: SubscriptionGate): Promise<SubscriptionChoice>;
  /**
   * A task hit its cap. Return the operator's guidance to hand the worker a
   * fresh set of iterations, or null to park the task. Optional: a handler
   * without it parks immediately, which is the old behaviour and the right one
   * for non-interactive contexts.
   */
  resolveTaskGate?(gate: TaskGate): Promise<string | null>;
  /**
   * A pit stop: the run has stopped to show the operator the product running,
   * and is asking whether it is still what they wanted (docs/PITSTOP.md).
   *
   * Optional, and its absence turns pit stops off entirely rather than making
   * them non-interactive — a demo agent and three reviewers cost real money,
   * and spending it to print a report nobody will answer is worse than not
   * stopping at all.
   */
  resolvePitStop?(stop: PitStop): Promise<PitStopDecision>;
}

/** The demo agent's report, as it comes back over the wire. */
const DemoJson = z.object({
  started: z.boolean(),
  howStarted: z.string().default(""),
  summary: z.string().default(""),
  // What the demo set out to drive, by name, so that what it did drive can be
  // measured against something it committed to first. Defaulting to empty is
  // not a loophole — a demo with no plan is scored inconclusive precisely
  // because there is nothing to hold its results against. See `demoCoverage`.
  plannedJourneys: z.array(z.string()).default([]),
  journeys: z
    .array(
      z.object({
        name: z.string(),
        result: z.enum(["worked", "broken", "not-reachable"]),
        evidence: z.string().default(""),
      })
    )
    .default([]),
  couldNotReach: z.array(z.string()).default([]),
  // A bare string is still accepted so that a demo agent which ignored the
  // shape does not lose its whole report to a parse error. It arrives with no
  // claim attached, which the evidence gate then strikes — lenient at the
  // parser, strict at the gate.
  artifacts: z
    .array(
      z.union([
        z.string().transform((file) => ({ file, shows: "" })),
        z.object({ file: z.string(), shows: z.string().default("") }),
      ])
    )
    .default([]),
  // Same shape and the same reasoning: a bare command string parses, arrives
  // with no claim attached, and is struck by the gate rather than losing the
  // whole report. Absent entirely is a demo that offered no command as proof,
  // which is a fact about the demo and not a parse error.
  commands: z
    .array(
      z.union([
        z.string().transform((command) => ({ command, shows: "" })),
        z.object({ command: z.string(), shows: z.string().default("") }),
      ])
    )
    .default([]),
});

/** One reviewer's verdict on whether the run is still building the right thing. */
const ReviewJson = z.object({
  verdict: z.enum(["on-track", "drifting", "off-track"]),
  findings: z.array(z.string()).default([]),
  question: z.string().default(""),
});

/**
 * What the pit stop's decider said to do next.
 *
 * The same four actions the operator has always had, parsed strictly: an
 * answer that is not one of them is not a decision, and the pit stop falls back
 * to asking rather than rounding it to the nearest one.
 */
const PitStopDecisionJson = z
  .object({
    action: z.enum(["continue", "redirect", "replan", "stop"]),
    blockedOn: z.enum(["money", "scope", "access", "direction"]).optional(),
    why: z.string().default(""),
    feedback: z.string().default(""),
  })
  // A stop must name which of the four things only an operator can settle it is
  // stopping on. Not decoration: a decider that cannot fill this in is a
  // decider stopping over something it had the authority to decide, and the
  // requirement is there to be felt while choosing rather than checked
  // afterwards. A stop that fails it falls through to `ask`, which parks the
  // run at the operator anyway — the same place the stop was heading, minus
  // the claim that an agent decided it.
  .refine((d) => d.action !== "stop" || Boolean(d.blockedOn), {
    message: 'a "stop" must say what it is blocked on: money, scope, access or direction',
    path: ["blockedOn"],
  });

/**
 * What the plan gate's adjudicator said about a failing intent check.
 *
 * There is deliberately no "approve" here. The gap list either goes back to the
 * planner or reaches the operator with a reason attached, and the operator is
 * the only thing that can turn a plan into a run.
 */
const PlanGateDecisionJson = z.object({
  action: z.enum(["replan", "accept"]),
  why: z.string().default(""),
  feedback: z.string().default(""),
});

/**
 * What the budget decider said about a cap that was reached.
 *
 * `capUsd` is checked against the spend and the bound by the caller rather than
 * here: a figure that is too low or too high is a decision the harness declines
 * to act on, and saying which is more useful in the log than a parse error.
 */
const BudgetDecisionJson = z.object({
  action: z.enum(["raise", "park"]),
  capUsd: z.number().default(0),
  why: z.string().default(""),
});

export class RunController {
  private wt: WorktreeManager;

  /**
   * The mergeability settle budget, as a field rather than the constant so a
   * test can shrink it. The timeout path is the one thing this phase exists to
   * prove — that "not known yet" is never reported as a merge — and at the real
   * half-minute it costs more wall clock than the rest of the suite together.
   */
  mergeabilitySettleMinutes = MERGEABILITY_SETTLE_MINUTES;

  constructor(
    private store: Store,
    private bus: Bus,
    private pool: AgentPool,
    private github: GitHubAdapter,
    private gates: GateHandler,
    private repoPath: string
  ) {
    this.wt = new WorktreeManager(repoPath);
  }

  /**
   * Start a run. With an `intake` transport the assignment is treated as a seed:
   * the intake agent interviews the operator and the resulting brief replaces it
   * before the planner ever sees it.
   */
  async startRun(assignment: string, config: RunConfig, intake?: IntakeUi): Promise<string> {
    const runId = randomUUID().slice(0, 8);
    this.store.createRun({
      id: runId,
      repoPath: this.repoPath,
      assignment,
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: this.wt.integrationBranch(runId),
      // Captured now, not at PR time: the operator is free to check out something
      // else while a run is in flight, and the PRs still belong on the branch the
      // work was actually based on. Persisted with the run, so resume agrees.
      config: { ...config, baseBranch: config.baseBranch || (await this.currentBranch()) },
    });
    // Intake runs before `drive`, so its own sessions would otherwise checkpoint
    // on the pool's default rather than on the cadence this run was configured
    // with. `drive` sets it again from the frozen config, which is what a
    // resumed run reads.
    this.applyCheckpointCadence(runId);
    if (intake) await this.intake(runId, assignment, intake);
    await this.drive(runId);
    return runId;
  }

  /**
   * Hand the pool this run's checkpoint cadence (checkpoint.ts).
   *
   * A frozen config from before checkpoints existed has no such field, and a
   * run's config is fixed at creation — so the pool takes `undefined` and keeps
   * its own default rather than this asking twice. The optional call is for the
   * pool doubles the controller's own tests stand up, which implement the one
   * method under test and nothing else.
   */
  private applyCheckpointCadence(runId: string): void {
    this.pool.configureCheckpoints?.(this.store.getRun(runId)!.config.checkpoint);
  }

  /**
   * Hand the pool the subscription this run spends and the watch that guards it
   * (subscription.ts).
   *
   * Optional-called like the cadence above, for the pool doubles the
   * controller's tests stand up. A run whose config predates this feature parses
   * with the schema's defaults — no accounts, so nothing to switch to, and the
   * gate can still stop a run before it walks into the weekly wall.
   */
  private applySubscription(runId: string): void {
    const config = this.store.getRun(runId)!.config.subscription;
    this.pool.configureSubscription?.({
      name: config.active,
      // Resolved here, once, so a `$TOKEN` that is not exported fails at the top
      // of the run — where the operator is watching — rather than on the first
      // session, which would read as an agent that could not authenticate.
      env: accountEnv(config, config.active),
      watch: (id, reading, spawnedAs) => this.watchSubscription(id, reading, spawnedAs),
    });
  }

  /**
   * Read the account's plan before the run spends anything, and open the gate
   * now if it is already past the line.
   *
   * Deliberately tolerant: `readSubscription` returns nothing rather than
   * throwing for an account whose plan does not meter (an API key, Bedrock,
   * Vertex) or an SDK without the control request, and nothing is exactly what
   * "carry on as before" looks like here.
   */
  private async preflightSubscription(runId: string): Promise<void> {
    const config = this.store.getRun(runId)!.config.subscription;
    if (!config.preflight || config.pauseAtPercent >= 100) return;
    const readings = (await this.pool.readSubscription?.(this.store.getRun(runId)!.config.models.worker)) ?? [];
    for (const reading of readings) this.publishReading(runId, reading);
    const over = tripped(readings, config);
    if (!over) return;
    // Asked as the account the run is currently on, which is what makes a
    // switch here visible: the answer differs from what was asked with.
    const next = await this.watchSubscription(runId, over, config.active);
    // A switch decided here has no session to restart — nothing has been
    // dispatched yet — so it is applied straight to the pool and the run starts
    // on the account the operator chose.
    if (next) this.applySubscription(runId);
  }

  /** Gate 0: turn the seed into an agreed brief, on the run's ledger and budget. */
  private async intake(runId: string, seed: string, ui: IntakeUi, prior: { question: string; answer: string | null }[] = []): Promise<void> {
    // Already INTAKE when this is a resumed conversation rather than a new one.
    if (this.store.getRun(runId)!.state !== "INTAKE") this.store.transitionRun(runId, "INTAKE");
    const run = this.store.getRun(runId)!;
    const brief = await runIntake(this.pool, this.bus, {
      runId,
      seed,
      repoPath: this.repoPath,
      config: run.config,
      ui,
      budgetCheck: () => this.checkStops(runId),
      // Matched on the seed — the only text that exists this early.
      skillsBlock: skillsBlock(this.selectSkills(indexSkills(run.config.skillsDirs), "intake", seed, run.config)),
      // The seed is very often "implement <issue link>". The harness holds a
      // token that can fetch it; before this the intake agent could not, and
      // asked the operator to paste an issue back at the tool that files them.
      readIssue: this.github.enabled ? this.github.readIssue.bind(this.github) : undefined,
      prior,
    });
    const assignment = briefToAssignment(brief);
    const dir = path.join(this.repoPath, ".harness", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "BRIEF.md"), `${assignment}\n`);
    this.store.setRunAssignment(runId, assignment);
    // Before PLANNING, because the whole value of specifying at intake is that
    // the operator is still here: `prd-to-tdd` refuses to invent an oracle for
    // anything the brief leaves open and records the gap instead, and this is
    // the last moment those gaps can be answered by the person who has them.
    await this.specify(runId, assignment, ui);
    this.store.transitionRun(runId, "PLANNING", "brief agreed");
  }

  /**
   * Turn the agreed brief into failing tests, on the branch every task will be
   * cut from.
   *
   * The integration branch rather than a scratch directory: task branches are
   * cut from it, so a specification committed here is inherited by every worker
   * in the run and ships in the pull request — which is what makes the tests a
   * deliverable rather than a harness artifact that evaporates when the run
   * ends.
   *
   * Never throws. A run whose specification could not be written is a run
   * without this gate, which is exactly the run every harness before this one
   * was; failing intake over it would trade a working run for no run.
   */
  private async specify(runId: string, assignment: string, ui: IntakeUi): Promise<void> {
    const run = this.store.getRun(runId)!;
    if (!run.config.spec.enabled) return;
    try {
      // The branch first: nothing has created it yet at intake, and it is the
      // whole point of writing the specification here — task branches are cut
      // from it, so every worker inherits the failing tests and the pull
      // request carries them.
      await this.wt.ensureIntegrationBranch(runId);
      const dir = await this.wt.ensureIntegrationWorktree(runId);
      const skills = this.selectSkills(indexSkills(run.config.skillsDirs), "spec", assignment, run.config);
      const sessionId = randomUUID();
      const spec = await this.specSession(runId, sessionId, dir, assignment, skills, run);
      if (!spec) return;

      const answered = await this.askSpecQuestions(runId, spec, ui);
      const final = answered.length ? ((await this.specSession(runId, randomUUID(), dir, assignment, skills, run, answered, sessionId)) ?? spec) : spec;

      this.bus.publish({ type: "run.spec_ready", runId, spec: final, ts: Date.now() });
      await this.commitSpec(runId, dir, final);
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "spec",
        text: `specification: ${final.requirements.length} requirement(s), ${final.scenarios.length} scenario(s), ${gating(final).length} of them gating${final.openQuestions.length ? `, ${final.openQuestions.length} open question(s)` : ""}`,
        ts: Date.now(),
      });
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "spec",
        text: `no specification was written, so the acceptance gate has nothing to hold this run to: ${String(e).slice(0, 300)}`,
        ts: Date.now(),
      });
    }
  }

  /** One pass of the specification agent — the first, or the one after answers. */
  private async specSession(
    runId: string,
    sessionId: string,
    cwd: string,
    assignment: string,
    skills: { name: string; path: string; sha256: string; content?: string }[],
    run: RunRow,
    answers: { question: string; answer: string }[] = [],
    resume?: string
  ): Promise<RunSpec | null> {
    const result = await this.pool.run({
      runId,
      sessionId,
      role: "spec",
      model: run.config.models.spec,
      systemPrompt: specSystemPrompt(toolbeltBlock(detectToolbelt(run.config.externalTools)), skillsBlock(skills)),
      skills: skills.map((s) => s.name),
      prompt: answers.length ? specAnswersPrompt(answers) : specPrompt(assignment, await repoFileList(cwd), run.config.deterministicChecks),
      cwd,
      resume,
      maxTurns: run.config.spec.maxTurns,
      budgetCheck: () => this.checkStops(runId),
    });
    // `extractJson` throws when there is no object at all, and `safeParse`
    // reports one that is not a specification. Both are the same fact — no
    // answer arrived — and both must return rather than throw: the caller's
    // fallback to the specification it already had is the difference between a
    // run whose second pass was unreadable and a run with no gate at all.
    let parsed;
    try {
      parsed = RunSpec.safeParse(extractJson(result.resultText));
    } catch (e) {
      parsed = { success: false as const, error: { issues: [{ message: String(e).slice(0, 200) }] } };
    }
    if (parsed.success) return parsed.data;
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "spec",
      text: `the specification agent's answer could not be read, so this run has no acceptance gate: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 200)}`,
      ts: Date.now(),
    });
    return null;
  }

  /**
   * Put the specification's open questions to the operator, through the same
   * transport that just interviewed them.
   *
   * This is the reason the specification is written at intake at all. Run
   * 40da9337 spent 37 hours and $773.55 shipping six of seven integrations as
   * fail-closed stubs because it planned past "real vendor accounts, sandbox
   * adapters, or fakes only?" — a question nobody was ever asked. Returns the
   * answers, empty when there is nobody to ask or nothing worth asking.
   */
  private async askSpecQuestions(runId: string, spec: RunSpec, ui: IntakeUi): Promise<{ question: string; answer: string }[]> {
    const run = this.store.getRun(runId)!;
    const questions = run.config.spec.askOpenQuestions ? blockingQuestions(spec) : [];
    if (!questions.length) return [];
    const answers: { question: string; answer: string }[] = [];
    for (const q of questions) {
      this.bus.publish({ type: "intake.question", runId, sessionId: "spec", question: q.question, options: [], ts: Date.now() });
      const answer = (await ui.ask({ question: q.question, detail: q.detail, options: [] })).trim();
      this.bus.publish({ type: "intake.answered", runId, sessionId: "spec", question: q.question, answer, ts: Date.now() });
      if (answer) answers.push({ question: q.question, answer });
    }
    return answers;
  }

  /**
   * Commit the specification to the integration branch, so every task branch
   * inherits it and the pull request carries it.
   *
   * Best-effort by design: a specification that could not be committed is still
   * a specification the gate can run, because the gate runs in a worktree of
   * this same branch. What is lost is the deliverable, not the check.
   */
  private async commitSpec(runId: string, dir: string, spec: RunSpec): Promise<void> {
    try {
      await git(dir, ["add", "-A"]);
      const staged = await git(dir, ["diff", "--cached", "--name-only"]);
      if (!staged.trim()) return;
      await git(dir, [
        "commit",
        "-m",
        `spec: ${spec.scenarios.length} failing scenario(s) for ${spec.feature || "this run"}\n\nWritten from the agreed brief before planning. Every P0/P1 scenario here blocks the run until it is green.`,
      ]);
    } catch (e) {
      this.bus.publish({ type: "agent.log", runId, sessionId: "spec", text: `the specification was written but not committed: ${String(e).slice(0, 200)}`, ts: Date.now() });
    }
  }

  async resume(runId: string, intake?: IntakeUi): Promise<void> {
    // Before `pruneAndReconcile`, not after: pruning walks the worktrees of a
    // run another harness may be working in, and booking and reopening both
    // move task states. Every one of those is the interference the lock exists
    // to stop, and all three happen before `drive` would have taken it.
    const unlock = this.lockRun(runId);
    try {
      await this.wt.pruneAndReconcile();
      await this.bookLandedParked(runId);
      await this.reopen(runId);
      await this.drive(runId, intake);
    } finally {
      unlock();
    }
  }

  /**
   * Book every parked task whose work is already on the integration branch.
   *
   * This runs before `reopen`, and outside it, because `reopen` is the ceremony
   * for a *finished* run and returns immediately for one still in `EXECUTING` —
   * which is where a run killed mid-flight sits. Run bc691359 was resumed after
   * the fix that books an already-landed task and came straight back with
   * `m1-exit-evidence` parked: the pre-dispatch check never ran because nothing
   * dispatches a `NEEDS_HUMAN` task, and the check inside `reopen` never ran
   * because the run was executing, not in review. A parked task is only ever
   * examined again by something that goes looking for it, so this goes looking
   * on every resume, whatever state the run is in.
   */
  private async bookLandedParked(runId: string): Promise<void> {
    for (const t of this.store.listTasks(runId)) {
      if (t.state !== "NEEDS_HUMAN") continue;
      const landed = (await this.wt.taskBranchDelta(runId, t.id)).landed;
      if (landed) this.bookAlreadyLanded(runId, t.id, landed, t.id);
    }
  }

  /**
   * Did this run fail before it ever produced a task?
   *
   * Such a run is not finished with, it is stuck: planning is the one phase
   * whose failure leaves nothing built, nothing merged and nothing in flight, so
   * there is no state a second attempt could talk over. What there is, is
   * everything the operator already paid for — the intake conversation, the
   * brief it became, the run's identity and config — and the only way to spend
   * it was, until now, to not fail. Run f338b5c8 hit its account's usage limit
   * three planner attempts in a row, ended `harness: fatal`, and `harness
   * resume` answered "No run to resume", leaving the operator to start over and
   * answer every intake question again.
   *
   * The pool now waits usage limits out, so the common cause of this is gone;
   * the door stays because a planning phase can fail for reasons that are worth
   * simply trying again — and a run that cannot be resumed is a run whose
   * history is lost.
   */
  replannable(runId: string): boolean {
    const run = this.store.getRun(runId);
    return Boolean(run && run.state === "FAILED" && this.store.listTasks(runId).length === 0);
  }

  /** Does a finished run still have work `resume` can pick up? */
  hasRecoverableWork(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run || run.state !== "PR_REVIEW") return false;
    // A merged task with no PR only counts where a PR could ever open — without
    // GitHub, every no-github run would look eternally resumable.
    const tasks = this.store.listTasks(runId);
    return (
      tasks.some((t) => t.state === "NEEDS_HUMAN" || (this.github.enabled && t.state === "MERGED" && t.prNumber === null)) ||
      this.revivableCancelled(runId, tasks).size > 0 ||
      // A pull request that cannot be merged is work, and it is work only the
      // run can do. Without this a run whose every task succeeded would report
      // nothing to resume while holding the one artifact it produced hostage.
      (this.github.enabled && this.store.mergeStatus(runId)?.state === "conflicting") ||
      // So does CI the repo has not answered green for: red because the repo
      // rejected the branch, pending because the run stopped waiting — a kill,
      // a GitHub that went unreadable mid-wait — before CI ever settled.
      // Either way `resume` re-asks and re-enters the fix loop rather than
      // waiting on a human to merge a branch the repo rejected, or one nothing
      // ever judged.
      (this.github.enabled && ["failing", "pending"].includes(this.store.ciStatus(runId)?.state ?? ""))
    );
  }

  /**
   * Is this run waiting on the world rather than on itself?
   *
   * A run configured with a production URL is not finished when its pull request
   * opens — it is finished when the merge deployed and production agreed. That
   * makes a merged-but-unverified run resumable with no task work outstanding,
   * which is what lets "I fixed the deploy, check again" be a `resume` rather
   * than a whole new run.
   */
  awaitingVerification(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run || !run.config.prodUrl || !this.github.enabled) return false;
    if (run.state === "VERIFYING") return true;
    if (run.state !== "PR_REVIEW") return false;
    return this.rollupPr(runId) !== undefined;
  }

  /**
   * Put a task back to a clean slate of attempts.
   *
   * Every counter here answers the same question — "how many times has this
   * task already tried, and should it be allowed another?" — so they are reset
   * together or not at all. `store.ts` states that invariant on
   * `emptyDeliveries`; this is where it is kept.
   *
   * Two things buy a task fresh iterations. An operator who has read the
   * failure and said what to do about it changed the conditions the old
   * failures happened under. And a task cancelled as `unreachable` was never
   * judged on its own work at all — it was collateral damage of a parked
   * dependency, and by the time that dependency is merged the ground it failed
   * on has moved. Run bc691359 reopened `cp-no-third-party-test` four days
   * after cancelling it and dispatched it carrying two QA strikes from a life
   * that ended before the work it was waiting for existed; its first honest
   * failure would have parked it.
   */
  private freshIterations(runId: string, taskId: string): void {
    this.store.updateTask(runId, taskId, {
      qaIterations: 0, respawns: 0, emptyDeliveries: 0, conflictFixes: 0, errorSummary: null,
    });
  }

  /**
   * Tasks cancelled as "unreachable" whose blockers have since resolved: every
   * dependency is merged, or is itself in the returned set. This is the run
   * where a parked dependency was later revived and merged, but its cancelled
   * dependents were left cancelled forever — the work they were waiting for
   * exists now, and only an operator's `resume` should spend money building it.
   * Tasks cancelled for any other reason (operator abandoned them) stay closed.
   */
  private revivableCancelled(runId: string, tasks: TaskRow[]): Set<string> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const set = new Set(
      tasks
        .filter((t) => t.state === "CANCELLED" && this.store.taskStateReason(runId, t.id).startsWith("unreachable"))
        .map((t) => t.id)
    );
    // Shrink to a fixpoint: drop anything depending on a task that is neither
    // merged nor a surviving member — e.g. still blocked behind a parked task.
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of set) {
        const ok = byId.get(id)!.dependsOn.every((d) => byId.get(d)?.state === "MERGED" || set.has(d));
        if (!ok) {
          set.delete(id);
          changed = true;
        }
      }
    }
    return set;
  }

  /**
   * Reopen a finished run the operator resumed (the second half of the
   * task-escalation gate). A run that ended with parked tasks parked because
   * nobody was there to answer — `resume` is somebody arriving to answer. Each
   * parked task opens its gate now; an answer revives it with fresh iterations
   * and puts its "unreachable" CANCELLED dependents back in the queue — as are
   * cancelled tasks whose blockers have since merged, gates or no gates. Merged
   * tasks whose PRs never opened get them retried — after backfilling the base
   * branch for runs from before it was captured at start.
   */
  private async reopen(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    // A planning failure re-enters planning. The assignment it plans from is the
    // brief intake already wrote, so the conversation is not repeated; what is
    // repeated is the phase that failed.
    if (run && this.replannable(runId)) {
      this.store.transitionRun(runId, "PLANNING", "the operator resumed a run whose planning phase failed");
      return;
    }
    if (!run || run.state !== "PR_REVIEW") return;
    if (!run.config.baseBranch) {
      const branch = await this.currentBranch();
      if (branch) this.store.patchRunConfig(runId, { baseBranch: branch });
    }
    const tasks = this.store.listTasks(runId);
    const parked = tasks.filter((t) => t.state === "NEEDS_HUMAN");
    const revivable = this.revivableCancelled(runId, tasks);
    const prless = this.github.enabled && tasks.some((t) => t.state === "MERGED" && t.prNumber === null);
    if (!parked.length && !revivable.size && !prless) return; // nothing recoverable; drive() will not touch it

    // EXECUTING before the gates open, so the dashboard shows the run (and its
    // gate cards) as live while the operator is being asked.
    this.store.transitionRun(runId, parked.length || revivable.size ? "EXECUTING" : "INTEGRATING", "reopened by the operator");

    let revived = 0;
    for (const t of parked) {
      // Nothing here asks whether the task already landed: `resume` swept for
      // that before calling in, and a task it booked is MERGED and not in
      // `parked` at all. Never ask about a task that is already delivered —
      // run bc691359 put the same question about `m1-exit-evidence` three
      // times in one morning, each answer reviving a task that could only park
      // again on the same reading of the same empty diff.
      //
      // Same invariant as the issue comment below: a parked task carries a
      // reason on the row or in its transition event.
      /* v8 ignore next */
      const why = t.errorSummary || this.store.taskStateReason(runId, t.id) || "parked";
      const guidance = await this.askOperator(runId, t.id, why);
      if (guidance === null) continue; // still parked; no transition needed
      this.freshIterations(runId, t.id);
      this.revivalGuidance.set(`${runId}/${t.id}`, `This task was parked (${why.slice(0, 300)}) and the operator reopened it with this guidance — follow it over anything that contradicts it:\n${guidance}\n\nInspect git log in this worktree first: earlier iterations may already contain most of the work.`);
      this.store.transitionTask(runId, t.id, "READY", "the operator answered the escalation; fresh iterations");
      revived++;
    }
    for (const t of tasks) {
      if (t.state !== "CANCELLED") continue;
      // Two ways back in: its blockers are already merged (`revivable`), or the
      // operator just revived a parked task its "unreachable" reason pointed at.
      // The scheduler re-cancels any whose dependencies are in fact still parked.
      if (revivable.has(t.id) || (revived && this.store.taskStateReason(runId, t.id).startsWith("unreachable"))) {
        // The cancellation reason is read above, from the transition event
        // rather than the row, so clearing `errorSummary` here cannot affect it.
        this.freshIterations(runId, t.id);
        this.store.transitionTask(runId, t.id, "PENDING", "dependencies reopened");
      }
    }
  }

  /**
   * Drive the run state machine forward until a terminal state or gate rejection.
   *
   * `intake` is the transport to re-open an interrupted conversation with; a
   * caller that has no operator attached (a daemon, a test) omits it and the
   * open questions are reported instead of asked.
   */
  private async drive(runId: string, intake?: IntakeUi): Promise<void> {
    // Nothing below this line is safe to run twice at once. The requeue sweeper
    // in `execute` states the assumption outright — "this controller is the only
    // runner" — and until run bc691359 was found with two `harness resume`
    // processes on it, nothing checked. See runLock.ts for what that cost.
    //
    // Here rather than at the two call sites because `startRun` and `resume` are
    // both ways of arriving at the same thing, and here rather than in the
    // constructor because a controller is also built by commands that only read.
    const unlock = this.lockRun(runId);
    try {
      await this.driveRun(runId, intake);
    } catch (e) {
      // A pause asked for while the run was *integrating* — validating the
      // intent, opening pull requests, waiting on checks — has no scheduler loop
      // to notice it, so it arrives here as a throw from whichever session was
      // mid-message. It is still an operator stopping their own run, not a
      // failure: park it exactly as the executing path does, and let the caller
      // print an outcome rather than a stack trace.
      if (!(e instanceof RunPaused)) throw e;
      this.store.transitionRun(runId, "PAUSED", "the operator paused the run");
    } finally {
      // The request was about this attempt at this run. A `resume` in the same
      // process — which is every test, and an operator who never left the
      // dashboard — must not inherit a pause the last drive already honoured.
      this.pauseAsked.delete(runId);
      // Released here and not on a signal: a process killed outright leaves the
      // file behind and takes its pid with it, which is exactly what the next
      // acquire reads as stale.
      unlock();
    }
  }

  /**
   * Hold the run for this controller, and hand back the release.
   *
   * Re-entrant on purpose: `resume` takes it and then calls `drive`, which takes
   * it again. The inner call is a no-op that leaves the outer holder to free it,
   * so the run stays locked for the whole of `resume` rather than only for the
   * part of it that dispatches.
   *
   * A repository with nowhere to write a lock file is not a reason to refuse to
   * drive a run — it only means this process cannot prove it is alone. Refusing
   * is reserved for the one case the lock exists to catch: another harness,
   * alive, already driving this run.
   */
  private lockRun(runId: string): () => void {
    if (this.locks.has(runId)) return () => {};
    let lock: RunLock;
    try {
      lock = acquireRunLock(path.join(this.repoPath, ".harness"), runId);
    } catch (e) {
      if (e instanceof Error && e.name === "RunLocked") throw e;
      return () => {};
    }
    this.locks.set(runId, lock);
    // Only now is it true that any session still marked "running" is a dead
    // process's leftover rather than somebody's live work. This used to run in
    // the constructor, where it was a guess — and a second `harness resume`
    // built a controller before it was turned away, settling the sessions of
    // the process that was still using them.
    this.store.sweepDeadSessions();
    return () => {
      this.locks.delete(runId);
      lock.release();
    };
  }

  private async driveRun(runId: string, intake?: IntakeUi): Promise<void> {
    let run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    // The checkpoint cadence, set once for every session this run will ever
    // dispatch. Here rather than at the seventeen `pool.run` call sites, and
    // here rather than in the constructor, because it is the run's frozen
    // config that decides it and a resumed run must pick up its own.
    this.applyCheckpointCadence(runId);
    // Which subscription this run spends, and the watch that stops it before
    // the plan runs out. Set beside the checkpoint cadence and for the same
    // reason — it belongs to the run, not to the call sites.
    this.applySubscription(runId);
    await this.sweepOrphans(runId);
    // Where the account stands before this run spends anything. A run started
    // at 97% of its weekly window would otherwise learn it from the first
    // session it paid for.
    await this.preflightSubscription(runId);
    if (run.state === "CREATED") {
      this.store.transitionRun(runId, "PLANNING");
      run = this.store.getRun(runId)!;
    } else if (run.state === "INTAKE") {
      // Resumed while a conversation was open. The agent's session and its brief
      // are gone, but the conversation is on the event log — and the question it
      // died holding is, by construction, the one it judged most worth asking.
      // Planning straight past it is what run 40da9337 did: it stopped one
      // question into "real vendor accounts, sandbox adapters, or fakes only?",
      // never got an answer, and shipped six of seven integrations as stubs.
      const prior = this.store.intakeTranscript(runId);
      const open = prior.filter((p) => p.answer === null);
      if (intake) {
        await this.intake(runId, run.assignment, intake, prior);
      } else {
        // Headless resume — there is nobody to ask. Plan from the assignment as
        // before, but never let the open question be the thing nobody mentions.
        for (const p of open) {
          this.bus.publish({
            type: "agent.log",
            runId,
            sessionId: "intake",
            text: `Resumed with no way to ask, so this went unanswered and the planner will have to assume: "${p.question}"`,
            ts: Date.now(),
          });
        }
        this.store.transitionRun(runId, "PLANNING", open.length ? `resumed mid-intake, ${open.length} question(s) unanswered` : "resumed mid-intake");
      }
      run = this.store.getRun(runId)!;
    } else if (run.state === "PAUSED") {
      // The only thing that parks a run rather than a task is an operator
      // choosing "stop, I want to think" at a pit stop. Resuming is them having
      // thought — the tasks and worktrees are exactly as they left them.
      //
      // So resuming opens a pit stop before anything is dispatched, and it is
      // the operator's to answer whatever `pitStop.decidedBy` says: they are
      // demonstrably here, and the whole reason this run is parked is that a
      // decision was taken about it. Without this, `resume` is a one-word
      // command whose only power is "run whatever is still queued" — and run
      // 6fe4ba37 is what that costs. It stopped with 3 tasks queued, 39
      // cancelled at an earlier re-plan, and no way for the operator to say
      // "those 39 are the work I actually want" short of starting a new run
      // and re-planning 167 commits of context from scratch. `replan` here
      // reaches exactly that, and `stop` leaves the run as it was found.
      if (await this.resumePitStop(runId)) return;
      run = this.store.getRun(runId)!;
    } else if (run.state === "BUDGET_HOLD") {
      // The cap that parked it is still in force: execution re-opens the budget
      // gate on the first check, giving the operator another chance to raise it.
      this.closeAbandonedGates(runId, "budget", "resumed from budget hold");
      this.store.transitionRun(runId, "EXECUTING", "resumed from budget hold");
      run = this.store.getRun(runId)!;
    } else if (run.state === "LIMIT_HOLD") {
      // Resumed from a subscription hold. Whether anything changed is not this
      // code's to judge: the operator either pointed it at another account
      // (`resume --account`, already patched into the config by the time this
      // runs) or waited for the window to reopen, and the preflight check above
      // has just read the account to find out which. If the plan is still spent
      // the gate opens again immediately, which is the honest outcome — nothing
      // was lost by trying.
      this.closeAbandonedGates(runId, "subscription", "resumed from subscription hold");
      this.store.transitionRun(runId, "EXECUTING", "resumed from subscription hold");
      run = this.store.getRun(runId)!;
    }
    let planFeedback = "";
    // What the adjudicator said last time it sent this plan back, so the next
    // round can be told what it already asked for and did not get.
    let planVeto = "";
    while (run.state === "PLANNING" || run.state === "PLAN_REVIEW") {
      if (run.state === "PLANNING") {
        const plan = await this.plan(runId, planFeedback);
        this.persistPlan(runId, plan);
        this.store.transitionRun(runId, "PLAN_REVIEW");
      }
      // Asked here, where a gap is worth a re-plan, rather than only at
      // INTEGRATING, where the same answer costs a whole run.
      const shortfall = await this.checkPlanIntent(runId);
      // One gate, one id, however it ends: the adjudicator below may close it by
      // sending the plan back, and if it does not, the operator closes it. Until
      // now nothing recorded who approved a plan at all.
      const gateId = randomUUID().slice(0, 8);
      this.bus.publish({ type: "run.gate_opened", runId, gateId, kind: "plan", payload: { gaps: shortfall.gaps }, ts: Date.now() });
      // Weighed before the operator sees it. A gap list with nobody's name
      // against it is the thing that gets waved through — f338b5c8 approved four
      // of them, one of which was the reason the run ended without a PR.
      const adjudged = await this.decidePlanGate(runId, shortfall.gaps, planVeto);
      if (adjudged.action === "replan") {
        this.bus.publish({
          type: "run.gate_resolved",
          runId,
          gateId,
          kind: "plan",
          resolution: "rejected",
          feedback: adjudged.why,
          decidedBy: adjudged.decidedBy,
          ts: Date.now(),
        });
        planVeto = adjudged.feedback;
        planFeedback = `${adjudged.feedback}${shortfall.block}`;
        this.store.transitionRun(runId, "PLANNING", `${adjudged.decidedBy} sent the plan back over the intent check's gaps`);
        run = this.store.getRun(runId)!;
        continue;
      }
      const gate = await this.gates.resolvePlanGate(this.planPrd(runId), `${this.planSummary(runId)}${shortfall.block}${adjudged.note}`);
      this.bus.publish({
        type: "run.gate_resolved",
        runId,
        gateId,
        kind: "plan",
        resolution: gate.approved ? "approved" : "rejected",
        feedback: gate.feedback,
        decidedBy: "operator",
        ts: Date.now(),
      });
      if (gate.approved) {
        await this.fileIssues(runId);
        this.store.transitionRun(runId, "EXECUTING", "plan approved");
      } else {
        // The operator's words first — they saw the shortfall and are answering
        // it — with the finding appended so a re-plan closes it even when they
        // rejected for some other reason entirely.
        planFeedback = `${gate.feedback}${shortfall.block}`;
        this.store.transitionRun(runId, "PLANNING", "plan rejected");
      }
      run = this.store.getRun(runId)!;
    }
    // EXECUTING and INTEGRATING are a loop rather than two steps because the pit
    // stop between the intent verdict and the first pull request can send the
    // run back to work: an operator reading a FAIL is being shown it at the last
    // moment where fixing it is still cheaper than a second run.
    //
    // The reasons written below name no one, because `pitStop.decidedBy` means
    // the answer may not have come from the operator, and a run history that
    // tells them they stopped their own run at 3am is worse than one that says
    // only that it was stopped. Who decided is on `run.pitstop_resolved`, one
    // event earlier.
    // Whether this call published. `republishUnmergeable` below exists for the
    // call that did *not* — a resume landing straight in PR_REVIEW — and running
    // it after a publish in the same pass would redo the whole reconcile,
    // spending a second set of merge-resolution sessions on the conflict the
    // first set just failed to resolve.
    let published = false;
    for (;;) {
      if (run.state === "EXECUTING") {
        const stopped = await this.execute(runId);
        if (stopped !== "complete") {
          this.store.transitionRun(
            runId,
            "PAUSED",
            stopped === "operator" ? "the operator paused the run" : "the run was stopped at a pit stop"
          );
          return;
        }
        this.store.transitionRun(runId, "INTEGRATING", "all tasks terminal");
        run = this.store.getRun(runId)!;
      }
      if (run.state === "INTEGRATING") {
        // Before the prose check and before any pull request: the scenarios the
        // operator's own brief was turned into, run against the merged whole.
        // First because it is the only mechanical answer available here — there
        // is no point paying a validator to form a view about a branch whose
        // own acceptance tests are red, and a worker sent back over a named
        // failing scenario has something to aim at that a gap sentence cannot
        // give it.
        const specFixes = await this.queueScenarioFixes(runId);
        if (specFixes.length) {
          this.store.transitionRun(runId, "EXECUTING", `closing ${specFixes.length} failing scenario(s) the specification requires`);
          run = this.store.getRun(runId)!;
          continue;
        }
        // Last step before any PR exists: does the merged whole do what was asked?
        // Task-level QA cannot answer that — it judged each task against its own
        // criteria, never the sum against the intent. Only after the verdict do the
        // pull requests open, so a reviewer arrives with the gap list in hand.
        await this.validateIntent(runId);
        // A FAIL names work, so queue it before the pit stop rather than after:
        // the operator is then shown the gaps *and* what is already queued to
        // close them, and "stop, none of that is worth it" stays sayable.
        const fixes = await this.queueIntentFixes(runId);
        const after = await this.closingPitStop(runId);
        if (after === "stop") {
          this.store.transitionRun(runId, "PAUSED", "the run was stopped at a pit stop");
          return;
        }
        if (after === "back-to-work" || fixes.length) {
          this.store.transitionRun(
            runId,
            "EXECUTING",
            after === "back-to-work" ? "the pit stop sent the run back to work" : `closing ${fixes.length} gap(s) the intent check found`
          );
          run = this.store.getRun(runId)!;
          continue;
        }
        await this.openPrs(runId);
        published = true;
        await this.awaitChecks(runId);
        // Red CI is work, not a report — the same rule the base merge follows,
        // one gate further down. The escalation is only consulted on a pass
        // that queued nothing: a round queued this pass has not run yet, and
        // counting it as spent would show the operator a stop about work the
        // run was still about to do.
        const ciTasks = await this.queueCiFixes(runId);
        const ciCall = ciTasks.length ? ("proceed" as const) : await this.ciPitStop(runId);
        if (ciCall === "stop") {
          this.store.transitionRun(runId, "PAUSED", "the run was stopped at a pit stop");
          return;
        }
        if (ciCall === "back-to-work" || ciTasks.length) {
          this.store.transitionRun(
            runId,
            "EXECUTING",
            ciCall === "back-to-work" ? "the pit stop sent the run back to work" : `fixing ${ciTasks.length} failing CI check(s)`
          );
          run = this.store.getRun(runId)!;
          continue;
        }
        await this.confirmMergeable(runId);
        this.store.transitionRun(runId, "PR_REVIEW", this.outcome(runId).line);
        run = this.store.getRun(runId)!;
      }
      // A resume landing here with CI not green asks again before anything
      // waits on a human merging a branch the repo has rejected.
      if (run.state === "PR_REVIEW" && !published) {
        if ((await this.recheckRedCi(runId)) === "back-to-work") {
          this.store.transitionRun(runId, "EXECUTING", "fixing the CI checks that were red when the run last reported");
          run = this.store.getRun(runId)!;
          continue;
        }
      }
      break;
    }
    // A merge that already happened — an eager human merging the rollup while
    // the run was still finishing — is verified now rather than next resume.
    if (run.state === "PR_REVIEW" || run.state === "VERIFYING") {
      if (!published) await this.republishUnmergeable(runId);
      const closed = await this.verify(runId);
      const now = this.store.getRun(runId)!;
      if (closed && now.state === "VERIFYING") {
        this.store.transitionRun(runId, "DONE", this.outcome(runId).line);
        await this.writeReport(runId);
      }
    }
  }

  /**
   * The page a person reads once the run is over.
   *
   * Written here rather than left to `harness report`, because the moment a run
   * reaches DONE is the last moment anyone is looking. Everything the report
   * needs is legible now and decays from here: the integration branch gets
   * pruned, the base branch moves on, and the diff that says which switches the
   * run left off becomes a reconstruction rather than a read.
   *
   * DONE only, deliberately. Every earlier state is a run that is still going
   * somewhere, and a completion report for a run that has not completed is the
   * kind of confident summary this whole feature exists to argue against. The
   * CLI can still be pointed at any run by hand, and says which state it found.
   *
   * Never throws. A run that did the work, shipped it and had production agree
   * has succeeded; failing it over a report it could not write would be the
   * tail wagging the dog.
   */
  private async writeReport(runId: string): Promise<void> {
    try {
      const report = await assembleReport({ store: this.store, repoPath: this.repoPath, runId, merged: true, origin: "done", now: Date.now() });
      const file = reportPath(this.repoPath, runId);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, standaloneReport(report));
      this.bus.publish({ type: "agent.log", runId, sessionId: "integrator", text: `completion report written: ${file} — ${report.ledger.headline}`, ts: Date.now() });
    } catch (e) {
      this.bus.publish({ type: "agent.log", runId, sessionId: "integrator", text: `the completion report could not be written: ${String(e).slice(0, 200)}`, ts: Date.now() });
    }
  }

  /**
   * Ask whether the plan could deliver the assignment, before anyone builds it.
   *
   * The harness already asks this question — at INTEGRATING, of the merged
   * result, which is the most expensive moment it could possibly be asked. Run
   * 40da9337's answer arrived after 37 hours and $773.55, and every gap in it
   * was legible in the plan: seven vendor categories whose acceptance criteria
   * asked for "an interface and a deterministic mock", under an assignment that
   * said "including all the integrations".
   *
   * Returns a block to append to what the operator reads at the gate, and to the
   * feedback a rejected plan carries back to the planner. Empty on PASS, on a
   * check that could not complete, and when the operator has turned it off —
   * this informs the gate, it never blocks it. The decision stays theirs.
   *
   * The gaps come back alongside the rendered block because `planGate.decidedBy`
   * adjudicates them item by item, and re-parsing them out of prose written for
   * a human to read is how the two drift apart.
   */
  private async checkPlanIntent(runId: string): Promise<{ block: string; gaps: string[] }> {
    const run = this.store.getRun(runId)!;
    const tasks = this.store.listTasks(runId);
    // Free and deterministic, so it runs before — and regardless of — the model
    // check: a criterion naming a command `infraGuardHook` denies is a task no
    // worker can finish, and run bc691359 spent three workers rediscovering one.
    const denied = unsatisfiableCriteria(tasks);
    const deniedGaps = denied.map(
      (d) =>
        `Task ${d.taskId}'s criterion names ${d.what}, which every agent session is denied — the harness produces reviewed configuration and never provisions. If satisfying it needs that command to actually run, no worker can ever pass it and the task will spend its attempts and escalate; rewrite it as a hand-off the operator executes. If it only asks for a document that names the command, it is satisfiable as written — say which reading this is. Criterion: "${d.criterion.slice(0, 300)}"`
    );
    if (denied.length) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "plan-gate",
        text: `${denied.length} acceptance criteri${denied.length === 1 ? "on names" : "a name"} a command the infrastructure guard denies to every session: ${denied.map((d) => `${d.taskId} (${d.what})`).join(", ")}`,
        ts: Date.now(),
      });
    }
    const render = (gaps: string[]): string =>
      !gaps.length
        ? ""
        : [
            "",
            "",
            "What this plan would not deliver, read against your assignment:",
            ...gaps.map((g) => `  - ${g}`),
            "",
            "Every task here can pass its own acceptance criteria and still leave the",
            "above missing — or, where a criterion names a denied command, can never",
            "pass it at all. Those criteria are the whole contract a worker builds to",
            "and QA checks. Rejecting sends this back to the planner with the list",
            "attached; approving accepts it as the scope.",
          ].join("\n");
    if (!run.config.planIntentCheck) return { block: render(deniedGaps), gaps: deniedGaps };
    try {
      const result = await this.pool.run({
        runId,
        role: "validator",
        model: run.config.models.qa,
        systemPrompt: planIntentSystemPrompt(),
        prompt: planIntentPrompt(run.assignment, this.planPrd(runId), tasks),
        cwd: this.repoPath,
        // Prose against prose. Reading the repository is the planner's job and
        // it has already been paid for; this is the cheap half of the check.
        tools: [],
        allowedTools: [],
        maxTurns: 12,
        budgetCheck: () => this.checkStops(runId),
      });
      const verdict = IntentVerdict.parse(extractJson(result.resultText));
      this.bus.publish({ type: "run.plan_intent_verdict", runId, verdict: verdict.verdict, gaps: verdict.gaps, summary: verdict.summary, ts: Date.now() });
      const gaps = verdict.verdict === "PASS" ? deniedGaps : [...deniedGaps, ...verdict.gaps];
      return { block: render(gaps), gaps };
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      // A plan that could not be checked is still a plan the operator may
      // approve. Say the check did not happen rather than implying it passed —
      // and the denied-command findings stand either way: they never depended
      // on the check that failed.
      this.bus.publish({ type: "agent.log", runId, sessionId: "validator", text: `the plan-intent check did not complete: ${String(e).slice(0, 300)}`, ts: Date.now() });
      return { block: `${render(deniedGaps)}\n\nThe plan-intent check did not complete, so nothing has compared this plan to your assignment.`, gaps: deniedGaps };
    }
  }

  /**
   * Weigh the intent check's gaps before the operator is asked to approve past
   * them (`planGate.decidedBy`).
   *
   * The check has worked from the day it shipped. Run f338b5c8's fired before a
   * worker was dispatched and named four things its plan would not deliver, one
   * of them the missing mechanism that made M0's gates unmeasurable — the exact
   * thing that ended the run 51 tasks and $475.07 later with no pull request.
   * The gap list was approved two and a half minutes after it appeared.
   *
   * Nothing about that is unusual. At the plan gate the operator's alternative
   * to `y` is composing re-planning feedback from a bulleted list of absences,
   * and an advisory finding with nobody's name against it loses that trade every
   * time. So a named skill takes the finding first and either sends the plan
   * back on its own authority, or writes down why the run survives the gap —
   * and the operator approves past a considered judgment rather than past a
   * list.
   *
   * Returns `accept` unchanged when there are no gaps, when the operator has
   * kept the gate for themselves, when the veto has been spent, and whenever
   * the adjudicator itself fails: a plan that could not be weighed is still a
   * plan they may approve, and it is never held hostage to an agent that died.
   */
  private async decidePlanGate(
    runId: string,
    gaps: string[],
    priorVeto: string
  ): Promise<{ action: "replan" | "accept"; feedback: string; why: string; note: string; decidedBy: string }> {
    const accept = (note = "", why = "", decidedBy = "operator") => ({ action: "accept" as const, feedback: "", why, note, decidedBy });
    const run = this.store.getRun(runId)!;
    const skill = run.config.planGate.decidedBy;
    if (!gaps.length || skill === "operator") return accept();

    const spent = this.store.planGateAutoReplans(runId);
    const rounds = run.config.planGate.replanRounds;
    const say = (text: string) => this.bus.publish({ type: "agent.log", runId, sessionId: "plan-gate", text, ts: Date.now() });
    // Out of vetoes. Saying so is worth more than the note a second adjudication
    // would produce: the operator is looking at gaps that already survived one
    // re-plan, and that is the fact that should decide how they read them.
    if (spent >= rounds) {
      return accept(
        `\n\n${skill} already sent this plan back over these gaps, and they are still here. A gap the planner has now failed to close twice is usually a question about the assignment rather than about the plan.\n`
      );
    }

    try {
      const skills = indexSkills(run.config.skillsDirs).filter((s) => s.name === skill && verifyHash(s));
      const bound =
        rounds - spent === 1
          ? "This is your last chance to send this plan back. After it, the gaps go to the operator however you answer, so a replan you are not sure about is one you do not get to correct."
          : `You may send this plan back ${rounds - spent} more times before the gaps go to the operator however you answer.`;
      const result = await this.pool.run({
        runId,
        role: "pm",
        model: run.config.models.pm,
        systemPrompt: planGateDeciderSystemPrompt(skill, bound, toolbeltBlock(detectToolbelt(run.config.externalTools)), skillsBlock(skills)),
        skills: skills.map((s) => s.name),
        prompt: planGateDeciderPrompt(run.assignment, this.planPrd(runId), this.planSummary(runId), gaps, priorVeto),
        cwd: this.repoPath,
        // The tree it would build in is the one it is standing in, and reading
        // it is how "no task owns this" is told apart from "this already
        // exists". Writing is not: nothing is built yet.
        disallowedTools: ["Write", "Edit", "NotebookEdit"],
        maxTurns: 20,
        budgetCheck: () => this.checkStops(runId),
      });
      const parsed = PlanGateDecisionJson.parse(extractJson(result.resultText));
      say(`${skill} on the plan-intent gaps: ${parsed.action}${parsed.why ? ` — ${parsed.why}` : ""}`);
      if (parsed.action === "replan") return { action: "replan", feedback: parsed.feedback, why: parsed.why, note: "", decidedBy: skill };
      return accept(
        `\n\n${skill} weighed these gaps and accepted them:\n${parsed.feedback || parsed.why}\n`,
        parsed.why,
        skill
      );
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      say(`${skill} did not weigh the plan-intent gaps (${String(e).slice(0, 200)}) — they go to you as they are`);
      return accept("\n\nNothing weighed these gaps: the adjudicator did not return a decision.\n");
    }
  }

  /**
   * Run the validator over the integration worktree and record its verdict.
   * A FAIL does not block the PRs — the harness never merges, so the human
   * review the PRs exist for is exactly where the gap list belongs. What a
   * FAIL must never be is silent.
   */
  private async validateIntent(runId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const tasks = this.store.listTasks(runId);
    if (!tasks.some((t) => t.state === "MERGED")) return; // nothing merged, nothing to judge
    // On a reopened run, a verdict newer than the newest merge still stands —
    // re-judging an unchanged tree would only spend tokens to learn it again.
    if (this.store.lastEventSeq(runId, "run.intent_verdict") > this.store.lastEventSeq(runId, "git.merged")) return;
    try {
      const wtPath = await this.wt.ensureIntegrationWorktree(runId);
      const base = run.config.baseBranch;
      const diffStat = base
        ? await git(wtPath, ["diff", "--stat", `${base}...HEAD`]).catch(() => "unavailable")
        : "unavailable";
      const taskLines = tasks.map((t) => `- ${t.title} (${t.id}): ${t.state}${t.errorSummary ? ` — ${t.errorSummary.slice(0, 120)}` : ""}`).join("\n");
      const result = await this.pool.run({
        runId,
        role: "validator",
        model: run.config.models.qa,
        systemPrompt: validatorSystemPrompt(toolbeltBlock(detectToolbelt(run.config.externalTools))),
        prompt: validatorPrompt(run.assignment, this.planPrd(runId), taskLines, diffStat.slice(0, 3000), run.config.deterministicChecks),
        cwd: wtPath,
        disallowedTools: ["WebSearch"],
        maxTurns: 60,
        budgetCheck: () => this.checkStops(runId),
      });
      const verdict = IntentVerdict.parse(extractJson(result.resultText));
      this.bus.publish({ type: "run.intent_verdict", runId, verdict: verdict.verdict, gaps: verdict.gaps, summary: verdict.summary, ts: Date.now() });
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      // An unvalidated run is reportable; an unfinished one is not. Say so and move on.
      this.bus.publish({ type: "agent.log", runId, sessionId: "validator", text: `intent validation did not complete: ${String(e).slice(0, 300)}`, ts: Date.now() });
    }
  }

  /**
   * Turn a failing intent verdict into work.
   *
   * The verdict was the most valuable thing the harness produced and the only
   * one it did nothing with: run 40da9337 spent $774, merged all 36 tasks, and
   * shipped a FAIL saying the disbursement worker, the webhook outbox, the
   * funding poller and reconciliation were all built, all tested, and scheduled
   * nowhere. Every one of those gaps is a task — small, concrete, and stated
   * against a tree that already exists. Leaving them for the human meant the
   * cheapest fixes in the run were the ones the harness declined to make.
   *
   * The gaps are chained rather than run in parallel. They are usually the same
   * omission seen from different angles — four of the seven above were "wire
   * this into the entrypoint" — so they land in the same file, and two workers
   * in one file is a merge conflict for no gain.
   *
   * Returns the ids queued; empty when the verdict passed, when there is nothing
   * to act on, or when this run has already had its rounds.
   */
  private async queueIntentFixes(runId: string): Promise<string[]> {
    const run = this.store.getRun(runId)!;
    const verdict = this.store.intentVerdict(runId);
    if (!verdict || verdict.verdict === "PASS" || !verdict.gaps.length) return [];
    const tasks = this.store.listTasks(runId);
    const rounds = new Set(tasks.map((t) => /^intent-fix-(\d+)-/.exec(t.id)?.[1]).filter(Boolean));
    if (rounds.size >= run.config.intentFixRounds) return [];
    const round = rounds.size + 1;
    // Enough to carry a real gap list, few enough that a validator answering
    // with an essay cannot re-plan the run. Anything dropped is said out loud.
    const MAX_GAPS = 10;
    const gaps = verdict.gaps.slice(0, MAX_GAPS);
    const queued: PlannedTask[] = gaps.map((gap, i) => ({
      id: `intent-fix-${round}-${i + 1}`,
      epicId: INTENT_FIX_EPIC.id,
      scenarioIds: [],
      title: `Close intent gap: ${gap.split("\n")[0]!.slice(0, 80).trim()}`,
      spec: `The run finished and a validation agent read the whole merged tree against the operator's original intent. It found this gap:\n\n${gap}\n\nWhat it concluded overall:\n${verdict.summary}\n\nClose that gap in the integration branch you are working from — it already contains every merged task, so the code the gap refers to is here. Fix the gap itself, not the surrounding design: the rest of this tree was reviewed and accepted, and a rewrite costs more than the gap did. If the gap turns out not to be real, say so in your summary with the file and line that settle it rather than changing code to satisfy it.`,
      acceptanceCriteria: [gap.split("\n")[0]!.slice(0, 300), "The claim the gap makes is no longer true of this tree, demonstrated by a check or a test that fails without the change"],
      // Chained: same omission, same file, and nothing here is urgent enough to
      // be worth a conflict.
      dependsOn: i === 0 ? [] : [`intent-fix-${round}-${i}`],
      touchedPaths: [],
      // The validator reports a gap in prose; it is not asked for a command,
      // and inventing one here would be the harness guessing at a check it has
      // no basis for.
      completionProbe: "",
      estimatedSize: "M",
    }));
    this.store.insertTasks(runId, [...this.store.listEpics(runId), INTENT_FIX_EPIC], queued.map(pendingRow));
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "validator",
      text:
        `the intent check failed with ${verdict.gaps.length} gap(s); queued ${queued.length} task(s) to close them` +
        (verdict.gaps.length > gaps.length ? `. Not queued, and yours to judge: ${verdict.gaps.slice(MAX_GAPS).join(" | ")}` : ""),
      ts: Date.now(),
    });
    await this.fileIssues(runId);
    this.wakeScheduler();
    return queued.map((t) => t.id);
  }

  /**
   * Turn a red CI into work, the way `reconcileWithBase` turned an unmergeable
   * branch into work.
   *
   * `awaitChecks` made the run *see* a failing check and then walked on: the
   * red state went into the outcome line and the run reported itself in review
   * over a branch the repo itself had rejected — the same shape as opening a
   * CONFLICTING pull request and calling it finished, one gate further down.
   *
   * The failed jobs are re-run once per round first, because the cheapest red
   * check is a flake and a fix task spawned against one produces a diff about
   * nothing. Only a failure that survives its re-run gets tasks: one per
   * failing check, carrying that job's own log tail, chained so they cannot
   * conflict. The caller sends the run back to EXECUTING; the next pass
   * through INTEGRATING re-merges, re-pushes and asks CI again.
   *
   * Returns the queued task ids — empty when CI is green, when checks are off,
   * when the rounds are spent (that is `ciPitStop`'s moment), or when the
   * re-run alone turned the branch green.
   */
  /**
   * Run the specification's scenarios against everything the run merged.
   *
   * The first gate in this harness that is not an agent's opinion. Every other
   * check on the way out — QA's verdict, the intent check, the pit-stop
   * reviewers — is a model reading a diff and forming a view, and they share a
   * failure mode: agreeing with the code because they misread the requirement
   * in the same direction it did. These scenarios were written from the brief
   * before any code existed and cannot make that mistake.
   *
   * Runs in a worktree of the integration branch, which is the merged whole and
   * also where the specification itself was committed. Null when this run has
   * no specification — which every caller must tell apart from a pass.
   */
  private async checkAcceptance(runId: string): Promise<AcceptanceVerdict | null> {
    const run = this.store.getRun(runId)!;
    const spec = this.store.runSpec(runId);
    if (!run.config.spec.enabled || !spec) return null;

    const command = spec.commands.all.trim();
    const verdict = command
      ? await this.runSuite(runId, spec, command, run.config.spec.suiteTimeoutMinutes)
      : acceptanceVerdict(spec, { exitCode: 0, output: "", error: "the specification named no command that runs its scenarios" });

    this.bus.publish({
      type: "run.acceptance_verdict",
      runId,
      passed: verdict.passed,
      failing: verdict.failing,
      named: verdict.named,
      blocked: verdict.blocked,
      line: verdict.line,
      ts: Date.now(),
    });
    return verdict;
  }

  /** One run of the scenario suite, in a worktree of the merged branch. */
  private async runSuite(runId: string, spec: RunSpec, command: string, timeoutMinutes: number): Promise<AcceptanceVerdict> {
    let dir: string;
    // Only reachable across processes: this run's own EXECUTING phase created
    // and cached this worktree, so within one process it is already there. A
    // resume whose worktree was pruned underneath it is the real case, and it
    // must read as unproven rather than as a pass.
    /* v8 ignore start */
    try {
      dir = await this.wt.ensureIntegrationWorktree(runId);
    } catch (e) {
      return acceptanceVerdict(spec, { exitCode: 1, output: "", error: `the merged branch could not be checked out: ${String(e).slice(0, 200)}` });
    }
    /* v8 ignore stop */
    try {
      const { stdout, stderr } = await execFileP("sh", ["-c", command], { cwd: dir, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMinutes * 60_000 });
      return acceptanceVerdict(spec, { exitCode: 0, output: `${stdout}\n${stderr}` });
    } catch (e) {
      return acceptanceVerdict(spec, suiteRunFrom(e as { code?: number; killed?: boolean }, timeoutMinutes));
    }
  }

  /**
   * Turn a red acceptance gate into work, the way `queueCiFixes` turns a red CI
   * into work.
   *
   * The same shape and for the same reason: a failing scenario is a promise the
   * run made and has not kept, which is work, not a report. One task per failing
   * scenario, carrying its oracle and the requirement behind it, chained so they
   * cannot conflict. The caller sends the run back to EXECUTING and the next
   * pass through INTEGRATING re-merges and asks again.
   *
   * Returns the queued task ids — empty when the gate passed, when there is no
   * specification, when the rounds are spent, or when the suite went red
   * without naming a scenario, which is a thing to tell a person rather than a
   * thing to hand a worker.
   */
  private async queueScenarioFixes(runId: string): Promise<string[]> {
    const run = this.store.getRun(runId)!;
    const verdict = await this.checkAcceptance(runId);
    if (!verdict || verdict.passed) return [];
    const spec = this.store.runSpec(runId)!;

    this.bus.publish({ type: "agent.log", runId, sessionId: "integrator", text: `acceptance: ${verdict.line}`, ts: Date.now() });
    if (!run.config.spec.gateRounds || !verdict.failing.length) return [];

    const tasks = this.store.listTasks(runId);
    const rounds = new Set(tasks.map((t) => /^spec-fix-(\d+)-/.exec(t.id)?.[1]).filter(Boolean));
    if (rounds.size >= run.config.spec.gateRounds) return [];
    const round = rounds.size + 1;

    // The same bound the intent gaps and the CI checks use, for the same
    // reason: enough for a real failure list, few enough that a broken suite
    // cannot re-plan the run. Anything dropped is said out loud.
    const MAX_SCENARIOS = 10;
    const failing = verdict.failing.slice(0, MAX_SCENARIOS);
    const byId = new Map(spec.scenarios.map((sc) => [sc.id, sc]));
    const requirement = (id: string) => spec.requirements.find((r) => r.id === byId.get(id)?.requirement);

    const queued: PlannedTask[] = failing.map((id: string, i: number) => {
      const sc = byId.get(id)!;
      const req = requirement(id);
      return {
        id: `spec-fix-${round}-${i + 1}`,
        epicId: SPEC_FIX_EPIC.id,
        title: `Make ${id} pass: ${(sc.title || sc.oracle).split("\n")[0]!.slice(0, 70)}`,
        spec:
          `The scenario \`${id}\` is failing against the merged branch. It was written from the operator's brief before any code existed, so it is the promise, not an opinion about the code.\n\n` +
          `What it checks: ${sc.oracle || sc.title}\n` +
          (req ? `The requirement behind it: ${req.text}\n` : "") +
          (sc.testRef ? `The test: ${sc.testRef}\n` : "") +
          `\nMake it pass by changing the product, not the test. If the scenario itself is wrong — it asserts something the brief never asked for, or asserts it in a way the design cannot satisfy — say so plainly and escalate rather than editing the assertion to match the code. A scenario edited to fit the implementation proves nothing at all, and it is the one failure this whole phase exists to prevent.`,
        acceptanceCriteria: [`${id} passes: ${sc.oracle || sc.title}`, "No scenario that was passing before this change is failing after it"],
        // Chained, so two fixes cannot land on the same file concurrently.
        dependsOn: i === 0 ? [] : [`spec-fix-${round}-${i}`],
        touchedPaths: [],
        completionProbe: usableProbe(scenarioCommand(spec.commands, [id])),
        scenarioIds: [id],
        estimatedSize: "S",
      };
    });

    if (verdict.failing.length > MAX_SCENARIOS) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `${verdict.failing.length - MAX_SCENARIOS} more failing scenario(s) were not queued this round: ${verdict.failing.slice(MAX_SCENARIOS).join(", ")}`,
        ts: Date.now(),
      });
    }
    this.store.insertTasks(runId, [SPEC_FIX_EPIC], queued.map(pendingRow));
    await this.fileIssues(runId);
    return queued.map((t) => t.id);
  }

  /**
   * The scenarios this task was written to turn green, as one command.
   *
   * Empty for a task no scenario covers, for a run with no specification, and
   * for a repository whose specification named no way to select a subset — all
   * three read as "this task has no scenario check", never as "run everything".
   * Holding one task to the whole suite would fail it over work nobody has
   * started, which teaches a worker to go and edit somebody else's files.
   */
  private scenarioProbe(runId: string, task: TaskRow): string {
    return usableProbe(scenarioProbeCommand(this.store.runSpec(runId), task.scenarioIds));
  }

  private async queueCiFixes(runId: string): Promise<string[]> {
    const run = this.store.getRun(runId)!;
    if (!run.config.waitForChecks || !this.github.enabled || !run.config.ciFixRounds) return [];
    let ci = this.store.ciStatus(runId);
    if (!ci || ci.state !== "failing") return [];
    // A CI status on the record means `awaitChecks` ran, and it only runs with
    // a pull request to ask about — so the rollup exists here by construction.
    const prNumber = this.rollupPr(runId)!;
    const tasks = this.store.listTasks(runId);
    const rounds = new Set(tasks.map((t) => /^ci-fix-(\d+)-/.exec(t.id)?.[1]).filter(Boolean));
    if (rounds.size >= run.config.ciFixRounds) return [];
    // One re-run per round: each round pushes a new head, and each head gets
    // one chance to have been unlucky before it is treated as broken.
    if (this.store.eventCount(runId, "run.ci_retry") <= rounds.size) {
      const reran = await (this.github.rerunFailedChecks?.(prNumber) ?? Promise.resolve(false));
      this.bus.publish({ type: "run.ci_retry", runId, prNumber, reran, ts: Date.now() });
      if (reran) {
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          text: `re-ran the failed jobs on #${prNumber} before diagnosing — a flake that passes on the second go is not work`,
          ts: Date.now(),
        });
        const red = ci; // the verdict that sent us here, before the re-ask
        await this.awaitChecks(runId);
        // Non-null by the same construction as `prNumber` above: a status was
        // on the record before the re-run, and events only accumulate.
        const after = this.store.ciStatus(runId)!;
        // A re-run answers "was that only flake?" only when it settles, and
        // `awaitChecks` does not always get to settle: GitHub going unreadable
        // ends its wait, and the newest `run.ci_status` is then the `pending`
        // it published while waiting. `ciStatus` is last-event-wins, so that
        // pending does not merely fail to answer — it overwrites the red this
        // function was called about, and reads below as "nothing is failing".
        //
        // Run bc691359 exited down that path. `test`, `coverage (project
        // floor)` and two bench gates had failed on #334; the failed jobs were
        // re-run; the next ask came back unreadable a minute later; and the
        // pending left behind stood the run down. Neither of its two fix
        // rounds was spent, `ciPitStop` found nothing to escalate, and the run
        // reported "1 pull request open for review; CI still running" over a
        // branch that is red to this day.
        //
        // Not knowing is not a pass. Only a settled answer overturns the one
        // already on the record.
        //
        // `none` is the other way of not knowing, and it took the same path out
        // until this line named it: `awaitChecks` publishes `state: "none"` when
        // the head carries no check runs at all, and its own comment says
        // "'None' is not a pass — it is the absence of the only check that
        // judges the merge." A re-run that comes back before GitHub has
        // re-attached its check runs answers nothing, and letting it through
        // discarded the red verdict exactly as the pending did.
        ci = after.state === "passing" || after.state === "failing" ? after : red;
        if (ci.state !== "failing") return [];
      }
    }
    const round = rounds.size + 1;
    // The same bound as the intent gaps, for the same reason: enough for a
    // real failure list, few enough that a matrix of shards cannot re-plan the
    // run. Anything dropped is said out loud below.
    const MAX_CHECKS = 10;
    const failing = ci.failing.slice(0, MAX_CHECKS);
    const logs = await (this.github.failingJobLogs?.(prNumber) ?? Promise.resolve([])).catch(() => [] as { name: string; log: string }[]);
    const queued: PlannedTask[] = failing.map((check, i) => {
      const log = logs.find((l) => l.name === check)?.log ?? "";
      return {
        id: `ci-fix-${round}-${i + 1}`,
        epicId: CI_FIX_EPIC.id,
        scenarioIds: [],
        title: `Fix red CI check: ${check.slice(0, 80)}`,
        spec:
          `The run's pull request #${prNumber} is red: the repo's own CI check "${check}" failed on the merged branch, after a re-run — this is not flake.\n\n` +
          (log
            ? `The tail of the failing job's log:\n\n\`\`\`\n${log}\n\`\`\`\n\n`
            : `No log could be fetched for it; reproduce it from the workflow definition in .github/workflows/.\n\n`) +
          `You are working on the integration branch, which already contains every merged task — the code the failure is about is here. Find the cause and fix it. If the check itself is the defect — it gates on a number nobody ever measured, or needs something this repo's runner cannot provide — fix the check and say exactly why in your summary; a gate that can never pass is not a quality bar. Do not weaken a working check to get past it.`,
        acceptanceCriteria: [
          `The command the "${check}" workflow job runs passes locally from the repo root`,
          "Whatever made it fail is fixed at its cause, or the check itself is corrected with the reason stated",
        ],
        // Chained like the intent fixes: CI failures routinely share a cause,
        // and nothing here is urgent enough to be worth a conflict.
        dependsOn: i === 0 ? [] : [`ci-fix-${round}-${i}`],
        touchedPaths: [],
        // The workflow's own command is in the spec; inventing a probe here
        // would be the harness guessing at a second one.
        completionProbe: "",
        estimatedSize: "M",
      };
    });
    this.store.insertTasks(runId, [...this.store.listEpics(runId), CI_FIX_EPIC], queued.map(pendingRow));
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "integrator",
      text:
        `CI is red on #${prNumber} with ${ci.failing.length} failing check(s); queued ${queued.length} task(s) to fix them (round ${round} of ${run.config.ciFixRounds})` +
        (ci.failing.length > failing.length ? `. Not queued, and yours to judge: ${ci.failing.slice(MAX_CHECKS).join(", ")}` : ""),
      ts: Date.now(),
    });
    this.wakeScheduler();
    return queued.map((t) => t.id);
  }

  /**
   * The escalation for a red CI that has outlived its fix rounds.
   *
   * The sibling of `closingPitStop`, and bounded for the same reason: "do not
   * exit until CI is green" without a bound is a run that never exits, spending
   * fix rounds restating a fact about the repo — a runner that cannot host
   * service containers, a floor no test suite meets — that only a person can
   * change. Opens only when CI is failing, the rounds are spent, and nobody has
   * been shown this failure yet.
   */
  private async ciPitStop(runId: string): Promise<"proceed" | "stop" | "back-to-work"> {
    const run = this.store.getRun(runId)!;
    if (!this.gates.resolvePitStop || run.config.pitStop.every === "never" || !run.config.ciFixRounds) return "proceed";
    const ci = this.store.ciStatus(runId);
    if (!ci || ci.state !== "failing") return "proceed";
    // No rounds-remaining guard: reaching here with a failing status means
    // `queueCiFixes` just returned empty despite it, and its only such path
    // leaves the rounds spent — every other empty return leaves the recorded
    // state not-failing (a failing status always names its checks, so a round
    // with capacity always queues). The count below is for the operator.
    const rounds = new Set(this.store.listTasks(runId).map((t) => /^ci-fix-(\d+)-/.exec(t.id)?.[1]).filter(Boolean));
    // No "already answered" guard like `closingPitStop`'s, because the status
    // here cannot go stale the way a verdict can: every pass through
    // INTEGRATING republishes `run.ci_status` after any pit stop resolves, so
    // by construction this is only reached with a failure newer than the last
    // stop — asking about it again IS the correct behaviour.
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "pitstop",
      text:
        `CI is still red after ${rounds.size} fix round(s): ${ci.failing.join(", ")} — ` +
        `the failure has survived everything the run can do to it, so this one is yours to answer`,
      ts: Date.now(),
    });
    const action = await this.pitStop(runId, { reason: "the repo's CI is red on the run's pull request", epicIds: [] }, true);
    if (action === "stop") return "stop";
    return action === "continue" ? "proceed" : "back-to-work";
  }

  /**
   * A resume landing on a run whose CI was not green when it last reported.
   *
   * The world moves while a run is parked in review: a human re-runs a job, a
   * runner comes back, someone pushes a fix. Ask again rather than trusting
   * the stale answer — and if it is still red with fix rounds left, the resume
   * is the operator asking the run to try, so it tries. No pit stop here: the
   * escalation was already shown on the way in, and PR_REVIEW has no legal
   * transition to PAUSED for a "stop" to land on.
   */
  private async recheckRedCi(runId: string): Promise<"proceed" | "back-to-work"> {
    const run = this.store.getRun(runId)!;
    if (!run.config.waitForChecks || !this.github.enabled) return "proceed";
    const prior = this.store.ciStatus(runId);
    if (!prior || prior.state === "passing") return "proceed";
    // The recheck is work, and PR_REVIEW is the one working moment the
    // dashboard cannot see: `listOpenRuns` excludes it by design, because a
    // run that ends there has ended. A resume that re-asks GitHub about a red
    // or unsettled check is not ended — it is integrating — so it wears that
    // state for as long as the recheck runs, and hands PR_REVIEW back only
    // when there is nothing left to fix. Without this, an operator who ran
    // `harness resume` watched a dashboard that said "no active runs" while
    // the run it had just resumed was waiting on the repo's answer.
    this.store.transitionRun(runId, "INTEGRATING", "resumed to re-check CI the repo had not answered green");
    await this.awaitChecks(runId);
    const tasks = await this.queueCiFixes(runId);
    if (tasks.length) return "back-to-work";
    this.store.transitionRun(runId, "PR_REVIEW", this.outcome(runId).line);
    return "proceed";
  }

  /**
   * Open the pull requests for everything merged — after validation, so no PR
   * exists before the run has been judged against the operator's intent. Each
   * task is attempted independently: a GitHub failure on one must not orphan
   * the rest, and never undoes a local merge.
   */
  private async openPrs(runId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    // A run reaches INTEGRATING with nothing merged when its foundation tasks
    // park: everything downstream is cancelled as unreachable and there is no
    // diff to publish. Both paths below then return without opening anything —
    // `openRunPr` on `!merged.length`, the per-task loop by never entering — and
    // an integrator that says nothing here is indistinguishable from one whose
    // push to GitHub failed. Say which it was.
    const outcome = this.outcome(runId);
    if (!outcome.merged) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `no pull request opened: no task reached MERGED, so the run has no diff to publish — ${outcome.parked.length} task${outcome.parked.length === 1 ? "" : "s"} parked, ${outcome.cancelled} never started`,
        ts: Date.now(),
      });
      return;
    }
    if (run.config.prMode === "single") {
      try {
        await this.openRunPr(runId);
      } catch (e) {
        // A run that is stopping is not a pull request that failed to open.
        // `reconcileWithBase` re-throws an operator's pause rather than
        // retrying into it, and swallowing it one frame up would undo that and
        // march a stopped run on to PR_REVIEW with no merge status at all.
        if (stopsTheRun(e)) throw e;
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          text: `merged locally, but the pull request could not be opened: ${String(e).slice(0, 300)}`,
          ts: Date.now(),
        });
      }
      return;
    }
    for (const task of this.store.listTasks(runId)) {
      if (task.state !== "MERGED" || task.prNumber !== null) continue;
      try {
        await this.openTaskPr(runId, task.id);
      } catch (e) {
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          taskId: task.id,
          text: `merged locally, but the pull request could not be opened: ${String(e).slice(0, 300)}`,
          ts: Date.now(),
        });
      }
    }
  }

  /**
   * Everything after the human's merge: did it deploy, and does the deployed
   * thing do what was asked?
   *
   * A run that ends at PR_REVIEW has shipped nothing and knows nothing about the
   * world. Every check before this one reads the repository — deterministic
   * checks in a worktree, QA on a branch, the intent validator on the merged
   * tree, CI on the pull request. All four can be green while production is
   * untouched: a merge whose deploy failed, or one that deployed correct code
   * on top of infrastructure that never got applied, looks identical from
   * inside the repo. Only asking production tells them apart.
   *
   * Returns whether the cycle closed. The run stays in VERIFYING when it did
   * not — a red deploy and a production that disagrees are both the operator's
   * to act on, and `resume` re-enters here once they have.
   */
  private async verify(runId: string): Promise<boolean> {
    const run = this.store.getRun(runId)!;
    if (!run.config.prodUrl || !this.github.enabled) return false;
    const prNumber = this.rollupPr(runId);
    if (prNumber === undefined) return false;

    // Nothing to verify until a human has merged: that is the boundary the
    // harness does not cross, and waiting here for it is not the same as
    // failing. The run simply stays where it is until the operator acts.
    const sha = await this.github.mergedSha?.(prNumber).catch(() => null);
    if (!sha) return false;
    if (run.state === "PR_REVIEW") this.store.transitionRun(runId, "VERIFYING", `#${prNumber} merged — following the deploy`);

    const deploy = await this.settleChecks(runId, (ref) => this.github.checksForRef?.(ref) ?? Promise.resolve(null), sha, run.config.deployTimeoutMinutes);
    if (deploy) {
      this.bus.publish({ type: "run.deploy_status", runId, sha, state: deploy.state, failing: deploy.failing, total: deploy.total, ts: Date.now() });
      if (deploy.state === "failing") {
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          text: `the merge deployed red: ${deploy.failing.join(", ")} — the change is merged but not live`,
          ts: Date.now(),
        });
        return false;
      }
      // Still running, or a repo whose base branch has no workflows at all: in
      // both cases nothing here can claim the change reached production.
      if (deploy.state !== "passing") return false;
    }
    return await this.validateProd(runId, run.config.prodUrl);
  }

  /**
   * Send an agent to look at the running system, and record what it found.
   *
   * The skills index carries the operator's own production-validation and QA
   * playbooks; the "prod" lens is what pulls them in, so this agent checks
   * production the way its operator would rather than the way a model guesses.
   */
  private async validateProd(runId: string, url: string): Promise<boolean> {
    const run = this.store.getRun(runId)!;
    const tasks = this.store.listTasks(runId);
    const taskLines = tasks
      .filter((t) => t.state === "MERGED")
      .map((t) => `- ${t.title}: ${t.acceptanceCriteria.map((c) => c.slice(0, 160)).join(" | ")}`)
      .join("\n");
    try {
      const skills = this.selectSkills(
        indexSkills(run.config.skillsDirs),
        "prod",
        `validate the deployed system in production\n${run.assignment}`,
        run.config
      );
      const result = await this.pool.run({
        runId,
        role: "prod",
        model: run.config.models.prod,
        systemPrompt: prodValidatorSystemPrompt(toolbeltBlock(detectToolbelt(run.config.externalTools)), skillsBlock(skills)),
        skills: skills.map((s) => s.name),
        prompt: prodValidatorPrompt(run.assignment, this.planPrd(runId), url, taskLines),
        cwd: this.repoPath,
        // Production is read through the network, not through the checkout, and
        // an agent that can edit files here is one that can "fix" a live finding
        // into a local diff nobody asked for.
        allowedTools: ["Bash", "Read", "Glob", "Grep", "WebFetch"],
        maxTurns: 80,
        budgetCheck: () => this.checkStops(runId),
      });
      const verdict = ProdVerdict.parse(extractJson(result.resultText));
      this.bus.publish({ type: "run.prod_verdict", runId, url, verdict: verdict.verdict, findings: verdict.findings, summary: verdict.summary, ts: Date.now() });
      return verdict.verdict === "PASS";
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      // An unverified deploy is reportable; a run that claims to have verified
      // one it never reached is not. Say which happened.
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `production validation did not complete: ${String(e).slice(0, 300)}`,
        ts: Date.now(),
      });
      return false;
    }
  }

  /** The pull request the most tasks point at — the one a human would merge. */
  private rollupPr(runId: string): number | undefined {
    const counts = new Map<number, number>();
    for (const t of this.store.listTasks(runId)) if (t.prNumber !== null) counts.set(t.prNumber, (counts.get(t.prNumber) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0];
  }

  /**
   * Poll one commit's checks until they stop being pending.
   *
   * A timeout is reported as whatever it last was — pending, never passing. The
   * answer is "not known yet", and anything stronger is the failure this whole
   * phase exists to prevent.
   */
  private async settleChecks<T>(
    _runId: string,
    read: (ref: T) => Promise<{ state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null>,
    ref: T,
    timeoutMinutes: number
  ): Promise<{ state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null> {
    const budgetMs = timeoutMinutes * 60_000;
    const deadline = Date.now() + budgetMs;
    const pollMs = Math.min(15_000, Math.max(250, Math.floor(budgetMs / 40)));
    // CI has usually not been queued yet on a commit that is seconds old, so an
    // immediate "none" is indistinguishable from a repo that has no CI at all.
    // Run 407c2b0b is why this is a fraction of the whole budget rather than a
    // fixed handful of polls: a fixed 4 polls at the 15s cap gives up after 60s
    // regardless of `timeoutMinutes`, which is well inside how long a busy or
    // self-hosted runner queue can leave a workflow un-started. A quarter of the
    // configured budget still lets a genuinely CI-less repo resolve quickly on
    // a short timeout, while giving a slow-to-queue real CI room to appear.
    const graceDeadline = Date.now() + Math.min(budgetMs, Math.max(pollMs, Math.floor(budgetMs / 4)));
    let checks = await read(ref).catch(() => null);
    while (checks && Date.now() < deadline) {
      if (checks.state === "none") {
        if (Date.now() >= graceDeadline) break;
      } else if (checks.state !== "pending") break;
      await new Promise((r) => setTimeout(r, pollMs));
      const next = await read(ref).catch(() => null);
      if (!next) break;
      checks = next;
    }
    return checks;
  }

  /**
   * Wait for the repo's own CI on the pull request, and record what it said.
   *
   * `deterministicChecks` prove one task's worktree was green in isolation. They
   * never see the merged branch, never run the repo's workflow, and cannot
   * notice that the base moved underneath the run — so a run could report "1
   * pull request open for review" over a branch whose CI was red, or that could
   * not merge at all. This is the first and only step that asks the repo.
   *
   * A timeout is reported as pending, never as a pass: the answer is "not known
   * yet", and saying anything stronger is the failure this exists to prevent.
   *
   * And pending is not an answer, so the wait starts over rather than walking
   * on. Run 5743ce85's twelve checks on one self-hosted runner simply outlived
   * the budget: the run recorded "pending", moved to PR_REVIEW saying "CI
   * still running", and the check that then went red was the very one
   * `queueCiFixes` below exists to turn into work. The budget bounds each
   * round of asking, not the waiting: every expiry records what is known, says
   * so, and asks again. An operator's pause lands between rounds, and only
   * GitHub going unreadable ends the wait unsettled — leaving "pending" on the
   * record, which `hasRecoverableWork` counts as work, so a resume re-asks.
   */
  private async awaitChecks(runId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    if (!run.config.waitForChecks || !this.github.enabled) return;
    const prNumber = this.rollupPr(runId);
    if (prNumber === undefined) return;
    const settle = () =>
      this.settleChecks(runId, (n: number) => this.github.prChecks?.(n) ?? Promise.resolve(null), prNumber, run.config.checkTimeoutMinutes);
    let checks = await settle();
    while (checks !== null && checks.state === "pending") {
      this.bus.publish({ type: "run.ci_status", runId, prNumber, state: "pending", failing: [], total: checks.total, ts: Date.now() });
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `CI on #${prNumber} has not settled after another ${run.config.checkTimeoutMinutes} minute(s): ${checks.total} check(s) still running — waiting for the repo's answer`,
        ts: Date.now(),
      });
      if (this.pauseAsked.has(runId)) throw new RunPaused(runId);
      checks = await settle();
    }
    if (!checks) return;
    this.bus.publish({ type: "run.ci_status", runId, prNumber, state: checks.state, failing: checks.failing, total: checks.total, ts: Date.now() });
    if (checks.state === "failing") {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `CI is red on #${prNumber}: ${checks.failing.join(", ")} — the merged branch does not pass the repo's own checks`,
        ts: Date.now(),
      });
    }
    // A repository with no workflow at all. This used to be the quietest
    // outcome in the run: `settleChecks` spent its grace polls, wrote
    // `total: 0`, and the outcome line skipped the clause entirely, so run
    // 3ae58e02 reported "1 pull request open for review" over 543 files that
    // nothing had ever built together. "None" is not a pass — it is the absence
    // of the only check that judges the merge, and it reads as an achievement
    // precisely because nothing is red.
    if (checks.state === "none") {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `#${prNumber} has no checks: this repository has no CI, so nothing has built or tested the merged branch. Every green result in this run came from a per-task worktree that was never this tree.`,
        ts: Date.now(),
      });
    }
  }

  /**
   * Make the run's integration branch mergeable into its base — or find out that
   * it is not, before a pull request tells the operator otherwise.
   *
   * The run cuts its integration branch once, at the start, and merges every
   * accepted task into it. Nothing brings the other direction back: `main` keeps
   * moving, and on a long run the branch the harness publishes is one GitHub
   * will not merge. Every check in the run can still be green while that is
   * true, because every one of them judges this branch alone — `deterministicChecks`
   * in a worktree, QA on a task branch, the intent validator on the merged tree,
   * and CI on a head commit whose base it never looks at.
   *
   * Run 5743ce85 is what that costs. It spent $373.36, merged 64 tasks, opened
   * #834 CONFLICTING, and moved to PR_REVIEW with the line "1 pull request open
   * for review" — a finished-looking run whose single deliverable could not be
   * merged by anyone. The operator found out by opening GitHub.
   *
   * So the base is merged in here, before the push, and a conflict is treated as
   * what it is: work, not a report. An agent gets `BASE_CONFLICT_FIX_ATTEMPTS`
   * at it in the integration worktree — the same shape as handing a task's
   * conflict back to its worker, one level up. Only when that fails does the
   * merge get aborted and the branch published as it stands, held as a draft and
   * named in the outcome line, which is the honest version of what run 5743ce85
   * reported as success.
   *
   * Never force-pushes and never discards a base commit: a merge nobody could
   * resolve leaves the integration branch exactly where it was.
   */
  private async reconcileWithBase(
    runId: string,
    base: string
  ): Promise<{ state: "mergeable" | "conflicting"; conflicts: string[]; resolvedBy: "already-current" | "merge" | "agent" | "none" }> {
    const run = this.store.getRun(runId)!;
    const integration = this.wt.integrationBranch(runId);
    const settled = (
      state: "mergeable" | "conflicting",
      conflicts: string[],
      resolvedBy: "already-current" | "merge" | "agent" | "none"
    ): { state: "mergeable" | "conflicting"; conflicts: string[]; resolvedBy: "already-current" | "merge" | "agent" | "none" } => {
      this.bus.publish({ type: "run.merge_status", runId, prNumber: 0, state, baseBranch: base, conflicts, resolvedBy, ts: Date.now() });
      return { state, conflicts, resolvedBy };
    };

    let caught = await this.wt.catchUpIntegrationBranch(runId, base);
    if (caught.ok) {
      if (caught.moved) {
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          text: `${caught.ref} moved while the run was working and has been merged into ${integration}; the pull request opens against a current base`,
          ts: Date.now(),
        });
      }
      return settled("mergeable", [], caught.moved ? "merge" : "already-current");
    }

    // A merge that failed with no unmerged paths did not conflict — the ref
    // would not resolve, or the worktree was not clean. There is nothing to hand
    // an agent, and saying "conflicts" about it would send the operator looking
    // for markers that are not there.
    if (!caught.conflicts.length) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `could not merge ${caught.ref} into ${integration}, and git reported no conflicted files — the branch is published as it stands and may not be mergeable`,
        ts: Date.now(),
      });
      return settled("conflicting", [], "none");
    }

    for (let attempt = 1; attempt <= BASE_CONFLICT_FIX_ATTEMPTS; attempt++) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `${caught.ref} conflicts with ${integration} in ${caught.conflicts.length} file(s): ${caught.conflicts.slice(0, 5).join(", ")}${caught.conflicts.length > 5 ? `, +${caught.conflicts.length - 5} more` : ""} — sending an agent to resolve it (attempt ${attempt} of ${BASE_CONFLICT_FIX_ATTEMPTS})`,
        ts: Date.now(),
      });
      try {
        await this.pool.run({
          runId,
          role: "integrator",
          model: run.config.models.integrator,
          systemPrompt:
            "You are resolving a git merge conflict between a finished body of work and the base branch it must merge into. " +
            "You are not reviewing, redesigning or extending either side. Resolve the merge, prove it still builds and passes, and commit it — " +
            "or abort it and explain what decision it needs. Both are acceptable answers; forcing through a resolution you do not believe in is not.",
          prompt: baseConflictPrompt(integration, caught.ref, caught.conflicts, attempt, BASE_CONFLICT_FIX_ATTEMPTS),
          cwd: await this.wt.ensureIntegrationWorktree(runId),
          disallowedTools: ["WebSearch"],
          maxTurns: 80,
          budgetCheck: () => this.checkStops(runId),
        });
      } catch (e) {
        if (stopsTheRun(e)) throw e;
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          text: `the merge-resolution session did not complete: ${String(e).slice(0, 300)}`,
          ts: Date.now(),
        });
      }
      // The branch, not the session's own account of itself. An agent that says
      // it resolved the merge and left MERGE_HEAD behind has not, and an
      // unfinished merge published as a pull request is the failure this method
      // exists to prevent. The base's own commit is the thing asked about, so an
      // agent that aborted and then committed something unrelated cannot read as
      // a success.
      const state = await this.wt.integrationMergeState(runId);
      const contains = await this.wt.integrationContains(runId, caught.sha);
      if (!state.merging && !state.conflicts.length && contains) {
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          text: `the conflict with ${caught.ref} was resolved and committed on ${integration}`,
          ts: Date.now(),
        });
        return settled("mergeable", [], "agent");
      }
      // Either it aborted, or it stopped mid-merge. Put the worktree back before
      // anything else touches it, then re-create the conflict for the next go.
      await this.wt.abortIntegrationMerge(runId);
      if (attempt === BASE_CONFLICT_FIX_ATTEMPTS) break;
      const again = await this.wt.catchUpIntegrationBranch(runId, base);
      if (again.ok) return settled("mergeable", [], "merge");
      if (!again.conflicts.length) break;
      caught = again;
    }

    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "integrator",
      text: `${integration} still does not merge into ${caught.ref} after ${BASE_CONFLICT_FIX_ATTEMPTS} attempt(s) — the merge has been abandoned and the branch is unchanged. The pull request is held as a draft: ${caught.conflicts.join(", ")}`,
      ts: Date.now(),
    });
    return settled("conflicting", caught.conflicts, "none");
  }

  /**
   * A resume on a run that already published a pull request nobody can merge.
   *
   * Everything else in this phase happens on the way to PR_REVIEW, and a run
   * that is already there never passes through it again: the loop above breaks
   * out of INTEGRATING and drops straight into `verify`, which waits for a human
   * merge that a conflicting pull request makes impossible. That is a run with
   * work left to do and no way to reach it — the operator's only remaining move
   * is to resolve the conflict by hand, which is the thing `reconcileWithBase`
   * exists to spare them.
   *
   * So a resume reconciles and republishes. `openPrs` is idempotent — `ensurePR`
   * finds the pull request that already exists and updates it — and it is where
   * the base merge, the draft decision and the body all live, so re-entering it
   * is the whole fix rather than a second copy of it.
   *
   * Skipped once the branch is known to merge, and once a human has merged or
   * closed the pull request: neither has anything left to reconcile. A run
   * recorded before any of this existed has no merge status at all, which is
   * treated as "not known to merge" on purpose — those are exactly the runs
   * sitting on a conflict nobody has looked at.
   */
  private async republishUnmergeable(runId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    if (run.state !== "PR_REVIEW" || !this.github.enabled) return;
    const prNumber = this.rollupPr(runId);
    if (prNumber === undefined) return;
    if (this.store.mergeStatus(runId)?.state === "mergeable") return;
    // Whatever the harness last thought, a pull request a human has already
    // dealt with is not this method's business.
    const state = await (this.github.prState?.(prNumber) ?? Promise.resolve(null));
    if (state === "merged" || state === "closed") return;
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "integrator",
      text: `#${prNumber} is open and not known to merge into ${run.config.baseBranch} — reconciling the branch with the base before anything waits on a human merging it`,
      ts: Date.now(),
    });
    await this.openPrs(runId);
    await this.confirmMergeable(runId);
  }

  /**
   * Ask GitHub whether the pull request it now has can actually be merged.
   *
   * `reconcileWithBase` already merged the base in before the push, so this
   * normally only confirms it. It is here for the gap that leaves: the base can
   * move between that merge and the push, the push can land on a branch a
   * protection rule blocks, and GitHub computes mergeability against a base it
   * knows about rather than the one this machine fetched.
   *
   * "unknown" is what a timeout reports, and it is never upgraded to mergeable —
   * the whole point of this phase is that a run must not claim a merge it has
   * not been told about.
   */
  private async confirmMergeable(runId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    if (!this.github.enabled) return;
    const prNumber = this.rollupPr(runId);
    const local = this.store.mergeStatus(runId);
    // No local verdict means nothing reconciled this branch against its base,
    // which is the same position as having no pull request at all: there is
    // nothing for GitHub's answer to confirm or contradict, and a run says
    // nothing rather than inventing a comparison it never made.
    if (prNumber === undefined || !local) return;
    // Mapped onto the check vocabulary so the settling, the grace period and the
    // timeout-is-not-a-pass rule are the ones `settleChecks` already proves.
    // GitHub computes `mergeable` in the background, so "unknown" is pending in
    // exactly the sense that phase was written for.
    const settled = await this.settleChecks(
      runId,
      async (n: number) => {
        const m = await (this.github.prMergeable?.(n) ?? Promise.resolve(null));
        if (!m) return null;
        return {
          state: m.state === "mergeable" ? ("passing" as const) : m.state === "conflicting" ? ("failing" as const) : ("pending" as const),
          failing: m.state === "conflicting" ? [m.mergeStateStatus] : [],
          total: 1,
        };
      },
      prNumber,
      Math.min(this.mergeabilitySettleMinutes, run.config.checkTimeoutMinutes)
    );
    if (!settled) return;
    const state = settled.state === "passing" ? "mergeable" : settled.state === "failing" ? "conflicting" : "unknown";
    this.bus.publish({
      type: "run.merge_status",
      runId,
      prNumber,
      state,
      baseBranch: run.config.baseBranch,
      // GitHub says whether it merges, never where it broke. The file list is
      // only ever the one the harness found itself.
      conflicts: state === "conflicting" ? local.conflicts : [],
      resolvedBy: state === "conflicting" ? "none" : (local.resolvedBy as "already-current" | "merge" | "agent" | "none"),
      ts: Date.now(),
    });
    if (state === "conflicting") {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text:
          `#${prNumber} cannot be merged into ${run.config.baseBranch}: GitHub reports it as conflicting` +
          (local.state === "mergeable"
            ? ` — the base moved again between the harness's own merge and the push, so this branch is already out of date. \`harness resume\` reconciles it and re-checks.`
            : `. Nothing downstream of this pull request can happen until that is resolved.`),
        ts: Date.now(),
      });
    }
  }

  /**
   * One PR for the whole run, head = the integration branch. Task branches are
   * cut from the integration branch, so per-task PRs against the base overlap —
   * the last task's PR carries nearly every earlier commit again. The rollup is
   * the run's complete diff exactly once, and exactly the tree the validator
   * judged; each task is still reviewable as its own `--no-ff` merge commit.
   */
  private async openRunPr(runId: string): Promise<PrRef | null> {
    const run = this.store.getRun(runId)!;
    const base = run.config.baseBranch;
    if (!this.github.enabled) return null;
    const merged = this.store.listTasks(runId).filter((t) => t.state === "MERGED");
    if (!merged.length) return null;
    if (!base) throw new Error("the run has no base branch (detached HEAD) — nothing to open a PR against");

    // Before the push, not after: a branch that cannot merge into its base is
    // something to fix while the run still has agents, not something to report
    // once the pull request is already open and reading as finished.
    const merge = await this.reconcileWithBase(runId, base);

    // SEC-5: only the harness/<runId>/* namespace is ever pushed.
    await pushRunBranch(this.repoPath, this.wt.integrationBranch(runId));

    // Some of this run's work may have shipped already: an eager human can merge
    // the rollup while tasks are still executing. Those merged PRs are named in
    // the body, so the reviewer of the follow-up knows this diff is the rest.
    const priors = [...new Set(merged.map((t) => t.prNumber).filter((n): n is number => n !== null))];
    const shipped: number[] = [];
    for (const n of priors) if ((await this.github.prState?.(n)) === "merged") shipped.push(n);

    const intent = this.store.intentVerdict(runId);
    // Every criterion the run passed on without settling, gathered from the
    // tasks that are actually in this diff. See `QaVerdict`'s PASS branch.
    const unsettled = merged.flatMap((t) => t.unverified.map((u) => ({ task: t.title, gap: u })));
    const body = [
      `${merged.length} task${merged.length === 1 ? "" : "s"} merged on the run's integration branch, one \`--no-ff\` merge commit each. Opened by harness — merge is always human.`,
      "",
      ...merged.map((t) => `- ${t.title} (QA iterations: ${t.qaIterations}${t.githubIssueNumber ? `, closes #${t.githubIssueNumber}` : ""})`),
      // The reviewer arrives with the validator's answer in hand, PASS or not.
      ...(intent
        ? [
            "",
            intent.verdict === "PASS" ? "Intent check: **PASS**." : `Intent check: **FAIL** — ${intent.gaps.length || "unstated"} gap${intent.gaps.length === 1 ? "" : "s"}:`,
            ...intent.gaps.map((g) => `- ${g.slice(0, 500)}`),
            ...(intent.verdict === "FAIL"
              ? [
                  "",
                  "**This PR is held as a draft because of that.** Every gap above is work this run",
                  "did not deliver, and merging is not a way to finish it — on a repo with CD, the",
                  "merge ships the half that is done and leaves the rest as a difference between",
                  "production and this description. Close the gaps and the run flips this ready, or",
                  "mark it ready yourself if you have decided to ship it incomplete on purpose.",
                ]
              : []),
          ]
        : []),
      ...(unsettled.length
        ? [
            "",
            `Passed but **not verified** — ${unsettled.length} criteri${unsettled.length === 1 ? "on" : "a"} QA could not settle in its environment:`,
            ...unsettled.map((u) => `- ${u.task}: ${u.gap.slice(0, 500)}`),
            "",
            "**This PR is held as a draft because of that.** Each line is something the",
            "run reports as unproven, not something it found wrong — QA said so itself",
            "rather than passing quietly, which is the only reason you are reading it.",
            "Settle them, or mark the PR ready if you have decided to ship on them.",
          ]
        : []),
      ...(merge.state === "conflicting"
        ? [
            "",
            `**This branch does not merge into \`${base}\`.**${merge.conflicts.length ? ` Conflicts in ${merge.conflicts.length} file${merge.conflicts.length === 1 ? "" : "s"}:` : ""}`,
            ...merge.conflicts.slice(0, 20).map((f) => `- \`${f}\``),
            ...(merge.conflicts.length > 20 ? [`- …and ${merge.conflicts.length - 20} more`] : []),
            "",
            `\`${base}\` moved while this run was working. The harness merged it into the run's`,
            "integration branch, gave an agent the conflict, and could not resolve it — so the",
            "merge was abandoned and this branch is exactly as the run left it. **It is held as a**",
            "**draft because of that**: there is no version of this pull request a reviewer can merge",
            "until the two are reconciled, and every check above judged this branch alone.",
            "",
            `To take it on by hand: \`git fetch origin ${base} && git merge origin/${base}\` in the run's`,
            "integration worktree, then `harness resume`.",
          ]
        : []),
      ...(shipped.length
        ? ["", `Continues ${shipped.map((n) => `#${n}`).join(", ")} — this PR carries only the commits merged into the run after that one shipped.`]
        : []),
    ].join("\n");
    // The PRD heading is a written title; the assignment's first line is whatever
    // the operator typed mid-bug. Prefer the former, and never cut mid-word.
    const heading = /^#\s*(?:PRD\s*[—–:-]\s*)?(.+)$/m.exec(this.planPrd(runId))?.[1]?.trim();
    const raw = heading || run.assignment.split("\n")[0]!.trim();
    const title = raw.length <= 80 ? raw : `${raw.slice(0, 79).replace(/\s+\S*$/, "")}…`;
    // `regroupPrs` can run while tasks are still executing. A PR a human can
    // merge before the run finishes ships half a run and strands the rest
    // (marrymath #89), so until every task is terminal the rollup is a draft;
    // completion flips it ready with the final task list and intent verdict.
    const stillWorking = run.state !== "INTEGRATING" && run.state !== "PR_REVIEW";
    /**
     * A run that did not deliver what it was asked for does not hand a human a
     * mergeable button.
     *
     * The verdict has always been written into the body, and on run 1e7d3df3 it
     * said FAIL and listed four gaps: the NetworkPolicy, the CloudFront CSP, the
     * edge fleet roll, and the session table's apply. The PR was flipped ready
     * anyway, because until now the only question asked here was whether the
     * tasks had stopped running. It was merged with the FAIL in its own
     * description, and dns-project's CD shipped the application half of a change
     * whose infrastructure half was in the gap list — which is how a console
     * that had passed ten checks started answering 503 to every request.
     *
     * A verdict a reviewer has to notice is not a control; a draft is. GitHub
     * refuses to merge one, so the same sentence now has to be acted on rather
     * than read past. This is not a veto: `markPrReady` is one click, and an
     * operator who means to ship an incomplete run still can. What they cannot
     * do any more is ship it by not reading.
     */
    const intentFailed = intent?.verdict === "FAIL";
    /**
     * The same hold, for the gap the intent check cannot see.
     *
     * The intent verdict judges the run against the operator's brief: it asks
     * whether the work is there. It has no way to ask whether the work was ever
     * exercised, because a task whose criteria are all satisfied against mocks
     * reaches it looking exactly like one that was run for real.
     *
     * dns-project's `af60742` is what that costs. Its own commit message ends "NOT
     * YET verified this session (turn budget ran out first)" and names both
     * halves of the outage — the live DynamoDB run it skipped, and the manifest
     * variable it talked itself out of adding. The information was there, in
     * writing, at merge time, in a field nothing gated on. Honesty that reaches
     * no control is indistinguishable from silence.
     */
    /**
     * The same hold again, for the one defect that makes every other verdict on
     * this pull request beside the point.
     *
     * A conflicting branch cannot be merged by anybody, so holding it as a draft
     * takes nothing away — GitHub was never going to accept it. What the draft
     * buys is that the run stops reading as finished. Run 5743ce85 published a
     * CONFLICTING #834 as ready for review and moved to PR_REVIEW; the operator
     * had no way to tell that outcome from a mergeable one without leaving the
     * dashboard.
     */
    const cannotMerge = merge.state === "conflicting";
    const draft = stillWorking || intentFailed || unsettled.length > 0 || cannotMerge;
    const pr = await this.github.ensurePR(runId, "run", this.wt.integrationBranch(runId), base, title, body, { draft });
    if (!pr) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `no pull request opened: ${this.wt.integrationBranch(runId)} has no commits that ${base} does not already have`,
        ts: Date.now(),
      });
      return null;
    }
    if (!draft) await this.github.markPrReady?.(runId, "run", pr.number, title, body);
    if (pr.fresh && shipped.length) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `PR ${shipped.map((n) => `#${n}`).join(", ")} was merged before the run finished; opened follow-up PR #${pr.number} with the remaining commits`,
        ts: Date.now(),
      });
    }
    // Every merged task's work ships in this PR; pointing them all at it is what
    // keeps `hasRecoverableWork`, the dashboard chips and `status` truthful.
    for (const t of merged) {
      if (t.prNumber !== pr.number) this.store.updateTask(runId, t.id, { prNumber: pr.number });
    }
    this.bus.publish({ type: "github.pr_opened", runId, taskId: "run", prNumber: pr.number, url: pr.url, ts: Date.now() });
    return pr;
  }

  /**
   * Replace a run's per-task pull requests with the single rollup PR, for runs
   * published before "single" became the default (or with it turned off). The
   * rollup opens first; only then is each superseded PR closed with a comment
   * pointing at it, so there is no moment with no PR open at all. PRs a human
   * already merged or closed are left exactly as they are.
   */
  async regroupPrs(runId: string): Promise<{ pr: PrRef; closed: number[] } | null> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (!this.github.enabled) throw new Error("GitHub is not configured — there are no pull requests to regroup");
    if (!run.config.baseBranch) {
      const branch = await this.currentBranch();
      if (branch) this.store.patchRunConfig(runId, { baseBranch: branch });
    }
    const oldNumbers = [...new Set(this.store.listTasks(runId).flatMap((t) => (t.prNumber === null ? [] : [t.prNumber])))];
    this.store.patchRunConfig(runId, { prMode: "single" }); // future resumes publish the same way
    const pr = await this.openRunPr(runId);
    if (!pr) return null;
    const closed: number[] = [];
    for (const n of oldNumbers) {
      if (n === pr.number) continue;
      const didClose = await this.github.closePR(
        n,
        `Superseded by #${pr.number}. Task branches stack on the run's integration branch, so the per-task pull requests overlapped each other; #${pr.number} carries the run's complete diff exactly once.`
      );
      if (didClose) closed.push(n);
    }
    return { pr, closed };
  }

  /**
   * What the run actually produced.
   *
   * The terminal transition used to announce "PRs opened; human review on GitHub"
   * unconditionally. A run whose foundation tasks all park cancels everything
   * downstream and opens no pull request at all — and then told the operator to go
   * review pull requests that do not exist. Reporting the counts costs one query.
   */
  outcome(runId: string): {
    prs: { taskId: string; title: string; number: number }[];
    parked: { taskId: string; title: string; issue: number | null; branch: string | null; why: string; blocking: string[] }[];
    merged: number;
    cancelled: number;
    total: number;
    intent: { verdict: "PASS" | "FAIL"; gaps: string[]; summary: string } | null;
    ci: { prNumber: number; state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null;
    mergeable: { state: "mergeable" | "conflicting" | "unknown"; baseBranch: string; conflicts: string[] } | null;
    deploy: { sha: string; state: "passing" | "failing" | "pending" | "none"; failing: string[]; total: number } | null;
    prod: { url: string; verdict: "PASS" | "FAIL"; findings: string[]; summary: string } | null;
    line: string;
  } {
    const tasks = this.store.listTasks(runId);
    // A rollup PR is shared by every merged task; report it once, not per task.
    const withPr = tasks.filter((t): t is typeof t & { prNumber: number } => t.prNumber !== null);
    const seen = new Set<number>();
    const prs = withPr
      .filter((t) => (seen.has(t.prNumber) ? false : (seen.add(t.prNumber), true)))
      .map((t) => {
        const shared = withPr.filter((o) => o.prNumber === t.prNumber).length;
        return shared > 1
          ? { taskId: "run", title: `${shared} tasks (rollup)`, number: t.prNumber }
          : { taskId: t.id, title: t.title, number: t.prNumber };
      });
    const count = (s: TaskState) => tasks.filter((t) => t.state === s).length;

    // What each parked task is waiting for, and what is waiting on it. "3 tasks
    // need you" is not actionable on its own: the operator has to be told which
    // three, why each stopped, and where to go and look at it.
    const parked = tasks
      .filter((t) => t.state === "NEEDS_HUMAN")
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        issue: t.githubIssueNumber,
        branch: t.branch,
        why: t.errorSummary || this.store.taskStateReason(runId, t.id),
        blocking: this.dependents(tasks, t.id),
      }));

    const cancelled = count("CANCELLED");
    const parts = [
      prs.length
        ? `${prs.length} pull request${prs.length === 1 ? "" : "s"} open for review`
        : "no pull requests opened",
    ];
    // Immediately after the count, and ahead of everything else, because it
    // disqualifies everything else. "1 pull request open for review; CI green;
    // intent check passed" describes run 5743ce85 accurately and still leaves
    // out the only fact that mattered: nobody could merge it.
    const mergeable = this.store.mergeStatus(runId);
    if (mergeable && prs.length) {
      if (mergeable.state === "conflicting") {
        parts.push(
          `CANNOT MERGE — conflicts with ${mergeable.baseBranch || "the base branch"}` +
            (mergeable.conflicts.length ? ` in ${mergeable.conflicts.length} file${mergeable.conflicts.length === 1 ? "" : "s"}` : "")
        );
      } else if (mergeable.state === "unknown") {
        parts.push("mergeability unconfirmed");
      } else if (mergeable.resolvedBy === "agent" || mergeable.resolvedBy === "merge") {
        // Worth a clause of its own: the branch in the pull request is not only
        // the run's work, it carries a base merge the operator did not ask for.
        parts.push(`${mergeable.baseBranch || "the base branch"} merged in to keep it mergeable`);
      }
    }
    if (parked.length) parts.push(parked.length === 1 ? "1 task needs you" : `${parked.length} tasks need you`);
    if (cancelled) {
      parts.push(parked.length ? `${cancelled} never started, blocked behind them` : `${cancelled} never started`);
    }
    // What the repo itself said about the branch. A red CI belongs next to the
    // pull request count, not three screens down the event feed: "1 pull request
    // open for review" over a branch that does not build is the wrong headline.
    // "none" belongs here too, and used to be the one state this skipped. A
    // repo with no CI produced the same headline as a repo whose CI was green,
    // which is the reading an operator will take every time: nothing is red.
    const ci = this.store.ciStatus(runId);
    if (ci) {
      parts.push(
        ci.state === "passing"
          ? "CI green"
          : ci.state === "failing"
            ? `CI red (${ci.failing.slice(0, 3).join(", ")}${ci.failing.length > 3 ? `, +${ci.failing.length - 3} more` : ""})`
            : ci.state === "none"
              ? "NO CI — nothing checked the merged branch"
              : "CI still running"
      );
    }
    // The validator's answer to the only question the operator actually asked.
    const intent = this.store.intentVerdict(runId);
    if (intent) parts.push(intent.verdict === "PASS" ? "intent check passed" : `intent check found ${intent.gaps.length || "unstated"} gap${intent.gaps.length === 1 ? "" : "s"}`);
    // Whether any of it reached anyone. This is the end of the cycle, so it goes
    // last: the operator reads left to right and this is the part that decides
    // whether the work is finished or merely merged.
    const deploy = this.store.deployStatus(runId);
    if (deploy && deploy.state !== "none") {
      parts.push(
        deploy.state === "passing"
          ? "deployed"
          : deploy.state === "failing"
            ? `deploy red (${deploy.failing.slice(0, 3).join(", ")})`
            : "deploy still running"
      );
    }
    const prod = this.store.prodVerdict(runId);
    if (prod) {
      parts.push(
        prod.verdict === "PASS"
          ? "verified in production"
          : `production check found ${prod.findings.length || "unstated"} problem${prod.findings.length === 1 ? "" : "s"}`
      );
    }
    return {
      prs,
      parked,
      merged: count("MERGED"),
      cancelled,
      total: tasks.length,
      intent,
      ci,
      mergeable: mergeable ? { state: mergeable.state, baseBranch: mergeable.baseBranch, conflicts: mergeable.conflicts } : null,
      deploy,
      prod,
      line: parts.join("; "),
    };
  }

  /**
   * Park a task for the operator, and write down why on the task itself.
   *
   * The reason used to live only in the transition event, so a parked task's row
   * carried an empty `errorSummary` and the dashboard card showed a red pill with
   * no explanation under it. Storing it costs one column write and is the whole
   * difference between "NEEDS_HUMAN" and "QA rejected it 3 times, because …".
   */
  private park(runId: string, taskId: string, why: string): void {
    this.store.updateTask(runId, taskId, { errorSummary: why.slice(0, 500) });
    this.store.transitionTask(runId, taskId, "NEEDS_HUMAN", why);
  }

  /**
   * Ask the operator before parking (Gate: task-escalation).
   *
   * Every parked run so far parked for a reason an agent could not fix and the
   * operator could, in one sentence: checks that needed a service running,
   * checks pointed at the wrong package, a suite that was red before the run
   * began. Parking silently turns that sentence into a dead run and a pile of
   * CANCELLED tasks; asking turns it into a fresh set of iterations.
   *
   * Returns the guidance to hand the worker, or null when the task parked —
   * either because the operator chose to, or because this gate handler has no
   * way to ask (headless / test contexts).
   *
   * `probe` marks the one escalation whose answer may also rewrite what the task
   * is being held to, because it is the one an answer alone cannot end.
   */
  private async askOrPark(runId: string, taskId: string, why: string, probe = false): Promise<string | null> {
    const guidance = await this.askOperator(runId, taskId, why, probe);
    if (guidance === null) {
      this.park(runId, taskId, why);
      return null;
    }
    // The answer buys a whole new set of iterations, not one more attempt: the
    // operator just changed the conditions the old failures happened under.
    this.freshIterations(runId, taskId);
    return guidance;
  }

  /**
   * Open the task-escalation gate and wait for the operator's words — no state
   * changes here, so it serves both mid-run caps (askOrPark) and reviving
   * already-parked tasks on resume (reopen), where park() would be an illegal
   * NEEDS_HUMAN -> NEEDS_HUMAN transition. Null when the operator declined or
   * this gate handler has no way to ask (headless / test contexts).
   */
  private async askOperator(runId: string, taskId: string, why: string, amendable = false): Promise<string | null> {
    const task = this.store.getTask(runId, taskId)!;
    const decider = this.taskGateDecider(runId, taskId);
    // Nobody to ask and nobody to decide: park, without paying for advice that
    // has no one to reach.
    if (!decider && !this.gates.resolveTaskGate) return null;
    // The question arrives with a proposed answer attached: the gate blocks the
    // whole run on a human, so a minute of agent time drafting their reply is
    // the cheapest latency win in the system. With a decider named, that same
    // session *is* the answer — see adviseOperator.
    const probe = amendable ? task.completionProbe : "";
    // How many times this same task has already stopped somebody. Every other
    // number the advisor is given was reset by the last answer — `qaIterations`
    // goes back to zero the moment a gate resolves, so a task on its fourteenth
    // escalation presents exactly the "3 attempts" its first one did. Without
    // this the advisor investigates each round from scratch and reaches the same
    // conclusion it reached last round, which is precisely the loop.
    const repeats = this.store.taskGateOpenings(runId, taskId);
    const advice = await this.adviseOperator(runId, taskId, why, decider, probe, repeats);
    // Done before the gate is published, so the answer the operator reads
    // already says what the task is now being held to.
    const amended = probe && advice.probe !== null ? this.amendProbe(runId, taskId, probe, advice.probe, decider, advice.why) : "";
    const drafted = amended ? `${amended}\n\n${advice.recommendation}` : advice.recommendation;
    // The runbook is for the person, so it is added only on the path that
    // reaches one. When a decider answers, `recommendation` goes to the worker
    // verbatim — and a worker told to "open the AWS console" learns only that
    // its brief was written for somebody else.
    const forOperator = !decider || advice.needsOperator;
    const recommendation = forOperator ? withRunbook(drafted, advice.runbook) : drafted;
    // The count goes on the question, not the answer. `recommendation` is sent
    // to the worker verbatim when a decider answers, and the worker has no use
    // for how many times a person was interrupted; the person does.
    const asked = why + repeatNote(repeats, taskId, runId, task.completionProbe);
    this.bus.publish({
      type: "task.gate_opened",
      runId,
      taskId,
      why: asked,
      recommendation,
      iterations: task.qaIterations,
      // Only when a person is the one being asked. A decider's own escalation
      // is answered in-process and there is nobody to page about it.
      runbook: forOperator ? advice.runbook : null,
      ts: Date.now(),
    });
    const because = advice.why ? ` — ${advice.why}` : "";
    if (decider && recommendation && !advice.needsOperator) {
      // Published as opened-then-resolved rather than never opened: the task
      // did hit its cap, and a run whose log shows only the answer hides the
      // fact that anything went wrong.
      this.bus.publish({ type: "agent.log", runId, taskId, sessionId: "advisor", text: `${decider} answered this task's escalation${because}`, ts: Date.now() });
      this.bus.publish({ type: "task.gate_resolved", runId, taskId, parked: false, guidance: recommendation, decidedBy: decider, ts: Date.now() });
      return recommendation;
    }
    if (decider) {
      this.bus.publish({
        type: "agent.log",
        runId,
        taskId,
        sessionId: "advisor",
        text: recommendation
          ? `${decider} sent this task's escalation back to you${because}`
          : `${decider} did not return an answer for this task's escalation — asking you instead`,
        ts: Date.now(),
      });
    }
    // Whatever the decider said, an escalation it did not answer is one for the
    // operator — and where there is no way to ask them, the task parks.
    if (!this.gates.resolveTaskGate) return null;
    // From here until the answer arrives this task is running no agent, so its
    // worker slot goes back to the run. The advisor above is deliberately
    // outside this window: it *is* an agent, and it is this task's.
    this.gatedTasks.add(taskId);
    this.wakeScheduler();
    let guidance: string | null;
    try {
      guidance = (await this.gates.resolveTaskGate({
        runId,
        taskId,
        title: task.title,
        why: asked,
        recommendation,
        iterations: task.qaIterations,
        branch: task.branch,
        worktreePath: task.worktreePath,
      }))?.trim() || null;
    } finally {
      // Claim the slot back before the loop next counts, and wake it either way:
      // an answer means this task wants to work again, and the count changed.
      this.gatedTasks.delete(taskId);
      this.wakeScheduler();
    }
    this.bus.publish({ type: "task.gate_resolved", runId, taskId, parked: guidance === null, guidance: guidance ?? "", decidedBy: "operator", ts: Date.now() });
    return guidance;
  }

  /**
   * The skill that answers this task's escalation, or "" when the operator does.
   *
   * Empty once the same task has been answered by a skill `autoAnswerRounds`
   * times *in a row*. The count is read off the event log rather than held in
   * memory, so a resumed run does not hand a task that already burned its rounds
   * a fresh set — the events are the only thing that survives the process, and
   * this bound exists precisely for the case where an agent is answering its own
   * escalation in a circle. An operator answer ends the streak; see
   * `taskGateAutoAnswers`.
   */
  private taskGateDecider(runId: string, taskId: string): string {
    const cfg = this.store.getRun(runId)!.config.taskGate;
    if (cfg.decidedBy === "operator") return "";
    return this.store.taskGateAutoAnswers(runId, taskId) < cfg.autoAnswerRounds ? cfg.decidedBy : "";
  }

  /**
   * Apply the advisor's rewritten probe, and return the line that tells the
   * worker its definition of done moved. Empty when nothing was applied.
   *
   * Only a run that named a decider may rewrite a probe, and only
   * `taskGate.probeAmendments` times: the advisor drafting for a run whose
   * operator kept the gate for themselves has no authority to change what the
   * task is judged by, and a skill that keeps rewriting the bar until it clears
   * it has stopped being a check on the work. When the amendment is not applied,
   * the proposed probe is not thrown away — it is logged as the command the
   * operator can run, which is the whole of what they were missing the nine
   * times run f338b5c8 asked them about a probe they had no way to change.
   *
   * The authority read here is `taskGate.decidedBy`, not the live decider from
   * `taskGateDecider`: the two allowances bound different things and hanging one
   * off the other switches the escape hatch off at exactly the wrong moment.
   * `autoAnswerRounds` retires a skill from *answering* — the circuit breaker on
   * an agent answering its own escalation in a circle. `probeAmendments` bounds
   * something else, has its own counter, and is what the loop needs once the
   * answers stop working. Gating it on the first meant that from the third
   * escalation onward run 1e7d3df3 could no longer touch a probe no answer could
   * ever satisfy, and asked the operator eleven more times instead.
   */
  private amendProbe(runId: string, taskId: string, from: string, to: string, decider: string, why: string): string {
    const next = to.trim().slice(0, 1000);
    if (next === from) return "";
    const gate = this.store.getRun(runId)!.config.taskGate;
    const spent = this.store.taskProbeAmendments(runId, taskId);
    if (gate.decidedBy === "operator" || spent >= gate.probeAmendments) {
      this.bus.publish({
        type: "agent.log",
        runId,
        taskId,
        sessionId: "advisor",
        text:
          `this task's completion probe looks wrong${why ? ` — ${why}` : ""}. It is checked before QA and no answer can make it pass. To change it:\n` +
          `  harness probe ${taskId} ${next ? shellQuote(next) : "--clear"} --run ${runId} --why '...'`,
        ts: Date.now(),
      });
      return "";
    }
    // `decider` is empty once the skill is out of answer rounds, but it is still
    // the authority the amendment is made under — and the name on the permanent
    // record has to be that authority rather than "", which would read back as
    // the operator's own amendment and not count against the allowance.
    const by = decider || gate.decidedBy;
    this.store.amendProbe(runId, taskId, next, by, why);
    return next
      ? `Your completion probe has been changed by the ${by}, which looked at why it was failing. It is now:\n\n    ${next}\n\nThat is the bar; the old one is not. Do not edit it.`
      : `Your completion probe has been withdrawn by the ${by}, which looked at why it was failing and found it was asking for the wrong thing. QA's judgment is now the whole of your definition of done.`;
  }

  /**
   * A short read-only advisor session in the stuck task's worktree, drafting
   * the answer the operator will probably give — or, when `decider` names a
   * skill, giving it. Never fatal — a crashed or unparseable advisor just means
   * the old, question-only gate.
   *
   * The turn budget buys verification, not just reading. An advisor that only
   * summarises the rejection is worse than none: on the run where this was
   * measured, QA's third paragraph reported a real key mismatch, the draft
   * compressed it away, the operator accepted the draft in one click and the
   * worker was re-dispatched never having heard about the defect.
   */
  private async adviseOperator(
    runId: string,
    taskId: string,
    why: string,
    decider = "",
    probe = "",
    repeats = 0
  ): Promise<{ recommendation: string; needsOperator: boolean; why: string; probe: string | null; runbook: Runbook | null }> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    const none = { recommendation: "", needsOperator: true, why: "", probe: null, runbook: null };
    try {
      // Looked up by name, as the pit stop's decider is: the skill was named to
      // be the one answering, and the lexical matcher's opinion of what this
      // task sounds like is a different question. A name that matches nothing
      // still decides — it wears the hat without the playbook.
      const skills = decider ? indexSkills(run.config.skillsDirs).filter((s) => s.name === decider && verifyHash(s)) : [];
      const result = await this.pool.run({
        runId,
        taskId,
        role: "advisor",
        model: run.config.models.advisor,
        systemPrompt: advisorSystemPrompt("", decider, skillsBlock(skills), probe, repeats),
        skills: skills.map((s) => s.name),
        prompt: advisorPrompt(task, why, run.config.deterministicChecks, repeats),
        cwd: task.worktreePath ?? this.repoPath,
        disallowedTools: ["Write", "Edit", "NotebookEdit", "WebSearch"],
        maxTurns: 30,
        env: isolationEnv(taskIsolation(runId, taskId)),
        // The advisor re-runs the suite to check QA's claims, so it leaves the
        // same debris a worker does — but only when it has a worktree of its own
        // to leave it in. Falling back to the repo means sweeping the repo.
        reapOnEnd: Boolean(task.worktreePath),
      });
      const parsed = extractJson(result.resultText) as {
        recommendation?: unknown;
        checked?: unknown;
        needsOperator?: unknown;
        why?: unknown;
        probe?: unknown;
        runbook?: unknown;
      };
      if (typeof parsed?.recommendation !== "string") return none;
      const checked = Array.isArray(parsed.checked) ? (parsed.checked as AdvisorCheck[]) : [];
      return {
        // advisorAnswer budgets the 4000 itself, spending it on the checks first.
        recommendation: advisorAnswer(parsed.recommendation.trim(), checked),
        needsOperator: parsed.needsOperator === true,
        why: typeof parsed.why === "string" ? parsed.why.slice(0, 300) : "",
        // Only a string is an amendment. Null is the documented "leave it
        // alone", and a session that answered without the field at all — an
        // advisor drafting for a human, an older prompt, a model that dropped
        // it — is saying the same thing by saying nothing.
        probe: probe && typeof parsed.probe === "string" ? parsed.probe : null,
        // Parsed here and rendered only if the gate actually reaches a person:
        // a decider that answers its own escalation hands the worker prose, and
        // a worker has no use for instructions addressed to somebody else.
        runbook: parseRunbook(parsed.runbook),
      };
    } catch {
      // A session that crashed decided nothing, which is not the same as
      // deciding to continue: the escalation goes to the person it always did.
      return none;
    }
  }

  /**
   * Kill anything still running in this run's worktrees before the run starts.
   *
   * The per-session sweep only catches what a session leaves behind while the
   * harness is alive to notice. A harness killed by SIGTERM — or by the operator's
   * terminal closing, which is how most of them end — takes its sessions with it
   * and leaves their shells running: run 40da9337 was resumed with 37 of them
   * still writing to the database every later task's checks would read. So a
   * resume starts by clearing the ground it is about to work on.
   *
   * Scoped to this run's own worktree tree, which is the harness's to clear.
   * A second harness working a different repo is untouched.
   */
  private async sweepOrphans(runId: string): Promise<void> {
    const root = path.join(this.wt.worktreeRoot(), runId);
    const reaped = await reapUnder(root).catch(() => []);
    if (!reaped.length) return;
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "integrator",
      text:
        `swept ${reaped.length} process${reaped.length === 1 ? "" : "es"} left over in this run's worktrees by an earlier harness process: ` +
        reaped.map((r) => `${r.pid} ${r.command.slice(0, 60)}`).join("; "),
      ts: Date.now(),
    });
  }

  /**
   * Tasks sitting at a gate, waiting on a human. In flight, but running no agent
   * — see `working()` in the dispatch loop.
   */
  private gatedTasks = new Set<string>();

  /**
   * Resolved whenever something outside the dispatch loop changes what is
   * runnable: a gate opens or closes, or an operator revives a parked task. The
   * loop otherwise only ever wakes when a task *finishes*, which is far too
   * coarse — a revived task can wait out an unrelated task's entire
   * worker→QA→worker loop before anyone looks at the ready set again.
   *
   * One promise shared by every waiter, replaced on each wake, so a loop that
   * races it repeatedly does not accumulate resolvers.
   */
  private wake: { promise: Promise<void>; resolve: () => void } | null = null;

  private schedulerChanged(): Promise<void> {
    if (!this.wake) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.wake = { promise, resolve };
    }
    return this.wake.promise;
  }

  /** Tell the dispatch loop to look at the ready set again now. */
  private wakeScheduler(): void {
    const pending = this.wake;
    this.wake = null;
    pending?.resolve();
  }

  /** Operator guidance for tasks revived by `reopen`, consumed by the first worker dispatch. */
  private revivalGuidance = new Map<string, string>();

  /** What the checks do on the integration branch, per commit of it. See `baseFailures`. */
  private baselines = new Map<string, Promise<CheckResult>>();

  /**
   * Unprompted operator feedback mid-run ("skip the e2e suite, it was red
   * before you started"). The target is a task id or an `@role` handle for a
   * run-level agent (`@planner`, `@intake`, …). Task feedback reaches the live
   * worker/QA session as a real user message, else queues for the next agent
   * dispatched on the task. Run-level agents have no "next dispatch" to queue
   * for, so their feedback only lands while they are running — otherwise this
   * throws. Also throws for unknown or finished tasks.
   *
   * A parked task has no next dispatch either, unless something arranges one.
   * "queued" on a NEEDS_HUMAN task used to mean "nobody will read this until
   * you reopen the task on some later resume" while reading exactly like
   * feedback to a task with a worker seconds away. An operator answering a
   * parked task is answering the escalation gate whether or not the gate is
   * still open, so while the run is still executing that answer revives the
   * task on the spot — which is what `reopen` would have done with it later.
   */
  sendFeedback(runId: string, target: string, text: string): "live" | "queued" | "revived" {
    const trimmed = text.trim().slice(0, 4000);
    if (!trimmed) throw new Error("feedback is empty");
    if (target.startsWith("@")) {
      const hit = this.pool.inject?.(runId, target, operatorFeedbackMessage(trimmed));
      if (!hit) throw new Error(`the ${target.slice(1)} isn't running right now — it finished before your message arrived`);
      this.bus.publish({ type: "task.feedback", runId, taskId: target, text: trimmed, delivery: "live", ts: Date.now() });
      return "live";
    }
    const task = this.store.getTask(runId, target);
    if (!task) throw new Error(`no task ${target} in run ${runId}`);
    if (task.state === "MERGED" || task.state === "CANCELLED") {
      throw new Error(`task ${target} is ${task.state} — no agent will read this. Reopen the task instead.`);
    }
    // Fakes in tests stand in for the pool without an inject(), hence the `?.`.
    const hit = this.pool.inject?.(runId, target, operatorFeedbackMessage(trimmed));
    if (!hit) this.store.queueFeedback(runId, target, trimmed);
    // Only while the scheduler is still looping: it re-lists tasks on every
    // dispatch and takes READY ones first. After EXECUTING nothing is watching,
    // and the note waits in the queue for `reopen` on the next resume — where it
    // now survives to be read, which is the whole point of persisting it.
    const revived = !hit && task.state === "NEEDS_HUMAN" && this.store.getRun(runId)?.state === "EXECUTING";
    if (revived) {
      this.freshIterations(runId, target);
      this.store.transitionTask(runId, target, "READY", "reopened by the operator's feedback");
      // …and tell the loop now, rather than leaving the revived task to wait out
      // whatever unrelated task happens to be mid-iteration.
      this.wakeScheduler();
    }
    const delivery = hit ? ("live" as const) : revived ? ("revived" as const) : ("queued" as const);
    this.bus.publish({ type: "task.feedback", runId, taskId: target, text: trimmed, delivery, ts: Date.now() });
    return delivery;
  }

  /**
   * Ask for a pit stop instead of waiting for one.
   *
   * The operator watching the log has the one thing no gate in this harness can
   * manufacture: a reason to look now. Everything else that opens a pit stop is
   * a boundary the plan crossed — an epic finished, a figure passed — and none
   * of those fire because the product started looking wrong on screen. Until
   * this existed the answer to "is it still building the right thing?" was to
   * wait for the next epic, or to type into the feedback box and get whatever a
   * worker mid-task made of it.
   *
   * What it does *not* do is interrupt anything. The request stops the scheduler
   * dispatching new tasks and the stop opens once the in-flight ones settle,
   * which is the same rule the automatic stops follow and for the same reason: a
   * tree with three workers half-way through their tasks is not a product to
   * show anybody. A worker forty turns in finishes; killing it would throw away
   * a warm worktree and change nothing about the demo, which reads the
   * integration branch and never a worker's tree.
   *
   * The question is required. A pit stop costs a demo and every reviewer lens,
   * and "have a look" spends that on the same generic pass the automatic stops
   * already buy — the question is what makes this stop worth more than the one
   * that was coming anyway.
   */
  requestPitStop(runId: string, question: string): string {
    const run = this.store.getRun(runId);
    if (!run) return `no run ${runId}`;
    if (!this.gates.resolvePitStop) return "this run has nobody to show a pit stop to";
    const trimmed = question.trim().slice(0, 4000);
    if (!trimmed) return "write the question the pit stop should answer";
    if (!["EXECUTING", "INTEGRATING"].includes(run.state)) {
      return `this run is ${run.state} — a pit stop needs a run that is still working`;
    }
    // Asking twice replaces the question rather than queueing a second stop:
    // `pendingPitStopRequest` is last-one-wins, and an operator who clicks again
    // because nothing visibly happened must not be charged for two demos.
    const already = this.store.pendingPitStopRequest(runId);
    this.bus.publish({ type: "run.pitstop_requested", runId, question: trimmed, ts: Date.now() });
    // The loop re-reads `pitStopReason` on every pass, but a run whose workers
    // are all mid-turn is not passing — without this the stop waits on whatever
    // unrelated thing happens to finish next.
    this.wakeScheduler();
    return already
      ? "your question replaced the one already waiting — the pit stop opens when the running tasks settle"
      : "pit stop requested — it opens when the running tasks settle, and no new task starts until it does";
  }

  /**
   * Call off a requested pit stop that has not opened yet.
   *
   * The cheapest undo in the harness, and the reason asking can be cheap: a
   * request that has not opened has spent nothing, so "never mind" costs
   * nothing either. Once the demo has started there is no undo here — that
   * money is spent, and the stop will open with whatever it found.
   */
  cancelPitStop(runId: string): string {
    const asked = this.store.pendingPitStopRequest(runId);
    if (!asked) return "nothing to cancel — no pit stop is waiting to open";
    this.bus.publish({ type: "run.pitstop_cancelled", runId, question: asked.question, ts: Date.now() });
    this.wakeScheduler();
    return "pit stop cancelled — nothing was spent, and the run keeps going";
  }

  /**
   * Fold new comments on a task's GitHub issue into its feedback queue.
   *
   * An operator who reads "QA rejected this three times" on issue #52 answers
   * it there — that is what the issue is for. Every one of those answers used
   * to go nowhere, because the harness only ever wrote to GitHub. Each comment
   * is queued once, keyed by its comment id, so re-polling on every iteration
   * costs one request and never repeats itself into the prompt.
   *
   * Never fatal: GitHub being unreachable must not park a task that is
   * otherwise ready to run.
   */
  private async ingestIssueComments(runId: string, taskId: string): Promise<void> {
    const task = this.store.getTask(runId, taskId);
    if (!task?.githubIssueNumber || !this.github.enabled) return;
    try {
      // `?.` for the same reason as everywhere else here: test fakes stand in
      // for the adapter and implement only the methods they care about.
      const comments = (await this.github.issueComments?.(task.githubIssueNumber)) ?? [];
      let queued = 0;
      for (const c of comments) {
        const text = `${c.author} commented on issue #${task.githubIssueNumber}:\n${c.body.slice(0, 4000)}`;
        if (this.store.queueFeedback(runId, taskId, text, "issue", String(c.id))) queued++;
      }
      if (queued) {
        this.bus.publish({
          type: "task.feedback",
          runId,
          taskId,
          text: `${queued} new comment${queued === 1 ? "" : "s"} on issue #${task.githubIssueNumber}`,
          delivery: "queued",
          ts: Date.now(),
        });
      }
    } catch {
      /* an unreachable GitHub is not a reason to hold up the task */
    }
  }

  /**
   * Resume a QA session that finished without writing its verdict JSON, and ask
   * for nothing but the verdict.
   *
   * Null when there is no session to resume, when the retry also fails, or when
   * it still will not answer in the required shape — every one of which leaves
   * the caller's existing FAIL exactly where it was. Budget stops are the one
   * thing that must still propagate: a run over its cap does not get to spend
   * two more turns being polite about it.
   */
  private async reaskVerdict(runId: string, taskId: string, qa: AgentResult, run: RunRow, cwd: string): Promise<QaVerdict | null> {
    if (!qa.sdkSessionId) return null;
    try {
      const retry = await this.pool.run({
        runId,
        taskId,
        role: "repair",
        // Not the QA model. This resumes the session that already judged the
        // task and asks it to restate the conclusion it reached — the judging
        // happened on the judging model, in the conversation being resumed, and
        // what is left is transcription. Two turns, no investigation, and the
        // prompt below forbids changing the verdict.
        model: run.config.models.repair,
        systemPrompt: "You are finishing a verification you have already done. Answer with JSON and nothing else.",
        prompt:
          "Your previous message did not contain the verdict JSON this task requires. Do not investigate anything further and do not change your judgment — just state the conclusion you already reached, as exactly one JSON object inside a ```json fence:\n" +
          '{"verdict":"PASS","notes":string,"unverified":[string]}\nor\n{"verdict":"FAIL","reasons":[string],"mustFix":[string]}',
        cwd,
        resume: qa.sdkSessionId,
        maxTurns: 2,
        budgetCheck: () => this.checkStops(runId),
      });
      return QaVerdict.parse(extractJson(retry.resultText));
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      return null;
    }
  }

  /** Every task that cannot run until `taskId` does — directly or through another. */
  private dependents(tasks: { id: string; dependsOn: string[] }[], taskId: string): string[] {
    const blocked = new Set([taskId]);
    // The DAG is small and topologically ordered in practice; iterate to a fixed
    // point rather than assuming the plan listed dependencies before dependents.
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of tasks) {
        if (!blocked.has(t.id) && t.dependsOn.some((d) => blocked.has(d))) {
          blocked.add(t.id);
          changed = true;
        }
      }
    }
    blocked.delete(taskId);
    return [...blocked];
  }

  // ---- planning ----

  /**
   * Planning is two calls, not one. A PRD plus a conventions doc plus every task
   * spec, JSON-escaped into a single object, does not fit in one message for any
   * real repository — and a plan cut off mid-JSON is worth nothing however many
   * times it is retried. Phase A surveys the repo and writes the prose as plain
   * markdown; phase B turns that prose into the DAG with no tools and no prose.
   */
  private async plan(runId: string, feedback: string): Promise<Plan> {
    await this.warnOutputCeiling(runId);
    const docs = await this.planDocs(runId, feedback);
    const breakdown = await this.planBreakdown(runId, docs, feedback);
    return { ...docs, ...breakdown };
  }

  /**
   * Say so when the SDK is going to grant the planner less than it asked for.
   *
   * `PLANNER_MAX_OUTPUT_TOKENS` is a request the SDK clamps per model, and a
   * model it does not recognise gets the default however high the request was.
   * Run 3ae58e02 lost a phase-B attempt to exactly that and the retry told the
   * planner to write less, because nothing had said the ceiling was half what
   * the harness believed. The run continues either way — the two-phase split
   * exists so it can — but the operator now knows which of the two it is.
   */
  private async warnOutputCeiling(runId: string): Promise<void> {
    const model = this.store.getRun(runId)!.config.models.planner;
    const text = ceilingNote(await sdkCeiling(model), PLANNER_MAX_OUTPUT_TOKENS);
    if (text) this.bus.publish({ type: "agent.log", runId, sessionId: "planner", text, ts: Date.now() });
  }

  /**
   * How much output to ask each planner message for: everything the model
   * allows, when the SDK will say what that is.
   *
   * Every planner message is one indivisible artifact — a PRD, a batch of the
   * DAG — so the ceiling is not a spending limit but the size of the largest
   * plan that can be written without being cut in half. `claude-opus-5` allows
   * 128k and hands out 64k unasked, and the difference is a phase that either
   * finishes in one message or spends three more attempts learning to be
   * shorter.
   */
  private async plannerOutputTokens(runId: string): Promise<number> {
    const model = this.store.getRun(runId)!.config.models.planner;
    return requestTokens(await sdkCeiling(model), PLANNER_MAX_OUTPUT_TOKENS);
  }

  /** Phase A: survey the repository and write the PRD and conventions documents. */
  private async planDocs(runId: string, feedback: string): Promise<Pick<Plan, "prdMarkdown" | "conventionsMarkdown">> {
    const run = this.store.getRun(runId)!;
    const attempts = 2;
    let lastReason = "the planner produced no output";
    let lastPath = "";
    const maxOutputTokens = await this.plannerOutputTokens(runId);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await this.plannerMessage({
        runId,
        role: "planner",
        model: run.config.models.planner,
        systemPrompt: plannerDocsSystemPrompt(skillsBlock(this.planSkills(runId))),
        skills: this.planSkills(runId).map((s) => s.name),
        prompt:
          `Assignment:\n${run.assignment}\n` +
          specPlanBlock(this.store.runSpec(runId) ?? RunSpec.parse({})) +
          (feedback ? `\nOperator feedback on the previous plan:\n${feedback}\n` : "") +
          (attempt > 1 ? `\nYour previous attempt was rejected: ${lastReason}\n` : "") +
          `\nSurvey the repository at your working directory, then emit the <prd> and <conventions> blocks.`,
        cwd: this.repoPath,
        tools: ["Read", "Glob", "Grep"], // planning is read-only
        allowedTools: ["Read", "Glob", "Grep"],
        maxTurns: 40,
        maxOutputTokens,
        budgetCheck: () => this.checkStops(runId),
      });
      if ("died" in result) {
        lastReason = this.failedAttempt(runId, attempt, result.died, lastPath, "error");
        continue;
      }
      lastPath = this.saveAttempt(path.join(this.repoPath, ".harness", runId), `docs-${attempt}`, result.resultText);

      const prdMarkdown = extractSection(result.resultText, "prd");
      const conventionsMarkdown = extractSection(result.resultText, "conventions");
      if (prdMarkdown && conventionsMarkdown) return { prdMarkdown, conventionsMarkdown };

      const missing = [!prdMarkdown && "<prd>", !conventionsMarkdown && "<conventions>"].filter(Boolean).join(" and ");
      lastReason = outputTruncated(result.resultText, result.errorDetail)
        ? `the documents ran past the output-token limit and were cut off (${missing} never closed) — write less`
        : `the planner did not emit ${missing}`;
      lastReason = this.failedAttempt(runId, attempt, lastReason, lastPath, result.outcome, result.errorDetail);
    }
    throw this.planFailed(runId, attempts, lastReason, lastPath);
  }

  /**
   * Phase B: the DAG. No tools — the survey happened in phase A and is quoted back.
   *
   * The DAG comes back in as many messages as it takes. A task costs about 500
   * tokens of JSON, a real plan runs to forty of them, and the SDK caps one
   * message at a figure it picks by model and does not negotiate — 32k for a
   * model it does not recognise, which today means every default planner. The
   * rule this replaces told the planner to emit "fewer, larger tasks" when the
   * plan would not fit, trading away the one thing a DAG exists for.
   *
   * A plan that fits still arrives in one message, exactly as before: the
   * continuation only happens when the planner itself says there is more.
   */
  private async planBreakdown(runId: string, docs: Pick<Plan, "prdMarkdown" | "conventionsMarkdown">, feedback: string): Promise<PlanBreakdown> {
    const run = this.store.getRun(runId)!;
    const attempts = 3;
    let lastReason = "the planner produced no output";
    let lastPath = "";
    let lastOutput = "";
    let lastTruncated = false;
    // Phase B has no tools, so what it knows about the repository is what it is
    // told. Without this it names `touchedPaths` from the PRD's vocabulary and
    // invents paths for files that already exist a directory away.
    const files = await repoFileList(this.repoPath);
    const maxOutputTokens = await this.plannerOutputTokens(runId);
    // What the planner is told to fit in one message follows what it will
    // actually be granted, so the two can never drift apart again.
    const perMessage = tasksPerMessage(grantedTokens(await sdkCeiling(run.config.models.planner), maxOutputTokens));

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Only the first attempt restates the PRD. A rejected breakdown is a shape
      // problem, so later attempts repair the previous JSON — re-deriving the
      // decomposition three times is what made one failed planning phase cost $3.34.
      const repair = attempt > 1 && lastOutput.length > 0;
      const epics: PlannedEpic[] = [];
      const tasks: PlannedTask[] = [];
      let resume: string | undefined;
      let reason = "";
      let outcome: AgentResult["outcome"] = "done";
      let errorDetail: string | undefined;

      // Each pass through here is one message of the DAG. Every way out is an
      // explicit break or the return: an attempt ends when the planner says the
      // plan is complete, when a message cannot be read, or at the cap.
      for (let batch = 1; ; batch++) {
        const result = await this.plannerMessage({
          runId,
          role: "planner",
          model: run.config.models.planner,
          systemPrompt: plannerBreakdownSystemPrompt(skillsBlock(this.planSkills(runId)), perMessage),
          skills: this.planSkills(runId).map((s) => s.name),
          resume,
          prompt:
            batch > 1
              ? plannerContinuePrompt(epics, tasks, perMessage)
              : repair
                ? plannerRepairPrompt(lastOutput, lastReason, lastTruncated)
                : `Assignment:\n${run.assignment}\n${specPlanBlock(this.store.runSpec(runId) ?? RunSpec.parse({}))}${feedback ? `\nOperator feedback on the previous plan:\n${feedback}\n` : ""}\n\nYou have already surveyed the repository and written these documents. Do not use any tools.\n\n<prd>\n${docs.prdMarkdown}\n</prd>\n\n<conventions>\n${docs.conventionsMarkdown}\n</conventions>\n${
                    files
                      ? `\n<repository-files>\n${files}\n</repository-files>\n\nThese are the files that exist today. Put the real ones under \`touchedPaths\` — a path you invent for a file that already exists is a task pointed at nothing, and two tasks naming the same file by different paths will collide instead of depending on each other. Only invent a path for a file the assignment genuinely requires and the repository does not have.\n`
                      : ""
                  }\nEmit the epic/task DAG as JSON.`,
          cwd: this.repoPath,
          tools: [],
          allowedTools: [],
          maxTurns: 4,
          maxOutputTokens,
          budgetCheck: () => this.checkStops(runId),
        });
        if ("died" in result) {
          reason = result.died;
          break;
        }
        // The continuation resumes the same conversation when the transport
        // offers a handle; when it does not, `plannerContinuePrompt` carries
        // enough of the plan for the next message to stand on its own.
        resume = result.sdkSessionId;
        lastOutput = result.resultText;
        lastTruncated = outputTruncated(result.resultText, result.errorDetail);
        outcome = result.outcome;
        errorDetail = result.errorDetail;
        // Always keep the raw output: an unusable plan is expensive, and diagnosing
        // it from a one-line error is impossible. The first message of an attempt
        // keeps the name it has always had; continuations extend it.
        lastPath = this.saveAttempt(path.join(this.repoPath, ".harness", runId), batch > 1 ? `dag-${attempt}-${batch}` : `dag-${attempt}`, result.resultText);

        const read = this.readBatch(result.resultText, lastTruncated);
        if ("reason" in read) {
          reason = read.reason;
          break;
        }
        epics.push(...read.batch.epics);
        tasks.push(...read.batch.tasks);
        if (!read.batch.more) {
          // The whole DAG is in. Shape and DAG validity are judged on the
          // assembled plan, never on a batch — a `dependsOn` edge is only
          // dangling once every message that could have satisfied it is in.
          const parsed = PlanBreakdown.safeParse({ epics, tasks });
          if (!parsed.success) {
            reason = `the breakdown does not match the required shape: ${issueSummary(parsed.error)}`;
            break;
          }
          const errors = validatePlanDag({ ...docs, ...parsed.data });
          if (errors.length) {
            reason = `the plan is not a valid DAG: ${errors.join("; ")}`;
            break;
          }
          // Shape and dependencies are not the only way a plan can be
          // unbuildable. A task written against a repository this run does not
          // own is finishable by nobody here, and the retry loop is the last
          // place that can say so cheaply.
          const scope = validatePlanScope(parsed.data.tasks, this.repoPath);
          if (scope.length) {
            reason = `the plan reaches outside this run's repository: ${scope.join("; ")}`;
            break;
          }
          return parsed.data;
        }
        if (batch === MAX_DAG_BATCHES) {
          // A planner that keeps saying "more" past this is not decomposing, it
          // is enumerating. Better a named failure than an unbounded spend.
          reason = `the breakdown was still unfinished after ${MAX_DAG_BATCHES} messages (${tasks.length} tasks so far) — it is too large to plan in one pass`;
          break;
        }
      }

      lastReason = this.failedAttempt(runId, attempt, reason, lastPath, outcome, errorDetail);
    }
    throw this.planFailed(runId, attempts, lastReason, lastPath);
  }

  /**
   * One planner message, or the reason its session died trying.
   *
   * Both planning phases retry — a rejected plan is nearly always a shape
   * problem the next attempt fixes — but that only ever covered output the
   * planner *returned*. A session that died mid-message threw straight past the
   * retry loop and out of `startRun`, ending the run with `harness: fatal` and
   * discarding everything the intake and PRD phases had already paid for. A
   * crash is a worse attempt than a bad plan, not a different kind of event.
   *
   * The budget is the one exception: it is the operator's cap, deliberately
   * reached, and retrying it would spend three times over the number they set.
   */
  private async plannerMessage(spec: AgentSpec): Promise<AgentResult | { died: string }> {
    try {
      return await this.pool.run(spec);
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      return { died: `the planner session died before it answered: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` };
    }
  }

  /** One message of the DAG, or the reason it was unusable. */
  private readBatch(text: string, truncated: boolean): { batch: PlanBatch } | { reason: string } {
    let json: unknown;
    try {
      json = extractJson(text);
    } catch (e) {
      return {
        reason: truncated
          ? "the breakdown ran past the output-token limit and was cut off mid-JSON — it is too long to emit in one message"
          : // Only `extractJson` and `JSON.parse` throw in here, and both throw
            // Errors — the String() arm is for a future throw that does not.
            /* v8 ignore next */
            `the breakdown JSON could not be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`,
      };
    }
    const parsed = PlanBatch.safeParse(json);
    return parsed.success ? { batch: parsed.data } : { reason: `the breakdown does not match the required shape: ${issueSummary(parsed.error)}` };
  }

  /** Record a rejected planner attempt; returns the reason the next attempt is told. */
  private failedAttempt(runId: string, attempt: number, reason: string, rawPath: string, outcome: string, errorDetail?: string): string {
    if (outcome !== "done" && errorDetail) reason += ` (the session also ended abnormally: ${errorDetail})`;
    this.bus.publish({ type: "run.plan_attempt_failed", runId, attempt, reason, rawPath, ts: Date.now() });
    return reason;
  }

  private planFailed(runId: string, attempts: number, reason: string, rawPath: string): Error {
    const detail = `${attempts} planner attempts rejected — ${reason}. Raw output: ${rawPath}`;
    this.store.transitionRun(runId, "FAILED", detail);
    return new Error(detail);
  }

  /** Persist one planner attempt verbatim; returns the path for the error message. */
  private saveAttempt(dir: string, attempt: string, text: string): string {
    const file = path.join(dir, `planner-attempt-${attempt}.txt`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
    } catch {
      return "(could not be written)";
    }
    return file;
  }

  private persistPlan(runId: string, plan: Plan): void {
    const run = this.store.getRun(runId)!;
    const dir = path.join(this.repoPath, ".harness", runId);
    mkdirSync(dir, { recursive: true });
    const prdPath = path.join(dir, "PRD.md");
    writeFileSync(prdPath, plan.prdMarkdown);
    writeFileSync(path.join(dir, "CONVENTIONS.md"), plan.conventionsMarkdown);
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan, null, 2));
    // SEC-13: hash what will be approved; the build consumes exactly this version.
    const planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
    this.store.setRunPlan(runId, prdPath, planHash);
    this.store.insertTasks(
      runId,
      plan.epics.map((e) => ({ id: e.id, title: e.title })),
      plan.tasks.map(pendingRow)
    );
    void run;
  }

  private planPrd(runId: string): string {
    const run = this.store.getRun(runId)!;
    return run.prdPath ? readFileSync(run.prdPath, "utf8") : "";
  }

  /**
   * The plan as the operator approves it, with what it is likely to cost.
   *
   * The estimate goes here rather than anywhere later because this is the last
   * moment it can change a decision: after approval the only cost signal is a
   * budget gate, which arrives as an interruption with the money already spent.
   */
  private planSummary(runId: string): string {
    const run = this.store.getRun(runId)!;
    const tasks = this.store.listTasks(runId);
    const lines = tasks.map((t) => `- [${t.id}] ${t.title} (deps: ${t.dependsOn.join(", ") || "none"})`).join("\n");
    const estimate = estimatePlan(tasks, this.store.runCosts(runId));
    // What the plan intends to fake, before anyone is paid to build it. Empty
    // when every external task pins a real sandbox, which is the common case on
    // a plan that does not have this problem.
    const integrations = renderIntegrations(scanIntegrations(tasks));
    // And what it has no task for at all. The brief is the assignment plus the
    // PRD written from it, because the operator's own words are the only thing
    // that can say whether this product was ever meant to deploy or have a login.
    const production = renderProduction(scanProduction(`${run.assignment}\n${this.planPrd(runId)}`, tasks));
    // And whether the plan builds the one check that will ever see the merged
    // branch. This takes no brief: nothing has to ask for CI, so unlike the two
    // above it reads only the plan.
    const ci = renderCi(scanCi(tasks));
    return [lines, renderEstimate(estimate, run.config.budget.runCapUsd), integrations, production, ci].filter(Boolean).join("\n\n");
  }

  private async fileIssues(runId: string): Promise<void> {
    if (!this.github.enabled) return;
    for (const task of this.store.listTasks(runId)) {
      const issue = await this.github.ensureIssue(
        runId,
        task.id,
        task.title,
        `${task.spec}\n\n**Acceptance criteria**\n${task.acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}`,
        ["harness"]
      );
      if (issue) {
        this.store.updateTask(runId, task.id, { githubIssueNumber: issue.number });
        this.bus.publish({ type: "github.issue_created", runId, taskId: task.id, issueNumber: issue.number, url: issue.url, ts: Date.now() });
      }
    }
  }

  // ---- execution ----

  private async execute(runId: string): Promise<"complete" | "pitstop" | "operator"> {
    const run = this.store.getRun(runId)!;
    await this.wt.ensureIntegrationBranch(runId);
    // The forge dir rides alongside the operator's dirs for task-level roles:
    // skills earlier runs forged for this repository are already paid for.
    // Deduped by realpath inside indexSkills, so an operator who added the
    // forge to `skillsDirs` themselves indexes it once.
    const skills = indexSkills([...run.config.skillsDirs, forgeDir(this.repoPath)]);

    // A task still marked in-flight here belongs to a harness process that died
    // mid-task: this controller is the only runner, so nothing can actually be
    // WORKING or in QA when the loop starts. Requeue it — its worktree still
    // holds every committed iteration — rather than leaving a state the
    // scheduler would eventually cancel as unreachable.
    for (const t of this.store.listTasks(runId)) {
      if (t.state === "WORKING" || t.state === "QA" || t.state === "QA_FAILED" || t.state === "ACCEPTED") {
        this.revivalGuidance.set(
          `${runId}/${t.id}`,
          t.state === "ACCEPTED"
            ? // Its work is done and QA already passed it; what did not finish is
              // the merge. Saying so keeps the worker from re-deriving a task it
              // has already completed, and the loop it re-enters ends in the
              // integrate() call that was interrupted.
              "The previous session for this task was interrupted (the harness process died) after QA accepted the work but before it merged into the integration branch. The work in this worktree is complete and already passed QA — inspect git log first, confirm it is still what the task asked for, and do not rewrite it."
            : "The previous session for this task was interrupted (the harness process died mid-task). Inspect git log in this worktree first: earlier iterations may already contain most or all of the work — verify it and finish."
        );
        this.store.transitionTask(runId, t.id, "READY", "requeued: the previous harness process died mid-task");
      }
    }

    // PRD §11.5 scheduler: ready = PENDING with every dependency MERGED (its
    // worktree then branches from an integration branch that really contains
    // the dependency's commits); dispatch while running < maxParallelWorkers.
    // Merges, main-repo git ops and the budget gate are each serialized behind
    // their own mutex, so parallel tasks contend only where they must.
    const cap = Math.max(1, run.config.maxParallelWorkers);
    const terminal = (s: TaskState) => ["MERGED", "NEEDS_HUMAN", "CANCELLED"].includes(s);
    const inFlight = new Map<string, Promise<void>>();
    // What this repository ships together, read once for the whole loop. It is
    // history, not state: nothing the run does changes it, and re-reading it per
    // dispatch would spend a `git log` to learn the same thing. A repo with no
    // usable history returns an index that widens nothing.
    const nearby = await coChangeIndex(this.repoPath);
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "scheduler",
      text: coChangeNote(nearby),
      ts: Date.now(),
    });
    let runStop: RunStop | null = null;
    /**
     * Slots in use. A task waiting at a gate is in flight but is not running an
     * agent, so it does not count.
     *
     * `maxParallelWorkers` is a bound on concurrent *agents* — how much of the
     * machine and the API the run may use at once — and a task blocked on a
     * human is using neither. Counting it anyway is how run 40da9337 spent half
     * an hour at one-third throughput: 21 merged, 12 pending, three slots, and
     * two of the three held by tasks that had been waiting on an answer since
     * 23:18. $13 in 29 minutes to run one worker.
     *
     * The cost is a transient overshoot: a task whose gate is answered resumes
     * immediately rather than queueing for a slot, so for as long as it takes the
     * replacement task to reach its next await, the run can be one worker over
     * cap per gate answered at once. Making it queue instead would put the
     * answered task — the one the operator is waiting on, with a warm worktree —
     * at the back of the line, which is the bug this fixes wearing a hat.
     */
    const working = () => [...inFlight.keys()].filter((id) => !this.gatedTasks.has(id)).length;

    for (;;) {
      // A pit stop due while work is in flight stops *dispatching* and waits:
      // the operator is being shown a product, and a tree with three workers
      // half-way through their tasks is not one. Nothing is cancelled — the
      // in-flight tasks finish, and the stop happens on the next pass.
      // An operator pause is a run-wide stop like a reached cap, and is handled
      // as one: stop dispatching, let the in-flight tasks fall out (their own
      // `checkStops` is throwing at them already), and settle below. Setting it
      // here rather than only in the catch is what makes a pause work when
      // nothing is in flight at all — every task gated, or the loop idling
      // between dispatches, which is exactly when an operator is most likely to
      // decide they are done for the day.
      if (this.pauseAsked.has(runId)) runStop = runStop ?? new RunPaused(runId);
      const due = runStop ? null : this.pitStopReason(runId);
      if (due && !inFlight.size) {
        await this.issueSync;
        if ((await this.pitStop(runId, due)) === "stop") return "pitstop";
        continue;
      }
      // Fill capacity. Re-listed per dispatch: a task that just merged may have
      // unblocked its dependents. Which runnable task goes next is `nextDispatch`
      // — the order decides what a budget cap leaves unbuilt.
      while (!runStop && !due && working() < cap) {
        const tasks = this.store.listTasks(runId);
        const ready = nextDispatch(tasks, new Set(inFlight.keys()), nearby.widen);
        if (!ready) break;
        if (ready.state === "PENDING") this.store.transitionTask(runId, ready.id, "READY");
        const id = ready.id;
        const flight = this.runTask(runId, id, skills)
          .catch((e) => {
            // One task's unexpected crash must not abandon the rest of the run:
            // park it for the operator and keep driving. A ceiling reached is
            // run-wide — remember it, stop dispatching, and let the other
            // in-flight tasks drain (their own checks stop them fast). Either
            // ceiling: the run's dollar cap, or the account's plan, which every
            // task in flight is spending just as surely.
            if (stopsTheRun(e)) {
              runStop = runStop ?? (e as RunStop);
              return;
            }
            const t = this.store.getTask(runId, id)!;
            if (t.state !== "NEEDS_HUMAN" && t.state !== "CANCELLED" && t.state !== "MERGED") {
              this.park(runId, id, `crashed: ${String(e).slice(0, 300)}`);
            }
          })
          .finally(() => {
            inFlight.delete(id);
            // Every path out of runTask lands here with the task in its terminal
            // state — merged, parked or crashed-then-parked — so this is the one
            // place that has to say so on the issue.
            this.queueIssueSync(runId, id);
          });
        inFlight.set(id, flight);
      }

      if (inFlight.size) {
        // Woken by a task finishing *or* by something outside this loop changing
        // what is runnable — a gate opening (which frees a slot), a gate closing,
        // or an operator reviving a parked task. Waiting only on completions is
        // how four tasks revived at 20:32 sat READY for eighteen minutes with two
        // of three slots idle, because the one task still running had not
        // finished its worker→QA→worker loop yet.
        await Promise.race([...inFlight.values(), this.schedulerChanged()]);
        continue;
      }
      // Nothing left to dispatch: let the queued issue updates land before this
      // returns or throws, or a budget stop ends the process with the tracker
      // still claiming every task is untouched.
      await this.issueSync;
      // A pause is the one run-wide stop that is not a failure and asks the
      // operator for nothing, so it returns rather than throws: there is no gate
      // to open and no cap to raise, and the caller parks the run and stops.
      if (runStop instanceof RunPaused) return "operator";
      if (runStop) throw runStop;

      const tasks = this.store.listTasks(runId);
      if (tasks.every((t) => terminal(t.state))) break;
      // Nothing runnable, nothing in flight: whatever is left waits on parked
      // or cancelled dependencies and can never start.
      for (const t of tasks) {
        if (terminal(t.state)) continue;
        // The backstop for a state this sweep cannot legally cancel. An accepted
        // task is the one that got here: it waits on nothing but its own merge,
        // so "unreachable" was already the wrong word, and ACCEPTED -> CANCELLED
        // is not a transition — the attempt threw, and the throw took the whole
        // run down rather than the one task (run bc691359, `m1-exit-evidence`,
        // with sixty-odd merged tasks behind it). The requeue at the top of this
        // loop now claims those before they reach here, so nothing should; what
        // must never happen again is a sweep that ends a run by cancelling
        // something it may not. Park it — the work exists and passed QA.
        /* v8 ignore next */
        if (t.state === "ACCEPTED") this.park(runId, t.id, "accepted by QA, but the run ended before the work merged into the integration branch");
        else this.store.transitionTask(runId, t.id, "CANCELLED", "unreachable: dependencies parked");
        this.queueIssueSync(runId, t.id);
      }
      break;
    }
    await this.issueSync;
    return "complete";
  }

  // ---- pit stops (docs/PITSTOP.md) ----

  /**
   * Is a pit stop due, and why? Null when they are switched off, when this gate
   * handler cannot ask (headless and test contexts — see `resolvePitStop`), or
   * when no boundary has been crossed since the last one.
   */
  private pitStopReason(runId: string): PitStopDue | null {
    const run = this.store.getRun(runId)!;
    if (!this.gates.resolvePitStop) return null;
    // The operator's own request outranks the cadence, and outranks switching
    // the cadence off. `{"every":"never"}` is an answer to "stop me at every
    // epic boundary" — it was never an answer to "I want to look at this now",
    // and a run that ignored the button because of a config the operator set
    // last week would be unusable exactly when they had reason to care.
    const asked = this.store.pendingPitStopRequest(runId);
    if (asked) {
      // No `epicIds`: this stop covers no epic boundary, and claiming one would
      // silently cancel the real pit stop that epic is owed — the same reason
      // `resumePitStop` leaves it empty.
      return {
        reason: "you asked for a look at the product",
        epicIds: [],
        question: asked.question,
        askedAt: asked.ts,
      };
    }
    if (run.config.pitStop.every === "never") return null;
    const merged = this.store.mergedTaskIds(runId);
    return pitStopDue(
      run.config.pitStop.every,
      this.store.listEpics(runId),
      this.store.listTasks(runId),
      { spentUsd: this.store.spentUsd(runId), nowMs: Date.now(), mergedCount: merged.length },
      this.store.pitStopHistory(runId, run.createdAt)
    );
  }

  /**
   * Stop, show the operator the product running, and do what they say.
   *
   * The order is deliberate: demo first, reviewers second, and the reviewers
   * read the demo. A reviewer that has only read the diff is producing the same
   * artifact the plan gate already produced — an opinion about a description.
   */
  private async pitStop(
    runId: string,
    due: PitStopDue,
    askOperator = false,
    opts: { demo?: boolean } = {}
  ): Promise<PitStopDecision["action"]> {
    const withDemo = opts.demo !== false;
    // A question means the operator stopped the run to ask it, and three things
    // follow from that: the demo drives what they asked about first, every lens
    // is bought rather than staged, and the decision comes back to them. See
    // each of those call sites for why.
    const question = (due.question ?? "").trim();
    const run = this.store.getRun(runId)!;
    const tasks = this.store.listTasks(runId);
    const history = this.store.pitStopHistory(runId, run.createdAt);
    const number = history.count + 1;
    const dir = path.join(this.repoPath, ".harness", runId, "pitstops", String(number));
    mkdirSync(dir, { recursive: true });

    const byId = new Map(tasks.map((t) => [t.id, t]));
    const mergedIds = this.store.mergedTaskIds(runId);
    const line = (t: TaskRow) => `${t.title} (${t.id})`;
    const mergedSince = mergedIds.slice(history.mergedAt).map((id) => byId.get(id)).filter((t): t is TaskRow => Boolean(t)).map(line);
    const upcoming = tasks.filter((t) => t.state === "PENDING" || t.state === "READY").map(line);
    const parked = tasks.filter((t) => t.state === "NEEDS_HUMAN").map((t) => `${line(t)} — ${t.errorSummary ?? this.store.taskStateReason(runId, t.id)}`);
    const cancelled = tasks.filter((t) => t.state === "CANCELLED").map((t) => `${line(t)} — ${this.store.taskStateReason(runId, t.id)}`);
    const allMerged = mergedIds.map((id) => byId.get(id)).filter((t): t is TaskRow => Boolean(t)).map(line);

    const spentUsd = this.store.spentUsd(runId);
    // What the rest of the plan looks like at the rate the finished tasks set.
    // Crude on purpose — the operator needs "this is heading for $600" long
    // before they need a good estimate of exactly how much over it will be.
    const done = tasks.filter((t) => ["MERGED", "NEEDS_HUMAN", "CANCELLED"].includes(t.state)).length;
    const projectedUsd = done > 0 ? (spentUsd / done) * tasks.length : spentUsd;

    // A stop with no demo runs no agents at all, so it costs nothing and opens
    // instantly — which is the only reason it is safe to put one in front of
    // every `harness resume`, including the resume of a run already at its cap.
    const demo = withDemo ? await this.runDemo(runId, run, number, dir, allMerged.join("\n") || "(nothing yet)", upcoming.join("\n"), question) : null;
    const reviewed = demo
      ? // Every lens, on a stop the operator asked for. The staging in
        // `runReviews` bets that a first pass agreeing the run is on track has
        // already given the answer, and that bet is only good when nothing
        // outside the report suggested there was something to find. Here
        // something did: a person watched this run and stopped it. That is a
        // stronger signal than any of the conditions `worthMoreLenses` fires
        // on, and it arrived before the first lens was bought.
        await this.runReviews(runId, run, demo, tasks, upcoming.join("\n"), { allLenses: Boolean(question) })
      : { reviews: [], skipped: [] };
    // Measured rather than estimated, and shown: a checkpoint whose price is
    // invisible is one the operator cannot decide they do not want.
    const afterUsd = this.store.spentUsd(runId);

    const stop: PitStop = {
      runId,
      number,
      reason: due.reason,
      demo,
      reviews: reviewed.reviews,
      skippedReviewers: reviewed.skipped,
      merged: mergedSince,
      upcoming,
      parked,
      cancelled,
      spentUsd: afterUsd,
      capUsd: run.config.budget.runCapUsd,
      stopCostUsd: afterUsd - spentUsd,
      projectedUsd,
      intent: this.store.intentVerdict(runId),
      artifactsDir: dir,
      markdown: "",
    };
    stop.markdown = renderPitStop(stop);
    writeFileSync(path.join(dir, "REPORT.md"), `${stop.markdown}\n`);
    writeFileSync(path.join(dir, "pitstop.json"), JSON.stringify(stop, null, 2));

    this.bus.publish({
      type: "run.pitstop_opened",
      runId,
      stop: number,
      reason: due.reason,
      epicIds: due.epicIds,
      mergedCount: mergedIds.length,
      spentUsd: afterUsd,
      artifactsDir: dir,
      // False for a stop that ran no demo, which is what "nothing was started"
      // means — the event carries `reason` for anyone who needs to tell the two
      // kinds of not-started apart.
      demoStarted: demo?.started ?? false,
      // Publishing this is what consumes the operator's request: `pendingPitStopRequest`
      // treats any `run.pitstop_opened` as the end of a pending one. It is
      // deliberately published here, after the demo and the reviewers, rather
      // than when the stop was picked up — a process that dies mid-demo has not
      // answered the question, and the request should survive to be answered by
      // whatever restarts the run.
      summoned: Boolean(question),
      // Which request this stop retires. Without it the publish below retires
      // whatever is pending *now*, which after a twenty-minute demo is not
      // necessarily the question this stop was picked up to ask.
      askedAt: due.askedAt ?? 0,
      ts: Date.now(),
    });

    const { decision, decidedBy, why } = await this.decidePitStop(runId, run, stop, askOperator, question);
    // The report is the artifact anyone reads afterwards, and until now it
    // stopped at the evidence. What was decided on it, by whom, and what that
    // cost belong in the same file — a decision recorded only as an event is
    // one nobody finds when they open the pit stop that made it.
    appendFileSync(
      path.join(dir, "REPORT.md"),
      `\n## Decision — ${decision.action}${decision.blockedOn ? `, blocked on ${decision.blockedOn}` : ""}\n\nDecided by: ${decidedBy}` +
        `${decidedBy === "operator" ? "" : ` ($${(this.store.spentUsd(runId) - afterUsd).toFixed(2)})`}\n` +
        `${why ? `\n${why}\n` : ""}${decision.feedback.trim() ? `\nWhat the run was told:\n\n${decision.feedback.trim()}\n` : ""}`
    );
    const touched = await this.applyPitStop(runId, decision);
    this.bus.publish({
      type: "run.pitstop_resolved",
      runId,
      stop: number,
      action: decision.action,
      // Not truncated. The 2000-character cap that used to be here cut the
      // decision mid-sentence, and the event is the only copy anything reads
      // programmatically — `harness diagnose`, the dashboard, and anyone
      // querying the store go here, not to REPORT.md. On waf-adjacent run
      // 6dfc504b it severed the third of three blocking questions a reviewer
      // had written for the operator, and a decision that reads as two
      // questions when it was three is worse than one that is obviously
      // missing. Length is bounded by what a decider writes, and a stop is
      // rare; there is nothing here worth protecting a few kilobytes from.
      feedback: decision.feedback,
      tasks: touched,
      decidedBy,
      why: why.slice(0, 500),
      blockedOn: decision.blockedOn ?? "",
      ts: Date.now(),
    });
    await this.sweepRunResources(runId, `pit stop ${number}`);
    return decision.action;
  }

  /**
   * Give the machine back, at every pit stop.
   *
   * A pit stop is the one moment in a run when nothing is mid-flight: the
   * operator has just answered, no worker is dispatched yet, and everything a
   * finished task started is by definition finished with. It is the only place
   * a sweep is both safe and worth doing.
   *
   * What accumulates is real. Agents are told to tear down what they start and
   * a session that hits its turn ceiling, dies, or is killed by the budget gate
   * never gets to; run 40da9337 ended with 37 orphaned processes across five
   * already-merged worktrees, two of them thirteen hours old, all still writing
   * to a database the live tasks were reading. Containers are worse than
   * processes because they hold ports and volumes as well as memory, and a
   * thirty-task run leaves thirty stacks behind.
   *
   * Nothing here can touch anything that is not this run's: compose projects
   * are named from this run's own task ids, and the process sweep is confined
   * to this run's worktree directory. Failures are logged and swallowed —
   * reclaiming disk is not worth ending a run over.
   */
  private async sweepRunResources(runId: string, why: string): Promise<void> {
    const tasks = this.store.listTasks(runId);
    // Every task's stack, plus the pit stops' own — the demo agent starts the
    // product too, and under a project of its own.
    const projects = [
      ...tasks.map((t) => taskIsolation(runId, t.id).composeProject),
      ...Array.from({ length: this.store.pitStopHistory(runId, 0).count + 1 }, (_, i) => taskIsolation(runId, `pitstop-${i + 1}`).composeProject),
    ];
    const [stacks, processes] = await Promise.all([
      composeDown(projects, async (bin, args, timeoutMs) => (await execFileP(bin, args, { timeout: timeoutMs })).stdout).catch(() => [] as string[]),
      reapUnder(path.join(this.wt.worktreeRoot(), runId)).catch(() => [] as unknown[]),
    ]);
    await this.wt.pruneAndReconcile().catch(() => undefined);
    if (!stacks.length && !processes.length) return;
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "integrator",
      text:
        `swept after ${why}: ` +
        [
          stacks.length ? `${stacks.length} container stack${stacks.length === 1 ? "" : "s"} still up and brought down (${stacks.slice(0, 5).join(", ")}${stacks.length > 5 ? ", …" : ""})` : "",
          processes.length ? `${processes.length} orphaned process${processes.length === 1 ? "" : "es"} killed` : "",
        ]
          .filter(Boolean)
          .join("; "),
      ts: Date.now(),
    });
  }

  /**
   * The pit stop between the intent verdict and the first pull request.
   *
   * It fires on a FAIL whatever the configured interval says (PITSTOP.md S6).
   * Run ec40b527's validator was right about a broken endpoint seam and right
   * that it had not looked for more of the same; both facts were printed once,
   * at the end, to a terminal that had scrolled, and were rediscovered by a
   * human hours later. A verdict the operator has to be lucky to read is not a
   * verdict that was delivered.
   */
  private async closingPitStop(runId: string): Promise<"proceed" | "stop" | "back-to-work"> {
    const run = this.store.getRun(runId)!;
    if (!this.gates.resolvePitStop || run.config.pitStop.every === "never") return "proceed";
    const verdict = this.store.intentVerdict(runId);
    if (verdict?.verdict !== "FAIL") return "proceed";
    // Only for a verdict nobody has been shown: a resumed run re-entering
    // integration must not re-open the same pit stop it already answered.
    //
    // Summoned stops are excluded, and that exclusion is the whole reason this
    // reads `lastUnsummonedPitStopSeq` rather than the event type. An operator
    // who asks a question after a FAIL verdict has been shown *their* question's
    // answer, not the verdict — and letting that suppress the closing stop would
    // break the one guarantee this pit stop exists to keep (PITSTOP.md S6:
    // "runs whose closing report is the first sight of a FAIL verdict → 0").
    if (this.store.lastUnsummonedPitStopSeq(runId) > this.store.lastEventSeq(runId, "run.intent_verdict")) return "proceed";
    // This is the pit stop that repeats: "back to work" returns the run to the
    // same verdict on a tree it has already judged, and one verdict per pass
    // means the count of them is the count of goes it has had. A person
    // answering this loop ends it by losing patience; nothing else does, so
    // past the bound the decision goes to a person whether or not `decidedBy`
    // names one.
    const rounds = this.store.eventCount(runId, "run.intent_verdict");
    const spent = rounds > run.config.pitStop.backToWorkRounds;
    if (spent) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "pitstop",
        text:
          `the intent check has come back FAIL ${rounds} times and the run has been sent back to work ${rounds - 1} of them — ` +
          `past ${run.config.pitStop.backToWorkRounds}, so this one is yours to answer`,
        ts: Date.now(),
      });
    }
    const action = await this.pitStop(runId, { reason: "the intent check came back FAIL", epicIds: [] }, spent);
    if (action === "stop") return "stop";
    // Redirect and replan both put work back in the queue; continuing from here
    // with tasks pending would open a pull request over an unfinished tree.
    return action === "continue" ? "proceed" : "back-to-work";
  }

  /**
   * The pit stop `harness resume` opens on a parked run, before it dispatches
   * anything. Returns true if the operator parked it again.
   *
   * No demo and no reviewers, so it is free and instant. That is the point: the
   * run this exists for was parked *at* its budget cap, and a checkpoint that
   * costs $9 to open is one an operator at their cap cannot afford to look at.
   * What it shows is what the run already knows — merged, queued, parked,
   * cancelled, spend — and what it offers is the full set of pit stop actions,
   * which is the part `resume` never had.
   *
   * Always the operator's to answer, whatever `pitStop.decidedBy` names: a
   * skill deciding is a bound on how long a run waits for an absent human, and
   * a human who has just typed `harness resume` is not absent.
   */
  private async resumePitStop(runId: string): Promise<boolean> {
    const run = this.store.getRun(runId)!;
    // Before the stop opens, so the budget gate has a state to hold (it only
    // holds EXECUTING and INTEGRATING) and the dashboard shows the run live
    // while the operator is being asked.
    this.store.transitionRun(runId, "EXECUTING", "resumed after a pit stop");
    // Nobody to ask — a daemon or a test. Resuming then means what it has
    // always meant: run what is queued.
    //
    // The other two stop triggers pair this with `pitStop.every === "never"`;
    // here that half cannot be false. A run only reaches PAUSED by an operator
    // answering "stop" at a pit stop, and a run with pit stops switched off
    // never opens one to answer. Carrying the check anyway would read as a
    // second way for this to return early when there is only one.
    if (!this.gates.resolvePitStop) return false;
    // `epicIds` stays empty: this stop demoes no epic, and marking one demoed
    // here would silently cancel the real pit stop that epic is owed.
    const action = await this.pitStop(runId, { reason: "you resumed a run that was parked at a pit stop", epicIds: [] }, true, { demo: false });
    if (action !== "stop") return false;
    this.store.transitionRun(runId, "PAUSED", "the run was stopped at a pit stop");
    return true;
  }

  /**
   * Start the half-built product and drive it.
   *
   * Runs in the integration worktree, which is the only tree that holds every
   * merged task. The demo agent is allowed to install, build and start things —
   * that is the job — so the worktree is put back exactly as it was afterwards,
   * whatever it did to it.
   */
  private async runDemo(
    runId: string,
    run: RunRow,
    number: number,
    dir: string,
    mergedLines: string,
    upcomingLines: string,
    /** The operator's question, when they are the reason this stop is happening. */
    question = ""
  ): Promise<DemoReport> {
    let wtPath: string | null = null;
    let head = "";
    // Overwritten on both paths below. It starts as the failure report because
    // that is what an unfinished demo *is*, and because a pit stop that cannot
    // demo anything must still open. Held as findings rather than a full report:
    // the coverage on it is the one `demoUnavailable` supplies, and the real one
    // is not known until the evidence gate has run.
    let report: DemoFindings = demoUnavailable("the demo agent did not run");
    let checks: EvidenceCheck[] = [];
    let commandChecks: CommandCheck[] = [];
    try {
      wtPath = await this.wt.ensureIntegrationWorktree(runId);
      head = (await git(wtPath, ["rev-parse", "HEAD"])).trim();
      const skills = this.selectSkills(indexSkills(run.config.skillsDirs), "demo", run.assignment, run.config);
      const common = {
        runId,
        role: "demo" as const,
        model: run.config.models.demo,
        systemPrompt: demoSystemPrompt(dir, toolbeltBlock(detectToolbelt(run.config.externalTools)), skillsBlock(skills)),
        skills: skills.map((s) => s.name),
        cwd: wtPath,
        disallowedTools: ["WebSearch"],
        // Its own port block and compose project, like a task worktree — a demo
        // must not collide with whatever the operator has running.
        env: isolationEnv(taskIsolation(runId, `pitstop-${number}`)),
        budgetCheck: () => this.checkStops(runId),
      };
      const result = await this.pool.run({
        ...common,
        prompt: demoPrompt(run.assignment, mergedLines, upcomingLines, question),
        maxTurns: run.config.pitStop.demoMaxTurns,
        // The product stays up between the two attempts below — re-capturing a
        // blank screenshot against a torn-down stack is not a retry, it is a
        // second demo. The sweep runs from this method's `finally` instead.
        reapOnEnd: false,
      });
      report = DemoJson.parse(extractJson(result.resultText));
      checks = this.inspectDemoEvidence(dir, report);

      // One resumed turn, and only when a retake could plausibly fix it. The
      // expensive half of a demo is standing the product up, and that is
      // already paid for; what is being bought here is the screenshot the
      // operator was going to be handed blank.
      if (retryableFaults(checks) && result.outcome === "done" && result.sdkSessionId) {
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: result.sessionId,
          text: `evidence rejected, asking the demo agent again: ${evidenceFaults(checks).join("; ").slice(0, 500)}`,
          ts: Date.now(),
        });
        const retry = await this.pool.run({
          ...common,
          prompt: demoEvidenceReaskPrompt(evidenceFaults(checks)),
          resume: result.sdkSessionId,
          maxTurns: EVIDENCE_REASK_TURNS,
        });
        // A re-ask that comes back unparseable leaves the first report standing:
        // its journeys are real findings, and losing them to a failed retake of
        // a screenshot would be a worse trade than the blank file was.
        try {
          const second = DemoJson.parse(extractJson(retry.resultText));
          report = second;
          checks = this.inspectDemoEvidence(dir, second);
        } catch {
          // keep the first report and its checks
        }
      }
      // Before the stack comes down in `finally`: a claim like "the health
      // endpoint returns 200" is only checkable while the product it was made
      // about is still running.
      commandChecks = await this.verifyDemoCommands(runId, wtPath, report);
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      report = demoUnavailable(String(e).slice(0, 300));
      checks = [];
      commandChecks = [];
    } finally {
      // It starts servers, emulators and databases by design. Nothing it
      // started outlives the pit stop — including across a re-ask that never
      // happened, or one that crashed.
      if (wtPath) await reapUnder(wtPath).catch(() => []);
      // Whatever it changed in the tree goes back. The demo agent is told not to
      // touch source, but "told not to" is not a mechanism, and the diff the
      // operator eventually reviews is not the demo's to edit.
      if (wtPath) await git(wtPath, ["reset", "--hard", head]).catch(() => "");
    }
    // Whatever survived the second look is what the operator is shown as
    // evidence; the rest is filed under what this pit stop did not verify.
    const withFiles = checks.length ? strikeEvidence(report, checks) : report;
    const verified = commandChecks.length ? strikeCommands(withFiles, commandChecks) : withFiles;
    // Coverage is read from the *struck* report, after the evidence gate, not
    // from what the agent claimed. A demo whose every screenshot came back blank
    // reached its journeys and proved none of them, and the number that decides
    // whether the expensive reviewers are worth buying has to be the one that
    // survived checking.
    const coverage = demoCoverage(verified);
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: `pitstop-${number}`,
      text: `demo coverage: ${coverage.status} — ${coverage.why}`,
      ts: Date.now(),
    });
    return { ...verified, coverage };
  }

  /**
   * How many of a demo's claimed commands the harness will repeat.
   *
   * Each one can be a full test suite, and a demo that lists a dozen would turn
   * a checkpoint into a second CI run. Anything past the cap is reported as
   * unverified rather than quietly dropped — a truncated list that reads as a
   * complete one is the failure this whole module exists to stop.
   */
  private static readonly MAX_VERIFIED_COMMANDS = 6;

  /**
   * Run the demo's own claimed commands again, in the worktree it ran them in.
   *
   * "I ran the suite and it is green" has until now reached the operator as a
   * fact on the strength of an agent having typed it. The claims that survive
   * this are the ones a second run agreed with; the rest move to what the pit
   * stop could not check, with the command printed beside them so the operator
   * can run it themselves.
   */
  private async verifyDemoCommands(runId: string, wtPath: string, report: DemoFindings): Promise<CommandCheck[]> {
    const claims = report.commands;
    if (!claims.length) return [];
    const runnable = [...new Set(claims.map((c) => c.command.trim()).filter((c) => c && repeatable(c).ok))];
    const willRun = runnable.slice(0, RunController.MAX_VERIFIED_COMMANDS);
    const results = new Map<string, Rerun>();
    // Serially: these are suites, and a pit stop that runs six of them at once
    // on the machine the operator is using is its own kind of failure.
    for (const command of willRun) {
      const out = await runDeterministicChecks(wtPath, [command], this.store.getRun(runId)!.config.deterministicCheckTimeoutMinutes);
      results.set(command, { ok: out.ok, output: out.failures[0]?.output ?? "" });
    }
    if (runnable.length > willRun.length) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        text: `the demo claimed ${runnable.length} commands; the harness re-ran the first ${willRun.length} and reported the rest as unverified`,
        ts: Date.now(),
      });
    }
    return checkCommands(
      claims,
      (command) => results.get(command) ?? null,
      `the harness re-runs at most ${RunController.MAX_VERIFIED_COMMANDS} commands per pit stop, and this one was past that`
    );
  }

  /** Read every file the demo agent offered and decide which of them are evidence. */
  private inspectDemoEvidence(dir: string, report: DemoFindings): EvidenceCheck[] {
    return checkEvidence(report.artifacts, (file) => {
      // Confined to the pit stop's own directory: an agent that lists
      // `../../README.md` is not offering evidence it produced.
      const full = path.resolve(dir, file);
      if (full !== dir && !full.startsWith(dir + path.sep)) return null;
      try {
        return readFileSync(full);
      } catch {
        return null;
      }
    });
  }

  /**
   * One short session per lens, in parallel, each reading the demo — bought in
   * two passes.
   *
   * Named perspectives rather than one neutral summary: the drift a product lens
   * sees and the drift a QA lens sees are different failures, and a single
   * reviewer asked for both reliably returns neither. That is why there are
   * four, and it is also why they are expensive — four Opus sessions at every
   * epic boundary, bought before anyone has looked at what the demo said.
   *
   * Most of those purchases buy agreement. A healthy run's pit stop is four
   * lenses independently reporting that it is on track, which is the answer the
   * first two already gave. So the first `reviewFirstPass` lenses go first, and
   * the rest are bought only when there is reason to think they will find
   * something the first pass did not — see `worthMoreLenses` below.
   *
   * The lenses that were not bought are returned as well, marked, because a
   * report that quietly showed two opinions where the config promises four is
   * the same lie as an evidence list that quietly dropped its blank captures.
   */
  private async runReviews(
    runId: string,
    run: RunRow,
    demo: DemoReport,
    tasks: TaskRow[],
    upcomingLines: string,
    /**
     * Skip the staging and buy every lens. Set for a pit stop the operator
     * asked for: a person interrupting a run is a stronger reason to look
     * harder than anything `worthMoreLenses` can read off the first pass.
     */
    opts: { allLenses?: boolean } = {}
  ): Promise<{ reviews: ReviewReport[]; skipped: string[] }> {
    const lenses = run.config.pitStop.reviewers;
    if (!lenses.length) return { reviews: [], skipped: [] };
    const indexed = indexSkills(run.config.skillsDirs);
    const wtPath = await this.wt.ensureIntegrationWorktree(runId).catch(() => this.repoPath);
    const taskLines = tasks.map((t) => `- ${t.title} (${t.id}): ${t.state}`).join("\n");
    const demoText = JSON.stringify(demo, null, 2).slice(0, 6000);
    const prd = this.planPrd(runId);

    /** One lens. `finished` is false when the session died — see `worthMoreLenses`. */
    const runLens = async (lens: string): Promise<{ report: ReviewReport; finished: boolean }> => {
      try {
        // The lens is a skill name, so it is looked up by name rather than
        // scored: "review it as the product manager" and "review it as
        // whatever the matcher thinks product management sounds like" are not
        // the same instruction.
        const skills = indexed.filter((s) => s.name === lens && verifyHash(s));
        const result = await this.pool.run({
          runId,
          role: "reviewer",
          model: run.config.models.reviewer,
          systemPrompt: reviewerSystemPrompt(lens, toolbeltBlock(detectToolbelt(run.config.externalTools)), skillsBlock(skills)),
          skills: skills.map((s) => s.name),
          prompt: reviewerPrompt(lens, run.assignment, prd, demoText, taskLines, upcomingLines),
          cwd: wtPath,
          disallowedTools: ["Write", "Edit", "NotebookEdit", "WebSearch"],
          maxTurns: 30,
          budgetCheck: () => this.checkStops(runId),
        });
        return { report: { lens, ...ReviewJson.parse(extractJson(result.resultText)) }, finished: true };
      } catch (e) {
        if (stopsTheRun(e)) throw e;
        // A lens that failed is reported as a lens that failed. Dropping it
        // silently would show the operator two opinions and imply three.
        //
        // `finished: false` matters more than it used to: this report carries
        // the verdict `on-track` because there is no honest verdict to carry,
        // and letting a crashed session's placeholder suppress the second pass
        // would turn a transport error into a cheaper, quieter pit stop.
        return {
          report: { lens, verdict: "on-track", findings: [`(this reviewer did not finish: ${String(e).slice(0, 200)})`], question: "" },
          finished: false,
        };
      }
    };

    const firstPass = opts.allLenses ? 0 : run.config.pitStop.reviewFirstPass;
    // `0` disables staging, and so does a first pass that is not actually
    // smaller than the list — buying two of two and then "escalating" to the
    // remaining zero is just the old behaviour with extra bookkeeping.
    if (firstPass <= 0 || firstPass >= lenses.length) {
      const all = await Promise.all(lenses.map(runLens));
      return { reviews: all.map((r) => r.report), skipped: [] };
    }

    const head = lenses.slice(0, firstPass);
    const tail = lenses.slice(firstPass);
    const first = await Promise.all(head.map(runLens));
    const why = this.worthMoreLenses(demo, first);
    const say = (text: string) => this.bus.publish({ type: "agent.log", runId, sessionId: "pitstop", text, ts: Date.now() });

    if (!why) {
      say(`staged review: ${head.join(", ")} agreed the run is on track, so ${tail.join(", ")} were not run`);
      return { reviews: first.map((r) => r.report), skipped: tail };
    }
    say(`staged review: ${why} — buying ${tail.join(", ")} as well`);
    const second = await Promise.all(tail.map(runLens));
    return { reviews: [...first, ...second].map((r) => r.report), skipped: [] };
  }

  /**
   * Whether the rest of the lenses are worth their price, given what the first
   * pass came back with. Returns the reason, or empty for "no".
   *
   * Deliberately generous. Every condition here is a reason to spend, the
   * default is to spend, and only unanimous, finished, well-founded agreement
   * stops the second pass. The asymmetry is the point: the money this saves is
   * saved on the boring pit stops, and the drift a pit stop exists to catch is
   * worth more than every reviewer session it would ever skip.
   */
  private worthMoreLenses(demo: DemoReport, first: { report: ReviewReport; finished: boolean }[]): string {
    // Nothing the first pass says is well-founded if the demo it read was not.
    // This is the condition that ties the cheap demo to the expensive reviewers:
    // a Haiku demo that came back thin must not also buy a quieter review.
    if (demo.coverage.status !== "demonstrated") {
      return `the demo was ${demo.coverage.status} (${demo.coverage.why})`;
    }
    const unfinished = first.filter((r) => !r.finished).map((r) => r.report.lens);
    if (unfinished.length) return `${unfinished.join(", ")} did not finish, so nothing was learned from ${unfinished.length === 1 ? "it" : "them"}`;
    const off = first.filter((r) => r.report.verdict !== "on-track");
    if (off.length) return `${off.map((r) => `${r.report.lens} says ${r.report.verdict}`).join(" and ")}`;
    // Unanimous on-track by this point, so a disagreement can only be about
    // findings: a lens that reports the run on track *and* lists things wrong
    // with it has not settled anything the other lenses might not deepen.
    const withFindings = first.filter((r) => r.report.findings.length).map((r) => r.report.lens);
    if (withFindings.length) return `${withFindings.join(", ")} called it on-track but still had findings`;
    const asked = first.filter((r) => r.report.question).map((r) => r.report.lens);
    if (asked.length) return `${asked.join(", ")} had a question for the operator`;
    return "";
  }

  /**
   * Decide what the run does next — and say who decided.
   *
   * `pitStop.decidedBy` names a skill, and that skill reads the report the
   * operator would have read and answers the way the operator would have
   * answered. `"operator"` asks instead, which is what this always did.
   *
   * Falling back to asking is not a formality. A decider that crashed, ran out
   * of turns or answered with prose has not decided anything, and the four
   * actions are far too consequential to infer one from silence — `continue`
   * would spend the rest of the plan on a judgment nobody made, and `stop`
   * would park a healthy run because a session died. So the pit stop reverts to
   * the thing it has always been able to do: ask.
   */
  private async decidePitStop(
    runId: string,
    run: RunRow,
    stop: PitStop,
    askOperator = false,
    /**
     * The operator's question, when they are the reason this stop is happening.
     *
     * It changes both halves of this method. The decider is asked to answer it,
     * and — whatever `decidedBy` says — the operator is asked to confirm the
     * action rather than being told about it afterwards.
     */
    question = ""
  ): Promise<{ decision: PitStopDecision; decidedBy: string; why: string }> {
    const ask = async (why = "", by = "") => ({
      decision: await this.gates.resolvePitStop!(stop),
      decidedBy: by || "operator",
      why,
    });
    const skill = run.config.pitStop.decidedBy;
    if (skill === "operator" || askOperator) return await ask();

    const say = (text: string) => this.bus.publish({ type: "agent.log", runId, sessionId: "pitstop", text, ts: Date.now() });
    try {
      // Looked up by name, like a reviewer's lens: "decide this as the product
      // manager" and "decide this as whatever the matcher thinks this sounds
      // like" are not the same instruction.
      const skills = indexSkills(run.config.skillsDirs).filter((s) => s.name === skill && verifyHash(s));
      const cap = run.config.budget.runCapUsd;
      const result = await this.pool.run({
        runId,
        role: "pm",
        model: run.config.models.pm,
        systemPrompt: pitStopDeciderSystemPrompt(skill, toolbeltBlock(detectToolbelt(run.config.externalTools)), skillsBlock(skills)),
        skills: skills.map((s) => s.name),
        prompt: pitStopDeciderPrompt(
          run.assignment,
          this.planPrd(runId),
          stop.markdown,
          `The run has spent $${stop.spentUsd.toFixed(2)} of its $${cap.toFixed(2)} cap and the whole plan projects to about $${stop.projectedUsd.toFixed(2)}.\n\n`,
          priorDecisionsBlock(this.store.pitStopDecisions(runId)),
          question
        ),
        cwd: await this.wt.ensureIntegrationWorktree(runId).catch(() => this.repoPath),
        disallowedTools: ["Write", "Edit", "NotebookEdit"],
        maxTurns: 30,
        budgetCheck: () => this.checkStops(runId),
      });
      const parsed = PitStopDecisionJson.parse(extractJson(result.resultText));
      // A stop the operator asked for ends with them, not with the skill.
      //
      // `decidedBy` exists because a run that stops at 2am must not wait for a
      // human who is asleep. That argument does not survive the operator having
      // clicked the button thirty seconds ago: they are provably at the
      // keyboard, they interrupted a running plan to ask something, and the
      // answer they paid a demo and four lenses for is a thing to read before
      // the run acts on it. Deciding for them here would spend their money and
      // take the checkpoint they bought with it.
      //
      // So the skill still answers — its answer is the value, and it is written
      // into the report they are about to read — and the four actions stay
      // theirs. This is the only pit stop where both happen.
      if (question) {
        appendFileSync(
          path.join(stop.artifactsDir, "REPORT.md"),
          `\n## What the ${skill} says\n\n> ${question.replace(/\n+/g, "\n> ")}\n\n${parsed.why || "(no answer given)"}\n\n` +
            `**It would ${parsed.action}**${parsed.blockedOn ? `, blocked on ${parsed.blockedOn}` : ""}.` +
            `${parsed.feedback.trim() ? ` What it would tell the run:\n\n${parsed.feedback.trim()}\n` : "\n"}` +
            "\nThis is a recommendation. You asked for this stop, so the decision is yours.\n"
        );
        stop.markdown = readFileSync(path.join(stop.artifactsDir, "REPORT.md"), "utf8").trimEnd();
        say(`${skill} answered you and recommends ${parsed.action}${parsed.why ? ` — ${parsed.why}` : ""}; the decision is yours`);
        return await ask(parsed.why, `operator, advised by ${skill}`);
      }
      say(`${skill} decided: ${parsed.action}${parsed.blockedOn ? ` (blocked on ${parsed.blockedOn})` : ""}${parsed.why ? ` — ${parsed.why}` : ""}`);
      return {
        decision: { action: parsed.action, feedback: parsed.feedback, blockedOn: parsed.blockedOn },
        decidedBy: skill,
        why: parsed.why,
      };
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      say(`${skill} did not return a decision (${String(e).slice(0, 200)}) — asking you instead`);
      return await ask();
    }
  }

  /**
   * Do what the operator said. Returns the tasks their words reached, which is
   * what the resolved event records — "I redirected the run" and "I redirected
   * the run and it landed on nothing" have to be distinguishable afterwards.
   */
  private async applyPitStop(runId: string, decision: PitStopDecision): Promise<string[]> {
    const text = decision.feedback.trim();
    if (decision.action === "continue" || decision.action === "stop" || !text) return [];
    // Parked tasks are targets too. They are terminal for the scheduler, but not
    // for the operator: `harness resume` offers each one back, and a queued note
    // is waiting when it restarts. The alternative is that someone who writes
    // about the parked half of the product at a pit stop writes into nothing,
    // which is precisely the failure this whole feature exists to end.
    const open = this.store.listTasks(runId).filter((t) => !["MERGED", "CANCELLED"].includes(t.state));
    // A redirect with nothing left to redirect is the operator asking for work
    // that no queued task can carry — the only reading that does anything is a
    // re-plan, so do that rather than swallowing their words.
    if (decision.action === "replan" || !open.length) return await this.replan(runId, text);
    for (const t of open) {
      this.store.queueFeedback(runId, t.id, operatorFeedbackMessage(text));
      this.bus.publish({ type: "task.feedback", runId, taskId: t.id, text, delivery: "queued", ts: Date.now() });
    }
    return open.map((t) => t.id);
  }

  /**
   * Re-plan the work that has not started, in the light of what the operator
   * just saw (PITSTOP.md S3).
   *
   * Everything already built is immovable: merged tasks keep their ids, their
   * branches, their issues and their place in the DAG, and only PENDING tasks —
   * the ones no worker has ever touched — are replaced. A failure here falls
   * back to attaching the operator's words to the existing tasks, because
   * losing what they said is the one outcome worse than an unchanged plan.
   */
  private async replan(runId: string, words: string): Promise<string[]> {
    const run = this.store.getRun(runId)!;
    const tasks = this.store.listTasks(runId);
    const epics = this.store.listEpics(runId);
    const pending = tasks.filter((t) => t.state === "PENDING");
    const keep = tasks.filter((t) => t.state !== "PENDING");
    try {
      const result = await this.pool.run({
        runId,
        role: "planner",
        model: run.config.models.planner,
        systemPrompt: plannerBreakdownSystemPrompt(skillsBlock(this.planSkills(runId))),
          skills: this.planSkills(runId).map((s) => s.name),
        prompt: replanPrompt(
          run.assignment,
          this.planPrd(runId),
          keep.map((t) => `- ${t.id}: ${t.title} [${t.state}]`).join("\n") || "(nothing yet)",
          pending.map((t) => `- ${t.id}: ${t.title} — ${t.spec.slice(0, 200)}`).join("\n") || "(nothing)",
          words,
          epics.map((e) => `- ${e.id}: ${e.title}`).join("\n")
        ),
        cwd: this.repoPath,
        tools: ["Read", "Glob", "Grep"],
        maxTurns: 40,
        maxOutputTokens: await this.plannerOutputTokens(runId),
        budgetCheck: () => this.checkStops(runId),
      });
      const breakdown = PlanBreakdown.parse(extractJson(result.resultText));
      const epicUnion = [
        ...epics.map((e) => ({ id: e.id, title: e.title, summary: "" })),
        ...breakdown.epics.filter((e) => !epics.some((x) => x.id === e.id)),
      ];
      // A CANCELLED task still owns its id — a re-plan that reuses it would
      // take a real task's branch and issue history, so it stays in the graph
      // and the duplicate-id check keeps seeing it. Its `dependsOn` edges do
      // not survive with it. Cancelling a task never rewrote the graph around
      // it, so those edges routinely point at PENDING tasks, and a re-plan
      // drops PENDING tasks by design: validating the two together makes every
      // dropped task look like a dangling reference from a task that was never
      // going to run again, and throws out an otherwise valid plan whole.
      //
      // Run bc691359 hit this on its third re-plan attempt in a row. Six
      // cancelled tasks held edges into the queue; the planner returned exactly
      // what the operator asked for and the whole thing was refused with
      // `task ci-e2e-operator-journey depends on unknown task cp-embed-spa`.
      // The more of a run's history is cancelled, the less it can be re-planned
      // — which is backwards, since a run accumulates cancellations precisely
      // by being re-planned.
      const constraining = keep.map((t) => (t.state === "CANCELLED" ? { ...t, dependsOn: [] } : t));
      const errors = validatePlanDag({
        prdMarkdown: "x",
        conventionsMarkdown: "x",
        epics: epicUnion,
        tasks: [...constraining, ...breakdown.tasks],
      });
      if (errors.length) throw new Error(`re-planned DAG is invalid: ${errors.join("; ")}`);
      // The pit stop can re-plan into the same out-of-scope mistake the first
      // plan could, and there is no retry loop here to absorb it — better a
      // named failure than tasks nothing in this run can build.
      const scope = validatePlanScope(breakdown.tasks, this.repoPath);
      if (scope.length) throw new Error(`the re-planned tasks reach outside this run's repository: ${scope.join("; ")}`);
      const replaced = new Set(breakdown.tasks.map((t) => t.id));
      const dropped = pending.filter((t) => !replaced.has(t.id));
      for (const t of dropped) {
        this.store.transitionTask(runId, t.id, "CANCELLED", "replaced when you re-planned at a pit stop");
        this.queueIssueSync(runId, t.id);
      }
      this.store.insertTasks(
        runId,
        epicUnion,
        breakdown.tasks.map(pendingRow)
      );
      await this.fileIssues(runId);
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "planner",
        text: `re-planned at your pit stop: ${breakdown.tasks.length} task(s) queued, ${dropped.length} dropped`,
        ts: Date.now(),
      });
      this.wakeScheduler();
      return breakdown.tasks.map((t) => t.id);
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "planner",
        text: `could not re-plan (${String(e).slice(0, 200)}) — your words go to the queued tasks instead, so nothing you said is lost`,
        ts: Date.now(),
      });
      for (const t of pending) {
        this.store.queueFeedback(runId, t.id, operatorFeedbackMessage(words));
        this.bus.publish({ type: "task.feedback", runId, taskId: t.id, text: words, delivery: "queued", ts: Date.now() });
      }
      return pending.map((t) => t.id);
    }
  }

  /**
   * The skills an operator bound to this kind of work by name, in `skillRouting`
   * order. A rule naming a skill that is not in `skillsDirs` is ignored rather
   * than fatal: the routing table outlives any one machine's skill collection.
   */
  private routedSkills(skills: IndexedSkill[], config: RunConfig, text: string, role: string): IndexedSkill[] {
    const byName = new Map(skills.map((s) => [s.name, s]));
    const picked: IndexedSkill[] = [];
    const take = (name: string) => {
      const skill = byName.get(name);
      if (skill && !picked.some((p) => p.name === name) && verifyHash(skill)) picked.push(skill);
    };
    // Bound to the job before bound to the topic: a role's standing skills are
    // unconditional, so they must not lose the per-role cap to a keyword hit.
    for (const name of config.roleSkills[role] ?? []) take(name);
    for (const rule of config.skillRouting) {
      // A rule that names roles is for those roles only. Absent, it is for all
      // of them — the routing tables written before `roles` existed must keep
      // meaning exactly what they meant.
      if (rule.roles?.length && !rule.roles.includes(role as (typeof rule.roles)[number])) continue;
      let matches = false;
      try {
        matches = new RegExp(rule.when, "i").test(text);
      } catch {
        continue; // an unparseable rule is the operator's typo, not a reason to fail the run
      }
      if (!matches) continue;
      for (const name of rule.skills) take(name);
    }
    return picked;
  }

  /**
   * The skills the planner carries, matched against the operator's assignment.
   *
   * Planning had no skills at all until the operator asked for a product voice
   * in every product decision — and the PRD and the task cut *are* the product
   * decisions. Everything downstream inherits them: a task the planner never
   * wrote cannot be rescued by giving its worker the right playbook.
   */
  private planSkills(runId: string) {
    const run = this.store.getRun(runId)!;
    return this.selectSkills(indexSkills(run.config.skillsDirs), "planner", run.assignment, run.config);
  }

  /**
   * Remember a raised turn ceiling for the whole run, not just the task that
   * discovered it.
   *
   * A ceiling that truncates one worker truncates the next: the repository is
   * the same size for every task in it. Until now each task started from the
   * configured value and rediscovered that independently, and the discovery is
   * not cheap — it costs a session that ran to its limit having done the most
   * work of any session on that task. Run 40da9337 paid for it 27 times: $142
   * of the $206 it lost to errored sessions was `error_max_turns`, which is more
   * than a sixth of the entire run.
   *
   * Written through the run config so it survives a resume, and only ever
   * upward — a later task must not lower a ceiling an earlier one proved too low.
   */
  private raiseCeiling(runId: string, key: "workerMaxTurns" | "qaMaxTurns", turns: number): void {
    const run = this.store.getRun(runId)!;
    if (run.config[key] >= turns) return;
    this.store.patchRunConfig(runId, { [key]: turns });
  }

  /**
   * What the configured checks do on the integration branch as it stands right now.
   *
   * Keyed by that branch's commit, so the suite runs once per merge rather than
   * once per task per iteration — and only ever lazily, when a task has already
   * failed and the answer would change what happens to it. A green base costs
   * nothing at all, because nothing asks.
   *
   * Every failure path returns "the base is clean", which charges the task for
   * everything: a baseline we could not measure is not evidence of innocence,
   * and the wrong direction here would wave real defects through.
   */
  private async baseFailures(runId: string): Promise<CheckResult> {
    const run = this.store.getRun(runId)!;
    const clean: CheckResult = { ok: true, failures: [] };
    // Both are guards on a call that only happens after the checks have already
    // run and failed against a branch that therefore exists — kept so a future
    // caller cannot measure a baseline that is not there.
    /* v8 ignore next */
    if (!run.config.deterministicChecks.length) return clean;
    const sha = await this.wt.integrationHead(runId);
    /* v8 ignore next */
    if (!sha) return clean;
    const key = `${runId}/${sha}`;
    let measured = this.baselines.get(key);
    if (!measured) {
      measured = this.wt
        .withBaselineWorktree(runId, sha, async (wtPath) => {
          // Same warm install the task worktrees get: without it every check
          // fails on missing dependencies and none of it means anything.
          await seedWorktreeDeps(wtPath);
          const result = await runDeterministicChecks(wtPath, run.config.deterministicChecks, run.config.deterministicCheckTimeoutMinutes);
          if (!result.ok) {
            this.bus.publish({
              type: "agent.log",
              runId,
              sessionId: runId,
              text: `integration branch at ${sha.slice(0, 8)} is already failing: ${result.failures.map((f) => f.command).join(", ")}`,
              ts: Date.now(),
            });
          }
          return result;
        })
        .catch(() => clean);
      this.baselines.set(key, measured);
    }
    return measured;
  }

  /**
   * Match, hash-verify, and budget the skills one role's session will carry.
   *
   * `text` is whatever that role is deciding about — a task's title and spec for
   * worker/QA, the operator's assignment for the roles that run before any task
   * exists.
   */
  private selectSkills(skills: IndexedSkill[], role: keyof typeof ROLE_SKILL_LENS, text: string, config: RunConfig, forced: IndexedSkill[] = []) {
    // Every role that calls this has a lens; the fallback is for one added
    // later without one.
    /* v8 ignore next */
    const query = `${text}\n${ROLE_SKILL_LENS[role] ?? ""}`;
    // Routed skills are the operator's declared intent and come first; scoring
    // only fills whatever room is left, and no skill at all is a valid outcome.
    // `forced` outranks even those: it is a skill forged for exactly this task
    // moments ago (skillForge.ts), and forcing it is what spares it a lexical
    // re-match it was only written because the lexicon lost.
    const routed = this.routedSkills(skills, config, text, role);
    const scored = matchSkills(skills, query, MAX_SKILLS_PER_ROLE)
      .filter((m) => m.score >= SKILL_SCORE_FLOOR && verifyHash(m.skill))
      .map((m) => m.skill);
    const chosen: IndexedSkill[] = [];
    for (const skill of [...forced, ...routed, ...scored]) {
      if (chosen.length >= MAX_SKILLS_PER_ROLE) break;
      if (!chosen.some((c) => c.name === skill.name)) chosen.push(skill);
    }
    let fullCount = 0;
    return chosen.map((skill) => {
      const full = skill.tokensApprox <= FULL_TEXT_SKILL_TOKEN_LIMIT && fullCount < MAX_FULL_TEXT_SKILLS;
      if (full) fullCount++;
      return { name: skill.name, path: skill.path, sha256: skill.sha256, content: full ? skill.body : undefined };
    });
  }

  /**
   * Forge a playbook for a task the collection has nothing for, or return null
   * for every reason not to — and there are more reasons not to than to.
   *
   * The trigger is the worker selection coming back empty: routed, standing
   * and scored skills all absent. That is the matcher saying "nothing here
   * covers this", which until now dispatched the worker cold and unteachable.
   * When it fires, a read-only skillsmith session drafts a skill (or extends
   * a previously forged one, or declines), and skillForge.ts — code, not the
   * agent — validates and installs it under `.harness/skills/`, keeping the
   * PRD's rule that no agent writes the skills registry.
   *
   * The forged skill is pushed into the run's shared index in place, so a
   * parallel task in the same domain matches it instead of forging a twin,
   * and `execute()` re-indexes the forge dir at the start of every later run.
   * The per-run cap is counted from `skills.forged` events rather than a
   * field, so it holds across resume the way every other cap here does.
   *
   * Every failure inside the forge is a log line and a cold worker — the
   * state before this feature existed — never a failed task. Only a budget
   * stop propagates, because that one is about the run, not the forge.
   */
  private async forgeSkillIfNeeded(
    runId: string,
    taskId: string,
    task: TaskRow,
    skills: IndexedSkill[],
    taskText: string
  ): Promise<IndexedSkill | null> {
    const run = this.store.getRun(runId)!;
    const config = run.config.skillForge;
    if (!config.enabled) return null;
    if (this.selectSkills(skills, "worker", taskText, run.config).length) return null;
    if (this.store.eventCount(runId, "skills.forged") >= config.maxPerRun) return null;
    const say = (text: string) => this.bus.publish({ type: "agent.log", runId, taskId, sessionId: "skillsmith", text, ts: Date.now() });
    try {
      const dir = forgeDir(this.repoPath);
      // Below-floor matches are the skillsmith's briefing, not its competition:
      // what the collection almost had is the strongest hint about the topic.
      const near = matchSkills(skills, taskText, 3).map((m) => ({ name: m.skill.name, description: m.skill.description }));
      const prior = skills.filter((s) => s.path.startsWith(dir + path.sep)).map((s) => ({ name: s.name, description: s.description }));
      const result = await this.pool.run({
        runId,
        taskId,
        role: "skillsmith",
        model: run.config.models.skillsmith,
        systemPrompt: skillsmithSystemPrompt(toolbeltBlock(detectToolbelt(run.config.externalTools))),
        prompt: skillsmithPrompt(task.title, task.spec, task.acceptanceCriteria, near, prior),
        cwd: this.repoPath,
        // It reads the repository to ground its claims; the draft comes back
        // as JSON and the harness does the writing.
        disallowedTools: ["Write", "Edit", "NotebookEdit"],
        maxTurns: 25,
        budgetCheck: () => this.checkStops(runId),
      });
      const decision = SkillForgeDecision.parse(extractJson(result.resultText));
      if (decision.action === "none") {
        say(`declined to forge a skill${decision.why ? `: ${decision.why}` : ""}`);
        return null;
      }
      let skill: IndexedSkill;
      if (decision.action === "create") {
        const draft = validateDraft(decision, new Set(skills.map((s) => s.name)), { runId, taskId });
        if ("error" in draft) {
          say(`rejected the drafted skill: ${draft.error}`);
          return null;
        }
        skill = installForged(dir, draft, { runId, taskId });
      } else {
        const grown = extendForged(dir, decision.name, decision.addendum, { runId, taskId });
        if ("error" in grown) {
          say(`rejected the extension: ${grown.error}`);
          return null;
        }
        skill = grown.skill;
      }
      // The shared index is this run's view of the world: replace a stale
      // entry (an extended skill's old hash would fail verify) or add the new
      // one, so every later selection this run makes can see it.
      const at = skills.findIndex((s) => s.name === skill.name);
      if (at >= 0) skills[at] = skill;
      else skills.push(skill);
      const action = decision.action === "create" ? ("created" as const) : ("extended" as const);
      this.bus.publish({ type: "skills.forged", runId, taskId, name: skill.name, sha256: skill.sha256, path: skill.path, action, tokensApprox: skill.tokensApprox, ts: Date.now() });
      say(`${action} skill "${skill.name}" (~${skill.tokensApprox} tokens) — it rides with this task's worker and stays in ${dir} for the next one`);
      return skill;
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      say(`skill forge did not complete: ${String(e).slice(0, 300)} — the task proceeds without one`);
      return null;
    }
  }

  private async runTask(runId: string, taskId: string, skills: IndexedSkill[]): Promise<void> {
    const run = this.store.getRun(runId)!;
    const wt = await this.wt.ensureWorktree(runId, taskId);
    this.store.updateTask(runId, taskId, { branch: wt.branch, worktreePath: wt.path });
    this.bus.publish({ type: "git.worktree_created", runId, taskId, path: wt.path, branch: wt.branch, ts: Date.now() });
    if (wt.created) {
      // Install once, off the agent's clock, warm from the package store —
      // otherwise the worker's first act is paying for `pnpm install` in tokens.
      for (const seeded of await seedWorktreeDeps(wt.path)) {
        this.bus.publish({ type: "task.deps_seeded", runId, taskId, ...seeded, ts: Date.now() });
      }
    }

    let task = this.store.getTask(runId, taskId)!;
    // Skill matching + provenance (SEC-14, PERF-4). Selected once per task,
    // per role: workers match on the task text alone, QA matches with a
    // verification lens on top (ROLE_SKILL_LENS).
    const taskText = `${task.title}\n${task.spec}`;
    // WORKING before the forge rather than after it: the skillsmith is an
    // agent spawned for this task, spending this task's budget, and a budget
    // stop inside it must find the task in the state an operator would call
    // it — started — not READY as if nothing had been paid for yet.
    this.store.transitionTask(runId, taskId, "WORKING");
    // A task nothing matched gets one chance at a forged playbook before the
    // worker goes in cold. The forged skill lands in the shared index too, so
    // later tasks — and later runs — can match it the ordinary way.
    const forged = await this.forgeSkillIfNeeded(runId, taskId, task, skills, taskText);
    const workerSkills = this.selectSkills(skills, "worker", taskText, run.config, forged ? [forged] : []);
    const qaSkills = this.selectSkills(skills, "qa", taskText, run.config);
    const meta = (s: { name: string; sha256: string; content?: string }) => ({ name: s.name, sha256: s.sha256, mode: s.content ? ("full" as const) : ("reference" as const) });
    this.store.updateTask(runId, taskId, {
      assignedSkills: [
        ...workerSkills.map((s) => ({ ...meta(s), role: "worker" as const })),
        ...qaSkills.map((s) => ({ ...meta(s), role: "qa" as const })),
      ],
    });
    for (const [role, injected] of [["worker", workerSkills], ["qa", qaSkills]] as const) {
      if (injected.length) {
        this.bus.publish({ type: "skills.injected", runId, taskId, role, skills: injected.map(meta), ts: Date.now() });
      }
    }

    const conventions = this.readConventions(runId);
    // The host ports and compose project this task owns. Handed to the agent two
    // ways, because both are load-bearing: in the environment, so compose picks
    // it up without the agent thinking about it, and in the prompt, so an agent
    // writing a compose file or a test fixture knows which ports are its own.
    const iso = taskIsolation(runId, taskId);
    // Stated once per task, ahead of the task block, so it stays prompt-cacheable.
    const toolbelt = `${toolbeltBlock(detectToolbelt(run.config.externalTools))}\n\n${isolationBlock(iso)}`;
    let workerSummary = "";
    // A revived task starts from the operator's words, not from a blank prompt.
    let qaFeedback: string | undefined = this.revivalGuidance.get(`${runId}/${taskId}`);
    this.revivalGuidance.delete(`${runId}/${taskId}`);

    // The SDK session of the last clean worker iteration. A re-dispatch after a
    // QA rejection resumes it — the repo exploration is already in its context —
    // instead of cold-starting. Cleared on crashes: a session that died
    // mid-stream left a transcript that cannot be trusted to replay.
    let workerSession: string | undefined;
    // Raised when a QA session dies at its ceiling: retrying a truncated
    // verification with the same budget truncates it again in the same place.
    let qaTurns = run.config.qaMaxTurns;
    // Raised on the same terms as qaTurns, for the same reason: a worker that
    // ran out of turns re-dispatched with the same ceiling runs out again in
    // the same place, having paid twice to reach it.
    let workerTurns = run.config.workerMaxTurns;
    /**
     * Which worker model this task starts on, and why — decided once, from
     * fields the planner already emits, by the rule in modelTier.ts.
     *
     * Recorded for every task, including the ones the rule refused and the ones
     * it changes nothing about — an operator who has set `models.workerLight`
     * back to `models.worker` still gets a full record of what the light tier
     * would have taken, from their own plans rather than from an estimate.
     */
    const tier = workerModelFor(task, run.config.models);
    this.bus.publish({
      type: "task.tier_decided",
      runId,
      taskId,
      tier: tier.decision.tier,
      model: tier.model,
      why: tier.decision.why,
      ts: Date.now(),
    });
    /**
     * The model the next worker iteration runs on. Starts at the tier's model
     * and only ever moves one way — up.
     *
     * A light-tier session that died is the case the whole tiering bet turns on.
     * Re-dispatching it on the same model replays the same wall and bills for it
     * twice, and a cheap model that needs three attempts costs more than the
     * expensive one that needed a single: at 3x the price difference, break-even
     * is somewhere under two attempts. So the first failure spends up, and the
     * task finishes on the model it should have started on if the rule was
     * wrong about it.
     *
     * Deliberately not triggered by a QA rejection. That is the normal loop —
     * work comes back, gets fixed, goes again — and treating it as evidence the
     * model is too weak would escalate most tasks on their first iteration and
     * collect none of the saving.
     */
    let workerModel = tier.model;
    /** Move this task up a tier for its next iteration. False when already there. */
    const escalateWorker = (sessionId: string, why: string): boolean => {
      if (workerModel === run.config.models.worker) return false;
      const from = workerModel;
      workerModel = run.config.models.worker;
      // Not also written onto the task row: the ledger already carries one row
      // per session with its model on it, so "this task ran on two models" is a
      // question the ledger answers without a second copy to keep in step.
      this.bus.publish({
        type: "agent.log",
        runId,
        taskId,
        sessionId,
        text: `worker escalated from ${from} to ${workerModel}: ${why}`,
        ts: Date.now(),
      });
      return true;
    };
    /**
     * Merges handed back to the worker so far, and branches that arrived
     * carrying nothing. Read from the task rather than started at zero: these
     * are the two counters that end a loop, and as locals they were reset by
     * every restart of the harness process — so a task repeating the identical
     * failure believed each attempt was its first, forever. Written back on
     * every increment, and reset only where `qaIterations` is.
     */
    let conflictFixes = task.conflictFixes;
    let emptyDeliveries = task.emptyDeliveries;
    /** Read from the task, and written back, for exactly the reasons above. */
    let abandonedJobs = task.abandonedJobs;
    /**
     * Why the last iteration was sent back, verbatim — QA's reasons, or the
     * failing check's output.
     *
     * Every other gate names its own cause ("QA rejected it 3 times: …"), but the
     * wall-clock gate only knows that time passed, so it opened with "still not
     * accepted after 45 minutes" and nothing else. The advisor drafting the
     * operator's answer then had no failure to look at: on cost-and-risk-reporting
     * it read the worktree line by line, confirmed five acceptance criteria, and
     * left the two that mattered UNVERIFIED — while the rejection that would have
     * pointed straight at them was sitting in a variable one frame up.
     */
    let lastRejection = "";
    let startedAt = Date.now();
    /**
     * Every gate — and every answered gate restarts the wall clock.
     *
     * The bound exists to detect a task going nowhere on its own. An answered
     * gate is the opposite of that: the operator has just read the failure and
     * said what to do about it, and the attempt that follows is the first one
     * made with that information. Judging it on a clock that has been running
     * since before the question was asked means the very next check can trip the
     * bound and interrupt them again — about their own answer.
     *
     * Giving back only the thinking time was not enough. A task that gates on
     * failing checks at minute 44 of a 45-minute bound comes back with an answer
     * and one minute of credit, and re-gates on the wall clock inside the next
     * iteration. That is 19 of the 77 gates in run 40da9337: a wall-clock gate
     * firing immediately after a different gate on the same task, asking a
     * question nobody had new information to answer.
     *
     * The bound is not lost, only re-armed: a task that keeps going nowhere
     * still reaches it again, one full interval later, and each of those
     * intervals is separated by an operator who chose to continue.
     */
    const ask = async (why: string, probe = false): Promise<string | null> => {
      const guidance = await this.askOrPark(runId, taskId, why, probe);
      startedAt = Date.now();
      return guidance;
    };
    /**
     * Time the account spent out of quota is not time this task spent going
     * nowhere. The pool waits limits out and continues the same session; the
     * clock this loop judges progress on has to skip that wait, or a limit
     * reached early in a task turns into a wall-clock escalation about slowness
     * — asked of an operator who is not there, which parks the task.
     */
    const creditLimitWait = (ms: number) => {
      startedAt += ms;
    };
    for (;;) {
      task = this.store.getTask(runId, taskId)!;
      // Before a worker is dispatched at all: is this task's work already on
      // the integration branch?
      //
      // Asked here because the answer makes the whole iteration unnecessary,
      // and because the state it detects is one no worker can act on. A branch
      // that has been merged changes no file against the integration branch,
      // which every gate below reads as "nothing has been committed" — so the
      // task is sent back to commit a change that is already committed, parks
      // when it cannot, and parks again identically each time the operator
      // reopens it. Run bc691359 held `m1-exit-evidence` in that loop for six
      // days across eight QA passes, and the last three days of it were three
      // reopens that could only ever have ended the same way.
      const landed = (await this.wt.taskBranchDelta(runId, taskId)).landed;
      if (landed) {
        this.bookAlreadyLanded(runId, taskId, landed, taskId);
        return;
      }
      // Wall clock (taskWallClockMinutes): a task looping past its bound is a
      // task going nowhere — ask the operator rather than iterating forever.
      // Their answer resets the clock along with the iteration caps.
      if (Date.now() - startedAt > run.config.taskWallClockMinutes * 60_000) {
        const guidance = await ask(
          `still not accepted after ${run.config.taskWallClockMinutes} minutes of wall clock (${task.qaIterations} QA iterations so far)` +
            (lastRejection ? `\n\nWhy the last iteration was sent back:\n${lastRejection}` : "")
        );
        if (guidance === null) return;
        qaFeedback =
          `The operator reviewed why this task is taking so long and says — follow it over anything that contradicts it:\n${guidance}` +
          // The clock is set immediately before the loop, so the first pass
          // cannot blow it — anything that gets here has been round at least
          // once, and every path that loops leaves feedback behind.
          /* v8 ignore next */
          (qaFeedback ? `\n\nThe pending feedback from the previous iteration still applies:\n${qaFeedback}` : "");
      }
      // The issue thread is the other place an operator answers a task, and
      // until now it was the one place nobody read. Polled here rather than on
      // a timer: this is the moment the answer can still change what happens.
      await this.ingestIssueComments(runId, taskId);
      // Operator feedback that arrived while no session was live on this task —
      // the task was queued, or between sessions — joins the worker's briefing.
      const queuedFeedback = this.store.drainFeedback(runId, taskId);
      if (queuedFeedback) {
        qaFeedback =
          (qaFeedback ? `${qaFeedback}\n\n` : "") +
          `The operator sent feedback on this task — follow it over anything that contradicts it:\n${queuedFeedback}`;
      }
      // The operator's own checkout, sampled either side of the session. The
      // worktree guard denies the direct forms of writing there; this is what
      // notices when something indirect got through, while there is still a
      // named task and a live session to attribute it to.
      const primaryBefore = await this.wt.primaryHead();
      /**
       * What the worker left running and the teardown sweep killed.
       *
       * Reset every iteration: it describes the session that just ended, and a
       * stale list would explain this attempt's empty branch with the last
       * attempt's mistake.
       */
      let abandoned: string[] = [];
      try {
        const worker = await this.pool.run({
          runId,
          taskId,
          role: "worker",
          model: workerModel,
          // The tier the rule decided, not the tier this session ended up on:
          // after an escalation the model has changed and the decision has not,
          // and the question the ledger is being asked is what light-tier tasks
          // cost in total — including the standard-model sessions they escalate
          // into. `escalated` in `taskSpend` is what separates the two.
          tier: tier.decision.tier,
          systemPrompt: workerSystemPrompt(conventions, skillsBlock(workerSkills), toolbelt),
          // The same list the prompt names, so a skill an agent is told to read
          // is one the Skill tool will actually run.
          skills: workerSkills.map((s) => s.name),
          prompt: workerSession && qaFeedback ? workerResumePrompt(qaFeedback) : workerTaskPrompt(task, qaFeedback),
          resume: workerSession,
          cwd: wt.path,
          disallowedTools: ["WebSearch"],
          maxTurns: workerTurns,
          env: isolationEnv(iso),
          reapOnEnd: true,
          budgetCheck: () => this.checkStops(runId),
          onLimitWait: creditLimitWait,
        });
        workerSummary = worker.resultText;
        workerSession = worker.sdkSessionId ?? workerSession;
        abandoned = worker.abandoned ?? [];
        if (worker.outcome === "error" && worker.errorDetail?.includes("error_max_turns")) {
          workerTurns = Math.min(400, Math.ceil(workerTurns * 1.5));
          this.raiseCeiling(runId, "workerMaxTurns", workerTurns);
          this.bus.publish({ type: "agent.log", runId, taskId, sessionId: worker.sessionId, text: `worker ran out of turns; the next dispatch on this task gets ${workerTurns}`, ts: Date.now() });
          // The clearest signal the light tier can send that it was the wrong
          // call: it did not fail to understand the task, it failed to finish
          // it, and the remedy the line above buys — half as many turns again —
          // is being bought for a model that already spent more of them than
          // the task was priced for. Raise both.
          escalateWorker(worker.sessionId, "it exhausted its turn ceiling on the light tier");
        } else if (worker.outcome === "error") {
          // A worker that hit the turn ceiling stopped; a worker that died was
          // stopped, mid-thought, and its worktree is whatever it happened to
          // have written by then. Running the checks against that tree charges
          // the task for being interrupted and sends a half-built feature to QA.
          // Treat it as the crash it is — the catch below re-dispatches against
          // the same worktree, so the committed work survives.
          throw new Error(worker.errorDetail ?? "worker session ended abnormally");
        }
      } catch (e) {
        if (stopsTheRun(e)) throw e;
        workerSession = undefined;
        // A session that died is not evidence about the model the way a turn
        // ceiling is — transports drop, quotas close, machines run out of disk,
        // and none of that is Haiku's doing. It escalates anyway, because the
        // alternative is telling the difference from an error string, and a
        // respawn that guesses wrong on a cheap model pays the crash twice.
        escalateWorker(taskId, `the session died on the light tier: ${String(e).slice(0, 120)}`);
        const respawns = task.respawns + 1;
        this.store.updateTask(runId, taskId, { respawns, errorSummary: String(e).slice(0, 500) });
        if (respawns >= run.config.workerRespawnCap) {
          const guidance = await ask(`worker crashed ${respawns} times (the cap); last: ${String(e).slice(0, 200)}`);
          if (guidance === null) return;
          qaFeedback = `The operator looked at the repeated crashes and says:\n${guidance}\nInspect git log in this worktree and continue.`;
          continue;
        }
        lastRejection = `The worker session died before finishing (respawn ${respawns} of ${run.config.workerRespawnCap}): ${String(e).slice(0, 500)}`;
        qaFeedback = `Previous session was interrupted (${String(e).slice(0, 200)}). Inspect git log in this worktree and continue.`;
        continue;
      }

      const primaryAfter = await this.wt.primaryHead();
      if (primaryBefore && primaryAfter && primaryBefore !== primaryAfter) {
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text:
            `the primary repository moved while this task was working: ${primaryBefore} -> ${primaryAfter}. ` +
            `No agent should write there — work committed to the operator's own checkout is on a branch this run will never merge or report.`,
          ts: Date.now(),
        });
      }

      // Before anything is spent reviewing it: does this branch carry work?
      //
      // Nothing downstream can tell. The checks run against the worktree, which
      // looks fine whether or not the task committed to it; QA reviews a diff
      // that is empty and has no criterion telling it that emptiness is a
      // failure; and `git merge` reports success on a branch with no commits.
      // So an empty delivery used to travel the whole pipeline and come out the
      // far end labelled MERGED — three times in run da8325bd, once for work
      // the operator was told had shipped.
      const delta = await this.wt.taskBranchDelta(runId, taskId);
      // Landed while this session was running — someone resolved the merge by
      // hand, or a merge the store never recorded finally took. Booked here for
      // the same reason it is checked before dispatch: everything below treats
      // an empty diff as work that never arrived.
      if (!delta.files.length && delta.landed) {
        this.bookAlreadyLanded(runId, taskId, delta.landed, workerSession ?? taskId);
        return;
      }
      if (!delta.files.length) {
        const foreign = foreignRepoPaths(task, this.repoPath);
        // An empty branch the harness can explain from its own records, before
        // anything charges the task for it.
        //
        // The sweep that ends a session kills everything still running in the
        // worktree, and a worker that redirected a long command and polled for
        // it — the form the background-shell denial recommends — ends its turn
        // with that command still going. Run bc691359's `m1-live-block-witness`
        // did exactly that: `bench/scripts/m1-live-smoke.sh > log 2>&1 &`, a
        // Monitor loop, "Still building — no action needed", and the session
        // closed `done` 49 seconds in. The harness then killed the script and
        // its `docker run`, read the empty branch, and counted the fifth empty
        // delivery. Eight of those and the task parked on a question the
        // operator had no way to answer, about work that had never been allowed
        // to finish.
        //
        // Counting that as the worker failing to commit is wrong twice over: it
        // spends a budget that exists to catch a worker writing outside its
        // worktree, and the advice it hands back — go and find your work — is
        // about work that does not exist yet. Not applied to a foreign-repo
        // task: that branch is empty for a reason no instruction to this worker
        // can change, and saying otherwise sends it back for another go at
        // nothing.
        if (abandoned.length && !foreign.length && abandonedJobs < ABANDONED_JOB_ATTEMPTS) {
          abandonedJobs++;
          this.store.updateTask(runId, taskId, { abandonedJobs });
          this.bus.publish({
            type: "agent.log",
            runId,
            taskId,
            sessionId: workerSession ?? taskId,
            text:
              `nothing to review, and the session caused it: it ended while ${abandoned.length} process${abandoned.length === 1 ? "" : "es"} it had started ` +
              `${abandoned.length === 1 ? "was" : "were"} still running, so the sweep killed ${abandoned.length === 1 ? "it" : "them"} (${abandoned.map((c) => c.slice(0, 60)).join("; ")}). ` +
              `Re-dispatching with instructions to run it in the foreground; this does not count as an empty delivery (${abandonedJobs} of ${ABANDONED_JOB_ATTEMPTS}).`,
            ts: Date.now(),
          });
          qaFeedback = abandonedJobPrompt(this.wt.branchName(runId, taskId), abandoned);
          lastRejection = `The session ended while its own long-running command was still going, so it was killed and the branch came back empty: ${abandoned[0]!.slice(0, 200)}`;
          continue;
        }
        emptyDeliveries++;
        this.store.updateTask(runId, taskId, { emptyDeliveries });
        // An empty branch has two very different causes, and until now every
        // message said the first one. A task written against a repository this
        // run does not own delivers nothing *correctly*; telling its worker to
        // go find the work it lost sends it somewhere no commit can be merged
        // from. Plans are checked for this before a worker runs, so reaching
        // here means a run planned before that check, or a repo named in a
        // shape the check does not read.
        if (emptyDeliveries > EMPTY_DELIVERY_ATTEMPTS) {
          this.park(
            runId,
            taskId,
            foreign.length
              ? `this task is written against ${foreign.join(", ")}, which this run does not own, so ${this.wt.branchName(runId, taskId)} has nothing on it after ` +
                  `${emptyDeliveries} attempts and re-dispatching cannot change that. The work belongs to a run on that repository.`
              : `the task branch is still empty after ${emptyDeliveries} attempts: nothing has been committed to ${this.wt.branchName(runId, taskId)}, ` +
                  `so there is nothing to review or merge. Check whether the work was written somewhere other than the worktree.`
          );
          return;
        }
        const iterations = task.qaIterations + 1;
        this.store.updateTask(runId, taskId, { qaIterations: iterations });
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text:
            `nothing to review: ${this.wt.branchName(runId, taskId)} changes no file against ${this.wt.integrationBranch(runId)} (${delta.commits} commit${delta.commits === 1 ? "" : "s"})` +
            (foreign.length ? ` — this task is written against ${foreign.join(", ")}, which this run does not own` : ""),
          ts: Date.now(),
        });
        qaFeedback = emptyBranchPrompt(this.wt.branchName(runId, taskId), delta.commits, foreign);
        lastRejection = `The branch was empty: ${delta.commits} commit${delta.commits === 1 ? "" : "s"}, no files changed against the integration branch.`;
        // The task stays WORKING and is re-dispatched, exactly as a failed
        // deterministic check is: nothing has been reviewed, so there is no
        // verdict to record and no state to leave the task in but the one it
        // is already in.
        if (iterations >= run.config.qaIterationCap) {
          const guidance = await ask(
            foreign.length
              ? `this task is written against ${foreign.join(", ")}, which this run does not own — ${this.wt.branchName(runId, taskId)} is still empty after ${iterations} attempts and no worker can change that from here`
              : `the task branch is still empty after ${iterations} attempts — nothing is committed to ${this.wt.branchName(runId, taskId)}, so there is nothing to review or merge`
          );
          if (guidance === null) return;
          qaFeedback = `The operator looked at the empty branch and says — follow it over anything that contradicts it:\n${guidance}\n\n${qaFeedback}`;
        }
        continue;
      }

      // Deterministic checks before QA tokens (PRD §11.1)
      const checks = await runDeterministicChecks(wt.path, run.config.deterministicChecks, run.config.deterministicCheckTimeoutMinutes);
      // Only the failures this task actually introduced are its problem. The
      // rest are the integration branch's, arriving either as the base the
      // worktree branched from or as a catch-up merge, and charging them to
      // whichever task happened to be in flight parks correct work.
      // Then, of what is left, only what fails twice. A check that passes on the
      // second run failed for a reason outside this tree — a neighbouring
      // worktree's leftover process, a port still bound, a suite sharing state
      // with itself — and a worker sent to fix it spends an iteration finding
      // nothing wrong, while the iteration it spent is what opens a gate.
      const base = checks.ok ? null : await this.baseFailures(runId);
      const { failures, inherited, timedOut, flaky, excused, flakySignatures } = checks.ok
        ? { failures: [], inherited: [], timedOut: [], flaky: [], excused: [], flakySignatures: [] }
        : await confirmFailures(wt.path, splitInheritedFailures(checks, base!), base!, knownFlakySignatures(this.store), run.config.deterministicCheckTimeoutMinutes);
      if (timedOut.length) {
        // The check never reached a verdict, so it cannot be one. Charging a
        // kill sends the worker to find a failing test that does not exist —
        // run bc691359 spent six hours and seven gates on exactly that — and
        // the tail it would be shown is whatever the runner was mid-sentence
        // on when the signal arrived. Say so, to the operator, whose
        // configuration is the only place this is fixable.
        const minutes = run.config.deterministicCheckTimeoutMinutes;
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text: `${timedOut.map((t) => t.command).join(", ")} did not finish inside ${minutes} minute(s) and was killed — not a test failure and not charged to this task. Raise deterministicCheckTimeoutMinutes above the check's honest wall clock, or split it.`,
          ts: Date.now(),
        });
      }
      if (excused.length) {
        // Failed twice, but only with failures this repository has already
        // watched come and go. Charging these is how a gate reopens three
        // times on a timing test the task never touched — say what was
        // excused instead, so a worker that DID break one can still object.
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text: `${excused.map((e) => e.command).join(", ")} failed twice, but only on failures this repository has watched fail and then pass before — known flaky, not charged to this task: ${excused.flatMap((e) => e.signatures).join(" · ").slice(0, 500)}`,
          ts: Date.now(),
        });
      }
      if (flaky.length) {
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text: `${flaky.join(", ")} failed once and passed on a re-run — not charged to this task`,
          ts: Date.now(),
        });
      }
      if (inherited.length) {
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text: `${inherited.map((i) => i.command).join(", ")} also fails on ${this.wt.integrationBranch(runId)} — not charged to this task`,
          ts: Date.now(),
        });
      }
      // What this check run proved about the repository, for the next run in it
      // to read before it spends anything (memory.ts).
      observeChecks(this.store, {
        runId,
        configured: run.config.deterministicChecks,
        failed: checks.failures.map((f) => f.command),
        inherited,
        flaky,
      });
      if (flakySignatures.length) observeFlakySignatures(this.store, runId, flakySignatures);
      if (failures.length) {
        const detail = failures.map((f) => `$ ${f.command}\n${f.output}`).join("\n\n");
        const notYours = inherited.length
          ? `\n\nThese were already failing on the integration branch before you started — do NOT try to fix them, and do not let them distract you: ${inherited.map((i) => i.command).join(", ")}.`
          : "";
        qaFeedback = `Deterministic checks failed. Fix these before finishing:\n${detail}${notYours}`;
        lastRejection = `Deterministic checks failed: ${failures.map((f) => f.command).join(", ")}\n${failures.map((f) => f.output.slice(-1500)).join("\n")}`;
        const iterations = task.qaIterations + 1;
        this.store.updateTask(runId, taskId, { qaIterations: iterations });
        if (iterations >= run.config.qaIterationCap) {
          const guidance = await ask(
            `deterministic checks still failing after ${iterations} attempts: ${failures.map((f) => f.command).join(", ")}\n\n${failures.map((f) => f.output.slice(-1500)).join("\n")}${notYours}`
          );
          if (guidance === null) return;
          qaFeedback = `The operator looked at the failing checks and says:\n${guidance}\n\nThe checks that were failing:\n${detail}`;
        }
        continue;
      }

      // The task's own definition of done, in a form that cannot be partly
      // satisfied. Run after the repo's checks and before QA: a probe is about
      // this task alone, so there is no base to compare it against and nothing
      // to inherit — it either passes on this branch or the task is not
      // finished. Most tasks have none, and cost nothing here.
      //
      // A task the specification covers has one whether or not the planner
      // thought of it: its scenarios are the promises this task was written to
      // keep, and running them here is what stops a scenario failure from
      // travelling all the way to the acceptance gate before anyone notices.
      // The planner's own probe wins when it wrote one — it is about this task
      // specifically, and the scenarios are already checked at the gate.
      const probeCommand = task.completionProbe || this.scenarioProbe(runId, task);
      if (probeCommand) {
        const probe = await runDeterministicChecks(wt.path, [probeCommand], run.config.deterministicCheckTimeoutMinutes);
        // The probe has stopped standing between this task and QA — because it
        // passed, or because the escalation it caused ended with it rewritten.
        let settled = probe.ok;
        if (!probe.ok) {
          // One command in, so a run that is not ok has exactly one failure in
          // it; the fallback is for the type, not for a state that occurs.
          /* v8 ignore next */
          const output = probe.failures[0]?.output ?? "";
          qaFeedback =
            `This task's completion probe still fails. The probe is the task's own definition of done, and it does not depend on ` +
            `which files you happened to edit — it passes when the job is complete everywhere and fails while any of it is left:\n\n` +
            `$ ${probeCommand}\n${output}\n\n` +
            `Do not change or delete the probe. Finish the work it is looking for. If you believe the probe itself is wrong, say so plainly in your summary and explain why, rather than editing it.`;
          lastRejection = `The completion probe failed: ${probeCommand}\n${output.slice(-1500)}`;
          const iterations = task.qaIterations + 1;
          this.store.updateTask(runId, taskId, { qaIterations: iterations });
          this.bus.publish({
            type: "agent.log",
            runId,
            taskId,
            sessionId: workerSession ?? taskId,
            text: `completion probe failed: ${probeCommand}`,
            ts: Date.now(),
          });
          if (iterations >= run.config.qaIterationCap) {
            const guidance = await ask(
              `the completion probe still fails after ${iterations} attempts — the task is not finished everywhere it was scoped to reach:\n\n$ ${task.completionProbe}\n${output.slice(-1500)}`,
              // The one gate whose answer may also change the question. Every
              // other escalation is about the attempt; this one is the only one
              // where the thing doing the rejecting can itself be wrong, and
              // where agreeing that it is wrong changes nothing on its own.
              true
            );
            if (guidance === null) return;
            qaFeedback = `The operator looked at the failing probe and says — follow it over anything that contradicts it:\n${guidance}\n\n${qaFeedback}`;
            // That answer may have rewritten the probe. Try the new one before
            // spending a worker iteration: the amendment exists because the
            // failure was the probe's rather than the work's, and re-dispatching
            // a worker to satisfy a bar that has already moved is the same
            // wasted round the gate was opened to stop.
            const amended = this.store.getTask(runId, taskId)!.completionProbe;
            if (amended !== task.completionProbe && (!amended || (await runDeterministicChecks(wt.path, [amended], run.config.deterministicCheckTimeoutMinutes)).ok)) {
              this.bus.publish({
                type: "agent.log",
                runId,
                taskId,
                sessionId: workerSession ?? taskId,
                text: amended ? `completion probe passes as amended: ${amended}` : "completion probe withdrawn — QA decides this task alone",
                ts: Date.now(),
              });
              // The probe's complaint died with the probe; anything the worker
              // is told next comes from QA, not from a bar that no longer exists.
              qaFeedback = "";
              lastRejection = "";
              settled = true;
            }
          }
          if (!settled) continue;
        }
      }

      // Re-read before QA is briefed. `task` was read when this iteration
      // began, and between there and here sit the worker session and five
      // operator gates — which is exactly when someone amends the criteria,
      // because a gate is where they are looking at the task. Grading the
      // work against a bar the operator has already moved wastes the round
      // the amendment existed to save, and reports a failure against wording
      // that no longer stands. The probe is re-read for the same reason a few
      // lines above; the criteria deserve the same freshness, and so does
      // `touchedPaths`, which the drift note below reads.
      task = this.store.getTask(runId, taskId)!;
      this.store.transitionTask(runId, taskId, "QA");
      const diffStat = await git(wt.path, ["diff", "--stat", `${this.wt.integrationBranch(runId)}...HEAD`]).catch(() => "unavailable");
      // What the plan expected this task to touch, against what it did. A
      // signal for the reviewer, never a verdict: the planner's list was
      // written before anyone read the code, and QA is holding the criteria
      // that decide which side of that is right.
      const drift = pathDrift(task.touchedPaths, delta.files);
      if (hasDrift(drift)) {
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text:
            `plan said ${task.touchedPaths.length} path${task.touchedPaths.length === 1 ? "" : "s"}, diff touched ${delta.files.length}` +
            (drift.missing.length ? `; never changed: ${drift.missing.join(", ")}` : "") +
            (drift.extra.length ? `; not in the plan: ${drift.extra.slice(0, 5).join(", ")}${drift.extra.length > 5 ? ", …" : ""}` : ""),
          ts: Date.now(),
        });
      }
      // Whether the pipeline that will deploy this repo is allowed to create
      // what the task just declared. Deterministic, and the only gate that can
      // see it: the answer lives in a deploy command's arguments rather than
      // in the template, so every check that reads the template passes.
      const capability = deployCapabilityNote(wt.path, delta.files);
      if (capability) {
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text: "named IAM in this diff, and the repo's deploy command does not acknowledge it — CloudFormation would refuse the changeset",
          ts: Date.now(),
        });
      }
      // Whether merging this diff deploys it before the infrastructure it needs
      // exists. Same shape of question as the capability gate above and the same
      // reason it lives here: the answer is in a workflow's trigger rather than
      // in the code, so every check that reads the code passes and the first
      // report is production.
      const order = deployOrderNote(wt.path, delta.files);
      if (order) {
        this.bus.publish({
          type: "agent.log",
          runId,
          taskId,
          sessionId: workerSession ?? taskId,
          text: "this diff declares infrastructure nothing applies on the merge, and the merge deploys code that needs it — the deploy would land first",
          ts: Date.now(),
        });
      }
      let qa;
      /**
       * A QA session that dies delivers no verdict, so the minutes it spent
       * dying are not minutes this task spent going nowhere — the same credit
       * `creditLimitWait` gives a quota wait, for the same reason. Without it a
       * long death converts straight into a wall-clock escalation: on run
       * f338b5c8 QA lost its API connection 14 minutes in, the bound fired on
       * the very next pass, and the question that reached a human was an
       * infrastructure failure wearing a rejection's clothes. The advisor
       * confirmed all six acceptance criteria, found nothing wrong, and still
       * had to hand it back — "re-run QA" is not something a task gate can say,
       * because the only thing it can return is guidance for the next worker.
       *
       * Only QA gets this. A worker that dies has usually committed something
       * first — its worktree survives and the next dispatch continues from it —
       * so the clock it burned may well have been spent building, and giving
       * that back would hide a task that really is going nowhere.
       */
      const qaStartedAt = Date.now();
      const clockBeforeQa = startedAt;
      try {
        qa = await this.pool.run({
          runId,
          taskId,
          role: "qa",
          model: run.config.models.qa,
          systemPrompt: qaSystemPrompt(toolbelt, skillsBlock(qaSkills)),
          skills: qaSkills.map((s) => s.name),
          prompt: qaTaskPrompt(
            task,
            workerSummary.slice(0, 4000),
            diffStat.slice(0, 2000),
            this.store.drainFeedback(runId, taskId) || undefined,
            inherited.map((i) => i.command),
            [
              renderDrift(drift),
              capability,
              order,
              task.completionProbe ? `This task's completion probe passes: \`${task.completionProbe}\`. That settles the "everywhere" half of the job; it says nothing about whether the change is correct.` : "",
            ]
              .filter(Boolean)
              .join("\n\n")
          ),
          cwd: wt.path,
          disallowedTools: ["WebSearch"],
          maxTurns: qaTurns,
          env: isolationEnv(iso),
          reapOnEnd: true,
          budgetCheck: () => this.checkStops(runId),
          onLimitWait: creditLimitWait,
        });
        // A session cut off at its turn ceiling still returns a result message —
        // just not the JSON verdict. Parsing that books a FAIL against the
        // iteration cap for work QA never actually judged, and three of those
        // park a task nobody ever found fault with, after sending the worker
        // back to fix nothing. A truncated QA is a missing verdict, not a bad
        // one, so it belongs on the crash path with the rest of them.
        if (qa.outcome === "error") {
          throw new Error(`QA ended after ${qa.turns} turns without a verdict: ${qa.errorDetail ?? "unknown"}`);
        }
      } catch (e) {
        // A QA session that never returned a verdict says nothing about the
        // work, which is still committed in the worktree — same treatment as a
        // worker crash. Bounded by the same cap: a QA agent that cannot finish
        // must not loop the task forever.
        if (stopsTheRun(e)) throw e;
        // Set rather than incremented: a limit wait inside this session has
        // already moved the clock once, and that wait is part of the span being
        // given back. Adding would credit it twice.
        //
        // Never backwards, though. The pool credits a quota wait *before* it
        // sleeps (pool.ts) and its sleep is injectable, so the clock can already
        // hold more credit than this session's measured wall time — a plain
        // assignment would quietly take that back. Credit only ever moves the
        // clock forward; whichever gave more, keep it.
        startedAt = Math.max(startedAt, clockBeforeQa + (Date.now() - qaStartedAt));
        // The one failure whose remedy is known: it ran out of room, so give the
        // next attempt more of it rather than replaying the same wall.
        if (/max_turns/.test(String(e))) this.raiseCeiling(runId, "qaMaxTurns", (qaTurns = Math.min(300, Math.round(qaTurns * 1.5))));
        const respawns = task.respawns + 1;
        this.store.updateTask(runId, taskId, { respawns, errorSummary: String(e).slice(0, 500) });
        if (respawns >= run.config.workerRespawnCap) {
          const guidance = await ask(`QA ended without a verdict ${respawns} times (the cap); last: ${String(e).slice(0, 200)}`);
          if (guidance === null) return;
          qaFeedback = `QA never delivered a verdict — the work itself may be fine, and was never judged — and the operator stepped in with guidance; follow it over anything that contradicts it:\n${guidance}`;
        } else {
          qaFeedback = `The previous QA session ended without a verdict (${String(e).slice(0, 200)}) — the work itself may be fine, and was never judged. Inspect git log in this worktree, verify the committed work, and finish. Leave the verification cheap to repeat: a deterministic check or a command recorded in the commit message beats a long manual investigation QA has to redo.`;
        }
        lastRejection = `QA ended without a verdict (respawn ${respawns} of ${run.config.workerRespawnCap}): ${String(e).slice(0, 500)}`;
        this.store.transitionTask(runId, taskId, "QA_FAILED", "QA ended without a verdict");
        this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched after QA returned no verdict");
        continue;
      }

      let verdict: QaVerdict;
      try {
        verdict = QaVerdict.parse(extractJson(qa.resultText));
      } catch {
        // Reached only when the session ended cleanly and still wrote something
        // that is not a verdict — a QA agent that ignored its output contract.
        //
        // The verification itself happened; only the formatting is missing, and
        // the whole investigation is still sitting in that session's context.
        // Ask it for the JSON alone before throwing the work away: two turns
        // against a warm cache, versus booking a FAIL that sends the worker
        // back to fix nothing and spends an iteration of the cap doing it.
        verdict = (await this.reaskVerdict(runId, taskId, qa, run, wt.path)) ?? {
          verdict: "FAIL",
          reasons: ["QA finished but wrote no valid verdict JSON, and could not produce one when asked again"],
          mustFix: ["re-run"],
        };
      }
      const iterations = this.store.getTask(runId, taskId)!.qaIterations + 1;
      this.store.updateTask(runId, taskId, { qaIterations: iterations });
      this.bus.publish({ type: "task.qa_verdict", runId, taskId, verdict: verdict.verdict, iteration: iterations, detail: verdict, ts: Date.now() });

      if (verdict.verdict === "PASS") {
        // What this PASS did not settle, kept as data rather than as prose in
        // the ACCEPTED reason. Written on every PASS, including the empty case,
        // so a later iteration that verifies more replaces an earlier
        // disclosure instead of leaving a stale one to hold the PR.
        this.store.updateTask(runId, taskId, { unverified: verdict.unverified });
        if (verdict.unverified.length) {
          this.bus.publish({
            type: "agent.log",
            runId,
            sessionId: "qa",
            text: `QA passed ${taskId} but could not settle ${verdict.unverified.length} criteri${verdict.unverified.length === 1 ? "on" : "a"}: ${verdict.unverified.join("; ")}`,
            ts: Date.now(),
          });
        }
        // Feedback that landed after QA already judged must not be merged away
        // unread — it buys the operator one more worker iteration instead.
        const late = this.store.drainFeedback(runId, taskId);
        if (late) {
          this.store.transitionTask(runId, taskId, "QA_FAILED", "operator feedback arrived after the PASS");
          this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched with the operator's feedback");
          qaFeedback = `QA passed this iteration, but the operator sent feedback that must be addressed before the task can finish — follow it over anything that contradicts it:\n${late}`;
          continue;
        }
        this.store.transitionTask(runId, taskId, "ACCEPTED", verdict.notes);
        const merged = await this.integrate(runId, taskId);
        if (merged.ok) return;
        // The branch emptied out between the pre-QA gate and here — a worker
        // that reset or aborted its own work during a conflict fix is the way
        // that happens. It is not a conflict and must not be described as one:
        // there is no other side to reconcile with.
        if ("empty" in merged) {
          this.store.transitionTask(runId, taskId, "WORKING", "the accepted branch carries no changes; re-dispatched to commit its work");
          qaFeedback = emptyBranchPrompt(this.wt.branchName(runId, taskId), 0);
          lastRejection = "QA accepted the work, but the branch turned out to change nothing against the integration branch.";
          continue;
        }
        // The work passed; the base moved. Hand the conflict back to the worker
        // that wrote the code — it has the worktree, the context and the only
        // informed opinion about which side of each hunk belongs. Parking is
        // what happens when that also fails.
        if (conflictFixes >= CONFLICT_FIX_ATTEMPTS) {
          const guidance = await ask(`merge conflicts in ${merged.conflicts.join(", ")}, and the worker could not resolve them`);
          if (guidance === null) return;
          qaFeedback = `The operator looked at the unresolved merge and says — follow it over anything that contradicts it:\n${guidance}`;
          this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched with the operator's merge guidance");
          continue;
        }
        conflictFixes++;
        this.store.updateTask(runId, taskId, { conflictFixes });
        const caught = await this.wt.catchUpTaskBranch(runId, taskId);
        // A merge that conflicted one way conflicts the other way too, so a
        // clean catch-up after a conflicted integrate does not happen.
        /* v8 ignore next */
        qaFeedback = conflictPrompt(this.wt.integrationBranch(runId), caught.ok ? merged.conflicts : caught.conflicts, caught.ok);
        this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched to resolve merge conflicts");
        continue;
      }
      if (iterations >= run.config.qaIterationCap) {
        const guidance = await ask(`QA rejected it ${iterations} times (the cap): ${verdict.reasons.join("; ")}`);
        if (guidance === null) return;
        this.store.transitionTask(runId, taskId, "QA_FAILED", "cap reached; operator answered the escalation");
        this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched with the operator's guidance");
        qaFeedback = `QA rejected the previous iteration, and the operator stepped in with guidance — follow it over anything that contradicts it:\n${guidance}\n\nQA's reasons were: ${verdict.reasons.join("; ")}`;
        continue;
      }
      this.store.transitionTask(runId, taskId, "QA_FAILED", verdict.reasons.join("; "));
      this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched with mustFix list");
      qaFeedback = `QA rejected the previous iteration.\nReasons: ${verdict.reasons.join("; ")}\nMust fix:\n${verdict.mustFix.map((m) => `- ${m}`).join("\n")}`;
      lastRejection = `QA rejected iteration ${iterations}.\nReasons: ${verdict.reasons.join("; ")}\nMust fix:\n${verdict.mustFix.map((m) => `- ${m}`).join("\n")}`;
    }
  }

  /**
   * Book a task whose branch is already contained in the integration branch.
   *
   * Nothing is being claimed about review or quality: the work is on the branch
   * the run will publish, which is the only thing MERGED has ever meant here,
   * and the alternative — the state this replaces — was a task cycling forever
   * against a branch that cannot be un-merged.
   */
  private bookAlreadyLanded(runId: string, taskId: string, sha: string, sessionId: string): void {
    const branch = this.wt.branchName(runId, taskId);
    const integration = this.wt.integrationBranch(runId);
    this.store.transitionTask(runId, taskId, "ACCEPTED", `already contained in ${integration}`);
    this.store.transitionTask(runId, taskId, "MERGED");
    this.mergedShas.set(`${runId}/${taskId}`, sha);
    this.bus.publish({ type: "git.merged", runId, taskId, branch, sha, ts: Date.now() });
    this.bus.publish({
      type: "agent.log",
      runId,
      taskId,
      sessionId,
      text:
        `${branch} is already contained in ${integration} as ${sha.slice(0, 7)} — it changes no file against it because its work has ` +
        `landed, not because it has none. Booked as merged rather than dispatched again.`,
      ts: Date.now(),
    });
    this.queueIssueSync(runId, taskId);
  }

  /**
   * Continuous integration: merge on accept (PRD §11.1 Integrator); PRs wait for
   * openPrs. Reports a conflict rather than parking on it — the caller decides
   * whether the worker gets a go at it first.
   */
  private async integrate(runId: string, taskId: string): Promise<{ ok: true } | { ok: false; empty: true } | { ok: false; conflicts: string[] }> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    const merge = await this.wt.mergeTaskBranch(runId, taskId);
    // Nothing landed, so nothing is booked. The task stays un-merged and the
    // caller sends it back — the one thing that must not happen is the state
    // this replaces, where an unmoved integration branch was recorded as this
    // task's delivery and its sha posted to the task's issue.
    if (!merge.ok && "empty" in merge) {
      this.bus.publish({
        type: "agent.log",
        runId,
        taskId,
        sessionId: taskId,
        // Branch is set by ensureWorktree before the task can ever be merged;
        // the fallback is for the column type, not for a state that occurs.
        /* v8 ignore next */
        text: `merge produced nothing: ${task.branch ?? this.wt.branchName(runId, taskId)} left ${this.wt.integrationBranch(runId)} where it was`,
        ts: Date.now(),
      });
      return merge;
    }
    if (!merge.ok) {
      // Same fallback, and the same reason it never fires.
      /* v8 ignore next */
      this.bus.publish({ type: "git.merge_conflict", runId, taskId, branch: task.branch ?? "", files: merge.conflicts, ts: Date.now() });
      return merge;
    }
    this.store.transitionTask(runId, taskId, "MERGED");
    this.mergedShas.set(`${runId}/${taskId}`, merge.sha);
    /* v8 ignore next */
    this.bus.publish({ type: "git.merged", runId, taskId, branch: task.branch ?? "", sha: merge.sha, ts: Date.now() });
    // The PR is NOT opened here. Merging is continuous; publishing waits until
    // the whole run has been validated against the operator's intent (openPrs),
    // so no reviewer ever sees a PR the harness has not finished judging.
    void run;
    return { ok: true };
  }

  /** The integration-branch commit each merged task landed as, for its issue. */
  private mergedShas = new Map<string, string>();

  /** Issue writes are serialized: one API call in flight, in the order tasks finished. */
  private issueSync: Promise<void> = Promise.resolve();

  /**
   * Queue "what became of this task" for its issue. Never awaited by the caller:
   * a GitHub round trip must not hold a worker slot that another ready task
   * could be using, and an issue that fails to update is not a reason to fail
   * a task whose code is already merged.
   */
  private queueIssueSync(runId: string, taskId: string): void {
    if (!this.github.enabled) return;
    this.issueSync = this.issueSync
      .then(() => this.syncIssue(runId, taskId))
      .catch((e) => {
        this.bus.publish({
          type: "agent.log",
          runId,
          sessionId: "integrator",
          taskId,
          text: `could not update the issue for this task: ${String(e).slice(0, 200)}`,
          ts: Date.now(),
        });
      });
  }

  /**
   * Say on the task's issue what became of it, now that the task is finished with.
   *
   * The harness filed an issue per task and then never wrote to it again. After a
   * thirty-task run every issue still read as untouched — one that merged twelve
   * hours ago looked exactly like one that never started, and the only place the
   * outcome existed was a sqlite file on the operator's laptop.
   *
   * What merged is *commented*, not closed: it is merged into the run's
   * integration branch, and the pull request that lands it on the base branch
   * says "Closes #n", so a human merging it closes the issue with the merge that
   * actually shipped. What was cancelled is closed here as not planned — no PR
   * will ever mention it, so nothing else would ever close it. What parked stays
   * open, which is precisely what an open issue means, and the comment says so.
   */
  private async syncIssue(runId: string, taskId: string): Promise<void> {
    const task = this.store.getTask(runId, taskId);
    if (!task?.githubIssueNumber) return;
    const issue = task.githubIssueNumber;
    // Keyed by state, so a resumed run that re-walks the same terminal state
    // does not comment twice, but a task that parks and later merges does.
    const key = `${runId}/${taskId}/${task.state}`;
    const why = this.store.taskStateReason(runId, taskId);

    if (task.state === "MERGED") {
      const sha = this.mergedShas.get(`${runId}/${taskId}`);
      const n = task.qaIterations;
      await this.github.commentOnIssue(
        issue,
        key,
        // The sha was recorded by this same process when it merged the task.
        /* v8 ignore next */
        `**Done** — merged into \`${this.wt.integrationBranch(runId)}\`${sha ? ` as \`${sha.slice(0, 7)}\`` : ""} after ${n} QA iteration${n === 1 ? "" : "s"}.\n\n` +
          `**Acceptance criteria**\n${task.acceptanceCriteria.map((c) => `- [x] ${c}`).join("\n")}\n\n` +
          // A merged task always has a branch — see the same note in integrate.
          /* v8 ignore next */
          `This closes when the pull request for \`${task.branch ?? "the task branch"}\` is merged.`
      );
      return;
    }

    if (task.state === "NEEDS_HUMAN") {
      // A branch name is not an address. The issue body is written for whoever
      // picks the task up and its commands are relative to the task's checkout —
      // but the task branch is not on the base branch, so the same commands run
      // from the operator's own clone hit files that are not there. One parked
      // task asked for a `kubectl apply -f deploy/k8s/<file>.yaml` the run had
      // written itself; the operator ran it from the primary checkout, got "the
      // path does not exist", and had no way to tell from the issue that the
      // file existed on disk a few directories away. Print the `cd`.
      const branch = task.branch ?? "no branch";
      const where = task.worktreePath
        ? `The work so far is on \`${branch}\`, checked out at:\n\n\`\`\`sh\ncd ${task.worktreePath}\n\`\`\`\n\n` +
          `Run anything this issue asks for from there. Nothing on that branch has been merged to the base branch, so a command run from the primary checkout will not find the files this task wrote.`
        : `The work so far is on \`${branch}\`.`;
      await this.github.commentOnIssue(
        issue,
        key,
        // `park()` always records a reason, so the literal is unreachable; it is
        // there so a future path that parks without one still says something.
        /* v8 ignore next */
        `**Parked for a human** — ${task.errorSummary || why || "the harness could not finish it"}\n\n` +
          `${where} While the run is still going, a reply in this thread is picked up as guidance and the task is dispatched again.`
      );
      return;
    }

    if (task.state === "CANCELLED") {
      // Cancelling always records why; the literal is for a path that stops
      // doing so.
      /* v8 ignore next */
      await this.github.commentOnIssue(issue, key, `**Not attempted** — ${why || "the run ended before this task became reachable"}.`);
      await this.github.closeIssue(issue, "not_planned");
    }
  }

  private async openTaskPr(runId: string, taskId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    const base = run.config.baseBranch;
    // Only MERGED tasks reach here, and a merged task has a branch.
    /* v8 ignore next */
    if (!this.github.enabled || !task.branch) return;
    if (!base) throw new Error("the run has no base branch (detached HEAD) — nothing to open a PR against");

    // SEC-5: push only harness/<runId>/* branches, never the base branch.
    // Nothing is ever forced; `pushRunBranch` explains a rejection.
    await pushRunBranch(this.repoPath, task.branch);
    await pushRunBranch(this.repoPath, this.wt.integrationBranch(runId));

    // Base is the branch the run started from, not the integration branch: the
    // task is already merged into the integration branch by now, so a PR there has
    // no commits of its own. It is also the only base a human can usefully merge.
    const pr = await this.github.ensurePR(
      runId,
      taskId,
      task.branch,
      base,
      task.title,
      `Implements ${task.title}.${task.githubIssueNumber ? `\n\nCloses #${task.githubIssueNumber}` : ""}\n\nQA iterations: ${task.qaIterations}. Opened by harness — merge is always human.`
    );
    if (!pr) {
      this.bus.publish({
        type: "agent.log",
        runId,
        sessionId: "integrator",
        taskId,
        text: `no pull request opened: ${task.branch} has no commits that ${base} does not already have`,
        ts: Date.now(),
      });
      return;
    }
    this.store.updateTask(runId, taskId, { prNumber: pr.number });
    this.bus.publish({ type: "github.pr_opened", runId, taskId, prNumber: pr.number, url: pr.url, ts: Date.now() });
  }

  /**
   * The branch HEAD is on, or "" when detached.
   *
   * `branch --show-current` rather than `rev-parse --abbrev-ref HEAD`, because
   * the two disagree on a repository with no commits yet: `rev-parse` cannot
   * resolve an unborn HEAD and exits 128, which the catch below turns into ""
   * — indistinguishable from a genuine detached HEAD. `branch --show-current`
   * answers "main" there, which is the truth: the branch exists, it just has
   * nothing on it yet.
   *
   * That distinction is worth a whole run. `harness run` in a freshly
   * `git init`-ed repository recorded baseBranch "" and froze it into the
   * config; three days and 60 merged tasks later every pull request failed to
   * open with "no base branch (detached HEAD)" — about a repository that had
   * been on `main` the entire time.
   */
  private async currentBranch(): Promise<string> {
    return await git(this.repoPath, ["branch", "--show-current"]).catch(() => "");
  }

  // ---- budget (PERF-7: checked before/while every agent turn) ----

  /**
   * Everything that can stop a session mid-turn, asked on every streamed
   * message of every session in the run.
   *
   * This is the only hook the pool calls that often, which is what makes it the
   * right place for a pause: one check reaches a worker mid-edit, a QA agent
   * mid-verdict and the planner, without a cancellation path of its own to get
   * wrong. The pause is read before the cap because it is free — a set lookup
   * against a spend query — and because an operator who has asked to stop
   * should not first be asked to raise a budget.
   */
  private async checkStops(runId: string): Promise<void> {
    if (this.pauseAsked.has(runId)) throw new RunPaused(runId);
    await this.enforce(runId);
  }

  /**
   * Runs the operator has asked to stop. Held here rather than on the run row
   * because it must be readable on every message without a database round trip,
   * and because it is a request about *this process*: a pause does not outlive
   * the harness that was asked for it, and a run picked up by `resume` is by
   * definition no longer paused.
   */
  private readonly pauseAsked = new Set<string>();

  /** Runs this controller is holding; see `lockRun`. */
  private readonly locks = new Map<string, RunLock>();

  /**
   * Stop the run at the next message of every session, and leave it resumable.
   *
   * Reached from the dashboard's Pause button and `harness pause`, which is why
   * it answers with a sentence rather than throwing: the caller is an operator
   * waiting on a line of text, not a code path that can handle an exception.
   *
   * Asking twice is not an error. The agents take a moment to notice — they
   * stop at their next message, not the instant the button is clicked — and an
   * operator who clicks again because nothing has visibly happened is asking a
   * reasonable question, so tell them it is already happening.
   */
  pauseRun(runId: string): string {
    const run = this.store.getRun(runId);
    if (!run) return `no run ${runId}`;
    if (!["EXECUTING", "INTEGRATING"].includes(run.state)) {
      return `this run is ${run.state} — only a run that is still working can be paused`;
    }
    if (this.pauseAsked.has(runId)) return "already pausing — the agents stop at their next message";
    this.pauseAsked.add(runId);
    this.bus.publish({ type: "run.pause_requested", runId, ts: Date.now() });
    // The loop only re-reads its stop conditions when something wakes it, and a
    // run whose workers are all mid-turn is not waking on its own.
    this.wakeScheduler();
    return "pausing — the agents stop at their next message, and the run keeps every commit they have made";
  }

  /**
   * With parallel workers, several sessions can trip the cap in the same tick,
   * and the dashboard holds exactly one budget-gate slot — a second concurrent
   * gate would silently overwrite the first's resolver and hang its session
   * forever. Every enforcement queues here instead: whoever is second waits for
   * the operator's answer to the first and then re-reads the (possibly raised)
   * cap, so one raise satisfies everyone and one decline stops everyone.
   */
  private budgetChain: Promise<void> = Promise.resolve();

  /**
   * A cap is a checkpoint, not a wall. Killing the run outright at the cap throws
   * away a half-finished task whose worker has already been paid for, so the
   * operator is asked whether to raise it; the agent session stays open and picks
   * up where it left off once they answer. Declining parks the run in BUDGET_HOLD,
   * which `resume` can continue from.
   */
  private async enforce(runId: string): Promise<void> {
    // Fast path outside the queue: the overwhelmingly common under-cap check
    // must not serialize every streamed message of every parallel session.
    if (this.store.spentUsd(runId) < this.capFor(runId)) return;
    const prev = this.budgetChain;
    let release!: () => void;
    this.budgetChain = new Promise((r) => (release = r));
    try {
      await prev;
      await this.enforceNow(runId);
    } finally {
      release();
    }
  }

  private capFor(runId: string): number {
    return this.store.getRun(runId)!.config.budget.runCapUsd;
  }

  private async enforceNow(runId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const cap = run.config.budget.runCapUsd;
    const spent = this.store.spentUsd(runId);
    // `enforce` already returned for anything under the cap, and spend only
    // grows — so this is a re-check that cannot fire, kept because the queue
    // between the two makes "still over?" the honest question to ask here.
    /* v8 ignore next */
    if (spent < cap) return;
    // The operator already declined while this check was queued — every other
    // session stops on its next check without opening the gate again.
    if (run.state === "BUDGET_HOLD") throw new BudgetExceeded(spent, cap, runId);

    const gateId = randomUUID().slice(0, 8);
    // BUDGET_HOLD is only reachable while building; during intake or planning the
    // gate still opens, the run just has no held state to sit in.
    const held = run.state === "EXECUTING" || run.state === "INTEGRATING" ? run.state : null;
    if (held) this.store.transitionRun(runId, "BUDGET_HOLD", `run cap $${cap.toFixed(2)} reached at $${spent.toFixed(2)}`);
    const payload: BudgetGate = { spentUsd: spent, capUsd: cap };
    this.bus.publish({ type: "run.gate_opened", runId, gateId, kind: "budget", payload, ts: Date.now() });

    // Asked of the skill first, and of the operator only when it has no
    // standing to answer — this is the gate that cost f338b5c8 six hours and
    // forty-two minutes of an idle worker slot for an answer that turned out to
    // be the suggested figure, accepted unchanged.
    const decided = await this.decideBudgetGate(runId, payload);
    const raised = decided.decidedBy === "operator" ? await this.gates.resolveBudgetGate(payload) : decided.capUsd;
    const ok = raised !== null && Number.isFinite(raised) && raised > spent;
    this.bus.publish({
      type: "run.gate_resolved",
      runId,
      gateId,
      kind: "budget",
      resolution: ok ? "approved" : "rejected",
      feedback:
        (ok ? `cap raised to $${raised!.toFixed(2)}` : `${decided.decidedBy} declined to raise the cap`) +
        (decided.why ? ` — ${decided.why}` : ""),
      decidedBy: decided.decidedBy,
      ts: Date.now(),
    });

    if (!ok) throw new BudgetExceeded(spent, cap, runId);

    const budget = { ...run.config.budget, runCapUsd: raised! };
    this.store.setRunBudget(runId, budget);
    this.bus.publish({ type: "run.budget_updated", runId, spentUsd: spent, capUsd: raised!, ts: Date.now() });
    if (held) this.store.transitionRun(runId, held, `cap raised to $${raised!.toFixed(2)}`);
  }

  // ---- subscription (the account's plan, not this run's dollar cap) ----

  /**
   * Windows already answered "carry on", keyed by run, window and reset time.
   *
   * The plan re-reports its utilization on most turns once it is past a warning
   * threshold, so without this the operator would be asked the same question
   * every few seconds for the rest of the window. Keyed by the reset time as
   * well as the window, so the next window asks again — that is a genuinely new
   * question, about quota that did not exist when the last one was answered.
   */
  private acknowledgedWindows = new Set<string>();

  /**
   * One gate at a time, whoever gets there first — the same discipline the
   * budget chain keeps, and needed more here: a weekly window trips every
   * session in the pool within the same second, and each one arrives holding
   * its own copy of the same question.
   */
  private subscriptionChain: Promise<void> = Promise.resolve();

  /**
   * Close the gates the previous process left open when it died holding one.
   *
   * A hold state and its gate are two records of one fact, written by the same
   * call: `askSubscription` parks the run and then awaits an answer. Kill the
   * process while it waits and only the parking survives — the awaited promise
   * dies with it, so `run.gate_resolved` is never written. `resume` then lifts
   * the hold and the gate is left standing, and because nothing ever revisits an
   * opened gate, it is answered by nobody for the life of the run.
   *
   * Resuming *is* the answer: the operator is at the keyboard, they either
   * pointed the run at another account or waited out the window, and the
   * preflight read above has already re-measured which. So the gate is closed
   * as approved — never attributed to a decider, or the auto-raise rounds in
   * `budgetAutoRaises` would count a resume as a skill's decision and spend the
   * operator's remaining rounds on nothing.
   *
   * `"resume"` rather than `"operator"`, because the two are not the same
   * reading and one report needs to tell them apart. `postmortem` counts every
   * gate closed by `"operator"` as time the run spent waiting on a person, so
   * attributing this one to them booked the whole span the process was dead —
   * which nobody was waiting through — as operator wait, and showed a budget
   * gate approved by somebody who never saw it. `budgetAutoRaises` excludes
   * this word for the same reason it excludes `"operator"`.
   *
   * Only gates of the kind that produced this hold: a subscription resume says
   * nothing about an open plan gate, and closing one it did not answer would
   * trade a stale record for a false one.
   */
  private closeAbandonedGates(runId: string, kind: z.infer<typeof GateKind>, feedback: string): void {
    for (const gate of this.store.openRunGates(runId)) {
      if (gate.kind !== kind) continue;
      this.bus.publish({
        type: "run.gate_resolved",
        runId,
        gateId: gate.gateId,
        kind,
        resolution: "approved",
        feedback,
        decidedBy: "resume",
        ts: Date.now(),
      });
    }
  }

  private publishReading(runId: string, reading: SubscriptionReading): void {
    this.bus.publish({
      type: "run.subscription_reading",
      runId,
      window: reading.window,
      percent: reading.percent,
      resetsAt: reading.resetsAt,
      account: this.store.getRun(runId)!.config.subscription.active,
      ts: Date.now(),
    });
  }

  /**
   * What the pool calls with every utilization reading a session reports.
   *
   * Returns the account the caller should continue under, or null to carry on
   * unchanged. Throws `SubscriptionPaused` when the operator declines to carry
   * on at all, which stops the session and parks the run.
   */
  private async watchSubscription(runId: string, reading: SubscriptionReading, spawnedAs: string): Promise<{ name: string; env: Record<string, string> } | null> {
    this.publishReading(runId, reading);
    const config = () => this.store.getRun(runId)!.config.subscription;
    if (!tripped([reading], config())) return null;
    const prev = this.subscriptionChain;
    let release!: () => void;
    this.subscriptionChain = new Promise((r) => (release = r));
    try {
      await prev;
      const key = `${runId}:${reading.window}:${reading.resetsAt ?? 0}`;
      // Not "has this run answered", but "has anyone answered *this window*" —
      // a session that queued behind the gate gets the answer that was already
      // given rather than re-opening it.
      if (!this.acknowledgedWindows.has(key)) await this.askSubscription(runId, reading, key);
      const now = config();
      // The session is told to move only when the run is on an account it is
      // not. A session dispatched before an earlier switch is the case this
      // exists for: nobody asked it anything, and it is still spending the
      // account the run left behind.
      return now.active === spawnedAs ? null : { name: now.active, env: accountEnv(now, now.active) };
    } finally {
      release();
    }
  }

  /**
   * The gate itself: the account is nearly out of plan, the sessions holding
   * the reading are open and idle, and somebody has to say what happens next.
   *
   * Modelled on the budget gate, because it is the same shape of decision — a
   * ceiling reached with paid-for work in flight — and deliberately not modelled
   * on the usage-limit wait, which is what happens after this question goes
   * unasked. The three answers are: move to another subscription, carry on and
   * take the wall when it comes, or stop here and pick the run up later.
   */
  private async askSubscription(runId: string, reading: SubscriptionReading, key: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const config = run.config.subscription;
    const gateId = randomUUID().slice(0, 8);
    // Only EXECUTING and INTEGRATING have a held state to sit in; earlier the
    // gate still opens and the run simply has nowhere to be parked, exactly as
    // the budget gate behaves during intake and planning.
    const held = run.state === "EXECUTING" || run.state === "INTEGRATING" ? run.state : null;
    if (held) this.store.transitionRun(runId, "LIMIT_HOLD", `${describeReading(reading)} — waiting on the operator`);
    const payload: SubscriptionGate = {
      window: reading.window,
      percent: reading.percent,
      resetsAt: reading.resetsAt,
      pauseAtPercent: config.pauseAtPercent,
      summary: describeReading(reading),
      untilReset: untilReset(reading, Date.now()),
      account: config.active,
      alternatives: alternatives(config),
    };
    this.bus.publish({ type: "run.gate_opened", runId, gateId, kind: "subscription", payload, ts: Date.now() });

    // No handler is a harness embedded somewhere with nobody to ask. It keeps
    // going — the alert is on the record, and parking a run that nobody can
    // resume would turn a warning into an outage.
    const choice = (await this.gates.resolveSubscriptionGate?.(payload)) ?? { action: "continue" as const };
    const resolution = choice.action === "park" ? "rejected" : "approved";
    const feedback =
      choice.action === "switch"
        ? `moved to subscription "${choice.account}"`
        : choice.action === "park"
          ? `parked at ${payload.summary}`
          : `carrying on at ${payload.summary}`;
    this.bus.publish({ type: "run.gate_resolved", runId, gateId, kind: "subscription", resolution, feedback, decidedBy: "operator", ts: Date.now() });

    if (choice.action === "park") throw new SubscriptionPaused(payload.summary, runId);

    if (choice.action === "switch") {
      // Resolved before the config is patched: an account whose token is not
      // exported must not become the run's account, or the run carries on
      // authenticating as nobody.
      //
      // Re-thrown as a pause rather than as itself, because of where it lands.
      // A plain error here is caught by the dispatcher as one task crashing,
      // parked, and driven past — which is a run that carries on spending the
      // exhausted subscription, having been told to stop, over a typo. As a
      // pause it stops the run and says which variable to export, and
      // `harness resume --account` is the fix.
      let env: Record<string, string>;
      try {
        env = accountEnv(config, choice.account);
      } catch (e) {
        // The reason, not the exception: this becomes the sentence the operator
        // reads in a terminal, and it has to name the variable to export.
        throw new SubscriptionPaused(`${payload.summary} — ${String(e).replace(/^Error: /, "")}`, runId);
      }
      this.store.patchRunConfig(runId, { subscription: { ...config, active: choice.account } });
      this.bus.publish({
        type: "run.subscription_switched",
        runId,
        from: config.active,
        to: choice.account,
        window: reading.window,
        percent: reading.percent,
        ts: Date.now(),
      });
      // The pool spawns everything after this under the new account; the
      // sessions already running are told one by one as they report a reading.
      this.pool.configureSubscription?.({ name: choice.account, env, watch: (id, r, as) => this.watchSubscription(id, r, as) });
      // A window answered by switching is *not* acknowledged: the new account
      // has its own windows, and the next reading over the line is a question
      // about a different subscription entirely.
    } else {
      this.acknowledgedWindows.add(key);
    }
    if (held) this.store.transitionRun(runId, held, feedback);
  }

  /**
   * Move the run's budget cap before it is ever reached, instead of waiting
   * for `enforceNow` to open a gate and ask. This is the operator watching
   * spend climb who would rather act now than be interrupted later — typed
   * straight into the run's own terminal (see `watchBudgetCommands` in the
   * CLI) or clicked in the dashboard header, while the run keeps going, so a
   * fast-moving run never has to pause for a gate that a pre-emptive raise
   * would have made unnecessary.
   */
  raiseBudget(runId: string, capUsd: number): string {
    const run = this.store.getRun(runId);
    if (!run) return `no run ${runId}`;
    if (!Number.isFinite(capUsd) || capUsd <= 0) return "a cap must be a positive number";
    const spent = this.store.spentUsd(runId);
    if (capUsd <= spent) return `the run has already spent $${spent.toFixed(2)} — the cap must be above that`;
    const budget = { ...run.config.budget, runCapUsd: capUsd };
    this.store.setRunBudget(runId, budget);
    this.bus.publish({ type: "run.budget_updated", runId, spentUsd: spent, capUsd, ts: Date.now() });
    return `cap raised to $${capUsd.toFixed(2)}`;
  }

  /**
   * Point one role at a different model for the rest of the run.
   *
   * `harness resume -m worker=…` could already do this, and that is exactly the
   * problem it leaves: re-routing meant stopping the run. The operator who
   * wants it is watching spend climb against work that is not moving, and the
   * remaining tasks — the ones that could still be made cheaper — are the ones
   * a resume would make them wait for. So this is the same edit, applied while
   * the run keeps going, next to the cap control that already works this way.
   *
   * Only agents spawned after it. A session already running keeps the model it
   * was spawned on, because a model cannot be changed mid-conversation without
   * throwing away the prompt cache that conversation is paying for — the harness
   * re-routes by spawning fresh, never by switching under a live session.
   *
   * The pinned roles hold, and they hold *here* rather than at dispatch:
   * `patchRunConfig` re-parses the whole config through `ModelRouting`, so a
   * judge cannot be moved below the judging floor by this door any more than by
   * the CLI's.
   */
  rerouteModel(runId: string, role: string, model: string): string {
    const run = this.store.getRun(runId);
    if (!run) return `no run ${runId}`;
    const roles = Object.keys(run.config.models);
    if (!roles.includes(role)) return `unknown role ${role} — the roles are ${roles.join(", ")}`;
    const wanted = model.trim();
    if (!wanted) return "name a model to route it to";
    const was = run.config.models[role as keyof typeof run.config.models];
    if (was === wanted) return `${role} is already on ${wanted}`;
    const models = { ...run.config.models, [role]: wanted };
    // Before the config is touched: a role routed to a vendor whose key is not
    // exported fails at the first spawn, minutes later, in a log, a long way
    // from the click that caused it.
    //
    // Only the role being moved. Checking the whole table looks more thorough
    // and is worse: the rest of it was validated at `harness run` and has not
    // changed, so the only thing a full check can add here is a complaint about
    // a role the operator did not just touch — which is what it did the day
    // `reviewer` was pinned to Google, answering "move the worker to Haiku"
    // with a sentence about GEMINI_API_KEY.
    const missing = missingKeys({ [role]: wanted });
    if (missing.length) return missing.join(" ");
    try {
      this.store.patchRunConfig(runId, { models });
    } catch (e) {
      // A ZodError from the pinned-role refinement, almost always. Its message
      // is written for the operator — see `routingViolations` — so it is worth
      // more than a generic failure line.
      const message = e instanceof z.ZodError ? e.issues.map((i) => i.message).join(" ") : String(e);
      return message.slice(0, 300);
    }
    this.bus.publish({
      type: "agent.log",
      runId,
      sessionId: "integrator",
      text: `${role} re-routed for the rest of the run: ${was} → ${wanted}`,
      ts: Date.now(),
    });
    const live = this.store.listSessions(runId).filter((s) => s.state === "running" && s.role === role);
    return (
      `${role} re-routed: ${was} → ${wanted}` +
      (live.length
        ? `. ${live.length} ${role} session${live.length === 1 ? "" : "s"} already running stay${live.length === 1 ? "s" : ""} on ${was} until ${live.length === 1 ? "it finishes" : "they finish"}.`
        : ". The next one to start uses it.")
    );
  }

  /**
   * Answer the run's budget cap once it has been reached, or hand it to the
   * operator (`budget.decidedBy`).
   *
   * The operator's half of this conversation had already collapsed into
   * pressing enter on a suggested figure — run f338b5c8's gate was accepted
   * unchanged **six hours and forty-two minutes** after it opened, with a
   * worker paused mid-task and three tasks queued behind it.
   *
   * Two bounds keep this honest:
   *
   * - **The cap is not the skill's to raise** unless the operator named a
   *   `ceilingUsd` in advance — that figure, typed by a person, is what makes
   *   this the skill's to answer at all.
   * - **`autoRaiseRounds`.** A cap raised three times is not a slightly wrong
   *   estimate; it is a run that does not know how to finish, and the fourth
   *   raise buys another round of exactly what the first three bought.
   *
   * Everything outside those bounds, and every failure, goes to the operator —
   * who has lost nothing, because asking them is all this ever did.
   */
  private async decideBudgetGate(runId: string, gate: BudgetGate): Promise<{ capUsd: number | null; decidedBy: string; why: string }> {
    const ask = { capUsd: null, decidedBy: "operator", why: "" };
    const run = this.store.getRun(runId)!;
    const skill = run.config.budget.decidedBy;
    if (skill === "operator") return ask;

    const say = (text: string) => this.bus.publish({ type: "agent.log", runId, sessionId: "budget", text, ts: Date.now() });
    // The most this decision may set the cap to — the figure the operator
    // typed in advance, without which this is not theirs to answer at all.
    const ceiling = run.config.budget.ceilingUsd;
    if (ceiling === undefined) return ask;
    if (ceiling <= gate.spentUsd) {
      say(`${skill} cannot answer this: the ceiling of $${ceiling.toFixed(2)} is already spent — asking you`);
      return ask;
    }
    const spentRounds = this.store.budgetAutoRaises(runId);
    if (spentRounds >= run.config.budget.autoRaiseRounds) {
      say(`${skill} has already raised this cap ${spentRounds} time(s) — this one is yours`);
      return ask;
    }

    const tasks = this.store.listTasks(runId);
    const inFlight = tasks.filter((t) => t.state !== "PENDING" && t.state !== "MERGED");
    const notStarted = tasks.filter((t) => t.state === "PENDING");
    try {
      const skills = indexSkills(run.config.skillsDirs).filter((s) => s.name === skill && verifyHash(s));
      const result = await this.pool.run({
        runId,
        role: "pm",
        model: run.config.models.pm,
        systemPrompt: budgetDeciderSystemPrompt(
          skill,
          `You may set this cap as high as $${ceiling.toFixed(2)} and no higher; a figure above it will be treated as that figure. ` +
            (run.config.budget.autoRaiseRounds - spentRounds === 1
              ? "This is the last raise you get on this cap — the next one is the operator's however you answer."
              : `You may raise this cap ${run.config.budget.autoRaiseRounds - spentRounds} more times before the operator is asked instead.`),
          toolbeltBlock(detectToolbelt(run.config.externalTools)),
          skillsBlock(skills)
        ),
        prompt: budgetDeciderPrompt(
          run.assignment,
          `The run's budget cap has been reached.`,
          inFlight.length
            ? inFlight.map((t) => `- **${t.title}** (\`${t.id}\`, ${t.estimatedSize}, state ${t.state}, QA failed it ${t.qaIterations} time(s))`).join("\n")
            : "",
          [
            `The run has spent $${gate.spentUsd.toFixed(2)} of its $${gate.capUsd.toFixed(2)} cap.`,
            spentRounds ? `This cap has already been raised ${spentRounds} time(s) without the operator being asked.` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          `Still to build: ${notStarted.length} task(s) that have not started${notStarted.length ? ` — ${notStarted.map((t) => `${t.id} (${t.estimatedSize})`).join(", ")}` : ""}.\n`
        ),
        cwd: await this.wt.ensureIntegrationWorktree(runId).catch(() => this.repoPath),
        disallowedTools: ["Write", "Edit", "NotebookEdit"],
        maxTurns: 20,
        // No `budgetCheck`: this session *is* the budget check. Enforcing the
        // cap on the agent deciding what to do about the cap re-enters `enforce`
        // behind a queue this call already holds, and the run deadlocks on
        // itself. Its own spend is bounded by `maxTurns` and counted against
        // everything measured after it.
      });
      const parsed = BudgetDecisionJson.parse(extractJson(result.resultText));
      if (parsed.action === "park") {
        say(`${skill} declined to raise the cap — ${parsed.why || "no reason given"}`);
        return { capUsd: null, decidedBy: skill, why: parsed.why };
      }
      // A cap at or below the spend trips again on the very next check, which is
      // a decline dressed as an approval — so it is read as what it does.
      if (!Number.isFinite(parsed.capUsd) || parsed.capUsd <= gate.spentUsd) {
        say(`${skill} answered with a cap of $${parsed.capUsd} that is not above the $${gate.spentUsd.toFixed(2)} already spent — asking you`);
        return ask;
      }
      const capped = Math.min(parsed.capUsd, ceiling);
      say(
        `${skill} raised the cap to $${capped.toFixed(2)}` +
          (capped < parsed.capUsd ? ` (asked for $${parsed.capUsd.toFixed(2)}, held at the ceiling)` : "") +
          (parsed.why ? ` — ${parsed.why}` : "")
      );
      return { capUsd: capped, decidedBy: skill, why: parsed.why };
    } catch (e) {
      if (stopsTheRun(e)) throw e;
      say(`${skill} did not return a decision (${String(e).slice(0, 200)}) — asking you instead`);
      return ask;
    }
  }

  private readConventions(runId: string): string {
    try {
      return readFileSync(path.join(this.repoPath, ".harness", runId, "CONVENTIONS.md"), "utf8");
    } catch {
      return "Follow the existing repository conventions.";
    }
  }
}
