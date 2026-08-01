import { z } from "zod";

export const RunState = z.enum([
  "CREATED",
  "PLANNING",
  "PLAN_REVIEW",
  "EXECUTING",
  "INTEGRATING",
  "PR_REVIEW",
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

export const AgentRole = z.enum(["planner", "worker", "qa", "integrator"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const SessionState = z.enum(["running", "done", "interrupted", "killed"]);
export type SessionState = z.infer<typeof SessionState>;

export const GateKind = z.enum(["plan", "integration-conflict", "budget", "task-escalation"]);
export type GateKind = z.infer<typeof GateKind>;

export const GateState = z.enum(["open", "approved", "rejected"]);
export type GateState = z.infer<typeof GateState>;

/** Legal run-state transitions; the orchestrator core is the only writer. */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  CREATED: ["PLANNING", "ABORTED"],
  PLANNING: ["PLAN_REVIEW", "FAILED", "PAUSED", "ABORTED"],
  PLAN_REVIEW: ["EXECUTING", "PLANNING", "ABORTED"],
  EXECUTING: ["INTEGRATING", "PAUSED", "BUDGET_HOLD", "FAILED", "ABORTED"],
  INTEGRATING: ["PR_REVIEW", "PAUSED", "BUDGET_HOLD", "FAILED", "ABORTED"],
  PR_REVIEW: [],
  PAUSED: ["PLANNING", "EXECUTING", "INTEGRATING", "ABORTED"],
  BUDGET_HOLD: ["EXECUTING", "INTEGRATING", "ABORTED"],
  FAILED: [],
  ABORTED: [],
};

export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PENDING: ["READY", "CANCELLED"],
  READY: ["WORKING", "CANCELLED"],
  WORKING: ["QA", "READY", "NEEDS_HUMAN", "CANCELLED"],
  QA: ["ACCEPTED", "QA_FAILED", "NEEDS_HUMAN", "CANCELLED"],
  QA_FAILED: ["WORKING", "NEEDS_HUMAN", "CANCELLED"],
  ACCEPTED: ["MERGED", "NEEDS_HUMAN"],
  MERGED: [],
  NEEDS_HUMAN: ["READY", "ACCEPTED", "CANCELLED"],
  CANCELLED: [],
};
