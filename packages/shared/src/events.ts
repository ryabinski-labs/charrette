import { z } from "zod";
import { AgentRole, GateKind, GateState, RunState, TaskState } from "./states.js";

const base = { runId: z.string(), ts: z.number().int() };

export const HarnessEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run.created"), assignment: z.string(), repoPath: z.string() }),
  z.object({ ...base, type: z.literal("run.state_changed"), from: RunState, to: RunState, reason: z.string().default("") }),
  z.object({ ...base, type: z.literal("run.gate_opened"), gateId: z.string(), kind: GateKind, payload: z.unknown() }),
  // `decidedBy` names the skill that answered, or "operator" when a person did —
  // the same field, and the same default, that `task.gate_resolved` carries. The
  // rows written before any skill could answer a run gate read back as the
  // operator, which is who answered them.
  z.object({
    ...base,
    type: z.literal("run.gate_resolved"),
    gateId: z.string(),
    kind: GateKind,
    resolution: GateState,
    feedback: z.string().default(""),
    decidedBy: z.string().default("operator"),
  }),
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
  // `decidedBy` names the skill that answered, or "operator" when a person did.
  // The old rows have no such field and were all answered by a person, which is
  // exactly what the default reads back as.
  z.object({
    ...base,
    type: z.literal("task.gate_resolved"),
    taskId: z.string(),
    parked: z.boolean(),
    guidance: z.string().default(""),
    decidedBy: z.string().default("operator"),
  }),
  // A task's definition of done, rewritten by whoever answered the escalation it
  // caused — the only edit to a probe anything is allowed to make, and the only
  // way out of a gate that reopens on a probe that cannot pass. `to` empty means
  // the probe was dropped and QA's judgment is all that is left of it. `by` is
  // the skill that decided, or "operator".
  z.object({
    ...base,
    type: z.literal("task.probe_amended"),
    taskId: z.string(),
    from: z.string(),
    to: z.string().default(""),
    by: z.string().default("operator"),
    why: z.string().default(""),
  }),
  // Which worker model a task was dispatched on, and what the rule in
  // modelTier.ts made of it. Recorded for every task, refused ones included, and
  // still recorded when `models.workerLight` is pointed back at `models.worker`
  // and the decision changes nothing: the reason to publish a no-op is so the
  // light tier can be counted from the operator's own plans whether or not it is
  // switched on.
  z.object({
    ...base,
    type: z.literal("task.tier_decided"),
    taskId: z.string(),
    tier: z.enum(["light", "standard"]),
    model: z.string(),
    why: z.string().default(""),
  }),
  // Unprompted operator feedback on a task mid-run: "live" went straight into the
  // running session; "queued" waits for the next agent dispatched on the task.
  z.object({ ...base, type: z.literal("task.feedback"), taskId: z.string(), text: z.string(), delivery: z.enum(["live", "queued", "revived"]) }),
  // The validator's answer to "did the merged result do what the operator asked?",
  // recorded before any pull request is opened.
  z.object({ ...base, type: z.literal("run.intent_verdict"), verdict: z.enum(["PASS", "FAIL"]), gaps: z.array(z.string()).default([]), summary: z.string().default("") }),
  // The same judgment, made of the plan instead of the result, at the gate where
  // acting on it costs a re-plan rather than a run.
  z.object({ ...base, type: z.literal("run.plan_intent_verdict"), verdict: z.enum(["PASS", "FAIL"]), gaps: z.array(z.string()).default([]), summary: z.string().default("") }),
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
  // The operator asked for a pit stop instead of waiting for one. Like the
  // trigger's own memory below, this is held in the event log rather than on the
  // controller: a request made at 2am against a run that is restarted at 3am is
  // still a request, and a request the process forgot is one the operator paid
  // attention for and got nothing from.
  //
  // `question` is what they typed, and it is the whole reason this is not just a
  // button. It reaches the demo, the reviewers and the decider, so the stop that
  // opens is about the thing they were worried about rather than a generic look
  // at the product.
  //
  // Pending means: this event with no later `run.pitstop_opened` and no later
  // `run.pitstop_cancelled`. Cancelling is free and is the reason asking can be
  // cheap — see `pendingPitStopRequest` in store.ts.
  z.object({
    ...base,
    type: z.literal("run.pitstop_requested"),
    question: z.string().default(""),
  }),
  z.object({
    ...base,
    type: z.literal("run.pitstop_cancelled"),
    /** What the operator had asked, so the log says what was called off. */
    question: z.string().default(""),
  }),
  // A pit stop: the run stopped to show the operator what it has built so far.
  // `epicIds` are the epics this stop covers, and they are what stops a second
  // pit stop firing for the same finished epic — so this event is the whole of
  // the trigger's memory, which is why it survives a resume for free.
  z.object({
    ...base,
    type: z.literal("run.pitstop_opened"),
    stop: z.number().int(),
    reason: z.string(),
    epicIds: z.array(z.string()).default([]),
    mergedCount: z.number().int(),
    spentUsd: z.number(),
    /** Where the demo's screenshots, logs and report were written. */
    artifactsDir: z.string().default(""),
    demoStarted: z.boolean().default(false),
    /**
     * The operator asked for this one; no boundary was crossed.
     *
     * Read by everything that treats this event as the *cadence's* memory, and
     * the reason those readers do not silently break when a person interrupts a
     * run. A summoned stop must not advance the `{usd}`, `{minutes}` or
     * `{tasks}` interval — asking a question at minute 40 would push the next
     * automatic ninety-minute stop out to minute 130, and nothing would say so
     * — and it must not stand in for the closing stop a FAIL verdict is owed,
     * which is the one guarantee PITSTOP.md holds this feature to.
     *
     * It still counts: the ordinal, the artifact directory and the container
     * sweep in `sweepRunResources` all enumerate stops, and a stop missing from
     * that enumeration is a stack left holding ports.
     */
    summoned: z.boolean().default(false),
  }),
  z.object({
    ...base,
    type: z.literal("run.pitstop_resolved"),
    stop: z.number().int(),
    action: z.enum(["continue", "redirect", "replan", "stop"]),
    feedback: z.string().default(""),
    /** Tasks the operator's words were attached to. */
    tasks: z.array(z.string()).default([]),
    /**
     * The skill that decided, or `"operator"`. A run that redirected itself and
     * a run the operator redirected are different histories, and the resolved
     * event is the only record of which one this was.
     */
    decidedBy: z.string().default("operator"),
    /** The decider's one-line reason. Empty when the operator decided. */
    why: z.string().default(""),
    /**
     * Which of the four things only an operator can settle a `stop` is waiting
     * on. Empty for every other action, and for a stop the operator chose
     * themselves — they do not have to justify parking their own run.
     *
     * It is on the record because it is the difference between a run that hit
     * something real and a run that stopped to be careful. f338b5c8's last pit
     * stop parked $127 of budget and eight buildable tasks over two questions,
     * and nothing in the log distinguished that from a hard blocker.
     */
    blockedOn: z.enum(["money", "scope", "access", "direction", ""]).default(""),
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
  // A skill the harness wrote for itself because nothing in the operator's
  // collection matched a task (skillForge.ts). The event is the provenance
  // trail SEC-14 asks for: the file on disk says what the skill claims, this
  // says which run and task put it there and what it hashed to at birth.
  z.object({ ...base, type: z.literal("skills.forged"), taskId: z.string(), name: z.string(), sha256: z.string(), path: z.string(), action: z.enum(["created", "extended"]), tokensApprox: z.number().int() }),
]);
export type HarnessEvent = z.infer<typeof HarnessEvent>;
export type HarnessEventType = HarnessEvent["type"];
