import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { query, type HookInput, type HookJSONOutput, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentRole, providerFor } from "@harness/shared";
import { checkpointDue, checkpointPrompt, describeQuestions, isCheckpointOnly, parseCheckpoint, DEFAULT_EVERY } from "./checkpoint.js";
import { toolLoop, unsupportedSpec, type PromptSource } from "./toolLoop.js";
import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { BudgetExceeded, costUsd } from "./budget.js";
import { humanWait, limitWaitMs, usageLimitOf, type UsageLimit } from "./usageLimit.js";
import { describeReading, keepsTranscript, readRateLimitEvent, readUsageSnapshot, type SubscriptionReading } from "./subscription.js";
import { harnessBuild } from "./build.js";
import { infraGuardHook } from "./infraGuard.js";
import { reapUnder } from "./reaper.js";
import { rtkHooks } from "./rtk.js";
import { worktreeGuardHook } from "./worktreeGuard.js";

import { BASH_TIMEOUT_MS } from "./limits.js";

export { BASH_TIMEOUT_MS };

/**
 * A backgrounded shell kills the session it was started from, so keep shells in
 * the foreground.
 *
 * When a backgrounded task finishes, the CLI enqueues its completion notice as a
 * queued command with `mode: "task-notification"` — and the streaming-input main
 * loop throws `only prompt commands are supported in streaming mode` for any
 * queued command that is not a prompt. We are *always* in streaming mode: the
 * prompt stream is held open so the operator can speak mid-flight. So a
 * backgrounded shell is a delayed-action kill, fired whenever that command
 * happens to exit — which is why the death never lands near the call that armed
 * it. Run 40da9337: 8 of the 21 sessions that ended up with a tracked background
 * task died this way, against 0 of the 138 without one, taking $19.22 and hours
 * of committed work with them.
 *
 * There are two ways in, and the flag is the rare one. The CLI *also* backgrounds
 * any command that outruns its timeout — `if (z.onTimeout && E) z.onTimeout(...)`,
 * telemetry `tengu_bash_command_timeout_backgrounded` — where the default timeout
 * is 120s and `E` excludes only a short denylist of first words, so essentially
 * every command qualifies. That is the path that actually fired in 40da9337: not
 * one of the run's 4357 Bash calls set `run_in_background`, and the session that
 * armed the fuse after the fix shipped did it by running `npm test`, which takes
 * longer than two minutes. So both doors get shut — the flag is denied outright,
 * and the timeout is raised past anything a test suite or build plausibly needs
 * (BASH_TIMEOUT_MS, applied to the session env and to explicit short requests).
 *
 * A plain `cmd > log 2>&1 &` inside one Bash call returns immediately and is
 * untracked by the CLI, so it neither times out nor raises a notification —
 * which is what the denial recommends.
 */
export function backgroundShellHook() {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    const args = input.tool_input as { run_in_background?: unknown; timeout?: unknown };
    if (args?.run_in_background === true) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Blocked: run_in_background kills this session. The CLI reports a finished background task through a channel this session cannot receive, and the session dies the moment the command exits — losing your uncommitted work, not just the command's output. Nothing you can do inside the session recovers it. Run the command in the foreground instead; if it is genuinely long-running, redirect it in a single call — `cmd > /tmp/out.log 2>&1 &` — and read the log with a later Bash call. That form is not tracked, raises no notification, and is safe.",
        },
      };
    }
    // An explicit `timeout` overrides the env default, so an agent asking for a
    // short one re-opens the door the env just closed. Raise it rather than
    // denying: the agent wanted a time limit, not a dead session, and a denial
    // here would reject commands that are otherwise perfectly fine.
    if (typeof args?.timeout === "number" && args.timeout < BASH_TIMEOUT_MS) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          permissionDecisionReason: `timeout raised to ${BASH_TIMEOUT_MS}ms; a Bash command that outruns its timeout is backgrounded, and a backgrounded command kills this session when it exits`,
          updatedInput: { ...args, timeout: BASH_TIMEOUT_MS },
        },
      };
    }
    return {};
  };
}

/**
 * The PreToolUse hooks every agent session runs with.
 *
 * Order matters: the guards run first so a denial is decided on the command the
 * agent actually wrote, before rtk has a chance to rewrite it into something the
 * matchers no longer recognise. And they are unconditional — rtk is optional and
 * absent on most machines, so a guard assembled as "rtk's hooks plus mine" would
 * be missing exactly where nobody was looking.
 *
 * `worktree` is the session's own directory. Sessions that have one get the
 * guard that keeps their git writes inside it; the few that do not — intake and
 * planning, which run against the repository itself and commit nothing — are
 * given no boundary to enforce rather than a wrong one.
 *
 * Exported for the test that pins these properties: this is the whole of what
 * stands between an agent under `bypassPermissions` and the operator's account.
 */
export function bashHooks(worktree = ""): Options["hooks"] {
  const guard = { matcher: "Bash", hooks: [infraGuardHook(), worktreeGuardHook(worktree), backgroundShellHook()] };
  const rtk = rtkHooks()?.PreToolUse ?? [];
  return { PreToolUse: [guard, ...rtk] };
}

export interface AgentSpec {
  runId: string;
  taskId?: string;
  /** Pre-allocate the session id when the caller needs it before the run starts. */
  sessionId?: string;
  role: AgentRole;
  model: string;
  /**
   * The worker tier this session was dispatched on, when the caller decided one
   * — `"light"` or `"standard"`. Booked onto every ledger row so that what a
   * task cost can be read back against the tier it was tried on, without
   * inferring the tier from the model name months later.
   */
  tier?: string;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  /**
   * The built-in tools that *exist* for this agent. `allowedTools` only
   * auto-approves; under bypassPermissions it restricts nothing, so read-only
   * roles must be constrained here. `[]` removes every built-in tool.
   */
  tools?: Options["tools"];
  allowedTools?: string[];
  disallowedTools?: string[];
  /** In-process MCP servers (SDK `tool()` definitions) exposed to this agent only. */
  mcpServers?: Options["mcpServers"];
  /**
   * The operator skills this session may invoke, by name.
   *
   * Always passed, never omitted: the SDK reads an absent `skills` as "leave
   * the CLI's defaults alone", which with a `user` setting source enables all
   * of them. `[]` is what "this task routed no skill" has to look like.
   */
  skills?: string[];
  maxTurns?: number;
  /**
   * Characters of transcript the harness-run loop may send before it compacts.
   * Ignored on the Anthropic transport, which compacts its own. Defaults per
   * provider; set it when a model's window is smaller than its family's.
   */
  contextBudget?: number;
  /**
   * Turns between checkpoints for this session, overriding the run's cadence.
   * `0` gives this session none. See checkpoint.ts.
   */
  checkpointEvery?: number;
  /**
   * SDK session id to resume (AgentResult.sdkSessionId of an earlier session).
   * A worker re-dispatched after a QA rejection re-attaches to its own
   * conversation — everything it learned about the repo is still in context —
   * instead of cold-starting and re-exploring from zero. Only ever set for
   * sessions that ended cleanly; a crashed session's transcript is not trusted.
   */
  resume?: string;
  /**
   * Per-message output ceiling. The planner emits its whole plan in one message
   * and the default (32k) truncates it mid-JSON, which no amount of retrying
   * fixes. Passed to the session as CLAUDE_CODE_MAX_OUTPUT_TOKENS.
   */
  maxOutputTokens?: number;
  /**
   * Extra environment for the session and everything it spawns — the per-task
   * compose project and port block (see isolation.ts). Merged over the inherited
   * environment, under the harness's own settings, which are not negotiable.
   */
  env?: Record<string, string>;
  /**
   * Kill whatever is still running in `cwd` when the session ends.
   *
   * Only ever set for a task worktree, which belongs to one task at a time and
   * holds nothing of the operator's. Never for the repo itself: a sweep there
   * would be a sweep of the machine the operator is working on.
   */
  reapOnEnd?: boolean;
  /**
   * Called before/while streaming. May block: a cap reached mid-session asks the
   * operator whether to raise it, and the session waits rather than dying with a
   * half-finished task. Throws BudgetExceeded to abort.
   */
  budgetCheck?: () => void | Promise<void>;
  /**
   * Called with the milliseconds this session spent waiting for the account's
   * usage limit to reset, once per wait.
   *
   * Time the harness spends waiting for quota is not time the task spent going
   * nowhere, and every wall clock the caller keeps has to be told so. Without
   * it, a five-hour limit reached at minute 3 of a task comes back to a
   * 45-minute wall-clock gate — an escalation about slowness, raised against a
   * task that has been asleep, to an operator who walked away hours ago.
   */
  onLimitWait?: (ms: number) => void;
}

/**
 * Which Claude subscription the run spends, and what happens as it runs out.
 *
 * `env` is applied to every session spawned afterwards — a token from `claude
 * setup-token` on another account, or a `CLAUDE_CONFIG_DIR` that account is
 * logged into. It is a credential: it goes into a spawned environment and
 * nowhere else, never onto the bus, the ledger or the event log.
 */
export interface SubscriptionPolicy {
  /** The account's name, for the log. Empty is the operator's ambient login. */
  name?: string;
  env?: Record<string, string>;
  /**
   * Called with every utilization reading a session reports. Returns the
   * account to continue under, or null to carry on unchanged.
   *
   * It may block for as long as the operator takes: that is the whole design —
   * the session holding this reading stays open and unbilled while the gate is
   * answered, exactly as the budget gate holds one at the cap. Throwing from
   * here stops the session, which is how "park the run" is expressed.
   *
   * `spawnedAs` is the account this particular session started under, which is
   * not always the one the run is on now: a session dispatched before a switch
   * keeps its credentials until it ends, and is exactly the session that needs
   * telling. Answering with the account it already has means "carry on".
   */
  watch?: (
    runId: string,
    reading: SubscriptionReading,
    spawnedAs: string
  ) => Promise<{ name: string; env: Record<string, string> } | null>;
}

/**
 * Thrown inside a session the operator has just moved to another subscription.
 *
 * The session cannot change the credentials it was spawned with, so continuing
 * on the new account means starting the attempt again — the same shape the
 * usage-limit wait already uses, and for the same reason: same session row, same
 * ledger, and where the transport allows it, the same conversation.
 */
class AccountSwitched extends Error {
  constructor(readonly account: string, readonly resumeFrom: string | undefined) {
    super(`moved to subscription account ${account}`);
  }
}

export interface AgentResult {
  sessionId: string;
  /** The SDK's own session id — the handle a later spec.resume re-attaches to. */
  sdkSessionId?: string;
  resultText: string;
  costUsd: number;
  turns: number;
  outcome: "done" | "error" | "killed";
  /** Set when the SDK ended the session abnormally (max turns, max budget, …). */
  errorDetail?: string;
}

/**
 * A session that has said nothing for this long is hung, not thinking: the
 * longest legitimate silence is a single long tool call, and the longest of
 * those is a Bash command, bounded by BASH_TIMEOUT_MS. Aborting hands the task
 * to the existing crash/respawn path — measured cost of not doing this: one
 * wedged QA session stalled a whole run for 62 minutes until the operator
 * noticed.
 *
 * Derived from BASH_TIMEOUT_MS rather than set by hand: at a flat 15 minutes it
 * sat *below* the 30-minute Bash timeout, so any test suite or install that ran
 * past 15 minutes killed its own session while the command was still legitimately
 * running — the watchdog fired on work, not on a wedge. The grace covers the SDK
 * turnaround between a tool result and the next message.
 */
const STALL_GRACE_MS = 5 * 60 * 1000;
const STALL_ABORT_MS = BASH_TIMEOUT_MS + STALL_GRACE_MS;

/** The SDK's own default, named so the wrap-up trigger and the option agree. */
const DEFAULT_MAX_TURNS = 100;

/**
 * How long the pre-run subscription check may take before the run starts
 * without it. Generous enough for a cold CLI subprocess on a slow machine,
 * short enough that nobody waits on it wondering whether `harness run` hung.
 */
const PREFLIGHT_TIMEOUT_MS = 20_000;

/**
 * What a session is told when it comes back from a usage-limit wait.
 *
 * It is the same conversation — everything it had read, run and decided is
 * still in its context — so the one thing worth saying is that time passed and
 * the work it had already done is still there. Replaying the original prompt
 * instead reads as a fresh assignment and is how a resumed worker starts the
 * task over on top of its own committed changes.
 *
 * The one thing that does *not* survive is what was running: the interrupted
 * attempt's sweep (`reapOnEnd`) kills everything left in the worktree, so an
 * agent told only that its context still stands will keep addressing a stack it
 * brought up hours ago and read the connection refusals as product bugs. Said
 * plainly, because the transcript above it is full of evidence that it worked.
 */
const LIMIT_CONTINUE_PROMPT =
  "[HARNESS] Your session was cut off part-way through because the account hit its usage limit. The limit has reset and this is the same conversation, continued — everything you had already established still stands. Before doing anything, check what you had already finished (git log and git status in your working directory, the files you were editing); the last thing you were doing may already be done. One thing did not survive the pause: anything you had left running in the background — dev server, watcher, database, containers — was stopped when the session was cut off, so start what you need again rather than assuming it is still up. Then carry on from exactly there and finish the task you were given, ending in the output format you were originally asked for.";


/**
 * What a session is told when it comes back on a different subscription.
 *
 * Deliberately not the usage-limit sentence above: nothing has reset and the
 * account did not run out. Said as what it was — an interruption for a reason
 * that has nothing to do with the work — because an agent told "your limit has
 * reset" will reasonably assume hours passed, and go back over ground it
 * covered a second ago to check whether the world moved under it.
 *
 * The background-process warning is the same, and for the same reason: the
 * interrupted attempt's sweep killed whatever it had running.
 */
const SWITCH_CONTINUE_PROMPT =
  "[HARNESS] Your session was interrupted part-way through because the operator moved this run onto a different Claude subscription. Nothing about your work was wrong and no time has passed to speak of: this is the same conversation, continued, and everything you had already established still stands. One thing did not survive the interruption — anything you had left running in the background (dev server, watcher, database, containers) was stopped, so start what you need again rather than assuming it is still up. Then carry on from exactly where you were and finish the task you were given, ending in the output format you were originally asked for.";

/**
 * Why the model stopped talking, when it says. Absent on the tool-loop
 * transport and on any SDK message shape that does not carry one, which reads
 * the same as a turn that ended normally — the caller only acts on `max_tokens`.
 */
function stopReasonOf(message: Record<string, unknown>): string | undefined {
  const inner = message.message as { stop_reason?: string | null } | undefined;
  return inner?.stop_reason ?? undefined;
}

/**
 * How far into its turn budget a session is asked to wrap up. Low enough that
 * the agent has room to write the answer, high enough that sessions which were
 * going to finish on their own never see the message at all.
 */
const WRAP_UP_AT = 0.8;

/**
 * The session's stdin, held open so the operator can speak mid-flight. The
 * initial prompt goes out immediately; anything push()ed afterwards becomes a
 * real user message in the live session. The stream closes itself on the first
 * result that finds nothing left to deliver — for the common session that
 * nobody talks to, that is the first result, exactly the old behavior.
 */
export class PromptStream {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  private sealed = false;
  /** The first prompt is delivered once, by whichever reader asks first. */
  private firstSent = false;

  constructor(private first: string) {}

  private message(text: string): SDKUserMessage {
    return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" };
  }

  private static textOf(m: SDKUserMessage): string {
    // Every message in this queue was built by `message()` above, so the
    // content is always a plain string. The union is the SDK's, not ours.
    return m.message.content as string;
  }

  /** Queue a message for the live session. False once the stream has closed or sealed. */
  push(text: string): boolean {
    if (this.closed || this.sealed) return false;
    this.queue.push(this.message(text));
    this.wake?.();
    return true;
  }

  /**
   * Nothing more may be said to this session, though it is still finishing.
   *
   * Set when a turn comes back cut off at the output ceiling. The API requires
   * the thinking blocks of the latest assistant message to be handed back
   * exactly as they were, and a truncated turn's never are — so appending a
   * message to one is a 400 that kills the session, and with it the run. See
   * the `max_tokens` branch in `run()`.
   *
   * Returns whatever was already queued and now cannot be delivered, so the
   * caller can say so rather than let it disappear. `push()` refuses from here,
   * which is what makes `inject()` report operator feedback as undelivered and
   * queue it for the next session instead of losing it.
   */
  seal(): string[] {
    this.sealed = true;
    return this.queue.splice(0).map(PromptStream.textOf);
  }

  /**
   * A result message arrived. Close unless something is still waiting to be
   * delivered. Counting replies instead deadlocks: two messages handed to the
   * CLI together get folded into one answer, so a reply-per-message ledger
   * never balances and the session hangs open forever after its last result.
   * Closing early is safe — a message already delivered still gets answered,
   * and a push() from now on is queued for the task's next session instead.
   */
  settle(): void {
    if (this.queue.length === 0) this.close();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  /**
   * The same stdin, read the way the harness-run tool loop needs it: one
   * blocking read for the next message, and a non-blocking drain for anything
   * queued while the model was working. The SDK reads `stream()` instead — both
   * sit on the same queue, and a session uses exactly one of them.
   */
  asSource(): PromptSource {
    return {
      next: async () => {
        if (!this.firstSent) {
          this.firstSent = true;
          return this.first;
        }
        for (;;) {
          if (this.queue.length) return PromptStream.textOf(this.queue.shift()!);
          if (this.closed) return null;
          await new Promise<void>((resolve) => {
            this.wake = resolve;
          });
          this.wake = undefined;
        }
      },
      drain: () => this.queue.splice(0).map(PromptStream.textOf),
    };
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    this.firstSent = true;
    yield this.message(this.first);
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * Thin wrapper over the Claude Agent SDK: one query() session per agent,
 * streams messages onto the bus, books usage into the ledger (PRD §11.1 Agent Pool).
 */
export class AgentPool {
  /**
   * `sleep` is injectable so the usage-limit wait can be tested without
   * spending one. Nothing else in the pool measures time it was not handed.
   */
  constructor(private store: Store, private bus: Bus, private sleep: (ms: number) => Promise<unknown> = delay) {}

  /**
   * The checkpoint cadence, set once per run rather than per dispatch.
   *
   * Seventeen call sites reach `run()`, and a knob threaded through all of them
   * would be a knob that is wrong at whichever one was added last. What a
   * checkpoint costs and what it is worth are properties of the run, not of the
   * call site, so the run controller sets this when it freezes its config and
   * every session dispatched afterwards inherits it. `spec.checkpointEvery`
   * still overrides per session, which is what tests and any future role with
   * an unusual shape use.
   */
  private checkpoints: { every: number; fold: boolean } = { every: DEFAULT_EVERY, fold: true };

  /**
   * Set the run's checkpoint cadence. `every: 0` turns checkpoints off.
   *
   * Undefined is a real argument, not a caller's mistake: a run created before
   * checkpoints existed has a frozen config without the field, and its config
   * is fixed at creation. Such a run keeps the default, which is the answer a
   * fresh one would have reached anyway.
   */
  configureCheckpoints(policy: { every?: number; fold?: boolean } | undefined): void {
    if (!policy) return;
    if (policy.every !== undefined) this.checkpoints.every = policy.every;
    if (policy.fold !== undefined) this.checkpoints.fold = policy.fold;
  }

  /**
   * Which subscription every session spawns under, and what to do as its plan
   * runs out.
   *
   * Set per run for the same reason the checkpoint cadence is: quota is a
   * property of the account, not of the seventeen call sites that reach `run()`,
   * and a credential threaded through all of them is a credential missing from
   * whichever one is added next. It is also the only honest place for it —
   * every session in flight meets the same wall at the same moment, so there is
   * one answer to give and one place to hold it.
   */
  private subscription: Required<Pick<SubscriptionPolicy, "name" | "env">> & Pick<SubscriptionPolicy, "watch"> = { name: "", env: {} };

  configureSubscription(policy: SubscriptionPolicy | undefined): void {
    if (!policy) return;
    // Filled in here so everything downstream reads a name and an overlay that
    // exist: a policy that names only a watch is a run with no account switch
    // configured, which is most of them.
    this.subscription = { name: policy.name ?? "", env: policy.env ?? {}, watch: policy.watch };
  }

  /**
   * Ask the account where it stands, without running an agent.
   *
   * Everything else here learns the utilization from a session that is already
   * spending — which is one dispatch too late for the run that starts at 97% of
   * its weekly window. This opens a session, asks the control channel the
   * question `/usage` answers, and closes it again: no prompt is ever sent, so
   * it costs a subprocess and no model tokens.
   *
   * Returns nothing rather than throwing on every failure it can have — an SDK
   * without the control request, an account whose plan does not meter (API key,
   * Bedrock, Vertex), a subprocess that will not start. A run must not fail to
   * begin because the thing watching its quota could not.
   */
  async readSubscription(model: string): Promise<SubscriptionReading[]> {
    const abort = new AbortController();
    // Held open and silent: the session has to exist for the control channel to
    // answer, and it must never be given anything to do. Closed by hand on the
    // way out rather than by listening for the abort, because a listener
    // registered after the abort has already fired never runs — and this
    // generator is iterated by the SDK on its own schedule.
    let closeIdle!: () => void;
    const idleClosed = new Promise<void>((resolve) => (closeIdle = resolve));
    const idle = async function* (): AsyncGenerator<SDKUserMessage> {
      await idleClosed;
    };
    const probe = query({
      prompt: idle(),
      options: {
        model,
        maxTurns: 1,
        abortController: abort,
        settingSources: [],
        env: { ...process.env, ...this.subscription.env },
      },
    });
    // Every failure lands on the same answer — nothing — so the question is
    // only ever "did it answer in time", and the cleanup below runs either way.
    const usage = await Promise.race([
      probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      this.sleep(PREFLIGHT_TIMEOUT_MS).then(() => {
        throw new Error(`the subscription check did not answer within ${PREFLIGHT_TIMEOUT_MS / 1000}s`);
      }),
    ]).catch(() => null);
    closeIdle();
    abort.abort();
    // A probe that answered and then would not shut down cleanly has still
    // answered, and its answer is what the run is waiting on.
    try {
      await probe.return(undefined);
    } catch {
      // The subprocess was already gone. Nothing here is worth a run.
    }
    return usage === null ? [] : readUsageSnapshot(usage);
  }

  /**
   * Live sessions accepting mid-flight operator feedback. Task agents key as
   * `runId/taskId`; run-level agents (intake, planner, validator, …) have no
   * task and key as `runId/@role`.
   */
  private live = new Map<string, { sessionId: string; role: AgentRole; stream: PromptStream }>();

  /**
   * Push operator feedback into the session currently working the target — a
   * task id or an `@role` handle. Returns what it reached, or null when nothing
   * there is listening — the caller queues the feedback (tasks) or reports the
   * agent gone (run-level).
   */
  inject(runId: string, target: string, text: string): { sessionId: string; role: AgentRole } | null {
    const hit = this.live.get(`${runId}/${target}`);
    if (!hit || !hit.stream.push(text)) return null;
    return { sessionId: hit.sessionId, role: hit.role };
  }

  /**
   * Run one agent session, waiting out the account's usage limits.
   *
   * A quota window closing is the one failure that is neither the agent's doing
   * nor fixable by anything the caller could decide: retrying now fails
   * identically, and reporting it upward spends an attempt, a respawn or a whole
   * run on a wall that goes away by itself. So it is absorbed here, at the one
   * place every role passes through, and the caller is handed a session that
   * either answered or failed for a reason worth acting on.
   *
   * The wait continues the *same* session — same row, same ledger, same handle
   * for live operator feedback — and, where the transport can, resumes the same
   * conversation, so an agent that was halfway through a task picks up from what
   * it already knows rather than paying to rediscover it. Bounded by
   * `usageLimitWaitMinutes`: past that the error comes back as it always did.
   */
  async run(spec: AgentSpec): Promise<AgentResult> {
    const sessionId = spec.sessionId ?? randomUUID();
    let budget = this.limitWaitBudgetMs(spec.runId);
    let waits = 0;
    /** The conversation the next attempt re-attaches to, when there is one. */
    let resumeFrom: string | undefined;
    /** What that attempt is told about the gap it just sat through. */
    let resumeWhy = LIMIT_CONTINUE_PROMPT;
    for (let attempt = 0; ; attempt++) {
      let result: AgentResult;
      try {
        result = await this.session(this.attemptSpec(spec, sessionId, resumeFrom, resumeWhy), sessionId, attempt);
      } catch (e) {
        // A limit can also arrive as a throw — the session dies without ever
        // producing a result. There is no handle to resume from that, so the
        // retry starts the session over rather than continuing it.
        if (e instanceof BudgetExceeded) throw e;
        // The operator moved the run to another subscription while this session
        // was mid-turn. Not a failure and not a wait: the same attempt again,
        // immediately, under credentials the pool has already swapped.
        if (e instanceof AccountSwitched) {
          resumeFrom = e.resumeFrom;
          resumeWhy = SWITCH_CONTINUE_PROMPT;
          continue;
        }
        const limit = usageLimitOf(String(e));
        if (!limit) throw e;
        const slept = await this.waitOutLimit(spec, sessionId, limit, waits++, budget);
        if (slept === null) throw e;
        budget -= slept;
        resumeFrom = undefined;
        continue;
      }
      const limit = result.outcome === "error" ? usageLimitOf(result.errorDetail) : null;
      if (!limit) return result;
      const slept = await this.waitOutLimit(spec, sessionId, limit, waits++, budget);
      // Out of patience: hand back the error the caller would have seen anyway.
      if (slept === null) return result;
      budget -= slept;
      resumeFrom = result.sdkSessionId;
      resumeWhy = LIMIT_CONTINUE_PROMPT;
      // Every way out of this loop is a return or a throw above: a wait that is
      // refused ends it, and the budget only shrinks.
      /* v8 ignore next */
    }
  }

  /**
   * The spec for one attempt. The first is the caller's, verbatim; a retry after
   * a limit re-attaches to the conversation the limit interrupted where the
   * transport keeps one — the OpenAI and Gemini loops are stateless, so those
   * start the session over with the original prompt, as they do everywhere else.
   */
  private attemptSpec(spec: AgentSpec, sessionId: string, resumeFrom: string | undefined, why: string): AgentSpec {
    const resumable = resumeFrom && providerFor(spec.model) === "anthropic";
    if (!resumable) return { ...spec, sessionId };
    return { ...spec, sessionId, resume: resumeFrom, prompt: why };
  }

  /**
   * Sleep until the quota is back, or refuse to. Returns the milliseconds
   * waited, or null when the wait is longer than this run allows — the caller
   * then reports the failure exactly as it did before any of this existed.
   */
  private async waitOutLimit(spec: AgentSpec, sessionId: string, limit: UsageLimit, priorWaits: number, budget: number): Promise<number | null> {
    const ms = limitWaitMs(limit, priorWaits);
    const say = (text: string) =>
      this.bus.publish({ type: "agent.log", runId: spec.runId, taskId: spec.taskId, sessionId, text, ts: Date.now() });
    if (ms > budget) {
      say(
        `the account is out of quota — ${limit.said} — and waiting ${humanWait(ms)} for it is more than this run allows ` +
          `(${humanWait(Math.max(0, budget))} of usageLimitWaitMinutes left). Giving the failure to the caller.`
      );
      return null;
    }
    say(
      `the account is out of quota — ${limit.said}. Waiting ${humanWait(ms)} and then continuing this ${spec.role} session ` +
        `from where it stopped. Nothing is lost and nothing is retried against it: a limit is not a verdict on the work.`
    );
    // Credited before the sleep, not after: a wall clock the caller keeps is
    // read by other tasks while this one is asleep.
    spec.onLimitWait?.(ms);
    await this.sleep(ms);
    say(`the usage limit should have reset — continuing the ${spec.role} session`);
    return ms;
  }

  /**
   * How long *one* session may spend asleep on quota, however many limits it
   * hits. Per session and not per run on purpose: a limit is account-wide, so a
   * run long enough to meet two quota windows would otherwise have its second
   * one refused by a budget the first spent — the run would die of the outage it
   * had already survived once. The bound that matters is the one on a single
   * session going quiet, and that is this one.
   */
  private limitWaitBudgetMs(runId: string): number {
    return (this.store.getRun(runId)?.config.usageLimitWaitMinutes ?? 0) * 60_000;
  }

  private async session(spec: AgentSpec, sessionId: string, attempt: number): Promise<AgentResult> {
    // Refuse an impossible pairing before the session row exists, so it reads
    // as a configuration error at the top of the run rather than as an agent
    // that behaved oddly halfway through one.
    const unsupported = providerFor(spec.model) === "anthropic" ? null : unsupportedSpec(spec);
    if (unsupported) {
      throw new Error(
        `the ${spec.role} role cannot run on ${spec.model}: ${unsupported}. ` +
          `Point models.${spec.role} at an Anthropic model, or give this role a spec this transport can honour.`
      );
    }

    const abort = new AbortController();
    const now = Date.now();
    if (attempt === 0) {
      this.store.db
        // The build is stamped here rather than on the run, because a run outlives
        // the process that started it: `resume` picks it up under whatever is
        // installed then, and only the session knows which fixes it could have had.
        .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt, build) VALUES (?,?,?,?,?,?,?,?)")
        .run(sessionId, spec.runId, spec.taskId ?? null, spec.role, spec.model, "running", now, harnessBuild());
    } else {
      // Continuing after a usage-limit wait reopens the row it already has
      // rather than opening a second one. The ledger is keyed by session id and
      // `endSession` settles the row from it, so a new row would split one
      // session's bill in two; the caller that pre-allocated the id (intake,
      // which follows its agent's prose by filtering on it) would also stop
      // hearing anything the moment the account ran out of quota.
      this.store.db.prepare("UPDATE sessions SET state = 'running', endedAt = NULL WHERE id = ?").run(sessionId);
    }
    // Replies this session made before the wait. `turns` below counts this
    // attempt only, and both writers of the column add the two: written flat, a
    // worker forty turns into a task when the quota window closed comes back
    // reading "3 replies" on the dashboard, which is the row the postmortem
    // trusts to say which sessions did the most and returned the least.
    const priorTurns = (this.store.db.prepare("SELECT turns FROM sessions WHERE id = ?").get(sessionId) as { turns: number }).turns;
    this.bus.publish({ type: "agent.spawned", runId: spec.runId, taskId: spec.taskId, sessionId, role: spec.role, model: spec.model, ts: now });

    // A re-dispatched worker normally re-attaches to its own conversation. The
    // OpenAI and Gemini APIs are stateless, so there is nothing to re-attach
    // to and this session starts cold. Said out loud rather than dropped
    // silently: the agent will re-explore the repo, and the extra turns it
    // spends doing that are otherwise a mystery in the postmortem.
    if (spec.resume && providerFor(spec.model) !== "anthropic") {
      this.bus.publish({
        type: "agent.log",
        runId: spec.runId,
        taskId: spec.taskId,
        sessionId,
        text: `starting cold: ${spec.model} has no resumable session, so the context from the earlier attempt is not carried over`,
        ts: now,
      });
    }

    // The CLI's dying words. "Claude Code process exited with code 1" alone is
    // undiagnosable — the actual error only ever appears on the subprocess's
    // stderr, which is otherwise dropped.
    let stderrTail = "";
    const turnCap = spec.maxTurns ?? DEFAULT_MAX_TURNS;
    // Our counter runs ahead of the SDK's own turn accounting (a validator
    // capped at 60 read 66 here), so a fraction of the cap is the honest
    // trigger — it is reached no later than the SDK's ceiling, never after.
    const wrapUpAt = Math.max(1, Math.floor(turnCap * WRAP_UP_AT));
    // A session too short to reach its first checkpoint before the wrap-up gets
    // none, which is how the two-turn repair role and the four-turn probes stay
    // out of this without being named anywhere. See checkpoint.ts.
    const checkpointEvery = spec.checkpointEvery ?? this.checkpoints.every;
    const options: Options = {
      model: spec.model,
      cwd: spec.cwd,
      systemPrompt: spec.systemPrompt,
      maxTurns: turnCap,
      stderr: (data) => {
        stderrTail = (stderrTail + data).slice(-2000);
      },
      permissionMode: "bypassPermissions",
      tools: spec.tools,
      allowedTools: spec.allowedTools,
      disallowedTools: spec.disallowedTools,
      mcpServers: spec.mcpServers,
      resume: spec.resume,
      abortController: abort,
      // Skills are discovered from a setting source and nowhere else. With `[]`
      // a session sees the sixteen skills built into the CLI and none of the
      // operator's — `skills: "all"` does not change that, because the filter
      // runs after a discovery that never happened. So the source is loaded and
      // the filter does the isolating: `skills` names exactly what skillRouting
      // picked for this task, and every other skill stays invisible to the Skill
      // tool. What the run injects into the prompt and what the agent may invoke
      // are then the same short list.
      //
      // The cost is that `user` brings the operator's settings.json with it,
      // including their own PreToolUse rtk hook alongside the one below. That
      // one is safe — rtk returns no rewrite for a command it has already
      // rewritten — but their other hooks now run in worker sessions too.
      settingSources: ["user"],
      skills: spec.skills ?? [],
      // …which also strips the operator's token-compression hook, so re-add it
      // programmatically: Bash commands route through rtk when it's installed —
      // alongside the guard that stops an agent applying real infrastructure,
      // which under bypassPermissions is the only thing standing between a
      // `terraform destroy` an agent writes and the operator's account.
      hooks: bashHooks(spec.cwd),
      // `env` replaces the inherited environment wholesale, so spread rather than
      // set: workers reach gh/aws/podman through PATH (see toolbelt.ts).
      env: {
        ...process.env,
        // Caller-supplied first — the per-task compose project and port block —
        // so the harness's own settings below stay non-negotiable and a spec
        // cannot hand an agent back the two-minute Bash timeout.
        ...spec.env,
        // Which subscription pays for this session. Above the inherited
        // environment on purpose: the operator's own `CLAUDE_CODE_OAUTH_TOKEN`
        // or `CLAUDE_CONFIG_DIR` is exactly what a switch is getting away from,
        // and an overlay that lost to the shell it was spawned from would keep
        // spending the exhausted account while the log said otherwise. Empty
        // for every run that never names an account, which is the old behaviour
        // of using whatever the operator is logged into.
        ...this.subscription.env,
        // The CLI backgrounds any command that outruns its timeout, and a
        // backgrounded command kills this session when it exits — see
        // backgroundShellHook. The stock 120s default reaches that outcome on an
        // ordinary `npm test`, so raise the floor for every session.
        BASH_DEFAULT_TIMEOUT_MS: String(BASH_TIMEOUT_MS),
        BASH_MAX_TIMEOUT_MS: String(BASH_TIMEOUT_MS),
        ...(spec.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.maxOutputTokens) } : {}),
      },
    };

    // Streaming input instead of a one-shot prompt string, so the operator can
    // drop a message into the running session (see inject()). A session nobody
    // talks to closes its stream on the first result — behavior is unchanged.
    const stream = new PromptStream(spec.prompt);
    // The advisor drafts a gate answer the operator is about to see anyway —
    // feedback to it would race its own output, so it stays unaddressable.
    const liveKey = spec.role === "advisor" ? null : `${spec.runId}/${spec.taskId ?? `@${spec.role}`}`;
    if (liveKey) this.live.set(liveKey, { sessionId, role: spec.role, stream });

    let resultText = "";
    let sdkSessionId: string | undefined;
    let turns = 0;
    let cost = 0;
    /** A turn came back cut off at the output ceiling; see the `max_tokens` branch. */
    let truncated = false;
    /** The session delivered its result, whatever it did afterwards. */
    let settled = false;
    let killedByBudget = false;
    /**
     * The subscription watch ended this attempt on purpose — moved to another
     * account, or stopped by an operator who declined to carry on. Either way
     * the session row is already closed with the reason, and the throw that
     * follows must reach the caller unwrapped.
     */
    let deliberateExit = false;
    /** The account this session was spawned under; a switch is measured against it. */
    const spawnedAs = this.subscription.name;
    let abnormal = "";
    // Tokens seen on assistant messages since the last `result` booked the bill.
    //
    // Usage and cost only ever arrive on a `result` message, so a session killed
    // before one — aborted by the watchdog, or gone with the whole process —
    // used to book nothing at all. In one run that was 16 of 20 interrupted
    // sessions with no ledger row between them: real money the budget gate could
    // not see, spent on turns that were also thrown away. This accumulates what
    // those turns consumed so the interrupted path has something true to book.
    let unbooked = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    /**
     * Settle those turns before the session row is written, so `endSession`
     * still sees the whole ledger. The cost is derived from the tokens rather
     * than reported by the SDK — an estimate, but one the budget gate can see,
     * which beats the zero it was charging for a session that ran for an hour.
     * A no-op once a `result` has settled the bill.
     */
    const bookUnbooked = () => {
      if (Object.values(unbooked).reduce((a, b) => a + b, 0) === 0) return;
      const estimate = costUsd(spec.model, unbooked);
      cost += estimate;
      this.store.recordUsage({ runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, role: spec.role, tier: spec.tier, ...unbooked, costUsd: estimate });
      this.bus.publish({ type: "agent.usage", runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, ...unbooked, costUsd: estimate, ts: Date.now() });
      unbooked = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    };
    // Watchdog for a wedged subprocess: no message for STALL_ABORT_MS → abort.
    let lastMessageAt = Date.now();
    let stalledMinutes = 0;
    const stallTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > STALL_ABORT_MS) {
        stalledMinutes = Math.round((Date.now() - lastMessageAt) / 60_000);
        abort.abort();
      }
    }, 30_000);
    // Which vendor answers is decided here and nowhere else. Everything below
    // — usage booking, the stall watchdog, turn counting, the wrap-up message,
    // mid-flight feedback, the reaper — reads the same message shapes either
    // way, so a role moved to another provider changes what answers, not how
    // the run is accounted for.
    const source =
      providerFor(spec.model) === "anthropic"
        ? query({ prompt: stream.stream(), options })
        : toolLoop({
            spec,
            prompts: stream.asSource(),
            signal: abort.signal,
            contextBudget: spec.contextBudget,
            // Only this transport can act on a digest. The SDK owns its own
            // transcript, so on Anthropic a checkpoint buys the record and the
            // questions but not the reclaimed context.
            foldOnCheckpoint: this.checkpoints.fold && checkpointEvery > 0,
          });

    try {
      for await (const message of source as AsyncIterable<{ type?: string } & Record<string, unknown>>) {
        lastMessageAt = Date.now();
        const sid = (message as { session_id?: string }).session_id;
        if (sid) sdkSessionId = sid;
        try {
          await spec.budgetCheck?.();
        } catch (e) {
          abort.abort();
          killedByBudget = true;
          bookUnbooked();
          this.endSession(spec, sessionId, priorTurns + turns, cost, "killed", String(e));
          throw e;
        }
        const reading = this.subscription.watch ? readRateLimitEvent(message) : null;
        if (reading) {
          // The account saying how much of its plan is left, mid-session. The
          // watch may block here for as long as the operator takes to answer:
          // this session is idle and unbilled while it does, which is the whole
          // reason the question is asked here rather than after the wall.
          //
          // A throw is the operator declining to carry on at all. It ends the
          // session the way the budget cap does — deliberately, with the reason
          // on the row — and reaches the caller, which parks the run.
          let next: { name: string; env: Record<string, string> } | null;
          try {
            next = await this.subscription.watch!(spec.runId, reading, spawnedAs);
          } catch (e) {
            abort.abort();
            deliberateExit = true;
            bookUnbooked();
            this.endSession(spec, sessionId, priorTurns + turns, cost, "killed", String(e));
            throw e;
          }
          if (next && next.name !== spawnedAs) {
            const carriesOver = keepsTranscript(this.subscription.env, next.env);
            this.subscription = { ...this.subscription, name: next.name, env: next.env };
            this.bus.publish({
              type: "agent.log",
              runId: spec.runId,
              taskId: spec.taskId,
              sessionId,
              text:
                `${describeReading(reading)} — continuing on subscription "${next.name}". ` +
                (settled
                  ? "This session had already answered, so it keeps its answer and the change applies to the next one."
                  : carriesOver
                    ? "Restarting this session on the new account, resuming the same conversation."
                    : "Restarting this session on the new account; it is a different login, so the conversation cannot be resumed and the task starts over."),
              ts: Date.now(),
            });
            // A session that has already delivered its answer has nothing to
            // restart: killing it here would throw away work that is paid for
            // and finished, and the switch reaches every session after it
            // anyway. Only a session still mid-turn is worth interrupting.
            if (!settled) {
              deliberateExit = true;
              abort.abort();
              bookUnbooked();
              this.endSession(spec, sessionId, priorTurns + turns, cost, "interrupted", `moved to subscription account ${next.name}`);
              throw new AccountSwitched(next.name, carriesOver ? sdkSessionId : undefined);
            }
          }
        } else if (message.type === "harness_note") {
          // The tool loop reporting something it did to the transcript itself.
          // Not a model turn: no usage, and it must not count toward the cap.
          this.bus.publish({
            type: "agent.log",
            runId: spec.runId,
            taskId: spec.taskId,
            sessionId,
            text: (message as { text: string }).text,
            ts: Date.now(),
          });
        } else if (message.type === "assistant") {
          turns++;
          const u = (message as { message?: { usage?: Record<string, number | undefined> } }).message?.usage;
          if (u) {
            unbooked.inputTokens += u.input_tokens ?? 0;
            unbooked.outputTokens += u.output_tokens ?? 0;
            unbooked.cacheReadTokens += u.cache_read_input_tokens ?? 0;
            unbooked.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
          }
          // A turn cut off at the per-message output ceiling ends the
          // conversation whether or not the harness is finished with it.
          //
          // The API requires the thinking blocks of the latest assistant
          // message to come back byte-identical, and a truncated turn's cannot
          // be — so the next request carrying anything appended to it is
          // rejected outright:
          //
          //   400 messages.1.content.1: `thinking` … blocks in the latest
          //   assistant message cannot be modified
          //
          // which exits the CLI, throws here, and killed a whole planning phase
          // ($2.18 of intake and PRD) over a plan the caller already knew how to
          // repair. Sealing costs the wrap-up nudge and any operator feedback
          // racing it — both of which are exactly what would trigger the 400 —
          // and lets the session settle so the truncated answer comes back to a
          // caller that can retry it.
          //
          // This is the 0.1.x shape, which is where that run died. Probed on
          // 0.3.222, the same overflow never reaches here: the CLI turns it into
          // an error result and throws, so there is no truncated turn left
          // standing for anything to be appended to. The guard stays because a
          // pinned older SDK still reaches this branch, and because a stop
          // reason is the only signal that arrives in time to prevent the push
          // rather than explain it afterwards.
          if (stopReasonOf(message) === "max_tokens" && !truncated) {
            truncated = true;
            for (const undelivered of stream.seal()) {
              this.bus.publish({
                type: "agent.log",
                runId: spec.runId,
                taskId: spec.taskId,
                sessionId,
                text: `undelivered — this session ended at the output ceiling before it could be told: ${undelivered.slice(0, 500)}`,
                ts: Date.now(),
              });
            }
            this.bus.publish({
              type: "agent.log",
              runId: spec.runId,
              taskId: spec.taskId,
              sessionId,
              text: `the answer hit the ${spec.maxOutputTokens ?? "default"}-token per-message output ceiling and was cut off — nothing more can be said to this session`,
              ts: Date.now(),
            });
          }
          // Ask for the answer before the ceiling takes it away.
          //
          // Sessions that die at maxTurns are the expensive ones — they die
          // having done the most work — and every one of them is a total loss:
          // no verdict, no summary, and a re-dispatch that starts over. Across
          // two runs that was ~$68 of discarded sessions, with QA deaths
          // clustered at 91-112 turns against a cap of 90.
          //
          // A message queued here is delivered because `settle()` only closes
          // the stream when nothing is waiting, so the agent gets one more
          // exchange to say what it found. A session that finishes early never
          // reaches this and is untouched.
          // Stop, say where you are, and ask before going further.
          //
          // Pushed here rather than inside either transport because this is the
          // one place above the split that sees a turn go by: the same message
          // reaches an SDK session and a harness-run tool loop, and only the
          // second can do anything with the answer beyond recording it.
          //
          // Guarded on `truncated` for the same reason the wrap-up nudge is —
          // appending to a turn cut off at the output ceiling is a 400 that
          // kills the session — and `checkpointDue` keeps it clear of the
          // wrap-up turn itself, which has a better use for the exchange.
          if (checkpointDue(turns, checkpointEvery, wrapUpAt) && !truncated) {
            stream.push(checkpointPrompt(turns, checkpointEvery));
            this.bus.publish({
              type: "agent.log",
              runId: spec.runId,
              taskId: spec.taskId,
              sessionId,
              text: `checkpoint at turn ${turns}/${turnCap} — asked for a state digest and any open questions`,
              ts: Date.now(),
            });
          }
          if (turns === wrapUpAt && !truncated) {
            stream.push(
              `[HARNESS] You are near this session's turn limit and will be cut off shortly. Stop investigating now and give your final answer immediately, in exactly the output format you were asked for. Report what you have actually established so far and say plainly what you did not get to — a partial answer in the right format is usable, and being cut off mid-investigation is not. If you have already given your final answer, ignore this message.`
            );
            this.bus.publish({
              type: "agent.log",
              runId: spec.runId,
              taskId: spec.taskId,
              sessionId,
              text: `approaching the turn limit (${turns}/${turnCap}) — asked for a final answer now`,
              ts: Date.now(),
            });
          }
          const content = (message as { message?: { content?: unknown } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === "text" && typeof block.text === "string") {
                // An answer to a checkpoint, if this turn was one. Published as
                // its own event rather than left in the log: the digest is the
                // only place a long session says what it believes, and the
                // questions are the whole reason the operator is being shown
                // anything mid-task. Parsed on every text block because an
                // agent may write the block a turn or two after being asked.
                const checkpoint = parseCheckpoint(block.text);
                if (checkpoint) {
                  this.bus.publish({
                    type: "agent.checkpoint",
                    runId: spec.runId,
                    taskId: spec.taskId,
                    sessionId,
                    turn: turns,
                    digest: checkpoint.digest.slice(0, 4000),
                    questions: checkpoint.questions.slice(0, 6),
                    ts: Date.now(),
                  });
                  // The event above is the dashboard's. The CLI is where most
                  // runs are actually watched and it renders `agent.log` and
                  // little else, so the questions go out as log lines too —
                  // one apiece, because the CLI prints a log's first line and
                  // nothing more. Without this an operator at a terminal sees
                  // "<harness-checkpoint>" scroll past and never learns what
                  // was asked, which is the one thing a checkpoint is for.
                  for (const line of describeQuestions(checkpoint.questions)) {
                    this.bus.publish({ type: "agent.log", runId: spec.runId, taskId: spec.taskId, sessionId, text: `checkpoint question: ${line}`, ts: Date.now() });
                  }
                }
                this.bus.publish({ type: "agent.log", runId: spec.runId, taskId: spec.taskId, sessionId, text: block.text.slice(0, 2000), ts: Date.now() });
              } else if (block?.type === "tool_use") {
                this.bus.publish({ type: "agent.tool_use", runId: spec.runId, taskId: spec.taskId, sessionId, tool: String(block.name ?? "?"), summary: JSON.stringify(block.input ?? {}).slice(0, 300), ts: Date.now() });
              }
            }
          }
          this.store.db.prepare("UPDATE sessions SET turns = ?, lastHeartbeatAt = ? WHERE id = ?").run(priorTurns + turns, Date.now(), sessionId);
        } else if (message.type === "result") {
          const m = message as {
            subtype?: string;
            is_error?: boolean;
            errors?: string[];
            result?: string;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          };
          // A checkpoint pushed on the turn the agent finished lands after the
          // answer, so the session settles a second time with the digest as its
          // last word. Everything downstream reads this field as the task's
          // answer, so a result that is nothing but a checkpoint block does not
          // displace one that has already been given. See isCheckpointOnly.
          const answer = m.result ?? "";
          if (!(resultText && isCheckpointOnly(answer))) resultText = answer;
          settled = true;
          // `error_max_turns` and friends still yield a result message; without this
          // a truncated session is indistinguishable from a clean one.
          if (m.subtype && m.subtype !== "success") {
            // Say which wall it hit in words. `error_max_turns` next to a reply
            // count that reads higher than the cap looks like the cap was not
            // enforced; the two are simply counted differently, and an operator
            // deciding whether to raise qaMaxTurns needs to know it was the
            // turn ceiling and not a crash.
            const named = m.subtype === "error_max_turns" ? `error_max_turns (hit the turn ceiling of ${turnCap})` : m.subtype;
            abnormal = named + (m.errors?.length ? `: ${m.errors.join("; ")}` : "");
          }
          // A truncated answer is not a clean finish, and the SDK reports the
          // session itself as successful — the ceiling was the model's, not the
          // CLI's. Unsaid, the caller cannot tell "the plan is malformed" from
          // "the plan is unfinished", which need opposite retries: one asks for
          // better JSON, the other for a shorter message. `outputTruncated` in
          // runController reads this string.
          if (truncated && !abnormal) {
            abnormal = `max_tokens (the answer hit the per-message output ceiling of ${spec.maxOutputTokens ?? "the SDK default"} tokens and was cut off mid-message)`;
          }
          // A failed session that calls itself a success.
          //
          // From SDK 0.3 an API-level failure comes back as `subtype: "success"`
          // with `is_error` set and the error text sitting where the answer
          // should be — so the subtype check above waves it through, and the
          // caller is handed "API Error: Claude's response exceeded the 1024
          // output token maximum" as though the agent had written it. Measured
          // on 0.3.222 against a deliberately small ceiling; that exact string
          // is what a planner attempt would otherwise have been graded on.
          if (m.is_error && !abnormal) abnormal = `the session ended in an error: ${resultText.slice(0, 300)}`;
          const usage = {
            inputTokens: m.usage?.input_tokens ?? 0,
            outputTokens: m.usage?.output_tokens ?? 0,
            cacheReadTokens: m.usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: m.usage?.cache_creation_input_tokens ?? 0,
          };
          // Probed on SDK 0.1.77: `usage` is per-turn but `total_cost_usd` is
          // session-cumulative, so tokens book as they come and cost books the
          // difference — an injected-feedback session must not double-bill.
          const costDelta = m.total_cost_usd !== undefined ? Math.max(0, m.total_cost_usd - cost) : costUsd(spec.model, usage);
          cost = m.total_cost_usd ?? cost + costDelta;
          this.store.recordUsage({ runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, role: spec.role, tier: spec.tier, ...usage, costUsd: costDelta });
          this.bus.publish({ type: "agent.usage", runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, ...usage, costUsd: costDelta, ts: Date.now() });
          // The bill is settled to here; anything counted before this result is
          // paid for and must not be booked a second time on the way out.
          unbooked = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
          stream.settle();
        }
      }
    } catch (e) {
      // No result message is coming for the turns since the last one.
      bookUnbooked();
      // A throw that only restates a result already in hand is not a crash.
      //
      // Through 0.1.x a session that hit its turn ceiling ended the iteration
      // normally and the caller got its partial answer back. From 0.3 the SDK
      // delivers the same `result` message and then throws it again as an
      // exception — measured on 0.3.222: `result{subtype: "error_max_turns",
      // is_error: true}` followed by `Error: Claude Code returned an error
      // result: Reached maximum number of turns (1)`.
      //
      // Propagating that costs the answer. `parseBrief` falls back to a brief
      // built from the answers the operator already gave rather than asking
      // them everything twice, and a throw skips it — so an intake that ran out
      // of turns would discard the whole conversation, which is the failure the
      // wrap-up message exists to prevent. The result is already recorded,
      // `abnormal` already says which wall it hit, so return it and let the
      // caller decide.
      // A switch throws with `settled` false by construction (a session that has
      // answered is never interrupted), so this reads as the guard it is: the
      // two deliberate throws below own their own exits and must not be turned
      // into "ended abnormally but had already answered".
      if (settled && !killedByBudget && !deliberateExit) {
        this.bus.publish({
          type: "agent.log",
          runId: spec.runId,
          taskId: spec.taskId,
          sessionId,
          text: `the session ended abnormally but had already answered — keeping what it produced (${String(e).slice(0, 200)})`,
          ts: Date.now(),
        });
      } else if (killedByBudget || deliberateExit) {
        // Both already ended the session row with the reason that ended it;
        // wrapping either in the generic crash path would file a subscription
        // switch as a session that died.
        throw e;
      } else {
        const stallNote = stalledMinutes ? `session watchdog: no output for ${stalledMinutes} minutes, aborted as hung. ` : "";
        const detail = stallNote + (stderrTail ? `${String(e)}\nstderr: ${stderrTail.trim().slice(-800)}` : String(e));
        this.endSession(spec, sessionId, priorTurns + turns, cost, "interrupted", detail);
        throw new Error(detail, { cause: e });
      }
    } finally {
      clearInterval(stallTimer);
      stream.close();
      if (liveKey && this.live.get(liveKey)?.stream === stream) this.live.delete(liveKey);
      await this.reap(spec, sessionId);
    }
    this.endSession(spec, sessionId, priorTurns + turns, cost, abnormal ? "error" : "done", abnormal);
    return {
      sessionId,
      sdkSessionId,
      resultText,
      costUsd: cost,
      turns,
      outcome: abnormal ? "error" : "done",
      errorDetail: abnormal || undefined,
    };
  }

  /**
   * Kill whatever the session left running in its worktree.
   *
   * Runs on every exit — clean, crashed, aborted, budget-killed — because the
   * orphans that mattered came from exactly the sessions that did not end
   * cleanly. Best-effort and unawaited by anything that reports a result: a
   * sweep is a tidy-up, and a task whose code is already committed must not
   * fail on it.
   */
  private async reap(spec: AgentSpec, sessionId: string): Promise<void> {
    if (!spec.reapOnEnd) return;
    try {
      const reaped = await reapUnder(spec.cwd);
      if (!reaped.length) return;
      this.bus.publish({
        type: "agent.log",
        runId: spec.runId,
        taskId: spec.taskId,
        sessionId,
        text:
          `killed ${reaped.length} process${reaped.length === 1 ? "" : "es"} left running in this worktree: ` +
          reaped.map((r) => `${r.pid} ${r.command.slice(0, 60)} (${r.signal})`).join("; "),
        ts: Date.now(),
      });
    } catch {
      // Nothing a sweep can fail at is worth failing a session over.
    }
  }

  private endSession(spec: AgentSpec, sessionId: string, turns: number, cost: number, state: string, detail: string): void {
    // `cost` only advances when a result message arrives, so a session that
    // died mid-stream books zero however much it spent — 13 interrupted
    // sessions in one run showed $0.00 against $16.02 of ledger rows, and the
    // sessions table came out a third short of the ledger for the whole run.
    // The ledger is the one that pays, so let it settle the bill.
    //
    // The token columns settle from the ledger for the same reason, and because
    // they were never written at all: every sessions row in every run so far
    // reads zero tokens, so "which sessions burned the most and returned the
    // least" — the question behind a quarter of a run's spend going to sessions
    // that died late — could only be answered by replaying the event log.
    this.store.db
      .prepare(
        `UPDATE sessions SET state = ?, endedAt = ?, turns = ?,
           costUsd = MAX(?, (SELECT COALESCE(SUM(costUsd),0) FROM ledger WHERE ledger.sessionId = sessions.id)),
           inputTokens = (SELECT COALESCE(SUM(inputTokens),0) FROM ledger WHERE ledger.sessionId = sessions.id),
           outputTokens = (SELECT COALESCE(SUM(outputTokens),0) FROM ledger WHERE ledger.sessionId = sessions.id),
           cacheReadTokens = (SELECT COALESCE(SUM(cacheReadTokens),0) FROM ledger WHERE ledger.sessionId = sessions.id),
           cacheWriteTokens = (SELECT COALESCE(SUM(cacheWriteTokens),0) FROM ledger WHERE ledger.sessionId = sessions.id)
         WHERE id = ?`
      )
      .run(state, Date.now(), turns, cost, sessionId);
    this.bus.publish({
      type: "agent.ended",
      runId: spec.runId,
      taskId: spec.taskId,
      sessionId,
      outcome: state === "done" ? "done" : state === "killed" ? "killed" : "error",
      detail: detail.slice(0, 500),
      ts: Date.now(),
    });
  }
}
