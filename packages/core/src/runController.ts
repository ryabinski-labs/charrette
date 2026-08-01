import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Plan, PlanBreakdown, QaVerdict, RunConfig, TaskState, briefToAssignment, validatePlanDag } from "@harness/shared";
import { indexSkills, matchSkills, verifyHash, type IndexedSkill } from "@harness/skills-mcp";
import { Bus } from "./bus.js";
import { BudgetExceeded } from "./budget.js";
import { seedWorktreeDeps } from "./deps.js";
import { git, WorktreeManager } from "./git.js";
import { GitHubAdapter, type PrRef } from "./github.js";
import { runIntake, type IntakeUi } from "./intake.js";
import { AgentPool } from "./pool.js";
import {
  advisorPrompt,
  advisorSystemPrompt,
  extractJson,
  extractSection,
  operatorFeedbackMessage,
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
  workerResumePrompt,
  workerSystemPrompt,
  workerTaskPrompt,
} from "./prompts.js";
import { runDeterministicChecks } from "./qa.js";
import { detectToolbelt, toolbeltBlock } from "./toolbelt.js";
import { Store, TaskRow } from "./store.js";

const FULL_TEXT_SKILL_TOKEN_LIMIT = 1500; // PERF-4
const MAX_FULL_TEXT_SKILLS = 2;

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
  qa: "QA quality assurance verify verification testing test end-to-end e2e regression review evidence security",
  // Pulls the operator's own production-validation and QA playbooks in, so the
  // live check is run the way they would run it rather than improvised.
  prod: "production prod live deployed deployment validate validation smoke health monitoring uptime QA end-to-end e2e verify evidence release",
};

/**
 * Injection floor, above matchSkills' own permissive cutoff. Against a real
 * skill corpus a genuine match scores well above 1; incidental term overlap
 * lands under ~0.4. A session with no relevant skill should carry none.
 */
const SKILL_SCORE_FLOOR = 0.5;

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
}

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
  private async intake(runId: string, seed: string, ui: IntakeUi): Promise<void> {
    this.store.transitionRun(runId, "INTAKE");
    const run = this.store.getRun(runId)!;
    const brief = await runIntake(this.pool, this.bus, {
      runId,
      seed,
      repoPath: this.repoPath,
      config: run.config,
      ui,
      budgetCheck: () => this.checkBudget(runId),
    });
    const assignment = briefToAssignment(brief);
    const dir = path.join(this.repoPath, ".harness", runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "BRIEF.md"), `${assignment}\n`);
    this.store.setRunAssignment(runId, assignment);
    this.store.transitionRun(runId, "PLANNING", "brief agreed");
  }

  async resume(runId: string): Promise<void> {
    await this.wt.pruneAndReconcile();
    await this.reopen(runId);
    await this.drive(runId);
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

  /** Drive the run state machine forward until a terminal state or gate rejection. */
  private async drive(runId: string): Promise<void> {
    let run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.state === "CREATED") {
      this.store.transitionRun(runId, "PLANNING");
      run = this.store.getRun(runId)!;
    } else if (run.state === "INTAKE") {
      // Resumed while a conversation was open: the brief is gone, so plan from
      // whatever assignment is on record rather than re-interviewing.
      this.store.transitionRun(runId, "PLANNING", "resumed mid-intake");
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
      const gate = await this.gates.resolvePlanGate(this.planPrd(runId), this.planSummary(runId));
      if (gate.approved) {
        await this.fileIssues(runId);
        this.store.transitionRun(runId, "EXECUTING", "plan approved");
      } else {
        planFeedback = gate.feedback;
        this.store.transitionRun(runId, "PLANNING", "plan rejected");
      }
      run = this.store.getRun(runId)!;
    }
    if (run.state === "EXECUTING") {
      await this.execute(runId);
      this.store.transitionRun(runId, "INTEGRATING", "all tasks terminal");
      run = this.store.getRun(runId)!;
    }
    if (run.state === "INTEGRATING") {
      // Last step before any PR exists: does the merged whole do what was asked?
      // Task-level QA cannot answer that — it judged each task against its own
      // criteria, never the sum against the intent. Only after the verdict do the
      // pull requests open, so a reviewer arrives with the gap list in hand.
      await this.validateIntent(runId);
      await this.openPrs(runId);
      await this.awaitChecks(runId);
      this.store.transitionRun(runId, "PR_REVIEW", this.outcome(runId).line);
      run = this.store.getRun(runId)!;
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
      const skills = this.selectSkills(indexSkills(run.config.skillsDirs), "prod", {
        title: "validate the deployed system in production",
        spec: run.assignment,
      } as TaskRow);
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
    const guidance = (await this.gates.resolveTaskGate({
      runId,
      taskId,
      title: task.title,
      why,
      recommendation,
      iterations: task.qaIterations,
      branch: task.branch,
      worktreePath: task.worktreePath,
    }))?.trim() || null;
    this.bus.publish({ type: "task.gate_resolved", runId, taskId, parked: guidance === null, guidance: guidance ?? "", ts: Date.now() });
    return guidance;
  }

  /**
   * A short read-only advisor session in the stuck task's worktree, drafting
   * the answer the operator will probably give. Never fatal — a crashed or
   * unparseable advisor just means the old, question-only gate.
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
        prompt: advisorPrompt(task, why),
        cwd: task.worktreePath ?? this.repoPath,
        disallowedTools: ["Write", "Edit", "NotebookEdit", "WebSearch"],
        maxTurns: 15,
      });
      const parsed = extractJson(result.resultText) as { recommendation?: unknown };
      return typeof parsed?.recommendation === "string" ? parsed.recommendation.trim().slice(0, 1500) : "";
    } catch {
      return "";
    }
  }

  /** Operator guidance for tasks revived by `reopen`, consumed by the first worker dispatch. */
  private revivalGuidance = new Map<string, string>();

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
    // dispatch and takes READY ones first, so a revived task is picked up
    // within one worker slot. After EXECUTING nothing is watching, and the
    // note waits in the queue for `reopen` on the next resume — where it now
    // survives to be read, which is the whole point of persisting it.
    const revived = !hit && task.state === "NEEDS_HUMAN" && this.store.getRun(runId)?.state === "EXECUTING";
    if (revived) {
      this.store.updateTask(runId, target, { qaIterations: 0, respawns: 0, errorSummary: null });
      this.store.transitionTask(runId, target, "READY", "reopened by the operator's feedback");
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
        systemPrompt: plannerDocsSystemPrompt(),
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
        systemPrompt: plannerBreakdownSystemPrompt(),
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
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ");
          lastReason = `the breakdown does not match the required shape: ${issues}`;
        }
      } catch (e) {
        lastReason = lastTruncated
          ? "the breakdown ran past the output-token limit and was cut off mid-JSON — it is too long to emit in one message"
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
      plan.tasks.map((t) => ({
        id: t.id,
        epicId: t.epicId,
        title: t.title,
        spec: t.spec,
        acceptanceCriteria: t.acceptanceCriteria,
        dependsOn: t.dependsOn,
        state: "PENDING" as TaskState,
        branch: null,
        worktreePath: null,
        githubIssueNumber: null,
        prNumber: null,
        qaIterations: 0,
        respawns: 0,
        assignedSkills: [],
        errorSummary: null,
      }))
    );
    void run;
  }

  private planPrd(runId: string): string {
    const run = this.store.getRun(runId)!;
    return run.prdPath ? readFileSync(run.prdPath, "utf8") : "";
  }

  private planSummary(runId: string): string {
    const tasks = this.store.listTasks(runId);
    return tasks.map((t) => `- [${t.id}] ${t.title} (deps: ${t.dependsOn.join(", ") || "none"})`).join("\n");
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

  private async execute(runId: string): Promise<void> {
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

    for (;;) {
      // Fill capacity. Re-listed per dispatch: a task that just merged may have
      // unblocked its dependents. A task already READY was revived by `reopen`
      // — it goes first.
      while (!budgetStop && inFlight.size < cap) {
        const tasks = this.store.listTasks(runId);
        const merged = new Set(tasks.filter((t) => t.state === "MERGED").map((t) => t.id));
        const ready =
          tasks.find((t) => t.state === "READY" && !inFlight.has(t.id)) ??
          tasks.find((t) => t.state === "PENDING" && !inFlight.has(t.id) && t.dependsOn.every((d) => merged.has(d)));
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
          });
        inFlight.set(id, flight);
      }

      if (inFlight.size) {
        await Promise.race(inFlight.values());
        continue;
      }
      if (budgetStop) throw budgetStop;

      const tasks = this.store.listTasks(runId);
      if (tasks.every((t) => terminal(t.state))) break;
      // Nothing runnable, nothing in flight: whatever is left waits on parked
      // or cancelled dependencies and can never start.
      for (const t of tasks) {
        if (!terminal(t.state)) this.store.transitionTask(runId, t.id, "CANCELLED", "unreachable: dependencies parked");
      }
      break;
    }
  }

  /** Match, hash-verify, and budget the skills one role's session will carry. */
  private selectSkills(skills: IndexedSkill[], role: keyof typeof ROLE_SKILL_LENS, task: TaskRow) {
    const query = `${task.title}\n${task.spec}\n${ROLE_SKILL_LENS[role] ?? ""}`;
    const matches = matchSkills(skills, query, 3).filter((m) => m.score >= SKILL_SCORE_FLOOR && verifyHash(m.skill));
    let fullCount = 0;
    return matches.map((m) => {
      const full = m.skill.tokensApprox <= FULL_TEXT_SKILL_TOKEN_LIMIT && fullCount < MAX_FULL_TEXT_SKILLS;
      if (full) fullCount++;
      return { name: m.skill.name, path: m.skill.path, sha256: m.skill.sha256, content: full ? m.skill.body : undefined };
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
      const seeded = await seedWorktreeDeps(wt.path);
      if (seeded) this.bus.publish({ type: "task.deps_seeded", runId, taskId, ...seeded, ts: Date.now() });
    }

    let task = this.store.getTask(runId, taskId)!;
    // Skill matching + provenance (SEC-14, PERF-4). Selected once per task,
    // per role: workers match on the task text alone, QA matches with a
    // verification lens on top (ROLE_SKILL_LENS).
    const workerSkills = this.selectSkills(skills, "worker", task);
    const qaSkills = this.selectSkills(skills, "qa", task);
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
    // Stated once per task, ahead of the task block, so it stays prompt-cacheable.
    const toolbelt = toolbeltBlock(detectToolbelt(run.config.externalTools));
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
    let startedAt = Date.now();
    for (;;) {
      task = this.store.getTask(runId, taskId)!;
      // Wall clock (taskWallClockMinutes): a task looping past its bound is a
      // task going nowhere — ask the operator rather than iterating forever.
      // Their answer resets the clock along with the iteration caps.
      if (Date.now() - startedAt > run.config.taskWallClockMinutes * 60_000) {
        const guidance = await this.askOrPark(
          runId,
          taskId,
          `still not accepted after ${run.config.taskWallClockMinutes} minutes of wall clock (${task.qaIterations} QA iterations so far)`
        );
        if (guidance === null) return;
        startedAt = Date.now();
        qaFeedback =
          `The operator reviewed why this task is taking so long and says — follow it over anything that contradicts it:\n${guidance}` +
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
          maxTurns: 100,
          budgetCheck: () => this.checkBudget(runId, taskId),
        });
        workerSummary = worker.resultText;
        workerSession = worker.sdkSessionId ?? workerSession;
      } catch (e) {
        if (e instanceof BudgetExceeded) throw e;
        workerSession = undefined;
        const respawns = task.respawns + 1;
        this.store.updateTask(runId, taskId, { respawns, errorSummary: String(e).slice(0, 500) });
        if (respawns >= run.config.workerRespawnCap) {
          const guidance = await this.askOrPark(runId, taskId, `worker crashed ${respawns} times (the cap); last: ${String(e).slice(0, 200)}`);
          if (guidance === null) return;
          qaFeedback = `The operator looked at the repeated crashes and says:\n${guidance}\nInspect git log in this worktree and continue.`;
          continue;
        }
        qaFeedback = `Previous session was interrupted (${String(e).slice(0, 200)}). Inspect git log in this worktree and continue.`;
        continue;
      }

      // Deterministic checks before QA tokens (PRD §11.1)
      const checks = await runDeterministicChecks(wt.path, run.config.deterministicChecks);
      if (!checks.ok) {
        qaFeedback = `Deterministic checks failed. Fix these before finishing:\n${checks.failures.map((f) => `$ ${f.command}\n${f.output}`).join("\n\n")}`;
        const iterations = task.qaIterations + 1;
        this.store.updateTask(runId, taskId, { qaIterations: iterations });
        if (iterations >= run.config.qaIterationCap) {
          const guidance = await this.askOrPark(
            runId,
            taskId,
            `deterministic checks still failing after ${iterations} attempts: ${checks.failures.map((f) => f.command).join(", ")}\n\n${checks.failures.map((f) => f.output.slice(-1500)).join("\n")}`
          );
          if (guidance === null) return;
          qaFeedback = `The operator looked at the failing checks and says:\n${guidance}\n\nThe checks that were failing:\n${checks.failures.map((f) => `$ ${f.command}\n${f.output}`).join("\n\n")}`;
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
          prompt: qaTaskPrompt(task, workerSummary.slice(0, 4000), diffStat.slice(0, 2000), this.store.drainFeedback(runId, taskId) || undefined),
          cwd: wt.path,
          disallowedTools: ["WebSearch"],
          maxTurns: qaTurns,
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
        if (/max_turns/.test(String(e))) qaTurns = Math.min(300, Math.round(qaTurns * 1.5));
        const respawns = task.respawns + 1;
        this.store.updateTask(runId, taskId, { respawns, errorSummary: String(e).slice(0, 500) });
        if (respawns >= run.config.workerRespawnCap) {
          const guidance = await this.askOrPark(runId, taskId, `QA ended without a verdict ${respawns} times (the cap); last: ${String(e).slice(0, 200)}`);
          if (guidance === null) return;
          qaFeedback = `QA never delivered a verdict — the work itself may be fine, and was never judged — and the operator stepped in with guidance; follow it over anything that contradicts it:\n${guidance}`;
        } else {
          qaFeedback = `The previous QA session ended without a verdict (${String(e).slice(0, 200)}) — the work itself may be fine, and was never judged. Inspect git log in this worktree, verify the committed work, and finish. Leave the verification cheap to repeat: a deterministic check or a command recorded in the commit message beats a long manual investigation QA has to redo.`;
        }
        this.store.transitionTask(runId, taskId, "QA_FAILED", "QA ended without a verdict");
        this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched after QA returned no verdict");
        continue;
      }

      let verdict: QaVerdict;
      try {
        verdict = QaVerdict.parse(extractJson(qa.resultText));
      } catch {
        // Reached only when the session ended cleanly and still wrote something
        // that is not a verdict — a QA agent that ignored its output contract,
        // which is a real finding about the run and does count as an iteration.
        verdict = { verdict: "FAIL", reasons: ["QA finished but wrote no valid verdict JSON"], mustFix: ["re-run"] };
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
        break;
      }
      if (iterations >= run.config.qaIterationCap) {
        const guidance = await this.askOrPark(runId, taskId, `QA rejected it ${iterations} times (the cap): ${verdict.reasons.join("; ")}`);
        if (guidance === null) return;
        this.store.transitionTask(runId, taskId, "QA_FAILED", "cap reached; operator answered the escalation");
        this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched with the operator's guidance");
        qaFeedback = `QA rejected the previous iteration, and the operator stepped in with guidance — follow it over anything that contradicts it:\n${guidance}\n\nQA's reasons were: ${verdict.reasons.join("; ")}`;
        continue;
      }
      this.store.transitionTask(runId, taskId, "QA_FAILED", verdict.reasons.join("; "));
      this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched with mustFix list");
      qaFeedback = `QA rejected the previous iteration.\nReasons: ${verdict.reasons.join("; ")}\nMust fix:\n${verdict.mustFix.map((m) => `- ${m}`).join("\n")}`;
    }

    await this.integrate(runId, taskId);
  }

  /** Continuous integration: merge on accept (PRD §11.1 Integrator); PRs wait for openPrs. */
  private async integrate(runId: string, taskId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    const merge = await this.wt.mergeTaskBranch(runId, taskId);
    if (!merge.ok) {
      this.bus.publish({ type: "git.merge_conflict", runId, taskId, branch: task.branch ?? "", files: merge.conflicts, ts: Date.now() });
      this.park(runId, taskId, `merge conflicts in ${merge.conflicts.join(", ")}`);
      return;
    }
    this.store.transitionTask(runId, taskId, "MERGED");
    this.bus.publish({ type: "git.merged", runId, taskId, branch: task.branch ?? "", sha: merge.sha, ts: Date.now() });
    // The PR is NOT opened here. Merging is continuous; publishing waits until
    // the whole run has been validated against the operator's intent (openPrs),
    // so no reviewer ever sees a PR the harness has not finished judging.
    void run;
  }

  private async openTaskPr(runId: string, taskId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    const base = run.config.baseBranch;
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
