import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Plan, PlanBreakdown, PlannedTask, QaVerdict, RunConfig, TaskState, briefToAssignment, validatePlanDag } from "@harness/shared";
import { indexSkills, matchSkills, verifyHash, type IndexedSkill } from "@harness/skills-mcp";
import { Bus } from "./bus.js";
import { BudgetExceeded } from "./budget.js";
import { seedWorktreeDeps } from "./deps.js";
import { nextDispatch } from "./dispatchOrder.js";
import { git, WorktreeManager } from "./git.js";
import { GitHubAdapter, type PrRef } from "./github.js";
import { runIntake, type IntakeUi } from "./intake.js";
import { isolationBlock, isolationEnv, taskIsolation } from "./isolation.js";
import { reapUnder } from "./reaper.js";
import { AgentPool, type AgentResult } from "./pool.js";
import {
  demoUnavailable,
  pitStopDue,
  renderPitStop,
  type DemoReport,
  type PitStop,
  type PitStopDecision,
  type PitStopDue,
  type ReviewReport,
} from "./pitstop.js";
import {
  type AdvisorCheck,
  advisorAnswer,
  advisorPrompt,
  advisorSystemPrompt,
  conflictPrompt,
  demoPrompt,
  demoSystemPrompt,
  extractJson,
  extractSection,
  operatorFeedbackMessage,
  replanPrompt,
  reviewerPrompt,
  reviewerSystemPrompt,
  plannerBreakdownSystemPrompt,
  plannerDocsSystemPrompt,
  plannerRepairPrompt,
  qaSystemPrompt,
  qaTaskPrompt,
  skillsBlock,
  prodValidatorPrompt,
  prodValidatorSystemPrompt,
  validatorPrompt,
  validatorSystemPrompt,
  planIntentPrompt,
  planIntentSystemPrompt,
  workerResumePrompt,
  workerSystemPrompt,
  workerTaskPrompt,
} from "./prompts.js";
import { confirmFailures, runDeterministicChecks, splitInheritedFailures, type CheckResult } from "./qa.js";
import { estimatePlan, renderEstimate } from "./estimate.js";
import { renderIntegrations, scanIntegrations } from "./integrationScan.js";
import { detectToolbelt, toolbeltBlock } from "./toolbelt.js";
import { Store, TaskRow, type RunRow } from "./store.js";

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

/** A planner's task as it enters the store: everything it said, nothing started yet. */
function pendingRow(t: PlannedTask): Omit<TaskRow, "runId"> {
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
 * Ask for the model's full output ceiling. Note this is a request, not a promise:
 * the SDK clamps it to a per-model table keyed by substring, and a model the
 * installed SDK has never heard of falls through to 32k however high this is set.
 * That is why planning is split in two (see `plan`) instead of relying on a bigger
 * budget — the split works on any SDK version.
 */
const PLANNER_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Did the session die against the output-token ceiling rather than produce bad
 * JSON? The two look identical downstream — both end in unparseable text — but
 * they need opposite retries, so they must be told apart.
 */
function outputTruncated(resultText: string, errorDetail?: string): boolean {
  return /max_tokens|output token|response exceeded/i.test(`${errorDetail ?? ""}\n${resultText}`);
}

/** What the operator is told when a cap is reached. Never carries secrets. */
export interface BudgetGate {
  /** Which cap tripped. A task cap stops one task; the run cap stops everything. */
  scope: "run" | "task";
  taskId?: string;
  /** Spend measured against the cap that tripped. */
  spentUsd: number;
  capUsd: number;
  /** Whole-run spend, for context when it was the task cap that tripped. */
  runSpentUsd: number;
}

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
  artifacts: z.array(z.string()).default([]),
});

/** One reviewer's verdict on whether the run is still building the right thing. */
const ReviewJson = z.object({
  verdict: z.enum(["on-track", "drifting", "off-track"]),
  findings: z.array(z.string()).default([]),
  question: z.string().default(""),
});

export class RunController {
  private wt: WorktreeManager;

  constructor(
    private store: Store,
    private bus: Bus,
    private pool: AgentPool,
    private github: GitHubAdapter,
    private gates: GateHandler,
    private repoPath: string
  ) {
    this.wt = new WorktreeManager(repoPath);
    // One harness process per project: any session "running" now is a dead
    // process's leftover, not ours.
    this.store.sweepDeadSessions();
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
    if (intake) await this.intake(runId, assignment, intake);
    await this.drive(runId);
    return runId;
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
      budgetCheck: () => this.checkBudget(runId),
      // Matched on the seed — the only text that exists this early.
      skillsBlock: skillsBlock(this.selectSkills(indexSkills(run.config.skillsDirs), "intake", seed, run.config)),
      prior,
    });
    const assignment = briefToAssignment(brief);
    const dir = path.join(this.repoPath, ".harness", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "BRIEF.md"), `${assignment}\n`);
    this.store.setRunAssignment(runId, assignment);
    this.store.transitionRun(runId, "PLANNING", "brief agreed");
  }

  async resume(runId: string, intake?: IntakeUi): Promise<void> {
    await this.wt.pruneAndReconcile();
    await this.reopen(runId);
    await this.drive(runId, intake);
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
      this.revivableCancelled(runId, tasks).size > 0
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
      // Same invariant as the issue comment below: a parked task carries a
      // reason on the row or in its transition event.
      /* v8 ignore next */
      const why = t.errorSummary || this.store.taskStateReason(runId, t.id) || "parked";
      const guidance = await this.askOperator(runId, t.id, why);
      if (guidance === null) continue; // still parked; no transition needed
      this.store.updateTask(runId, t.id, { qaIterations: 0, respawns: 0, errorSummary: null });
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
    let run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    await this.sweepOrphans(runId);
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
      this.store.transitionRun(runId, "EXECUTING", "resumed after a pit stop");
      run = this.store.getRun(runId)!;
    } else if (run.state === "BUDGET_HOLD") {
      // The cap that parked it is still in force: execution re-opens the budget
      // gate on the first check, giving the operator another chance to raise it.
      this.store.transitionRun(runId, "EXECUTING", "resumed from budget hold");
      run = this.store.getRun(runId)!;
    }
    let planFeedback = "";
    while (run.state === "PLANNING" || run.state === "PLAN_REVIEW") {
      if (run.state === "PLANNING") {
        const plan = await this.plan(runId, planFeedback);
        this.persistPlan(runId, plan);
        this.store.transitionRun(runId, "PLAN_REVIEW");
      }
      // Asked here, where a gap is worth a re-plan, rather than only at
      // INTEGRATING, where the same answer costs a whole run.
      const shortfall = await this.checkPlanIntent(runId);
      const gate = await this.gates.resolvePlanGate(this.planPrd(runId), `${this.planSummary(runId)}${shortfall}`);
      if (gate.approved) {
        await this.fileIssues(runId);
        this.store.transitionRun(runId, "EXECUTING", "plan approved");
      } else {
        // The operator's words first — they saw the shortfall and are answering
        // it — with the finding appended so a re-plan closes it even when they
        // rejected for some other reason entirely.
        planFeedback = `${gate.feedback}${shortfall}`;
        this.store.transitionRun(runId, "PLANNING", "plan rejected");
      }
      run = this.store.getRun(runId)!;
    }
    // EXECUTING and INTEGRATING are a loop rather than two steps because the pit
    // stop between the intent verdict and the first pull request can send the
    // run back to work: an operator reading a FAIL is being shown it at the last
    // moment where fixing it is still cheaper than a second run.
    for (;;) {
      if (run.state === "EXECUTING") {
        if ((await this.execute(runId)) === "paused") {
          this.store.transitionRun(runId, "PAUSED", "you stopped the run at a pit stop");
          return;
        }
        this.store.transitionRun(runId, "INTEGRATING", "all tasks terminal");
        run = this.store.getRun(runId)!;
      }
      if (run.state === "INTEGRATING") {
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
          this.store.transitionRun(runId, "PAUSED", "you stopped the run at a pit stop");
          return;
        }
        if (after === "back-to-work" || fixes.length) {
          this.store.transitionRun(
            runId,
            "EXECUTING",
            after === "back-to-work" ? "you sent the run back to work at a pit stop" : `closing ${fixes.length} gap(s) the intent check found`
          );
          run = this.store.getRun(runId)!;
          continue;
        }
        await this.openPrs(runId);
        await this.awaitChecks(runId);
        this.store.transitionRun(runId, "PR_REVIEW", this.outcome(runId).line);
        run = this.store.getRun(runId)!;
      }
      break;
    }
    // A merge that already happened — an eager human merging the rollup while
    // the run was still finishing — is verified now rather than next resume.
    if (run.state === "PR_REVIEW" || run.state === "VERIFYING") {
      const closed = await this.verify(runId);
      const now = this.store.getRun(runId)!;
      if (closed && now.state === "VERIFYING") this.store.transitionRun(runId, "DONE", this.outcome(runId).line);
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
   */
  private async checkPlanIntent(runId: string): Promise<string> {
    const run = this.store.getRun(runId)!;
    if (!run.config.planIntentCheck) return "";
    const tasks = this.store.listTasks(runId);
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
        budgetCheck: () => this.checkBudget(runId),
      });
      const verdict = IntentVerdict.parse(extractJson(result.resultText));
      this.bus.publish({ type: "run.plan_intent_verdict", runId, verdict: verdict.verdict, gaps: verdict.gaps, summary: verdict.summary, ts: Date.now() });
      if (verdict.verdict === "PASS" || !verdict.gaps.length) return "";
      return [
        "",
        "",
        "What this plan would not deliver, read against your assignment:",
        ...verdict.gaps.map((g) => `  - ${g}`),
        "",
        "Every task here can pass its own acceptance criteria and still leave the",
        "above missing, because those criteria are the whole contract a worker",
        "builds to and QA checks. Rejecting sends this back to the planner with",
        "the list attached; approving accepts it as the scope.",
      ].join("\n");
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      // A plan that could not be checked is still a plan the operator may
      // approve. Say the check did not happen rather than implying it passed.
      this.bus.publish({ type: "agent.log", runId, sessionId: "validator", text: `the plan-intent check did not complete: ${String(e).slice(0, 300)}`, ts: Date.now() });
      return "\n\nThe plan-intent check did not complete, so nothing has compared this plan to your assignment.";
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
        budgetCheck: () => this.checkBudget(runId),
      });
      const verdict = IntentVerdict.parse(extractJson(result.resultText));
      this.bus.publish({ type: "run.intent_verdict", runId, verdict: verdict.verdict, gaps: verdict.gaps, summary: verdict.summary, ts: Date.now() });
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
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
      title: `Close intent gap: ${gap.split("\n")[0]!.slice(0, 80)}`,
      spec: `The run finished and a validation agent read the whole merged tree against the operator's original intent. It found this gap:\n\n${gap}\n\nWhat it concluded overall:\n${verdict.summary}\n\nClose that gap in the integration branch you are working from — it already contains every merged task, so the code the gap refers to is here. Fix the gap itself, not the surrounding design: the rest of this tree was reviewed and accepted, and a rewrite costs more than the gap did. If the gap turns out not to be real, say so in your summary with the file and line that settle it rather than changing code to satisfy it.`,
      acceptanceCriteria: [gap.split("\n")[0]!.slice(0, 300), "The claim the gap makes is no longer true of this tree, demonstrated by a check or a test that fails without the change"],
      // Chained: same omission, same file, and nothing here is urgent enough to
      // be worth a conflict.
      dependsOn: i === 0 ? [] : [`intent-fix-${round}-${i}`],
      touchedPaths: [],
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
        prompt: prodValidatorPrompt(run.assignment, this.planPrd(runId), url, taskLines),
        cwd: this.repoPath,
        // Production is read through the network, not through the checkout, and
        // an agent that can edit files here is one that can "fix" a live finding
        // into a local diff nobody asked for.
        allowedTools: ["Bash", "Read", "Glob", "Grep", "WebFetch"],
        maxTurns: 80,
        budgetCheck: () => this.checkBudget(runId),
      });
      const verdict = ProdVerdict.parse(extractJson(result.resultText));
      this.bus.publish({ type: "run.prod_verdict", runId, url, verdict: verdict.verdict, findings: verdict.findings, summary: verdict.summary, ts: Date.now() });
      return verdict.verdict === "PASS";
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
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
    let graceLeft = 4;
    let checks = await read(ref).catch(() => null);
    while (checks && Date.now() < deadline) {
      if (checks.state === "none" && graceLeft > 0) graceLeft--;
      else if (checks.state !== "pending") break;
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
   */
  private async awaitChecks(runId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    if (!run.config.waitForChecks || !this.github.enabled) return;
    const prNumber = this.rollupPr(runId);
    if (prNumber === undefined) return;
    const checks = await this.settleChecks(runId, (n: number) => this.github.prChecks?.(n) ?? Promise.resolve(null), prNumber, run.config.checkTimeoutMinutes);
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

    // SEC-5: only the harness/<runId>/* namespace is ever pushed.
    await git(this.repoPath, ["push", "origin", this.wt.integrationBranch(runId)], { serialize: true });

    // Some of this run's work may have shipped already: an eager human can merge
    // the rollup while tasks are still executing. Those merged PRs are named in
    // the body, so the reviewer of the follow-up knows this diff is the rest.
    const priors = [...new Set(merged.map((t) => t.prNumber).filter((n): n is number => n !== null))];
    const shipped: number[] = [];
    for (const n of priors) if ((await this.github.prState?.(n)) === "merged") shipped.push(n);

    const intent = this.store.intentVerdict(runId);
    const body = [
      `${merged.length} task${merged.length === 1 ? "" : "s"} merged on the run's integration branch, one \`--no-ff\` merge commit each. Opened by harness — merge is always human.`,
      "",
      ...merged.map((t) => `- ${t.title} (QA iterations: ${t.qaIterations}${t.githubIssueNumber ? `, closes #${t.githubIssueNumber}` : ""})`),
      // The reviewer arrives with the validator's answer in hand, PASS or not.
      ...(intent
        ? ["", intent.verdict === "PASS" ? "Intent check: **PASS**." : `Intent check: **FAIL** — ${intent.gaps.length || "unstated"} gap${intent.gaps.length === 1 ? "" : "s"}:`, ...intent.gaps.map((g) => `- ${g.slice(0, 500)}`)]
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
    const pr = await this.github.ensurePR(runId, "run", this.wt.integrationBranch(runId), base, title, body, { draft: stillWorking });
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
    if (!stillWorking) await this.github.markPrReady?.(runId, "run", pr.number, title, body);
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
    if (parked.length) parts.push(parked.length === 1 ? "1 task needs you" : `${parked.length} tasks need you`);
    if (cancelled) {
      parts.push(parked.length ? `${cancelled} never started, blocked behind them` : `${cancelled} never started`);
    }
    // What the repo itself said about the branch. A red CI belongs next to the
    // pull request count, not three screens down the event feed: "1 pull request
    // open for review" over a branch that does not build is the wrong headline.
    const ci = this.store.ciStatus(runId);
    if (ci && ci.state !== "none") {
      parts.push(
        ci.state === "passing"
          ? "CI green"
          : ci.state === "failing"
            ? `CI red (${ci.failing.slice(0, 3).join(", ")}${ci.failing.length > 3 ? `, +${ci.failing.length - 3} more` : ""})`
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
    return { prs, parked, merged: count("MERGED"), cancelled, total: tasks.length, intent, ci, deploy, prod, line: parts.join("; ") };
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
   */
  private async askOrPark(runId: string, taskId: string, why: string): Promise<string | null> {
    const guidance = await this.askOperator(runId, taskId, why);
    if (guidance === null) {
      this.park(runId, taskId, why);
      return null;
    }
    // The answer buys a whole new set of iterations, not one more attempt: the
    // operator just changed the conditions the old failures happened under.
    this.store.updateTask(runId, taskId, { qaIterations: 0, respawns: 0, errorSummary: null });
    return guidance;
  }

  /**
   * Open the task-escalation gate and wait for the operator's words — no state
   * changes here, so it serves both mid-run caps (askOrPark) and reviving
   * already-parked tasks on resume (reopen), where park() would be an illegal
   * NEEDS_HUMAN -> NEEDS_HUMAN transition. Null when the operator declined or
   * this gate handler has no way to ask (headless / test contexts).
   */
  private async askOperator(runId: string, taskId: string, why: string): Promise<string | null> {
    if (!this.gates.resolveTaskGate) return null;
    const task = this.store.getTask(runId, taskId)!;
    // The question arrives with a proposed answer attached: the gate blocks the
    // whole run on a human, so a minute of agent time drafting their reply is
    // the cheapest latency win in the system.
    const recommendation = await this.adviseOperator(runId, taskId, why);
    this.bus.publish({ type: "task.gate_opened", runId, taskId, why, recommendation, iterations: task.qaIterations, ts: Date.now() });
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
        why,
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
    this.bus.publish({ type: "task.gate_resolved", runId, taskId, parked: guidance === null, guidance: guidance ?? "", ts: Date.now() });
    return guidance;
  }

  /**
   * A short read-only advisor session in the stuck task's worktree, drafting
   * the answer the operator will probably give. Never fatal — a crashed or
   * unparseable advisor just means the old, question-only gate.
   *
   * The turn budget buys verification, not just reading. An advisor that only
   * summarises the rejection is worse than none: on the run where this was
   * measured, QA's third paragraph reported a real key mismatch, the draft
   * compressed it away, the operator accepted the draft in one click and the
   * worker was re-dispatched never having heard about the defect.
   */
  private async adviseOperator(runId: string, taskId: string, why: string): Promise<string> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    try {
      const result = await this.pool.run({
        runId,
        taskId,
        role: "advisor",
        model: run.config.models.advisor,
        systemPrompt: advisorSystemPrompt(),
        prompt: advisorPrompt(task, why, run.config.deterministicChecks),
        cwd: task.worktreePath ?? this.repoPath,
        disallowedTools: ["Write", "Edit", "NotebookEdit", "WebSearch"],
        maxTurns: 30,
        env: isolationEnv(taskIsolation(runId, taskId)),
        // The advisor re-runs the suite to check QA's claims, so it leaves the
        // same debris a worker does — but only when it has a worktree of its own
        // to leave it in. Falling back to the repo means sweeping the repo.
        reapOnEnd: Boolean(task.worktreePath),
      });
      const parsed = extractJson(result.resultText) as { recommendation?: unknown; checked?: unknown };
      if (typeof parsed?.recommendation !== "string") return "";
      const checked = Array.isArray(parsed.checked) ? (parsed.checked as AdvisorCheck[]) : [];
      // advisorAnswer budgets the 4000 itself, spending it on the checks first.
      return advisorAnswer(parsed.recommendation.trim(), checked);
    } catch {
      return "";
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
      this.store.updateTask(runId, target, { qaIterations: 0, respawns: 0, errorSummary: null });
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
        role: "qa",
        model: run.config.models.qa,
        systemPrompt: "You are finishing a verification you have already done. Answer with JSON and nothing else.",
        prompt:
          "Your previous message did not contain the verdict JSON this task requires. Do not investigate anything further and do not change your judgment — just state the conclusion you already reached, as exactly one JSON object inside a ```json fence:\n" +
          '{"verdict":"PASS","notes":string}\nor\n{"verdict":"FAIL","reasons":[string],"mustFix":[string]}',
        cwd,
        resume: qa.sdkSessionId,
        maxTurns: 2,
        budgetCheck: () => this.checkBudget(runId, taskId),
      });
      return QaVerdict.parse(extractJson(retry.resultText));
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
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
    const docs = await this.planDocs(runId, feedback);
    const breakdown = await this.planBreakdown(runId, docs, feedback);
    return { ...docs, ...breakdown };
  }

  /** Phase A: survey the repository and write the PRD and conventions documents. */
  private async planDocs(runId: string, feedback: string): Promise<Pick<Plan, "prdMarkdown" | "conventionsMarkdown">> {
    const run = this.store.getRun(runId)!;
    const attempts = 2;
    let lastReason = "the planner produced no output";
    let lastPath = "";

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const result = await this.pool.run({
        runId,
        role: "planner",
        model: run.config.models.planner,
        systemPrompt: plannerDocsSystemPrompt(skillsBlock(this.planSkills(runId))),
        prompt:
          `Assignment:\n${run.assignment}\n` +
          (feedback ? `\nOperator feedback on the previous plan:\n${feedback}\n` : "") +
          (attempt > 1 ? `\nYour previous attempt was rejected: ${lastReason}\n` : "") +
          `\nSurvey the repository at your working directory, then emit the <prd> and <conventions> blocks.`,
        cwd: this.repoPath,
        tools: ["Read", "Glob", "Grep"], // planning is read-only
        allowedTools: ["Read", "Glob", "Grep"],
        maxTurns: 40,
        maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
        budgetCheck: () => this.checkBudget(runId),
      });
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

  /** Phase B: the DAG. No tools — the survey happened in phase A and is quoted back. */
  private async planBreakdown(runId: string, docs: Pick<Plan, "prdMarkdown" | "conventionsMarkdown">, feedback: string): Promise<PlanBreakdown> {
    const run = this.store.getRun(runId)!;
    const attempts = 3;
    let lastReason = "the planner produced no output";
    let lastPath = "";
    let lastOutput = "";
    let lastTruncated = false;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Only the first attempt restates the PRD. A rejected breakdown is a shape
      // problem, so later attempts repair the previous JSON — re-deriving the
      // decomposition three times is what made one failed planning phase cost $3.34.
      const repair = attempt > 1 && lastOutput.length > 0;
      const result = await this.pool.run({
        runId,
        role: "planner",
        model: run.config.models.planner,
        systemPrompt: plannerBreakdownSystemPrompt(skillsBlock(this.planSkills(runId))),
        prompt: repair
          ? plannerRepairPrompt(lastOutput, lastReason, lastTruncated)
          : `Assignment:\n${run.assignment}\n${feedback ? `\nOperator feedback on the previous plan:\n${feedback}\n` : ""}\n\nYou have already surveyed the repository and written these documents. Do not use any tools.\n\n<prd>\n${docs.prdMarkdown}\n</prd>\n\n<conventions>\n${docs.conventionsMarkdown}\n</conventions>\n\nEmit the epic/task DAG as JSON.`,
        cwd: this.repoPath,
        tools: [],
        allowedTools: [],
        maxTurns: 4,
        maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
        budgetCheck: () => this.checkBudget(runId),
      });
      lastOutput = result.resultText;
      lastTruncated = outputTruncated(result.resultText, result.errorDetail);
      // Always keep the raw output: an unusable plan is expensive, and diagnosing
      // it from a one-line error is impossible.
      lastPath = this.saveAttempt(path.join(this.repoPath, ".harness", runId), `dag-${attempt}`, result.resultText);

      // Three distinct failures with three distinct fixes — never collapse them
      // into one message.
      try {
        const parsed = PlanBreakdown.safeParse(extractJson(result.resultText));
        if (parsed.success) {
          const errors = validatePlanDag({ ...docs, ...parsed.data });
          if (errors.length === 0) return parsed.data;
          lastReason = `the plan is not a valid DAG: ${errors.join("; ")}`;
        } else {
          const issues = parsed.error.issues
            .slice(0, 5)
            // `extractJson` has already guaranteed an object, so every issue has a
          // key to name; "(root)" is for a schema that grows a root-level rule.
          /* v8 ignore next */
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
          lastReason = `the breakdown does not match the required shape: ${issues}`;
        }
      } catch (e) {
        lastReason = lastTruncated
          ? "the breakdown ran past the output-token limit and was cut off mid-JSON — it is too long to emit in one message"
          // Only `extractJson` and `JSON.parse` throw in here, and both throw
          // Errors — the String() arm is for a future throw that does not.
          /* v8 ignore next */
          : `the breakdown JSON could not be read: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
      }
      lastReason = this.failedAttempt(runId, attempt, lastReason, lastPath, result.outcome, result.errorDetail);
    }
    throw this.planFailed(runId, attempts, lastReason, lastPath);
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
    return [lines, renderEstimate(estimate, run.config.budget.runCapUsd), integrations].filter(Boolean).join("\n\n");
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

  private async execute(runId: string): Promise<"complete" | "paused"> {
    const run = this.store.getRun(runId)!;
    await this.wt.ensureIntegrationBranch(runId);
    const skills = indexSkills(run.config.skillsDirs);

    // A task still marked in-flight here belongs to a harness process that died
    // mid-task: this controller is the only runner, so nothing can actually be
    // WORKING or in QA when the loop starts. Requeue it — its worktree still
    // holds every committed iteration — rather than leaving a state the
    // scheduler would eventually cancel as unreachable.
    for (const t of this.store.listTasks(runId)) {
      if (t.state === "WORKING" || t.state === "QA" || t.state === "QA_FAILED") {
        this.revivalGuidance.set(
          `${runId}/${t.id}`,
          "The previous session for this task was interrupted (the harness process died mid-task). Inspect git log in this worktree first: earlier iterations may already contain most or all of the work — verify it and finish."
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
    let budgetStop: BudgetExceeded | null = null;
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
      const due = budgetStop ? null : this.pitStopReason(runId);
      if (due && !inFlight.size) {
        await this.issueSync;
        if ((await this.pitStop(runId, due)) === "stop") return "paused";
        continue;
      }
      // Fill capacity. Re-listed per dispatch: a task that just merged may have
      // unblocked its dependents. Which runnable task goes next is `nextDispatch`
      // — the order decides what a budget cap leaves unbuilt.
      while (!budgetStop && !due && working() < cap) {
        const tasks = this.store.listTasks(runId);
        const ready = nextDispatch(tasks, new Set(inFlight.keys()));
        if (!ready) break;
        if (ready.state === "PENDING") this.store.transitionTask(runId, ready.id, "READY");
        const id = ready.id;
        const flight = this.runTask(runId, id, skills)
          .catch((e) => {
            // One task's unexpected crash must not abandon the rest of the run:
            // park it for the operator and keep driving. A budget stop is
            // run-wide — remember it, stop dispatching, and let the other
            // in-flight tasks drain (their own budget checks stop them fast).
            if (e instanceof BudgetExceeded) {
              budgetStop = budgetStop ?? e;
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
      if (budgetStop) throw budgetStop;

      const tasks = this.store.listTasks(runId);
      if (tasks.every((t) => terminal(t.state))) break;
      // Nothing runnable, nothing in flight: whatever is left waits on parked
      // or cancelled dependencies and can never start.
      for (const t of tasks) {
        if (!terminal(t.state)) {
          this.store.transitionTask(runId, t.id, "CANCELLED", "unreachable: dependencies parked");
          this.queueIssueSync(runId, t.id);
        }
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
    if (!this.gates.resolvePitStop || run.config.pitStop.every === "never") return null;
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
  private async pitStop(runId: string, due: PitStopDue): Promise<PitStopDecision["action"]> {
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
    const allMerged = mergedIds.map((id) => byId.get(id)).filter((t): t is TaskRow => Boolean(t)).map(line);

    const spentUsd = this.store.spentUsd(runId);
    // What the rest of the plan looks like at the rate the finished tasks set.
    // Crude on purpose — the operator needs "this is heading for $600" long
    // before they need a good estimate of exactly how much over it will be.
    const done = tasks.filter((t) => ["MERGED", "NEEDS_HUMAN", "CANCELLED"].includes(t.state)).length;
    const projectedUsd = done > 0 ? (spentUsd / done) * tasks.length : spentUsd;

    const demo = await this.runDemo(runId, run, number, dir, allMerged.join("\n") || "(nothing yet)", upcoming.join("\n"));
    const reviews = await this.runReviews(runId, run, demo, tasks, upcoming.join("\n"));
    // Measured rather than estimated, and shown: a checkpoint whose price is
    // invisible is one the operator cannot decide they do not want.
    const afterUsd = this.store.spentUsd(runId);

    const stop: PitStop = {
      runId,
      number,
      reason: due.reason,
      demo,
      reviews,
      merged: mergedSince,
      upcoming,
      parked,
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
      demoStarted: demo.started,
      ts: Date.now(),
    });

    const decision = await this.gates.resolvePitStop!(stop);
    const touched = await this.applyPitStop(runId, decision);
    this.bus.publish({
      type: "run.pitstop_resolved",
      runId,
      stop: number,
      action: decision.action,
      feedback: decision.feedback.slice(0, 2000),
      tasks: touched,
      ts: Date.now(),
    });
    return decision.action;
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
    if (this.store.lastEventSeq(runId, "run.pitstop_opened") > this.store.lastEventSeq(runId, "run.intent_verdict")) return "proceed";
    const action = await this.pitStop(runId, { reason: "the intent check came back FAIL", epicIds: [] });
    if (action === "stop") return "stop";
    // Redirect and replan both put work back in the queue; continuing from here
    // with tasks pending would open a pull request over an unfinished tree.
    return action === "continue" ? "proceed" : "back-to-work";
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
    upcomingLines: string
  ): Promise<DemoReport> {
    let wtPath: string | null = null;
    let head = "";
    // Overwritten on both paths below. It starts as the failure report because
    // that is what an unfinished demo *is*, and because a pit stop that cannot
    // demo anything must still open.
    let report = demoUnavailable("the demo agent did not run");
    try {
      wtPath = await this.wt.ensureIntegrationWorktree(runId);
      head = (await git(wtPath, ["rev-parse", "HEAD"])).trim();
      const skills = this.selectSkills(indexSkills(run.config.skillsDirs), "demo", run.assignment, run.config);
      const result = await this.pool.run({
        runId,
        role: "demo",
        model: run.config.models.demo,
        systemPrompt: demoSystemPrompt(dir, toolbeltBlock(detectToolbelt(run.config.externalTools)), skillsBlock(skills)),
        prompt: demoPrompt(run.assignment, mergedLines, upcomingLines),
        cwd: wtPath,
        disallowedTools: ["WebSearch"],
        maxTurns: run.config.pitStop.demoMaxTurns,
        // Its own port block and compose project, like a task worktree — a demo
        // must not collide with whatever the operator has running.
        env: isolationEnv(taskIsolation(runId, `pitstop-${number}`)),
        // It starts servers, emulators and databases by design. Nothing it
        // started outlives the pit stop.
        reapOnEnd: true,
        budgetCheck: () => this.checkBudget(runId),
      });
      report = DemoJson.parse(extractJson(result.resultText));
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      report = demoUnavailable(String(e).slice(0, 300));
    } finally {
      // Whatever it changed in the tree goes back. The demo agent is told not to
      // touch source, but "told not to" is not a mechanism, and the diff the
      // operator eventually reviews is not the demo's to edit.
      if (wtPath) await git(wtPath, ["reset", "--hard", head]).catch(() => "");
    }
    return report;
  }

  /**
   * One short session per lens, in parallel, each reading the demo.
   *
   * Three named perspectives rather than one neutral summary: the drift a
   * product lens sees and the drift a QA lens sees are different failures, and
   * a single reviewer asked for both reliably returns neither.
   */
  private async runReviews(
    runId: string,
    run: RunRow,
    demo: DemoReport,
    tasks: TaskRow[],
    upcomingLines: string
  ): Promise<ReviewReport[]> {
    const lenses = run.config.pitStop.reviewers;
    if (!lenses.length) return [];
    const indexed = indexSkills(run.config.skillsDirs);
    const wtPath = await this.wt.ensureIntegrationWorktree(runId).catch(() => this.repoPath);
    const taskLines = tasks.map((t) => `- ${t.title} (${t.id}): ${t.state}`).join("\n");
    const demoText = JSON.stringify(demo, null, 2).slice(0, 6000);
    const prd = this.planPrd(runId);
    const settled = await Promise.all(
      lenses.map(async (lens): Promise<ReviewReport | null> => {
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
            prompt: reviewerPrompt(lens, run.assignment, prd, demoText, taskLines, upcomingLines),
            cwd: wtPath,
            disallowedTools: ["Write", "Edit", "NotebookEdit", "WebSearch"],
            maxTurns: 30,
            budgetCheck: () => this.checkBudget(runId),
          });
          return { lens, ...ReviewJson.parse(extractJson(result.resultText)) };
        } catch (e) {
          if (e instanceof BudgetExceeded) throw e;
          // A lens that failed is reported as a lens that failed. Dropping it
          // silently would show the operator two opinions and imply three.
          return { lens, verdict: "on-track", findings: [`(this reviewer did not finish: ${String(e).slice(0, 200)})`], question: "" };
        }
      })
    );
    return settled.filter((r): r is ReviewReport => r !== null);
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
        maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
        budgetCheck: () => this.checkBudget(runId),
      });
      const breakdown = PlanBreakdown.parse(extractJson(result.resultText));
      const epicUnion = [
        ...epics.map((e) => ({ id: e.id, title: e.title, summary: "" })),
        ...breakdown.epics.filter((e) => !epics.some((x) => x.id === e.id)),
      ];
      const errors = validatePlanDag({
        prdMarkdown: "x",
        conventionsMarkdown: "x",
        epics: epicUnion,
        tasks: [...keep, ...breakdown.tasks],
      });
      if (errors.length) throw new Error(`re-planned DAG is invalid: ${errors.join("; ")}`);
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
      if (e instanceof BudgetExceeded) throw e;
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
          const result = await runDeterministicChecks(wtPath, run.config.deterministicChecks);
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
  private selectSkills(skills: IndexedSkill[], role: keyof typeof ROLE_SKILL_LENS, text: string, config: RunConfig) {
    // Every role that calls this has a lens; the fallback is for one added
    // later without one.
    /* v8 ignore next */
    const query = `${text}\n${ROLE_SKILL_LENS[role] ?? ""}`;
    // Routed skills are the operator's declared intent and come first; scoring
    // only fills whatever room is left, and no skill at all is a valid outcome.
    const routed = this.routedSkills(skills, config, text, role);
    const scored = matchSkills(skills, query, MAX_SKILLS_PER_ROLE)
      .filter((m) => m.score >= SKILL_SCORE_FLOOR && verifyHash(m.skill))
      .map((m) => m.skill);
    const chosen: IndexedSkill[] = [];
    for (const skill of [...routed, ...scored]) {
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
    const workerSkills = this.selectSkills(skills, "worker", taskText, run.config);
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

    this.store.transitionTask(runId, taskId, "WORKING");
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
    /** Merges handed back to the worker so far; past the cap it is the operator's. */
    let conflictFixes = 0;
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
    const ask = async (why: string): Promise<string | null> => {
      const guidance = await this.askOrPark(runId, taskId, why);
      startedAt = Date.now();
      return guidance;
    };
    for (;;) {
      task = this.store.getTask(runId, taskId)!;
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
      try {
        const worker = await this.pool.run({
          runId,
          taskId,
          role: "worker",
          model: run.config.models.worker,
          systemPrompt: workerSystemPrompt(conventions, skillsBlock(workerSkills), toolbelt),
          prompt: workerSession && qaFeedback ? workerResumePrompt(qaFeedback) : workerTaskPrompt(task, qaFeedback),
          resume: workerSession,
          cwd: wt.path,
          disallowedTools: ["WebSearch"],
          maxTurns: workerTurns,
          env: isolationEnv(iso),
          reapOnEnd: true,
          budgetCheck: () => this.checkBudget(runId, taskId),
        });
        workerSummary = worker.resultText;
        workerSession = worker.sdkSessionId ?? workerSession;
        if (worker.outcome === "error" && worker.errorDetail?.includes("error_max_turns")) {
          workerTurns = Math.min(400, Math.ceil(workerTurns * 1.5));
          this.raiseCeiling(runId, "workerMaxTurns", workerTurns);
          this.bus.publish({ type: "agent.log", runId, taskId, sessionId: worker.sessionId, text: `worker ran out of turns; the next dispatch on this task gets ${workerTurns}`, ts: Date.now() });
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
        if (e instanceof BudgetExceeded) throw e;
        workerSession = undefined;
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

      // Deterministic checks before QA tokens (PRD §11.1)
      const checks = await runDeterministicChecks(wt.path, run.config.deterministicChecks);
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
      const { failures, inherited, flaky } = checks.ok
        ? { failures: [], inherited: [], flaky: [] }
        : await confirmFailures(wt.path, splitInheritedFailures(checks, base!), base!);
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

      this.store.transitionTask(runId, taskId, "QA");
      const diffStat = await git(wt.path, ["diff", "--stat", `${this.wt.integrationBranch(runId)}...HEAD`]).catch(() => "unavailable");
      let qa;
      try {
        qa = await this.pool.run({
          runId,
          taskId,
          role: "qa",
          model: run.config.models.qa,
          systemPrompt: qaSystemPrompt(toolbelt, skillsBlock(qaSkills)),
          prompt: qaTaskPrompt(
            task,
            workerSummary.slice(0, 4000),
            diffStat.slice(0, 2000),
            this.store.drainFeedback(runId, taskId) || undefined,
            inherited.map((i) => i.command)
          ),
          cwd: wt.path,
          disallowedTools: ["WebSearch"],
          maxTurns: qaTurns,
          env: isolationEnv(iso),
          reapOnEnd: true,
          budgetCheck: () => this.checkBudget(runId, taskId),
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
        if (e instanceof BudgetExceeded) throw e;
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
   * Continuous integration: merge on accept (PRD §11.1 Integrator); PRs wait for
   * openPrs. Reports a conflict rather than parking on it — the caller decides
   * whether the worker gets a go at it first.
   */
  private async integrate(runId: string, taskId: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    const merge = await this.wt.mergeTaskBranch(runId, taskId);
    if (!merge.ok) {
      // Branch is set by ensureWorktree before the task can ever be merged;
    // the fallback is for the column type, not for a state that occurs.
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
      await this.github.commentOnIssue(
        issue,
        key,
        // `park()` always records a reason, so the literal is unreachable; it is
        // there so a future path that parks without one still says something.
        /* v8 ignore next */
        `**Parked for a human** — ${task.errorSummary || why || "the harness could not finish it"}\n\n` +
          `The work so far is on \`${task.branch ?? "no branch"}\`. While the run is still going, a reply in this thread is picked up as guidance and the task is dispatched again.`
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

    // SEC-5: push only harness/<runId>/* branches, never the base branch. Both are
    // append-only, so a plain push is always a fast-forward — nothing is ever
    // forced, and a rejection is a real problem worth surfacing.
    await git(this.repoPath, ["push", "origin", task.branch], { serialize: true });
    await git(this.repoPath, ["push", "origin", this.wt.integrationBranch(runId)], { serialize: true });

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

  /** The branch HEAD is on, or "" when detached. */
  private async currentBranch(): Promise<string> {
    const name = await git(this.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
    return name === "HEAD" ? "" : name;
  }

  // ---- budget (PERF-7: checked before/while every agent turn) ----

  private async checkBudget(runId: string, taskId?: string): Promise<void> {
    await this.enforce(runId, "run");
    if (taskId) await this.enforce(runId, "task", taskId);
  }

  /**
   * With parallel workers, several sessions can trip a cap in the same tick,
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
  private async enforce(runId: string, scope: "run" | "task", taskId?: string): Promise<void> {
    // Fast path outside the queue: the overwhelmingly common under-cap check
    // must not serialize every streamed message of every parallel session.
    if (this.store.spentUsd(runId, taskId) < this.capFor(runId, scope)) return;
    const prev = this.budgetChain;
    let release!: () => void;
    this.budgetChain = new Promise((r) => (release = r));
    try {
      await prev;
      await this.enforceNow(runId, scope, taskId);
    } finally {
      release();
    }
  }

  private capFor(runId: string, scope: "run" | "task"): number {
    const run = this.store.getRun(runId)!;
    return scope === "run" ? run.config.budget.runCapUsd : run.config.budget.taskCapUsd;
  }

  private async enforceNow(runId: string, scope: "run" | "task", taskId?: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const cap = scope === "run" ? run.config.budget.runCapUsd : run.config.budget.taskCapUsd;
    const spent = this.store.spentUsd(runId, taskId);
    // `enforce` already returned for anything under the cap, and spend only
    // grows — so this is a re-check that cannot fire, kept because the queue
    // between the two makes "still over?" the honest question to ask here.
    /* v8 ignore next */
    if (spent < cap) return;
    // The operator already declined while this check was queued — every other
    // session stops on its next check without opening the gate again.
    if (run.state === "BUDGET_HOLD") throw new BudgetExceeded(scope, spent, cap, runId);

    const gateId = randomUUID().slice(0, 8);
    // BUDGET_HOLD is only reachable while building; during intake or planning the
    // gate still opens, the run just has no held state to sit in.
    const held = run.state === "EXECUTING" || run.state === "INTEGRATING" ? run.state : null;
    if (held) this.store.transitionRun(runId, "BUDGET_HOLD", `${scope} cap $${cap.toFixed(2)} reached at $${spent.toFixed(2)}`);
    const payload: BudgetGate = { scope, taskId, spentUsd: spent, capUsd: cap, runSpentUsd: this.store.spentUsd(runId) };
    this.bus.publish({ type: "run.gate_opened", runId, gateId, kind: "budget", payload, ts: Date.now() });

    const raised = await this.gates.resolveBudgetGate(payload);
    const ok = raised !== null && Number.isFinite(raised) && raised > spent;
    this.bus.publish({
      type: "run.gate_resolved",
      runId,
      gateId,
      kind: "budget",
      resolution: ok ? "approved" : "rejected",
      feedback: ok ? `${scope} cap raised to $${raised!.toFixed(2)}` : "operator declined to raise the cap",
      ts: Date.now(),
    });

    if (!ok) throw new BudgetExceeded(scope, spent, cap, runId);

    const budget = { ...run.config.budget, [scope === "run" ? "runCapUsd" : "taskCapUsd"]: raised! };
    this.store.setRunBudget(runId, budget);
    this.bus.publish({ type: "run.budget_updated", runId, spentUsd: spent, capUsd: raised!, ts: Date.now() });
    if (held) this.store.transitionRun(runId, held, `${scope} cap raised to $${raised!.toFixed(2)}`);
  }

  private readConventions(runId: string): string {
    try {
      return readFileSync(path.join(this.repoPath, ".harness", runId, "CONVENTIONS.md"), "utf8");
    } catch {
      return "Follow the existing repository conventions.";
    }
  }
}
