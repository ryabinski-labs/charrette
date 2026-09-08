import { z } from "zod";

export const RunState = z.enum([
  "CREATED",
  "INTAKE",
  "PLANNING",
  "PLAN_REVIEW",
  "EXECUTING",
  "INTEGRATING",
  "PR_REVIEW",
  // The run reached the end of INTEGRATING and could not prove itself: the
  // acceptance suite is red or has no opinion, the intent check failed or could
  // not finish, or nothing merged so there is no pull request to review. Its
  // own state rather than PR_REVIEW with a sad reason string, because the two
  // are different requests of the operator. PR_REVIEW asks them to review;
  // this asks them for help, and it must read that way on the dashboard, in
  // `harness status` and in the notification. waf de2cb7aa and ledger-app
  // a8df0107 both reported themselves in review over a red acceptance suite
  // (issue #115); this is the state they should have landed in.
  "BLOCKED",
  // The human merged the pull request. Everything past here is about the world
  // rather than the repo: did the merge deploy, and does the deployed thing do
  // what was asked? A run that stops at PR_REVIEW has shipped nothing.
  "VERIFYING",
  "DONE",
  "PAUSED",
  "BUDGET_HOLD",
  // The account's plan is nearly spent and the operator declined to point the
  // run at another subscription. Its own state rather than BUDGET_HOLD's: the
  // two are parked on different things — money the operator controls, and quota
  // that comes back on a date nobody controls — and `resume` has to be able to
  // tell an operator which of the two they are looking at.
  "LIMIT_HOLD",
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

export const AgentRole = z.enum([
  "intake",
  "planner",
  "worker",
  "qa",
  "integrator",
  "validator",
  "advisor",
  "prod",
  // Pit stops: `demo` starts the half-built product and drives it; `reviewer`
  // reads what the demo found through one named lens and says whether the run
  // is still building the right thing; `pm` reads all of that and decides what
  // the run does next.
  "demo",
  "reviewer",
  "pm",
  // The closing gate's agent: starts the finished product from a clean checkout
  // by the repository's own documented start, drives the critical path the
  // specification names, and reports what it observed. Its own role rather
  // than `demo` because it decides whether the run may report itself in
  // review, and the ledger has to show what that decision cost.
  "live",
  // Resumes a session that finished without formatting its answer and asks for
  // nothing but the answer. Its own role rather than the role it is repairing,
  // so that a cheap two-turn re-ask cannot be mistaken for the judgment it is
  // transcribing — the ledger would otherwise show a Haiku row labelled `qa`.
  "repair",
  // Writes a playbook for a task no existing skill covers (skillForge.ts). Its
  // own role so the ledger shows what forging costs, and so its sessions can
  // never be mistaken for the worker they were forging for.
  "skillsmith",
  // Turns the agreed brief into an executable specification — requirements,
  // falsifiable scenarios, and the failing tests that put the run in the red
  // phase — before the planner writes a single task. Its own role because it
  // spends before any task exists, and because what it produces is the standard
  // every later gate is judged against rather than more of the same judgment.
  "spec",
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const SessionState = z.enum(["running", "done", "interrupted", "killed"]);
export type SessionState = z.infer<typeof SessionState>;

export const GateKind = z.enum(["plan", "integration-conflict", "budget", "task-escalation", "pit-stop", "subscription"]);
export type GateKind = z.infer<typeof GateKind>;

export const GateState = z.enum(["open", "approved", "rejected"]);
export type GateState = z.infer<typeof GateState>;

/** Legal run-state transitions; the orchestrator core is the only writer. */
export const RUN_TRANSITIONS: Record<RunState, RunState[]> = {
  CREATED: ["INTAKE", "PLANNING", "ABORTED"],
  INTAKE: ["PLANNING", "FAILED", "PAUSED", "ABORTED"],
  PLANNING: ["PLAN_REVIEW", "FAILED", "PAUSED", "ABORTED"],
  PLAN_REVIEW: ["EXECUTING", "PLANNING", "ABORTED"],
  EXECUTING: ["INTEGRATING", "PAUSED", "BUDGET_HOLD", "LIMIT_HOLD", "FAILED", "ABORTED"],
  // INTEGRATING -> EXECUTING: the pit stop the validator's FAIL opens sits here,
  // between the verdict and the first pull request. An operator who reads that
  // verdict and asks for the gap to be fixed has to be able to send the run back
  // to work — the alternative is closing it and starting another.
  INTEGRATING: ["PR_REVIEW", "BLOCKED", "EXECUTING", "PAUSED", "BUDGET_HOLD", "LIMIT_HOLD", "FAILED", "ABORTED"],
  // A finished run is not a dead run: `resume` reopens it when tasks parked
  // (back to EXECUTING via the escalation gate) or merged work never got its
  // pull requests (back to INTEGRATING to retry them).
  PR_REVIEW: ["EXECUTING", "INTEGRATING", "VERIFYING"],
  // The same two doors as PR_REVIEW, and for the same reason: what blocked the
  // run is something the operator fixes — a scenario, a question, a parked
  // task — and `resume` is how the run is asked to look again. Never straight
  // to PR_REVIEW: the gates it failed are the gates it has to pass.
  BLOCKED: ["EXECUTING", "INTEGRATING", "ABORTED"],
  // A run stays in VERIFYING while the deploy is red or production disagrees:
  // both are states the operator has to act on, and neither is the harness's to
  // guess at. `resume` re-enters verification, so fixing the deploy and running
  // it again is what moves the run on — no new run, no lost history.
  VERIFYING: ["DONE", "EXECUTING", "PAUSED", "FAILED", "ABORTED"],
  DONE: [],
  PAUSED: ["INTAKE", "PLANNING", "EXECUTING", "INTEGRATING", "ABORTED"],
  BUDGET_HOLD: ["EXECUTING", "INTEGRATING", "ABORTED"],
  // Same doors as BUDGET_HOLD, and for the same reason: what parked the run was
  // a ceiling, not a fault, so resuming puts it back exactly where it stopped.
  // The difference is what makes resuming worth anything — a raised cap there, a
  // different subscription (or a reset window) here.
  LIMIT_HOLD: ["EXECUTING", "INTEGRATING", "ABORTED"],
  // FAILED -> PLANNING: a run that died before it produced a single task can be
  // planned again. Everything it has is still worth something — the intake
  // conversation the operator sat through, the brief it became — and the
  // alternative is a new run that asks them all of it a second time. Only from a
  // planning failure: a run that failed with work in flight has state a re-plan
  // would talk over, and `resume` has other doors for that.
  FAILED: ["PLANNING"],
  ABORTED: [],
};

export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PENDING: ["READY", "CANCELLED"],
  // READY -> NEEDS_HUMAN: dispatch itself can fail (worktree creation, say)
  // before any worker starts; that parks like any other crash.
  READY: ["WORKING", "NEEDS_HUMAN", "CANCELLED"],
  // WORKING/QA/QA_FAILED -> READY: a task found mid-flight when no agent can be
  // running it (the previous harness process died) is requeued, not abandoned.
  // WORKING -> ACCEPTED: the pre-QA gate found the branch already contained in
  // the integration branch. Nothing is being claimed about a review here — the
  // door exists because the work has demonstrably landed, and the alternative
  // was the state run bc691359 sat in for six days, where the only legal moves
  // from WORKING all led back to a worker being asked to commit a change that
  // was already committed.
  WORKING: ["QA", "ACCEPTED", "READY", "NEEDS_HUMAN", "CANCELLED"],
  QA: ["ACCEPTED", "QA_FAILED", "READY", "NEEDS_HUMAN", "CANCELLED"],
  QA_FAILED: ["WORKING", "READY", "NEEDS_HUMAN", "CANCELLED"],
  // ACCEPTED -> WORKING: the merge into the integration branch conflicted. The
  // work is good; it is the base that moved under it, so it goes back to the
  // worker that wrote it rather than to a human.
  // ACCEPTED -> READY: the same requeue the three states above get. A task that
  // passed QA and died before its merge landed is mid-flight like any other,
  // and leaving it out stranded it: nothing dispatches an ACCEPTED task, so it
  // sat until the scheduler swept it as unreachable and tried to cancel it —
  // which is not a legal move from here, and the throw killed the whole run.
  ACCEPTED: ["MERGED", "WORKING", "READY", "NEEDS_HUMAN"],
  MERGED: [],
  NEEDS_HUMAN: ["READY", "ACCEPTED", "CANCELLED"],
  // "unreachable: dependencies parked" stops being true the moment the operator
  // revives the dependency — resume puts these back in the queue.
  CANCELLED: ["PENDING"],
};
