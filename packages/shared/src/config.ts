import { z } from "zod";
import { routingViolations } from "./providers.js";

/**
 * The cheap tier. Named once because four roles reference it and a version
 * string copied five times is four chances to price one of them wrong: the
 * budget table in budget.ts keys on this exact id, and a model absent from that
 * table is charged at the top tier rather than its own.
 */
const HAIKU = "claude-haiku-4-5-20251001";

export const ModelRoutingShape = z.object({
  intake: z.string().default("claude-opus-5"),
  planner: z.string().default("claude-opus-5"),
  worker: z.string().default("claude-sonnet-5"),
  /**
   * The worker model for tasks the light-tier rule admits. See modelTier.ts for
   * what "admits" means — it is a deterministic rule over fields the planner
   * already emits, not a tier the planner names for itself.
   *
   * The worker is where the money is — one recorded run spent $65 across
   * seventeen worker sessions against $14 across eight QA ones — so this is the
   * only line in this table that can move the total much.
   *
   * Two things carry the risk rather than a threshold. The rule admits a
   * deliberately narrow slice (sized S, at most `LIGHT_TIER_MAX_PATHS` files, a
   * completion probe, no risky domain), and a light-tier session that dies of
   * `error_max_turns` is re-dispatched on `worker` rather than retried here —
   * see `escalateWorker` in runController.ts. A cheap model that needs three
   * attempts costs more than the expensive one that needed one, so the first
   * failure spends up instead of replaying the same wall.
   *
   * Set this to `models.worker` to switch the experiment off without losing the
   * measurement: the rule still runs and still publishes `task.tier_decided`,
   * so the ledger keeps recording which tasks it *would* have sent down the
   * cheap road. `taskSpend()` in store.ts splits a task's bill by role and
   * flags the ones that escalated, which is the number that says whether this
   * paid for itself.
   */
  workerLight: z.string().default(HAIKU),
  qa: z.string().default("claude-sonnet-5"),
  /**
   * Resolves the run's merge conflict with its own base branch.
   *
   * Almost every `sessionId: "integrator"` in runController.ts is deterministic
   * git work — merging a task branch, opening a pull request, waiting on checks —
   * and calls no model at all. This key was documented as unused for exactly
   * that reason. `reconcileWithBase` is the one exception: when `main` has moved
   * under a long run and the integration branch no longer merges into it, an
   * agent is dispatched into the integration worktree to resolve it, because the
   * alternative is a pull request nobody can merge.
   *
   * Stays on Sonnet. The judgment it needs is narrow — which side of a hunk
   * belongs, given two commit histories it can read — and it is bounded by
   * `BASE_CONFLICT_FIX_ATTEMPTS` and verified against the branch afterwards
   * rather than taken on trust.
   */
  integrator: z.string().default("claude-sonnet-5"),
  /**
   * Drafts the operator's answer when a task escalates (Gate: task-escalation).
   *
   * Stays on Sonnet, and the reason is worth writing down because this role
   * *looks* like the cheapest thing in the harness: it writes one short answer,
   * and a human or a skill reads it before anything acts on it. What that
   * framing misses is that the answer decides which hypothesis gets attention.
   * Run f338b5c8 spent nine rounds and about $80 on a single task whose probe
   * was a false positive, and every advisor answer in that loop was *correct* —
   * "the probe is wrong, leave it alone" — and every one of them led straight
   * back to the same gate. Correct-but-useless is the failure mode here, it is
   * not visible in the draft, and a cheaper drafter makes more of it.
   */
  advisor: z.string().default("claude-sonnet-5"),
  /** Judges the deployed system against the assignment. The last word, so: Opus. */
  prod: z.string().default("claude-opus-5"),
  /**
   * Starts the half-built product at a pit stop and drives it.
   *
   * The expensive half of a pit stop — an 80-turn ceiling against a product the
   * agent has never seen — and mostly tool work, which is what Haiku is for.
   *
   * It is on the cheap tier only because the demo now has to say what it set out
   * to do before it says what it did. A demo that degrades quietly is the one
   * genuinely dangerous thing about this change: "started it and clicked twice"
   * reaches four Opus reviewers looking exactly like "drove it and photographed
   * six screens", and they reason about the product from whichever one they were
   * handed. So `plannedJourneys` is compared against what came back, in code,
   * and a demo that fell short of its own plan is published as INCONCLUSIVE
   * rather than as thin evidence. See `demoCoverage` in evidence.ts.
   *
   * Break-even, if the operator wants to check the bet against the ledger: Haiku
   * may burn up to 3x Sonnet's tokens at the same price, less whatever the
   * fallback rate costs — under about 2.4x at a 20% fallback rate.
   */
  demo: z.string().default(HAIKU),
  /**
   * Re-asks a finished session for output it already produced but did not format.
   *
   * The only role in the harness that is genuinely mechanical, and the reason is
   * structural rather than a judgment about how hard the work is: it runs with
   * `maxTurns: 2` against a *resumed* session, and its entire instruction is to
   * restate a conclusion someone else already reached without revisiting it.
   * There is no judgment left to degrade — the judging was done, on the judging
   * model, in the session being resumed. What is being bought here is JSON.
   *
   * It saves very little. A repair only fires when a QA agent ignored its output
   * contract, and it is capped at two turns when it does. It is on this list
   * because it is free of risk, not because it is worth money.
   */
  repair: z.string().default(HAIKU),
  /**
   * Reads the demo through one named lens and says whether the run is still
   * building the right thing. This is the judgment the whole pit stop exists to
   * buy, and it is judgment rather than tool work.
   *
   * Gemini rather than Opus, and the reason is independence rather than price.
   * Every line this role is judging was written by an Anthropic worker and
   * already passed an Anthropic QA; a reviewer from the same family is fluent
   * in exactly the reasoning that produced the work, which makes the objection
   * it is least likely to raise the one the pit stop exists to buy. Pinned, not
   * merely defaulted — see `PINNED_ROLES` in providers.ts.
   *
   * Flash rather than Pro because the reviewer's expensive input is already
   * paid for: it reads a demo report and a PRD that other roles produced, at a
   * 30-turn ceiling, and emits a short verdict-and-findings JSON. The judgment
   * is what is being bought here, not long-horizon tool work, and Flash is the
   * tier where a second opinion is cheap enough to run on every lens rather
   * than on the one lens somebody picked.
   */
  reviewer: z.string().default("gemini-3.7-flash"),
  /**
   * Decides what the run does next at a pit stop, having read the demo and
   * every reviewer. It is the only agent in the harness whose output redirects
   * or re-plans the remaining work on its own, so it is the last place to save
   * money: Opus.
   */
  pm: z.string().default("claude-opus-5"),
  /**
   * Writes a playbook when a task matched nothing in the operator's skill
   * collection (`skillForge`). Sonnet rather than Haiku, and the reason is the
   * blast radius rather than the difficulty: a skill is injected into every
   * later session it matches, so a wrong claim here is repeated by agents that
   * have no way to know it is wrong — the one-to-many amplifier the PRD's
   * trust boundary 6 warns about. Not Opus, because the skillsmith's output is
   * advisory prose the worker can ignore, not a verdict that gates anything.
   */
  skillsmith: z.string().default("claude-sonnet-5"),
});

/**
 * Any role may be pointed at another vendor except the ones `PINNED_ROLES`
 * names — see providers.ts for why each is pinned.
 *
 * Enforced here, where the config is parsed, rather than where the role is
 * dispatched. A run whose `prod` validator is misrouted would otherwise be
 * discovered by the validator itself, after every worker had been paid for;
 * this refuses at `harness run`, before the first agent spawns.
 *
 * This used to say that the stored config of an existing run could not trip it,
 * because nothing violating it could ever have been written. Pinning `reviewer`
 * to Google ended that: every run recorded before the switch holds
 * `reviewer: "claude-opus-5"`, which this now refuses — and `getRun` re-parses
 * the frozen config on every read, so those runs would have become unreadable
 * rather than merely unstartable. `freezeReviewer` in store.ts rewrites them at
 * open. Any future pin that moves a role which already had a default needs the
 * same treatment; the check to make is whether an existing row could hold a
 * value the new rule refuses.
 */
export const ModelRouting = ModelRoutingShape.superRefine((models, ctx) => {
  for (const message of routingViolations(models)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

/**
 * How often the run stops and shows the operator what it has built.
 *
 * `"epic"` is the default because it is the only boundary that is about the
 * product rather than the run: a count, a budget or a clock can cut an epic in
 * half and demo something that was never meant to stand alone. The others exist
 * for plans whose epics are too coarse to be a useful checkpoint.
 */
export const PitStopEvery = z.union([
  z.literal("epic"),
  z.literal("never"),
  z.object({ tasks: z.number().int().min(1) }),
  z.object({ usd: z.number().positive() }),
  z.object({ minutes: z.number().int().min(1) }),
]);
export type PitStopEvery = z.infer<typeof PitStopEvery>;

export const PitStopConfig = z.object({
  every: PitStopEvery.default("epic"),
  /**
   * The lenses the built product is reviewed through, by skill name. Each one is
   * a separate short session, so this is also the pit stop's price: four lenses
   * is four reviews. Skills absent from `skillsDirs` still get their lens — the
   * name alone tells the reviewer which hat to wear — but they read far better
   * with the operator's own playbook in front of them.
   *
   * `ui-ux-cx-engineer` is here because the pit stop is the only place anyone
   * looks at the whole product at once. Task-level QA judges one screen against
   * one task's criteria and cannot see that six of them disagree about spacing,
   * button weight and where the primary action lives. It is also newly worth
   * paying for: the demo agent could not photograph anything until it was given
   * a browser, so this lens would have been reviewing prose.
   */
  reviewers: z
    .array(z.string())
    .max(4)
    .default(["product-manager", "critical-challenger", "qa-agent", "ui-ux-cx-engineer"]),
  /**
   * How many lenses read the demo before the harness decides whether the rest
   * are worth paying for. `0` runs them all, every time, which is what this used
   * to do unconditionally.
   *
   * Every lens is a separate Opus session, and four of them fire at every epic
   * boundary whatever the demo said. Most pit stops in a healthy run are four
   * reviewers agreeing that the run is on track — which is the answer the first
   * two already gave, for half the money.
   *
   * So the remaining lenses are bought only when the first pass suggests there
   * is something to find: any first-pass lens that is not `on-track`, any
   * disagreement between them, a lens that did not finish, or a demo that came
   * back INCONCLUSIVE. The escalation is deliberately generous — the second pass
   * is cheap next to missing the drift a pit stop exists to catch, and the
   * failure this saves money on is the boring case, not the interesting one.
   *
   * Which lenses were skipped, and why, is published with the report. A staged
   * review that silently ran two lenses would read as four opinions, which is
   * the same lie as a truncated evidence list reading as a complete one.
   */
  reviewFirstPass: z.number().int().min(0).max(4).default(2),
  /**
   * The demo agent's turn ceiling. It has to start a product it has never seen
   * and drive it, which is the expensive half of a pit stop; a ceiling that is
   * too low produces a report that says only "I could not start it".
   */
  demoMaxTurns: z.number().int().min(20).max(200).default(80),
  /**
   * Who decides what the run does next, by skill name — or `"operator"` to be
   * asked, which is what this used to be unconditionally.
   *
   * A pit stop already buys four opinions from four named lenses. What it did
   * with them was print them and block until a human typed a letter, which
   * means the checkpoint only works while someone is watching: the run that
   * stops at 2am for a decision its own reviewers had already made is a run
   * that has stopped, and the operator wakes to a demo, four reviews and no
   * progress. The named skill reads the same report and answers the same four
   * ways, so the checkpoint keeps its judgment and loses its dependence on
   * someone being awake for it.
   *
   * The operator is not cut out of anything they had: the report is still
   * written, still published, and the decision and its reasoning are recorded
   * next to it. What they lose is having to be there.
   *
   * A decider that fails, or answers with something that is not one of the four
   * actions, falls back to asking — a pit stop is never resolved by a guess.
   */
  decidedBy: z.string().min(1).default("product-manager"),
  /**
   * How many times the closing pit stop may send the run back to work before
   * the next one goes to the operator whatever `decidedBy` says.
   *
   * The closing pit stop is the one that repeats. Every other pit stop happens
   * at a new point in the plan — a decider that redirects at three consecutive
   * epics is doing its job — but this one fires on a FAIL from the intent
   * check, and "back to work" returns the run to the same verdict on a tree it
   * has already judged. Answered by a human that loop ends when they lose
   * patience; answered by an agent it ends when the run hits its cap, having
   * paid for a demo, four reviewers, a decider and a round of workers each time
   * round. Two goes, and then the question is one only a person can settle.
   */
  backToWorkRounds: z.number().int().min(0).max(10).default(2),
});
export type PitStopConfig = z.infer<typeof PitStopConfig>;

export const CheckpointConfig = z.object({
  /**
   * Turns between checkpoints. `0` turns them off entirely.
   *
   * A checkpoint costs one turn and one exchange's tokens. At twenty, a worker
   * on the default 120-turn ceiling pays four of them — under 4% of its budget
   * — and a session that ends before its wrap-up point never pays anything,
   * because the cadence is compared against that point rather than against the
   * cap. Lower it to steer harder on a run you are watching; the floor is a
   * checkpoint every five turns, below which the session spends more time
   * describing the work than doing it.
   */
  every: z.number().int().min(0).max(200).default(20),
  /**
   * Replace the older transcript with the agent's own digest, rather than only
   * recording it.
   *
   * Only the harness-run tool loop can honour this — OpenAI and Google sell the
   * turn and nothing else, so the harness holds those transcripts and can swap
   * material out of them. Anthropic sessions run inside the SDK, which compacts
   * its own; there a checkpoint still buys the record and the questions, and
   * this flag is simply not reachable.
   *
   * On, because it is the half that pays for itself: the digest was written on
   * a turn that was going to happen anyway, and folding it in is the difference
   * between a session carrying six-hundred-character stubs of everything it
   * ever read and one carrying what those files turned out to say.
   */
  fold: z.boolean().default(true),
});
export type CheckpointConfig = z.infer<typeof CheckpointConfig>;

export const Budget = z.object({
  runCapUsd: z.number().positive().default(30),
  /**
   * Who answers when the run cap is reached, by skill name — or `"operator"`
   * to be asked, which is what this used to be unconditionally.
   *
   * The operator's half of that has always been pressing enter on a suggested
   * figure — run f338b5c8's budget gate was accepted unchanged **six hours and
   * forty minutes** after it opened, with a worker slot idle the whole time.
   *
   * A skill answers the same question against something the terminal prompt
   * never showed: what the plan still has left, and what the last iterations
   * actually produced. It may decline, and a decline parks the run exactly as
   * the operator's `s` did.
   */
  decidedBy: z.string().min(1).default("product-manager"),
  /**
   * The run-spend figure a skill may raise the cap up to, and never past.
   * Unset — the default — means the gate is always the operator's, whatever
   * `decidedBy` says.
   *
   * The run cap is the agreed number itself, and an agent that can raise its
   * own ceiling has no ceiling. So raising it needs a second number, typed by
   * a person, in advance — `{"budget":{"runCapUsd":100,"ceilingUsd":600}}`
   * reads as "go to 600 without me if the work is worth it", which is a thing
   * an operator can mean.
   */
  ceilingUsd: z.number().positive().optional(),
  /**
   * How many times a skill may raise the run cap before the next one goes to
   * the operator whatever `decidedBy` says.
   *
   * A cap reached three times is not an estimate that was slightly off. It is
   * a run that does not know how to finish, and the fourth raise buys another
   * round of whatever the first three bought. `0` asks every time, which is
   * `decidedBy: "operator"` with extra steps.
   */
  autoRaiseRounds: z.number().int().min(0).max(10).default(3),
});

/**
 * One Claude subscription the run may spend, named so the operator can hand the
 * run a different one without editing anything but the name.
 *
 * `env` is the whole mechanism: it is merged into the environment of every agent
 * session spawned afterwards, and the two things worth putting in it are the two
 * ways a Claude Code session picks its account —
 *
 *   { "name": "personal", "env": { "CLAUDE_CODE_OAUTH_TOKEN": "$PERSONAL_TOKEN" } }
 *   { "name": "work",     "env": { "CLAUDE_CONFIG_DIR": "/Users/me/.claude-work" } }
 *
 * — a long-lived token from `claude setup-token` run on the other account, or a
 * second config directory that account is logged into. An `ANTHROPIC_API_KEY`
 * here is legal too and means "stop spending the plan, start spending money".
 *
 * A value written as `$NAME` or `${NAME}` is read from the harness's own
 * environment when the session is spawned, never from this file. That is not a
 * convenience: this file lives in the repository, and a subscription token
 * committed to it is a subscription token published. The harness refuses a
 * reference it cannot resolve rather than spawning a session with an empty
 * credential, which fails later and less clearly.
 */
export const SubscriptionAccount = z.object({
  name: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  /** Free text shown beside the name when the operator is choosing. */
  note: z.string().default(""),
});
export type SubscriptionAccount = z.infer<typeof SubscriptionAccount>;

/**
 * Watch how much of the account's plan the run has left, and stop before it is
 * gone (`docs/OPERATIONS.md`, "Subscription limits").
 *
 * The harness already survives a limit it has *hit*: every session in flight
 * dies at once, `usageLimit.ts` reads the dying words, and the pool sleeps until
 * the window reopens. That is the right answer for the five-hour window, which
 * reopens while the operator is at lunch. It is the wrong answer for the weekly
 * one: a run that walks into the weekly wall on a Tuesday is parked until
 * Friday, holding worktrees, containers and a half-merged integration branch,
 * and the operator finds out by noticing nothing has happened.
 *
 * So the weekly window gets a gate instead of a wait. At `pauseAtPercent` the
 * run stops with its sessions still open, says which window and when it resets,
 * and asks — exactly as the budget cap does, and for the same reason: the work
 * in flight has already been paid for.
 *
 * The readings come from the account's own plan metering, not from the harness's
 * ledger. `budget.runCapUsd` counts what this run spent; this counts what the
 * *account* has spent, on every machine and every session, which is the number
 * the wall is actually made of.
 */
export const SubscriptionConfig = z.object({
  /**
   * The utilization, in percent, at which the run stops and asks.
   *
   * Not 100: a gate that opens at the wall is a gate that opens after every
   * session in flight has already died against it, which is the failure this
   * exists to prevent. Five percent of a weekly window is roughly the last few
   * tasks — enough to finish what is running and choose deliberately.
   */
  pauseAtPercent: z.number().min(1).max(100).default(95),
  /**
   * Which windows this gate watches, matched as prefixes of the window name.
   *
   * `seven_day` covers every weekly window the plan meters — the plan-wide one
   * and the per-model ones (`seven_day_opus`, `seven_day_sonnet`) — because they
   * are the same kind of wall: days away, and nothing to do but wait it out.
   * Adding `five_hour` extends the gate to the short window, which is a
   * defensible choice for a run you are watching and a poor one for a run you
   * left going: the short window reopens on its own, and `usageLimitWaitMinutes`
   * already sleeps through it without asking anybody anything.
   */
  windows: z.array(z.string().min(1)).default(["seven_day"]),
  /**
   * The subscriptions this run may be pointed at. Empty — the default — leaves
   * the gate able to pause and alert but with nothing to offer but "carry on" or
   * "park", which is still strictly better than walking into the wall.
   */
  accounts: z.array(SubscriptionAccount).default([]),
  /**
   * Which of them the run is spending now. Empty means the ambient one: whatever
   * account the operator's own `claude` is logged into, which is what every run
   * before this feature used and what a run with no `accounts` keeps using.
   *
   * Set by the gate when the operator switches, and by `harness resume
   * --account <name>`. Unlike the repo path, this is deliberately not frozen at
   * creation: a subscription is a thing a run can run out of, so being able to
   * change it mid-run is the entire point.
   */
  active: z.string().default(""),
  /**
   * Read the account's utilization once before the run spends anything, instead
   * of waiting for a live session to report it.
   *
   * A session only reports what it sees, and it sees nothing until it has been
   * spawned — so without this, a run started at 97% of its weekly window pays
   * for a planner before anything notices. The check costs no model tokens: it
   * opens a session, asks the control channel the same question `/usage`
   * answers, and closes it. Off skips it and leaves the gate driven purely by
   * what live sessions report.
   */
  preflight: z.boolean().default(true),
});
export type SubscriptionConfig = z.infer<typeof SubscriptionConfig>;

/**
 * Who answers the plan gate when the intent check says this plan would not
 * deliver the assignment.
 *
 * The check itself is not the problem — it works. Run f338b5c8's fired before a
 * single worker was dispatched and named four things the plan would not
 * deliver, including the one that ended the run 51 tasks and $475 later: no
 * task owned the mechanism that makes M0's gates measurable. It was approved
 * two and a half minutes later.
 *
 * That is what an advisory finding is worth at a gate whose other option is
 * typing a paragraph of re-planning feedback at 9pm. So the finding gets an
 * adjudicator: a skill that reads the assignment, the PRD, the plan and the
 * gaps, and either sends the plan back — on its own authority, no human in the
 * loop — or accepts the gaps in writing, with the reasoning appended to what
 * the operator then approves.
 *
 * Approval stays the operator's either way. This is a veto, not a rubber stamp
 * with a different signature: the plan gate is the cheapest moment in a run and
 * the operator is demonstrably at the keyboard, having just started it, so
 * there is nothing to win by deciding it for them. What there is to win is a
 * FAIL that costs something to wave through.
 *
 * `"operator"` restores the old behaviour of showing the gaps and asking.
 */
export const PlanGateConfig = z.object({
  decidedBy: z.string().min(1).default("product-manager"),
  /**
   * How many times the decider may send a plan back over the intent check's
   * gaps before the gate is the operator's however it answers.
   *
   * Each round is a planner session and another intent check, and the second
   * one reads a plan written by the same planner against the same brief. One
   * go, and then a gap the planner could not close twice is a question about
   * the assignment, not about the plan. `0` turns the veto off and leaves the
   * decider's reasoning as a note on the gate.
   */
  replanRounds: z.number().int().min(0).max(3).default(1),
});
export type PlanGateConfig = z.infer<typeof PlanGateConfig>;

/**
 * Who answers when a task hits its cap (Gate: task-escalation).
 *
 * The advisor has drafted that answer for a while now, and the operator's part
 * in it had already shrunk to reading a verified recommendation and clicking
 * accept. That click is still a person being awake: a run that escalates at 2am
 * stops there, with a worker slot idle and an answer sitting on screen that
 * nobody is there to send. Naming a skill hands the same draft to the same
 * judgment the pit stop already trusts — the advisor answers *as* that skill,
 * with its playbook in front of it, and the worker gets a fresh set of
 * iterations without waiting for anyone.
 *
 * `"operator"` restores the old behaviour of always asking.
 *
 * Nothing is hidden by this: the escalation, the recommendation and who
 * answered it are all still published, and the answer is the one the operator
 * would have been shown.
 */
export const TaskGateConfig = z.object({
  decidedBy: z.string().min(1).default("product-manager"),
  /**
   * How many times a skill may answer the *same* task's escalation before the
   * next one goes to the operator whatever `decidedBy` says.
   *
   * Each answer resets the task's iteration and respawn counters — that is the
   * point of answering — so an agent answering its own escalations is a loop
   * with no natural end but the task's budget cap. A skill that has now twice
   * told the same task how to get unstuck, and been wrong twice, is not the
   * thing standing between this task and finishing. `0` asks every time, which
   * is `decidedBy: "operator"` with extra steps.
   */
  autoAnswerRounds: z.number().int().min(0).max(10).default(2),
  /**
   * How many times the decider may rewrite the *probe* a task is escalating
   * about, rather than answering around it.
   *
   * A completion probe is checked before QA and the worker is forbidden to edit
   * it, so nothing an answer says can make a wrong one pass: run f338b5c8 spent
   * nine rounds and about $80 on one task whose probe ended in
   * `! rg -qi 'passkey|webauthn' frontend/src`, matching one enum value in a
   * generated file that no login screen was ever going to remove. Every answer
   * was correct — "the probe is a false positive, leave it alone" — and every
   * answer led straight back to the same gate, because agreeing with the
   * escalation was the one thing that could not end it.
   *
   * So the decider may narrow the probe once, on the record
   * (`task.probe_amended`), and after that the task's definition of done is
   * settled as far as any agent is concerned. `0` restores the probe as
   * unamendable; the operator's own `harness probe` is never bounded.
   */
  probeAmendments: z.number().int().min(0).max(5).default(1),
});
export type TaskGateConfig = z.infer<typeof TaskGateConfig>;

/**
 * The vocabulary of user-interface work, written once because three rules match
 * on it. Splitting the UI rule by role is the point — see `skillRouting` — and
 * three copies of a regex this long is three chances for them to drift apart.
 */
// Deliberately excludes `brand`, `logo` and `visual identity`: those are the
// marketing rule's words, that rule sits below this one, and a branding task
// that tripped both would spend its four slots on frontend skills and drop
// `branding-manager` at the cap. Design-system vocabulary is named instead.
//
// Tuned for precision rather than recall, which is the opposite of how a
// keyword gate is usually written — because since `INTERFACE_STANDARD` the
// craft rules reach every worker unconditionally, from the prompt. This regex
// no longer decides whether a task gets design guidance at all; it decides
// whether it also gets two 200-line playbooks, against a four-skill cap. A miss
// now costs depth. A false positive costs a slot on a task with no surface, and
// that slot is the one the genuinely relevant skill needed.
//
// So the ambiguous words are qualified rather than dropped: bare `table` is a
// database table far more often than a data grid, bare `graph` is a dependency
// graph, bare `toggle` is a feature flag, and `page` is pagination whenever it
// is followed by size/token/cursor/number. `form` is excluded before "of" for
// the same reason — "in the form of" appears in ordinary prose.
// Every countable noun here carries `s?`, which the original vocabulary did
// not: `\bicon\b` does not match "icons", so "Replace the emoji with proper
// icons" routed nowhere, and neither did "responsive components". A gate that
// depends on a planner writing the singular is not a gate.
const UI_WHEN =
  "\\b(" +
  // Surfaces and the design system itself.
  "ui|ux|frontend|front-end|dashboards?|console|web pages?|landing|components?|css|styling|layouts?|responsive|" +
  "accessib\\w+|design systems?|design tokens?|design language|style guides?|screens?|themes?|palettes?|" +
  "typograph\\w+|wordmarks?|pages?(?! ?(size|token|cursor|number))|" +
  // Controls a person points at. The rule about using the app's own components,
  // and the one about scaling a control to its data, are only checkable when a
  // task that names the control rather than the container still routes.
  "buttons?|forms?(?! of)|input fields?|text fields?|dropdowns?|drop-?downs?|combo ?box(es)?|autocomplete|" +
  "typeahead|date ?pickers?|checkbox(es)?|radio groups?|toggle switch(es)?|sliders?|modals?|dialogs?|" +
  "tooltips?|popovers?|toasts?|snackbars?|banners?|hero|breadcrumbs?|nav|navbars?|navigation|sidebars?|" +
  "menus?|tab bars?|steppers?|wizards?|data ?tables?|table views?|list views?|grid views?|charts?|" +
  "visuali[sz]ations?|icons?|iconograph\\w+|avatars?|" +
  // The states everyone forgets, and the polish that separates a screen that
  // works from one that is pleasant to use.
  "empty states?|loading states?|error states?|spinners?|placeholders?|helper text|microcopy|onboarding|" +
  "dark mode|light mode|contrast ratios?|focus states?|hover states?|animations?|micro-?interactions?|" +
  // Where it is looked at.
  "mobile|ios|android|tablet|touch targets?|safe areas?" +
  ")\\b";

export const RunConfig = z.object({
  // PRD §11.5: default 3. Independent DAG tasks run concurrently, each in its
  // own worktree; runs recorded before the parallel scheduler keep whatever
  // value is frozen in their config.
  maxParallelWorkers: z.number().int().min(1).max(16).default(3),
  qaIterationCap: z.number().int().min(1).max(3).default(3),
  /**
   * How many turns a QA session gets before the SDK cuts it off.
   *
   * A QA agent that runs out of turns never writes its verdict, and a task can
   * only be judged by a QA session that finished. Sixty turns is plenty to read
   * a diff and run `tsc && jest`; it is not enough where verifying means booting
   * an emulator or building an image, so this is a per-repo knob. The retry also
   * raises it on its own (see `dispatchTask`) — a ceiling that was too low once
   * is too low twice.
   */
  qaMaxTurns: z.number().int().min(20).max(300).default(90),
  /**
   * How many turns a worker session gets before the SDK cuts it off.
   *
   * The same knob as `qaMaxTurns`, for the role that actually keeps hitting the
   * wall: one run lost $65 across 17 worker sessions to `error_max_turns`
   * against $14 across 8 QA sessions, and the worker's ceiling was hardcoded
   * where QA's was configurable. A worker dies at the ceiling having done the
   * most work of any session in the run, and the re-dispatch starts over.
   * Raised on retry too — a ceiling that truncated once truncates twice.
   */
  workerMaxTurns: z.number().int().min(20).max(400).default(120),
  workerRespawnCap: z.number().int().min(1).max(3).default(3),
  taskWallClockMinutes: z.number().int().min(5).default(45),
  /**
   * How long a single agent session may spend waiting for the account's usage
   * limit to reset before it gives up and reports the failure.
   *
   * Per session, not per run: the limit is account-wide, so a run long enough to
   * meet two quota windows would have its second one refused by a budget the
   * first had spent. What this bounds is how long any one session is allowed to
   * go quiet; a long run can survive several outages, each of them this long.
   *
   * A quota window closing is not a fault in the work: every session in flight
   * dies at once with "You've hit your session limit · resets 8:20pm", and the
   * only remedy is time. Read as an ordinary error it ends runs — three planner
   * attempts inside one second, `harness: fatal`, and an intake conversation the
   * operator sat through thrown away with it.
   *
   * Six hours covers a five-hour window reached at its very start, with slack
   * for a message quoting a reset the account then honours a little late. Longer
   * suits an operator who leaves runs going overnight and wants a weekly limit
   * slept through too; `0` restores the old behaviour of failing immediately.
   */
  usageLimitWaitMinutes: z.number().int().min(0).max(7 * 24 * 60).default(360),
  models: ModelRouting.default({}),
  budget: Budget.default({}),
  /**
   * What the run does as the *account's* plan runs out, rather than as this
   * run's dollar cap does. `{"subscription":{"pauseAtPercent":100}}` restores
   * the old behaviour of noticing only once the wall is hit.
   */
  subscription: SubscriptionConfig.default({}),
  /**
   * How often the run stops, demos what it has built, and asks the operator
   * whether it is still the thing they wanted. See docs/PITSTOP.md.
   *
   * On by default, at every epic boundary. The two runs that motivated this
   * both produced accurate findings — a broken endpoint seam, a $721 tree
   * nobody could describe — that arrived only after the money was spent, and
   * the harness had no checkpoint between "approve this plan" and "here is the
   * diff". `{"pitStop":{"every":"never"}}` restores that.
   */
  pitStop: PitStopConfig.default({}),
  /**
   * How often a running agent stops to say where it is and what it would like
   * decided. See docs/CHECKPOINT.md.
   *
   * The pit stop above is the run's checkpoint and fires on epic boundaries,
   * spend and wall clock. This is the session's, and it fires on turns — which
   * is what an agent losing the plot is actually measured in, and tens of
   * thousands of tokens finer-grained than any pit stop can be.
   * `{"checkpoint":{"every":0}}` restores the old behaviour of never asking.
   */
  checkpoint: CheckpointConfig.default({}),
  /**
   * Who answers a task that hit its cap, and how many times they may answer the
   * same one. `{"taskGate":{"decidedBy":"operator"}}` always asks you.
   */
  taskGate: TaskGateConfig.default({}),
  /**
   * Who adjudicates a failing plan-intent check, and how many times they may
   * send the plan back over it. `{"planGate":{"decidedBy":"operator"}}` shows
   * you the gaps and asks, which is what this used to do unconditionally.
   */
  planGate: PlanGateConfig.default({}),
  /**
   * How many times a failing intent check may queue work to close its own gaps.
   *
   * The validator reads the merged tree as a whole and answers the only question
   * task-level QA never asks: does the sum of this do what was asked? Its verdict
   * used to be a note in the log. Run 40da9337 merged 36 tasks, opened its pull
   * requests, and reported success carrying a FAIL that said none of the workers
   * that move money were scheduled to run anywhere outside a test — seven gaps,
   * every one of them a task the harness could have written.
   *
   * One round by default: the gaps are small, concrete and derived from a tree
   * that already exists, so a second pass rarely finds what the first could not,
   * and an unbounded loop is a run that never lets go. `0` restores the old
   * behaviour of reporting the verdict and stopping there.
   */
  intentFixRounds: z.number().int().min(0).max(3).default(1),
  /**
   * Ask, at the plan gate, whether this plan could deliver the assignment at all
   * — before a worker is dispatched.
   *
   * The same question is already asked at the end of every run, and asking it
   * there is what makes the answer expensive. Run 40da9337's plan gave every one
   * of seven vendor categories acceptance criteria that a deterministic mock
   * satisfies, against an assignment that said "including all the integrations".
   * Nothing was wrong with the execution; the plan promised less than the brief
   * and no one compared them until $773.55 later. One agent call at the gate is
   * roughly a dollar.
   *
   * Off restores the old behaviour: the operator reads the plan and is the only
   * thing standing between a hollow plan and a run that faithfully builds it.
   */
  planIntentCheck: z.boolean().default(true),
  skillsDirs: z.array(z.string()).default([]),
  /**
   * Let the harness write a skill for itself when a task matches nothing.
   *
   * The trigger is precise: a task about to dispatch whose worker selection —
   * routed, standing and scored together — came back empty. That is the case
   * the whole skills system cannot help with today: the matcher's honest
   * answer is "your collection has nothing for this", and the worker goes in
   * cold. When it fires, a `skillsmith` session reads the repository, drafts a
   * playbook for that class of task (or extends one it forged earlier, or
   * declines), and the harness — not the agent — installs it under
   * `<repo>/.harness/skills/`.
   *
   * Two lines the design does not cross. The skillsmith never writes files:
   * it emits a draft and the harness validates and installs it, so the PRD's
   * rule that no agent modifies the skills registry stays true — the
   * operator's `skillsDirs` are never touched, and the forge directory is
   * harness state, beside the run database. And forged skills carry the same
   * provenance discipline as everything else: frontmatter naming the run and
   * task that forged them, a `skills.forged` event with the birth hash, and
   * the same hash-verify-at-injection as operator skills (SEC-14/15).
   *
   * Forged skills persist across runs of the same repository on purpose — the
   * second run should not pay to relearn what the first one wrote down. That
   * is a standing decision to reuse model-authored guidance, which memory.ts
   * deliberately refuses for *facts*; a playbook is advisory and wrapped as
   * such, but an operator who shares that caution sets `enabled: false`, and
   * the files themselves are plain markdown in `.harness/skills/`, theirs to
   * read, edit or delete.
   *
   * `maxPerRun` bounds what forging may spend: each forge is one bounded
   * read-only session, and a run that needs more than a few is a run whose
   * plan is telling the operator something about their skill collection.
   */
  skillForge: z
    .object({
      enabled: z.boolean().default(true),
      maxPerRun: z.number().int().min(0).max(20).default(3),
    })
    .default({}),
  /**
   * Skills bound to a class of work, by name, ahead of any scoring.
   *
   * Lexical matching alone cannot decide this. Measured against a real 47-skill
   * corpus and a 36-task payments plan, the top match for the sanctions-screening
   * task was `testimonial-collector`, for card tokenization `branding-manager`,
   * for a state machine `cartographer` — each scoring *above* every genuinely
   * relevant skill, with and without idf weighting, matching on descriptions or
   * on bodies. No threshold separates those, because the ranking itself is noise:
   * a backend task has no lexical neighbour in a corpus of marketing and ops
   * skills, so the matcher returns the nearest thing rather than nothing.
   *
   * So the operator says it outright. `when` is a case-insensitive regular
   * expression tested against the task's title and spec; every named skill that
   * exists in `skillsDirs` is injected, and scoring only fills what is left.
   *
   * `roles` narrows a rule to the sessions that should carry it — omit it and
   * every role does, which is the older behaviour. The reason it exists is that
   * some skills are for building and some are for grading, and handing the agent
   * that wrote the screen the playbook for judging it is not a review. It also
   * relieves the per-role cap: a builder skill and a grader skill no longer
   * compete for the same four slots.
   */
  skillRouting: z
    .array(
      z.object({
        when: z.string(),
        skills: z.array(z.string()),
        roles: z.array(z.enum(["intake", "planner", "worker", "qa", "prod"])).optional(),
      })
    )
    .default([
      // First, because both of these lose the per-role cap to the architecture
      // rule otherwise. A DNS task and a greenfield task both match the
      // architecture vocabulary, and that rule alone fills all four slots — so
      // the one skill that knows the actual answer would be the one dropped.
      {
        when: "\\b(dns|dns-project|nameservers?|name server|cname|txt record|mx record|zone file|subdomain|apex domain|custom domain|cert-?manager|clusterissuer|dns-?01|let'?s encrypt|route ?53)\\b",
        skills: ["dns-project-iac-engineer"],
      },
      {
        when: "\\b(greenfield|from scratch|scaffold\\w*|boilerplate|new (project|service|application)|tech(nology)? stack|stack (choice|selection)|dynamodb|magic[- ]link|webauthn|passwordless|serverless|lambda|cloudfront|api gateway)\\b",
        skills: ["fullstack-app"],
      },
      {
        when: "\\b(architect(ure|ural)?|system design|data model|schema design|infrastructur\\w*|terraform|cloudformation|kubernetes|k8s|deployment topology|scalab\\w+|throughput|latency|capacity)\\b",
        skills: ["architect", "security-engineer", "performance-engineer", "frontend-design"],
      },
      // UI work, split by who is doing what. The build side gets a product voice
      // alongside the design ones; the grading side gets the specialist that
      // looks at pixels, and never reaches the agent that drew them.
      { when: UI_WHEN, skills: ["frontend-design", "ui-ux-cx-engineer"] },
      { when: UI_WHEN, skills: ["product-manager"], roles: ["worker"] },
      { when: UI_WHEN, skills: ["visual-qa-agent"], roles: ["qa"] },
      {
        when: "\\b(product|roadmap|prioriti\\w+|user stor(y|ies)|onboarding|activation|retention|churn|pricing|monetiz\\w+|scope|mvp|kpi|north star|funnel|success metric)\\b",
        skills: ["product-manager"],
      },
      {
        when: "\\b(marketing|campaign|brand(ing)?|copy(writing)?|messaging|positioning|seo|content strategy|newsletter|social media|launch|press|announcement)\\b",
        skills: ["marketing-director", "branding-manager"],
      },
      {
        when: "\\b(sales|selling|conversion|upsell|cross-sell|lead gen\\w*|crm|pipeline|quote|discount|paywall|trial|subscription tier|checkout funnel)\\b",
        skills: ["online-sales-specialist"],
      },
      {
        when: "\\b(focus group|persona panel|user research|customer interview|usability (test|study)|voice of (the )?customer|survey)\\b",
        skills: ["persona-panel"],
      },
    ]),
  /**
   * Skills a role always carries, whatever the text says.
   *
   * `skillRouting` binds a skill to a *topic*; this binds one to a *job*. The
   * distinction matters for the agents whose whole output is a product decision:
   * the intake agent decides what gets built and the planner decides how it is
   * cut up, and neither of those is reliably signalled by a keyword in the
   * operator's one-line assignment. "Add rate limiting" contains no product
   * vocabulary and is still a product decision.
   *
   * Keyed by role (`intake`, `planner`, `worker`, `qa`, `prod`). Named skills
   * absent from `skillsDirs` are ignored, and these count against the same
   * per-role cap as routed and scored skills.
   */
  roleSkills: z
    .record(z.string(), z.array(z.string()))
    .default({ intake: ["product-manager"], planner: ["product-manager"] }),
  githubRepo: z.string().optional(),
  /**
   * The branch the run started from. Component PRs target this, not the run's
   * integration branch: the integrator merges every accepted task into the
   * integration branch before opening its PR, so a PR based there has no commits
   * of its own and GitHub rejects it. Basing on the start branch is also what
   * makes the PR mergeable by a human, which is the point of opening it.
   * Empty when HEAD is detached — PRs are then skipped rather than guessed at.
   */
  baseBranch: z.string().default(""),
  /**
   * How merged work is published. Task branches are cut from the integration
   * branch, so each one carries every merge that landed before it — per-task
   * PRs against the base overlap until the last one is nearly the whole run.
   * "single" (default) opens one PR from the integration branch: the complete
   * diff exactly once, and exactly the tree the intent validator judged.
   * "per-task" keeps the one-PR-per-task behaviour.
   */
  prMode: z.enum(["single", "per-task"]).default("single"),
  deterministicChecks: z.array(z.string()).default([]),
  /**
   * Wait for the pull request's own checks before calling the run finished.
   *
   * The deterministic checks prove one task's worktree was green in isolation;
   * the repo's CI is the only thing that judges the merged branch the way the
   * repo does — including the conflicts and the workflow steps no worktree ever
   * runs. A run that reports "1 pull request open for review" over a red branch
   * has told the operator the opposite of the truth. Off skips the wait.
   */
  waitForChecks: z.boolean().default(true),
  /** How long to wait for those checks before reporting them as still pending. */
  checkTimeoutMinutes: z.number().int().min(1).max(120).default(20),
  /**
   * How many rounds of fix tasks a red CI may queue before the run stops
   * treating it as its own work and hands it to a person.
   *
   * `waitForChecks` made the run *see* a red branch; this makes it act. A
   * failing check is work in exactly the sense a base conflict is: something
   * only the run can fix while it still has agents, not something to report.
   * Each round re-runs the failed jobs once first (CI flakes; a fix task
   * against a flake "fixes" code that was never broken), then queues one task
   * per failing check with that job's log in the spec. Two rounds by default:
   * the first fixes the ordinary breakage, the second catches what the first
   * missed, and past that the failure is telling you something about the repo
   * or its runner that an agent loop will only spend money restating. `0`
   * restores the old behaviour — report the red branch and stop.
   */
  ciFixRounds: z.number().int().min(0).max(3).default(2),
  /**
   * The live URL this repo deploys to. Set it and a run does not end at the
   * pull request: once a human merges, the harness follows the deploy and sends
   * an agent to check the running system against the original assignment.
   *
   * Empty (the default) keeps the old behaviour — the run ends at PR_REVIEW.
   */
  prodUrl: z.string().default(""),
  /** How long to wait for the merge commit's deploy before giving up on it. */
  deployTimeoutMinutes: z.number().int().min(1).max(240).default(30),
  /**
   * External CLIs (gh, aws, podman, adb, …) advertised to worker and QA agents.
   * Omit for everything found on PATH; `[]` to tell them about nothing.
   */
  externalTools: z.array(z.string()).optional(),
});
export type RunConfig = z.infer<typeof RunConfig>;
