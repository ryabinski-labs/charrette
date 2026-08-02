import { z } from "zod";
import { AgentRole, GateKind, GateState, RunState, TaskState } from "./states.js";

const base = { runId: z.string(), ts: z.number().int() };

export const HarnessEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run.created"), assignment: z.string(), repoPath: z.string() }),
  z.object({ ...base, type: z.literal("run.state_changed"), from: RunState, to: RunState, reason: z.string().default("") }),
  z.object({ ...base, type: z.literal("run.gate_opened"), gateId: z.string(), kind: GateKind, payload: z.unknown() }),
  z.object({ ...base, type: z.literal("run.gate_resolved"), gateId: z.string(), kind: GateKind, resolution: GateState, feedback: z.string().default("") }),
  z.object({ ...base, type: z.literal("run.budget_updated"), spentUsd: z.number(), capUsd: z.number() }),
  z.object({ ...base, type: z.literal("run.plan_attempt_failed"), attempt: z.number().int(), reason: z.string(), rawPath: z.string() }),
  z.object({ ...base, type: z.literal("intake.question"), sessionId: z.string(), question: z.string(), options: z.array(z.string()).default([]) }),
  z.object({ ...base, type: z.literal("intake.answered"), sessionId: z.string(), question: z.string(), answer: z.string() }),
  z.object({ ...base, type: z.literal("intake.brief_ready"), goal: z.string(), decisions: z.number().int() }),
  z.object({ ...base, type: z.literal("task.state_changed"), taskId: z.string(), from: TaskState, to: TaskState, reason: z.string().default("") }),
  z.object({ ...base, type: z.literal("task.qa_verdict"), taskId: z.string(), verdict: z.enum(["PASS", "FAIL"]), iteration: z.number().int(), detail: z.unknown() }),
  // The task-escalation gate (GateKind has named it since v0.0): a task hit a cap
  // and the operator is being asked for guidance before it is parked for good.
  z.object({ ...base, type: z.literal("task.gate_opened"), taskId: z.string(), why: z.string(), iterations: z.number().int(), recommendation: z.string().default("") }),
  z.object({ ...base, type: z.literal("task.gate_resolved"), taskId: z.string(), parked: z.boolean(), guidance: z.string().default("") }),
  // Unprompted operator feedback on a task mid-run: "live" went straight into the
  // running session; "queued" waits for the next agent dispatched on the task.
  z.object({ ...base, type: z.literal("task.feedback"), taskId: z.string(), text: z.string(), delivery: z.enum(["live", "queued", "revived"]) }),
  // The validator's answer to "did the merged result do what the operator asked?",
  // recorded before any pull request is opened.
  z.object({ ...base, type: z.literal("run.intent_verdict"), verdict: z.enum(["PASS", "FAIL"]), gaps: z.array(z.string()).default([]), summary: z.string().default("") }),
  // What the repo's own CI said about the pull request the run opened. The
  // deterministic checks run in a worktree on one task's branch; this is the
  // first thing that judges the merged whole the way the repo actually judges it.
  z.object({
    ...base,
    type: z.literal("run.ci_status"),
    prNumber: z.number().int(),
    state: z.enum(["passing", "failing", "pending", "none"]),
    failing: z.array(z.string()).default([]),
    total: z.number().int().default(0),
  }),
  // What the deploy triggered by the human's merge did. The CI status judged the
  // pull request; this judges the merge commit on the base branch — the first
  // thing that reflects whether the change actually reached anyone.
  z.object({
    ...base,
    type: z.literal("run.deploy_status"),
    sha: z.string(),
    state: z.enum(["passing", "failing", "pending", "none"]),
    failing: z.array(z.string()).default([]),
    total: z.number().int().default(0),
  }),
  // The verdict of an agent that went and looked at production itself.
  z.object({
    ...base,
    type: z.literal("run.prod_verdict"),
    url: z.string(),
    verdict: z.enum(["PASS", "FAIL"]),
    findings: z.array(z.string()).default([]),
    summary: z.string().default(""),
  }),
  z.object({ ...base, type: z.literal("agent.spawned"), sessionId: z.string(), taskId: z.string().optional(), role: AgentRole, model: z.string() }),
  z.object({ ...base, type: z.literal("agent.log"), sessionId: z.string(), taskId: z.string().optional(), text: z.string() }),
  z.object({ ...base, type: z.literal("agent.tool_use"), sessionId: z.string(), taskId: z.string().optional(), tool: z.string(), summary: z.string() }),
  z.object({ ...base, type: z.literal("agent.usage"), sessionId: z.string(), taskId: z.string().optional(), model: z.string(), inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int(), cacheWriteTokens: z.number().int(), costUsd: z.number() }),
  z.object({ ...base, type: z.literal("agent.ended"), sessionId: z.string(), taskId: z.string().optional(), outcome: z.enum(["done", "interrupted", "killed", "error"]), detail: z.string().default("") }),
  z.object({ ...base, type: z.literal("git.worktree_created"), taskId: z.string(), path: z.string(), branch: z.string() }),
  // Dependency install run once at worktree creation, outside any agent's turn
  // budget — without it every worker paid for its own `pnpm install` in tokens.
  // One event per manifest: a repo whose lockfiles live in `frontend/` and
  // `backend/` seeds twice, and an operator watching a red baseline needs to see
  // which of the two failed.
  z.object({ ...base, type: z.literal("task.deps_seeded"), taskId: z.string(), dir: z.string().default(""), ok: z.boolean(), manager: z.string(), seconds: z.number() }),
  z.object({ ...base, type: z.literal("git.merged"), taskId: z.string(), branch: z.string(), sha: z.string() }),
  z.object({ ...base, type: z.literal("git.merge_conflict"), taskId: z.string(), branch: z.string(), files: z.array(z.string()) }),
  z.object({ ...base, type: z.literal("github.issue_created"), taskId: z.string().optional(), epicId: z.string().optional(), issueNumber: z.number().int(), url: z.string() }),
  z.object({ ...base, type: z.literal("github.pr_opened"), taskId: z.string(), prNumber: z.number().int(), url: z.string() }),
  z.object({ ...base, type: z.literal("skills.injected"), taskId: z.string(), role: z.enum(["worker", "qa"]).optional(), skills: z.array(z.object({ name: z.string(), sha256: z.string(), mode: z.enum(["full", "reference"]) })) }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
export type HarnessEventType = HarnessEvent["type"];
