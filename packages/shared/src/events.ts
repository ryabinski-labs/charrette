import { z } from "zod";
import { ReleaseEvidence } from "./delivery.js";
import { RunSpec } from "./spec.js";
import { AgentRole, GateKind, GateState, RunState, TaskState } from "./states.js";

const base = { runId: z.string(), ts: z.number().int() };

/**
 * The operator's half of an escalation, as steps rather than prose.
 *
 * It rides on the gate event rather than being folded into `recommendation` and
 * left there, because the two readers want different things from it. The
 * dashboard and the terminal want the rendered text; anything that has to reach
 * a person who is not looking at either — mail, chat, a pager — wants the steps
 * apart from each other so it can lay them out. Rendering happens once, in
 * `renderRunbook`; keeping the structure here is what stops every other channel
 * from having to parse that rendering back.
 *
 * `command` is optional because half of what an operator has to do has no
 * command — approve a plan, create an account, decide something — and a shape
 * that demands one gets invented shell.
 */
export const RunbookShape = z.object({
  blocked: z.string().default(""),
  steps: z.array(z.object({ do: z.string(), command: z.string().optional() })).default([]),
  sendBack: z.string().default(""),
});
export type Runbook = z.infer<typeof RunbookShape>;

export const CharretteEvent = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("run.release_evidence"), ...ReleaseEvidence.shape }),
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
  // How much of the account's plan is gone, as the plan itself reports it —
  // recorded on every reading, not only the ones that open a gate. A run that
  // stopped at 95% is diagnosed from the climb that got it there: whether the
  // window was already half spent when the run started is the difference between
  // "this run is expensive" and "this run was unlucky".
  //
  // `percent` is 0-100 whatever the source said. The two sources disagree — the
  // streamed event reports 0.82 and the control channel reports 82 for the same
  // window at the same moment — so normalising at the edge is the only way the
  // number on the dashboard and the number in the log can be the same number.
  z.object({
    ...base,
    type: z.literal("run.subscription_reading"),
    window: z.string(),
    percent: z.number(),
    /** Epoch ms the window reopens, or null when the reading named no time. */
    resetsAt: z.number().int().nullable(),
    /** The named account this reading is about; empty is the ambient login. */
    account: z.string().default(""),
  }),
  // The run was pointed at a different subscription. `from`/`to` are account
  // names, never credentials — nothing in this log is ever a secret.
  z.object({
    ...base,
    type: z.literal("run.subscription_switched"),
    from: z.string().default(""),
    to: z.string(),
    /** What was true when the switch was made, for the postmortem. */
    window: z.string().default(""),
    percent: z.number().default(0),
  }),
  z.object({ ...base, type: z.literal("run.plan_attempt_failed"), attempt: z.number().int(), reason: z.string(), rawPath: z.string() }),
  z.object({ ...base, type: z.literal("intake.question"), sessionId: z.string(), question: z.string(), options: z.array(z.string()).default([]) }),
  // `decidedBy` names who answered: "operator" for a person, a skill name when a
  // decider stood in, "nobody" when the question reached neither. It defaults to
  // the operator because every row written before intake could be delegated was
  // one, and because a reader that cannot tell them apart should assume the
  // answer came from the person rather than from a model.
  z.object({
    ...base,
    type: z.literal("intake.answered"),
    sessionId: z.string(),
    question: z.string(),
    answer: z.string(),
    decidedBy: z.string().default("operator"),
  }),
  z.object({ ...base, type: z.literal("intake.brief_ready"), goal: z.string(), decisions: z.number().int() }),
  z.object({ ...base, type: z.literal("task.state_changed"), taskId: z.string(), from: TaskState, to: TaskState, reason: z.string().default("") }),
  z.object({ ...base, type: z.literal("task.qa_verdict"), taskId: z.string(), verdict: z.enum(["PASS", "FAIL"]), iteration: z.number().int(), detail: z.unknown() }),
  // The task-escalation gate (GateKind has named it since v0.0): a task hit a cap
  // and the operator is being asked for guidance before it is parked for good.
  // `runbook` is null on every gate a worker can act on alone, which is most of
  // them, and on every row written before it existed.
  z.object({
    ...base,
    type: z.literal("task.gate_opened"),
    taskId: z.string(),
    why: z.string(),
    iterations: z.number().int(),
    recommendation: z.string().default(""),
    // Optional rather than defaulted, so the field is absent from the thousands
    // of gate rows written before it existed and from every publisher that has
    // no runbook to attach, instead of carrying an explicit null apiece.
    runbook: RunbookShape.nullable().optional(),
  }),
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
  // The bar itself moved, not just the probe in front of it. Only the operator
  // writes this: an agent that could rewrite the criteria it is judged against
  // is not being judged. A task merged against amended criteria has to be able
  // to say who amended them and why, so `from` keeps the original wording.
  z.object({
    ...base,
    type: z.literal("task.criteria_amended"),
    taskId: z.string(),
    from: z.array(z.string()),
    to: z.array(z.string()),
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
    tier: z.enum(["light", "standard", "ui", "heavy"]),
    model: z.string(),
    why: z.string().default(""),
  }),
  // Unprompted operator feedback on a task mid-run: "live" went straight into the
  // running session; "queued" waits for the next agent dispatched on the task.
  z.object({ ...base, type: z.literal("task.feedback"), taskId: z.string(), text: z.string(), delivery: z.enum(["live", "queued", "revived"]) }),
  // The validator's answer to "did the merged result do what the operator asked?",
  // recorded before any pull request is opened.
  /**
   * The run's executable specification, as the spec agent left it. Carried on
   * the log rather than in a table because it is written once and read by
   * everything after — the plan, the task gates, the acceptance gate and the
   * completion report — and the log is already the thing a resumed process
   * rebuilds its world from.
   */
  z.object({ ...base, type: z.literal("run.spec_ready"), spec: RunSpec }),
  z.object({
    ...base,
    type: z.literal("run.acceptance_verdict"),
    /**
     * Green, red, or no opinion. A spec with no gating scenario, or whose every
     * gating scenario is blocked on an unanswered question, proves nothing —
     * and for a while that was spelled `passed: true`, which is how both runs
     * in issue #115 walked through this gate. `passed` stays on the event for
     * readers that predate the third answer; it is true only for green.
     */
    verdict: z.enum(["green", "red", "no-opinion"]).optional(),
    passed: z.boolean(),
    failing: z.array(z.string()).default([]),
    /** False when the suite went red and its output named no scenario. */
    named: z.boolean().default(true),
    blocked: z.array(z.string()).default([]),
    line: z.string().default(""),
  }),
  /**
   * PASS, FAIL, or UNKNOWN. The third answer is for what the turn budget did
   * not reach: a validator with no way to abstain resolves "I ran out of turns"
   * as a PASS with the unchecked items listed underneath, where nothing reads
   * them — rust-service de2cb7aa closed on exactly that verdict. `unchecked` is what an
   * UNKNOWN could not settle, in the validator's words.
   */
  z.object({
    ...base,
    type: z.literal("run.intent_verdict"),
    verdict: z.enum(["PASS", "FAIL", "UNKNOWN"]),
    gaps: z.array(z.string()).default([]),
    unchecked: z.array(z.string()).default([]),
    summary: z.string().default(""),
  }),
  /**
   * What the closing gate decided, every time it decides. `unmet` is the list
   * of things the run could not prove — an acceptance suite that is red, an
   * intent check that failed or never finished, a run with nothing to review —
   * and it is empty exactly when the run may report itself in review. On the
   * log rather than derived, so the reason a run is BLOCKED is one query away
   * from anyone watching it.
   */
  z.object({ ...base, type: z.literal("run.closing_proof"), proven: z.boolean(), unmet: z.array(z.string()).default([]), held: z.boolean().default(true) }),
  /**
   * The intent check ran and produced no verdict — the third answer the run
   * had no way to record.
   *
   * A validator that cannot evidence an answer and says so in prose is behaving
   * correctly; it was the charrette that had nowhere to put "I could not tell".
   * So the parse error was swallowed as a log line and `intentVerdict` went on
   * returning the last verdict that *did* parse, which is how ledger-app
   * a8df0107 closed with "intent check found 2 gaps" — the fifth pass's answer,
   * one gap of which the run had since closed itself and the other of which was
   * never real. A verdict is a statement about the tree that was read; carrying
   * one forward silently attributes it to a tree nobody read.
   */
  z.object({ ...base, type: z.literal("run.intent_unknown"), why: z.string().default("") }),
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
    // Every check the head carried when this was read, skipped ones included.
    // A later read that is missing any of them is GitHub mid-way through
    // re-attaching a re-run, not a verdict — which is only decidable with
    // the earlier list on the record. Run de2cb7aa's #527 went "failing over
    // 28" to "passing over 17" in the three seconds around a re-run, and the
    // count alone was all the log had to say about it.
    names: z.array(z.string()).default([]),
    // The commit `names` were read on. A later read of the same commit is held
    // to them; a new head is not.
    sha: z.string().default(""),
  }),
  // The run asked GitHub to re-run the failed jobs before spending a fix task
  // on them. CI flakes; a task queued against a flake "fixes" code that was
  // never broken. `reran` is false when nothing could be re-run — checks not
  // from Actions, or an API refusal — and the fix round proceeds on the
  // failure as it stands.
  z.object({ ...base, type: z.literal("run.ci_retry"), prNumber: z.number().int(), reran: z.boolean() }),
  /**
   * The green hold granted the run another `ciFixRounds` of fix rounds against
   * a red pull request — by a pit stop answering "continue", or by an operator
   * resuming a run that paused with the rounds spent. `rounds` is the new
   * allowance in total; `queueCiFixes` counts against it. Held in the event
   * log rather than the config so raising it never fails the schema's cap on
   * `ciFixRounds`, and so the record says who kept the run going.
   */
  z.object({ ...base, type: z.literal("run.ci_rounds_granted"), prNumber: z.number().int().default(0), rounds: z.number().int(), by: z.enum(["pitstop", "resume"]) }),
  /**
   * Whether the run's pull request can be merged into its base at all.
   *
   * The sibling of `run.ci_status`, for the half of "is this branch shippable"
   * that CI cannot see. A green check on a branch whose base moved underneath it
   * is still a branch nobody can merge, and the charrette used to report exactly
   * that as a finished run.
   *
   * `conflicts` carries the files when the charrette found them itself, merging
   * the base into the integration branch. It is empty when the verdict came from
   * GitHub, which reports mergeability without saying where it broke.
   */
  z.object({
    ...base,
    type: z.literal("run.merge_status"),
    prNumber: z.number().int().default(0),
    // "behind": no conflict, but the base moved and a protection rule can
    // refuse the merge until the branch is brought up to date — which is the
    // charrette's own base merge, so the green hold reconciles and re-asks.
    state: z.enum(["mergeable", "conflicting", "behind", "unknown"]),
    baseBranch: z.string().default(""),
    conflicts: z.array(z.string()).default([]),
    resolvedBy: z.enum(["already-current", "merge", "agent", "none"]).default("none"),
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
  // The operator asked the run to stop and be picked up later. Recorded when it
  // is *asked for* rather than when it takes effect, because the gap between
  // the two is the interesting part: every session has to reach its next
  // message to notice, and a feed that only showed the finished pause would
  // leave the operator watching a page that appears to be ignoring them.
  z.object({
    ...base,
    type: z.literal("run.pause_requested"),
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
    /**
     * The `ts` of the `run.pitstop_requested` this stop actually carried, or 0.
     *
     * Publishing this event is what retires a pending request, and until this
     * field existed it retired *whichever* request was pending at publish time.
     * A stop is picked up, runs its demo and its reviewers for ten or twenty
     * minutes, and only then opens; an operator who asks a question inside that
     * window had it deleted by a stop that never carried it and never asked it.
     * On run bc691359 that is exactly what happened: seq 69990 asked why nothing
     * owned bench.yml at 05:11:38, seq 70000 opened the config-canon cadence stop
     * at 05:23:36, and the question was gone with nothing anywhere saying so.
     *
     * With the instant recorded, `pendingPitStopRequest` can retire only the
     * request this stop was carrying and leave a newer one standing. 0 means a
     * stop that carried no question — a cadence stop retires nothing.
     */
    askedAt: z.number().default(0),
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
  /**
   * A requirement the brief named that this run will not deliver, and the
   * answer that made that a decision rather than an omission.
   *
   * rust-service cancelled 177 tasks against 377 merged and carried none of their
   * requirements anywhere: they stopped existing and reappeared as sections of
   * a 118 KB gaps file. A write-off is the same outcome with a person's answer
   * attached, and the difference is the whole of issue #120.
   */
  z.object({
    ...base,
    type: z.literal("run.scope_written_off"),
    requirementId: z.string(),
    requirement: z.string().default(""),
    /** The operator's own words, or the skill's. */
    answer: z.string().default(""),
    decidedBy: z.string().default("operator"),
    /** The tasks that claimed it, and what became of each. */
    claimants: z.array(z.object({ id: z.string(), state: z.string(), why: z.string().default("") })).default([]),
  }),
  /**
   * What the live-exercise gate observed when it started the finished product
   * from a clean checkout and drove the critical path (issue #116). `worked`
   * means every step was reached, worked, and left proof that survived the
   * evidence gate; `broken` names the first step that did not; `not-run`
   * means the product never started, or the agent never answered. Never a
   * reading of the code: this is the one event in the run written by something
   * that used the product.
   */
  z.object({
    ...base,
    type: z.literal("run.live_verdict"),
    verdict: z.enum(["worked", "broken", "not-run"]),
    path: z.string().default(""),
    /** One line per step: `worked`, `broken`, or `not-reached`. */
    steps: z.array(z.object({ step: z.string(), result: z.enum(["worked", "broken", "not-reached"]) })).default([]),
    howStarted: z.string().default(""),
    why: z.string().default(""),
    /** Where the transcript, screenshots and captures were kept. */
    artifactsDir: z.string().default(""),
    /** Artifacts and re-run commands that survived checking, as claims. */
    proof: z.array(z.string()).default([]),
    couldNotReach: z.array(z.string()).default([]),
  }),
  /**
   * What the live-exercise agent saw at each step, verbatim.
   *
   * Its own event rather than a field on the verdict: the verdict is what
   * every reader of the run is held to, and this is the prose one fix task is
   * handed about one step. Keeping them apart means a long observation cannot
   * crowd out the judgment in any reader that renders the verdict whole.
   */
  z.object({
    ...base,
    type: z.literal("run.live_observed"),
    steps: z.array(z.object({ step: z.string(), observed: z.string().default("") })).default([]),
  }),
  // The verdict of an agent that went and looked at production itself.
  z.object({
    ...base,
    type: z.literal("run.prod_verdict"),
    url: z.string(),
    verdict: z.enum(["PASS", "FAIL"]),
    findings: z.array(z.string()).default([]),
    unchecked: z.array(z.string()).optional(),
    observations: z.array(z.object({ scenarioId: z.string(), evidence: z.string() })).optional(),
    summary: z.string().default(""),
  }),
  z.object({ ...base, type: z.literal("agent.spawned"), sessionId: z.string(), taskId: z.string().optional(), role: AgentRole, model: z.string() }),
  z.object({ ...base, type: z.literal("agent.log"), sessionId: z.string(), taskId: z.string().optional(), text: z.string() }),
  z.object({ ...base, type: z.literal("agent.tool_use"), sessionId: z.string(), taskId: z.string().optional(), tool: z.string(), summary: z.string() }),
  // A running agent stopped on the turn cadence to say where it had got to and
  // what it would like decided (checkpoint.ts). Two things live here that exist
  // nowhere else in the log: what a long session actually believed halfway
  // through — every other record of that is either the tool calls it made or
  // the answer it gave at the end — and the questions it was prepared to guess
  // at. `recommended` is what it guessed, and it is on the record whether or
  // not anyone answered, because a run that drifted is diagnosed from the
  // assumption it drifted on.
  z.object({
    ...base,
    type: z.literal("agent.checkpoint"),
    sessionId: z.string(),
    taskId: z.string().optional(),
    turn: z.number().int(),
    digest: z.string().default(""),
    questions: z
      .array(
        z.object({
          question: z.string(),
          options: z.array(z.string()).default([]),
          recommended: z.string().default(""),
        })
      )
      .default([]),
  }),
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
  /**
   * A run that merged work it could not publish.
   *
   * The distinction this carries is the whole reason it exists. "Nothing to
   * publish" and "publishing failed" both leave a run with no pull request
   * number, and every gate downstream reads that number: with only a log line
   * to tell them apart, `greenGate` took the second for the first and skipped
   * the CI hold entirely. ledger-app a8df0107 merged 127 tasks, had its rollup
   * body refused as oversized, and reported itself in review over a branch
   * nothing had ever checked — with `holdUntilGreen` on. A log line cannot be
   * gated on; this can.
   */
  z.object({ ...base, type: z.literal("github.pr_publish_failed"), taskId: z.string(), error: z.string().default("") }),
  z.object({ ...base, type: z.literal("skills.injected"), taskId: z.string(), role: z.enum(["worker", "qa"]).optional(), skills: z.array(z.object({ name: z.string(), sha256: z.string(), mode: z.enum(["full", "reference"]) })) }),
  // A `roleSkills` pin naming a skill this machine's `skillsDirs` do not hold.
  // Skipping it is deliberate — the routing table outlives any one machine's
  // collection — but it used to be skipped in silence, and the default pin is
  // `spec` -> `prd-to-tdd`: a spec phase without it invents its own idea of
  // what a scenario is, and the acceptance gate then holds the run to the
  // invention. Published once per drive, before anything is dispatched, so the
  // event log answers "was the run specified against the standard?" without
  // anyone having to remember what was installed that day.
  z.object({ ...base, type: z.literal("skills.unresolved"), role: z.string(), skill: z.string(), reason: z.enum(["missing", "changed"]) }),
  // A skill the charrette wrote for itself because nothing in the operator's
  // collection matched a task (skillForge.ts). The event is the provenance
  // trail SEC-14 asks for: the file on disk says what the skill claims, this
  // says which run and task put it there and what it hashed to at birth.
  z.object({ ...base, type: z.literal("skills.forged"), taskId: z.string(), name: z.string(), sha256: z.string(), path: z.string(), action: z.enum(["created", "extended"]), tokensApprox: z.number().int() }),
]);
export type CharretteEvent = z.infer<typeof CharretteEvent>;
export type CharretteEventType = CharretteEvent["type"];
