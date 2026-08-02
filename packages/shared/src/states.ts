import { z } from "zod";

export const RunState = z.enum([
  "CREATED",
  "INTAKE",
  "PLANNING",
  "PLAN_REVIEW",
  "EXECUTING",
  "INTEGRATING",
  "PR_REVIEW",
  // The human merged the pull request. Everything past here is about the world
  // rather than the repo: did the merge deploy, and does the deployed thing do
  // what was asked? A run that stops at PR_REVIEW has shipped nothing.
  "VERIFYING",
  "DONE",
  "PAUSED",
  "BUDGET_HOLD",
  "FAILED",
  "ABORTED",
]);
export type RunState = z.infer<typeof RunState>;

export const TaskState = z.enum([
  "PENDING",
  "READY",
  "WORKING",
  "QA",
  "QA_FAILED",
  "ACCEPTED",
  "MERGED",
  "NEEDS_HUMAN",
  "CANCELLED",
]);
export type TaskState = z.infer<typeof TaskState>;

export const AgentRole = z.enum(["intake", "planner", "worker", "qa", "integrator", "validator", "advisor", "prod"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const SessionState = z.enum(["running", "done", "interrupted", "killed"]);
export type SessionState = z.infer<typeof SessionState>;

export const GateKind = z.enum(["plan", "integration-conflict", "budget", "task-escalation"]);
export type GateKind = z.infer<typeof GateKind>;

export const GateState = z.enum(["open", "approved", "rejected"]);
export type GateState = z.infer<typeof GateState>;

/** Legal run-state transitions; the orchestrator core is the only writer. */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  CREATED: ["INTAKE", "PLANNING", "ABORTED"],
  INTAKE: ["PLANNING", "FAILED", "PAUSED", "ABORTED"],
  PLANNING: ["PLAN_REVIEW", "FAILED", "PAUSED", "ABORTED"],
  PLAN_REVIEW: ["EXECUTING", "PLANNING", "ABORTED"],
  EXECUTING: ["INTEGRATING", "PAUSED", "BUDGET_HOLD", "FAILED", "ABORTED"],
  INTEGRATING: ["PR_REVIEW", "PAUSED", "BUDGET_HOLD", "FAILED", "ABORTED"],
  // A finished run is not a dead run: `resume` reopens it when tasks parked
  // (back to EXECUTING via the escalation gate) or merged work never got its
  // pull requests (back to INTEGRATING to retry them).
  PR_REVIEW: ["EXECUTING", "INTEGRATING", "VERIFYING"],
  // A run stays in VERIFYING while the deploy is red or production disagrees:
  // both are states the operator has to act on, and neither is the harness's to
  // guess at. `resume` re-enters verification, so fixing the deploy and running
  // it again is what moves the run on — no new run, no lost history.
  VERIFYING: ["DONE", "EXECUTING", "PAUSED", "FAILED", "ABORTED"],
  DONE: [],
  PAUSED: ["INTAKE", "PLANNING", "EXECUTING", "INTEGRATING", "ABORTED"],
  BUDGET_HOLD: ["EXECUTING", "INTEGRATING", "ABORTED"],
  FAILED: [],
  ABORTED: [],
};

export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PENDING: ["READY", "CANCELLED"],
  // READY -> NEEDS_HUMAN: dispatch itself can fail (worktree creation, say)
  // before any worker starts; that parks like any other crash.
  READY: ["WORKING", "NEEDS_HUMAN", "CANCELLED"],
  // WORKING/QA/QA_FAILED -> READY: a task found mid-flight when no agent can be
  // running it (the previous harness process died) is requeued, not abandoned.
  WORKING: ["QA", "READY", "NEEDS_HUMAN", "CANCELLED"],
  QA: ["ACCEPTED", "QA_FAILED", "READY", "NEEDS_HUMAN", "CANCELLED"],
  QA_FAILED: ["WORKING", "READY", "NEEDS_HUMAN", "CANCELLED"],
  // ACCEPTED -> WORKING: the merge into the integration branch conflicted. The
  // work is good; it is the base that moved under it, so it goes back to the
  // worker that wrote it rather than to a human.
  ACCEPTED: ["MERGED", "WORKING", "NEEDS_HUMAN"],
  MERGED: [],
  NEEDS_HUMAN: ["READY", "ACCEPTED", "CANCELLED"],
  // "unreachable: dependencies parked" stops being true the moment the operator
  // revives the dependency — resume puts these back in the queue.
  CANCELLED: ["PENDING"],
};
