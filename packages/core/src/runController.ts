import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Plan, QaVerdict, RunConfig, TaskState, validatePlanDag } from "@harness/shared";
import { indexSkills, matchSkills, verifyHash, type IndexedSkill } from "@harness/skills-mcp";
import { Bus } from "./bus.js";
import { BudgetExceeded } from "./budget.js";
import { git, WorktreeManager } from "./git.js";
import { GitHubAdapter } from "./github.js";
import { AgentPool } from "./pool.js";
import {
  extractJson,
  plannerSystemPrompt,
  qaSystemPrompt,
  qaTaskPrompt,
  skillsBlock,
  workerSystemPrompt,
  workerTaskPrompt,
} from "./prompts.js";
import { runDeterministicChecks } from "./qa.js";
import { Store, TaskRow } from "./store.js";

const FULL_TEXT_SKILL_TOKEN_LIMIT = 1500; // PERF-4
const MAX_FULL_TEXT_SKILLS = 2;

export interface GateHandler {
  /** Present the plan; resolve with approval or rejection feedback. */
  resolvePlanGate(prdMarkdown: string, planSummary: string): Promise<{ approved: boolean; feedback: string }>;
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
  }

  async startRun(assignment: string, config: RunConfig): Promise<string> {
    const runId = randomUUID().slice(0, 8);
    this.store.createRun({
      id: runId,
      repoPath: this.repoPath,
      assignment,
      state: "CREATED",
      prdPath: null,
      planHash: null,
      integrationBranch: this.wt.integrationBranch(runId),
      config,
    });
    await this.drive(runId);
    return runId;
  }

  async resume(runId: string): Promise<void> {
    await this.wt.pruneAndReconcile();
    await this.drive(runId);
  }

  /** Drive the run state machine forward until a terminal state or gate rejection. */
  private async drive(runId: string): Promise<void> {
    let run = this.store.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    if (run.state === "CREATED") {
      this.store.transitionRun(runId, "PLANNING");
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
      this.store.transitionRun(runId, "PR_REVIEW", "PRs opened; human review on GitHub");
    }
  }

  // ---- planning ----

  private async plan(runId: string, feedback: string): Promise<Plan> {
    const run = this.store.getRun(runId)!;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await this.pool.run({
        runId,
        role: "planner",
        model: run.config.models.planner,
        systemPrompt: plannerSystemPrompt(),
        prompt: `Assignment:\n${run.assignment}\n${feedback ? `\nOperator feedback on the previous plan:\n${feedback}` : ""}\n\nSurvey the repository at your working directory (read key files, do NOT dump whole trees into context), then produce the plan JSON.`,
        cwd: this.repoPath,
        allowedTools: ["Read", "Glob", "Grep"],
        maxTurns: 40,
        budgetCheck: () => this.checkBudget(runId),
      });
      try {
        const plan = Plan.parse(extractJson(result.resultText));
        const errors = validatePlanDag(plan);
        if (errors.length === 0) return plan;
        feedback = `Your previous plan failed DAG validation:\n${errors.join("\n")}`;
      } catch (e) {
        feedback = `Your previous output failed schema validation: ${String(e).slice(0, 500)}`;
      }
    }
    this.store.transitionRun(runId, "FAILED", "planner could not produce a valid plan after 3 attempts");
    throw new Error("planning failed");
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

    // v0.0 walking skeleton: serial execution (maxParallelWorkers=1). The scheduler
    // shape (ready-queue over the DAG) is already what v0.1 parallelism needs.
    for (;;) {
      const tasks = this.store.listTasks(runId);
      const merged = new Set(tasks.filter((t) => t.state === "MERGED").map((t) => t.id));
      const terminal = (s: TaskState) => ["MERGED", "NEEDS_HUMAN", "CANCELLED"].includes(s);
      if (tasks.every((t) => terminal(t.state))) break;
      // Ready = PENDING with all deps MERGED (continuous integration, PRD §11.5).
      const ready = tasks.find((t) => t.state === "PENDING" && t.dependsOn.every((d) => merged.has(d)));
      if (!ready) {
        const blocked = tasks.filter((t) => !terminal(t.state)).map((t) => t.id);
        for (const id of blocked) this.store.transitionTask(runId, id, "CANCELLED", "unreachable: dependencies parked");
        break;
      }
      this.store.transitionTask(runId, ready.id, "READY");
      await this.runTask(runId, ready.id, skills);
    }
  }

  private async runTask(runId: string, taskId: string, skills: IndexedSkill[]): Promise<void> {
    const run = this.store.getRun(runId)!;
    const wt = await this.wt.ensureWorktree(runId, taskId);
    this.store.updateTask(runId, taskId, { branch: wt.branch, worktreePath: wt.path });
    this.bus.publish({ type: "git.worktree_created", runId, taskId, path: wt.path, branch: wt.branch, ts: Date.now() });

    let task = this.store.getTask(runId, taskId)!;
    // Skill matching + provenance (SEC-14, PERF-4)
    const matches = matchSkills(skills, `${task.title}\n${task.spec}`, 3).filter((m) => verifyHash(m.skill));
    let fullCount = 0;
    const injected = matches.map((m) => {
      const full = m.skill.tokensApprox <= FULL_TEXT_SKILL_TOKEN_LIMIT && fullCount < MAX_FULL_TEXT_SKILLS;
      if (full) fullCount++;
      return { name: m.skill.name, path: m.skill.path, sha256: m.skill.sha256, content: full ? m.skill.body : undefined };
    });
    this.store.updateTask(runId, taskId, {
      assignedSkills: injected.map((s) => ({ name: s.name, sha256: s.sha256, mode: s.content ? ("full" as const) : ("reference" as const) })),
    });
    if (injected.length) {
      this.bus.publish({
        type: "skills.injected", runId, taskId,
        skills: injected.map((s) => ({ name: s.name, sha256: s.sha256, mode: s.content ? ("full" as const) : ("reference" as const) })),
        ts: Date.now(),
      });
    }

    const conventions = this.readConventions(runId);
    let workerSummary = "";
    let qaFeedback: string | undefined;

    this.store.transitionTask(runId, taskId, "WORKING");
    for (;;) {
      task = this.store.getTask(runId, taskId)!;
      try {
        const worker = await this.pool.run({
          runId,
          taskId,
          role: "worker",
          model: run.config.models.worker,
          systemPrompt: workerSystemPrompt(conventions, skillsBlock(injected)),
          prompt: workerTaskPrompt(task, qaFeedback),
          cwd: wt.path,
          disallowedTools: ["WebSearch"],
          maxTurns: 100,
          budgetCheck: () => this.checkBudget(runId, taskId),
        });
        workerSummary = worker.resultText;
      } catch (e) {
        if (e instanceof BudgetExceeded) throw e;
        const respawns = task.respawns + 1;
        this.store.updateTask(runId, taskId, { respawns, errorSummary: String(e).slice(0, 500) });
        if (respawns >= run.config.workerRespawnCap) {
          this.store.transitionTask(runId, taskId, "NEEDS_HUMAN", "worker crash cap reached");
          return;
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
          this.store.transitionTask(runId, taskId, "NEEDS_HUMAN", "iteration cap hit on deterministic checks");
          return;
        }
        continue;
      }

      this.store.transitionTask(runId, taskId, "QA");
      const diffStat = await git(wt.path, ["diff", "--stat", `${this.wt.integrationBranch(runId)}...HEAD`]).catch(() => "unavailable");
      const qa = await this.pool.run({
        runId,
        taskId,
        role: "qa",
        model: run.config.models.qa,
        systemPrompt: qaSystemPrompt(),
        prompt: qaTaskPrompt(task, workerSummary.slice(0, 4000), diffStat.slice(0, 2000)),
        cwd: wt.path,
        disallowedTools: ["WebSearch"],
        maxTurns: 60,
        budgetCheck: () => this.checkBudget(runId, taskId),
      });

      let verdict: QaVerdict;
      try {
        verdict = QaVerdict.parse(extractJson(qa.resultText));
      } catch {
        verdict = { verdict: "FAIL", reasons: ["QA output unparseable"], mustFix: ["re-run"] };
      }
      const iterations = this.store.getTask(runId, taskId)!.qaIterations + 1;
      this.store.updateTask(runId, taskId, { qaIterations: iterations });
      this.bus.publish({ type: "task.qa_verdict", runId, taskId, verdict: verdict.verdict, iteration: iterations, detail: verdict, ts: Date.now() });

      if (verdict.verdict === "PASS") {
        this.store.transitionTask(runId, taskId, "ACCEPTED", verdict.notes);
        break;
      }
      if (iterations >= run.config.qaIterationCap) {
        this.store.transitionTask(runId, taskId, "NEEDS_HUMAN", `QA iteration cap: ${verdict.reasons.join("; ")}`);
        return;
      }
      this.store.transitionTask(runId, taskId, "QA_FAILED", verdict.reasons.join("; "));
      this.store.transitionTask(runId, taskId, "WORKING", "re-dispatched with mustFix list");
      qaFeedback = `QA rejected the previous iteration.\nReasons: ${verdict.reasons.join("; ")}\nMust fix:\n${verdict.mustFix.map((m) => `- ${m}`).join("\n")}`;
    }

    await this.integrate(runId, taskId);
  }

  /** Continuous integration: merge on accept, then open the PR (PRD §11.1 Integrator). */
  private async integrate(runId: string, taskId: string): Promise<void> {
    const run = this.store.getRun(runId)!;
    const task = this.store.getTask(runId, taskId)!;
    const merge = await this.wt.mergeTaskBranch(runId, taskId);
    if (!merge.ok) {
      this.bus.publish({ type: "git.merge_conflict", runId, taskId, branch: task.branch ?? "", files: merge.conflicts, ts: Date.now() });
      this.store.transitionTask(runId, taskId, "NEEDS_HUMAN", `merge conflicts: ${merge.conflicts.join(", ")}`);
      return;
    }
    this.store.transitionTask(runId, taskId, "MERGED");
    this.bus.publish({ type: "git.merged", runId, taskId, branch: task.branch ?? "", sha: merge.sha, ts: Date.now() });

    if (this.github.enabled && task.branch) {
      // SEC-5: push only harness/<runId>/* branches, never the default branch.
      await git(this.repoPath, ["push", "origin", task.branch], { serialize: true }).catch(() => undefined);
      await git(this.repoPath, ["push", "origin", this.wt.integrationBranch(runId)], { serialize: true }).catch(() => undefined);
      const pr = await this.github.ensurePR(
        runId,
        taskId,
        task.branch,
        this.wt.integrationBranch(runId),
        task.title,
        `Implements ${task.title}.${task.githubIssueNumber ? `\n\nCloses #${task.githubIssueNumber}` : ""}\n\nQA iterations: ${task.qaIterations}. Opened by harness — merge is always human.`
      );
      if (pr) {
        this.store.updateTask(runId, taskId, { prNumber: pr.number });
        this.bus.publish({ type: "github.pr_opened", runId, taskId, prNumber: pr.number, url: pr.url, ts: Date.now() });
      }
    }
    void run;
  }

  // ---- budget (PERF-7: checked before/while every agent turn) ----

  private checkBudget(runId: string, taskId?: string): void {
    const run = this.store.getRun(runId)!;
    const spentRun = this.store.spentUsd(runId);
    if (spentRun >= run.config.budget.runCapUsd) throw new BudgetExceeded("run", spentRun, run.config.budget.runCapUsd);
    if (taskId) {
      const spentTask = this.store.spentUsd(runId, taskId);
      if (spentTask >= run.config.budget.taskCapUsd) throw new BudgetExceeded("task", spentTask, run.config.budget.taskCapUsd);
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
