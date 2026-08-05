import { randomUUID } from "node:crypto";
import { query, type HookInput, type HookJSONOutput, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentRole, providerFor } from "@harness/shared";
import { toolLoop, unsupportedSpec, type PromptSource } from "./toolLoop.js";
import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { costUsd } from "./budget.js";
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
  maxTurns?: number;
  /**
   * Characters of transcript the harness-run loop may send before it compacts.
   * Ignored on the Anthropic transport, which compacts its own. Defaults per
   * provider; set it when a model's window is smaller than its family's.
   */
  contextBudget?: number;
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
  constructor(private store: Store, private bus: Bus) {}

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

  async run(spec: AgentSpec): Promise<AgentResult> {
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

    const sessionId = spec.sessionId ?? randomUUID();
    const abort = new AbortController();
    const now = Date.now();
    this.store.db
      // The build is stamped here rather than on the run, because a run outlives
      // the process that started it: `resume` picks it up under whatever is
      // installed then, and only the session knows which fixes it could have had.
      .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt, build) VALUES (?,?,?,?,?,?,?,?)")
      .run(sessionId, spec.runId, spec.taskId ?? null, spec.role, spec.model, "running", now, harnessBuild());
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
      // Do not inherit the operator's filesystem settings/skills into worker context.
      settingSources: [],
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
      this.store.recordUsage({ runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, ...unbooked, costUsd: estimate });
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
        : toolLoop({ spec, prompts: stream.asSource(), signal: abort.signal, contextBudget: spec.contextBudget });

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
          this.endSession(spec, sessionId, turns, cost, "killed", String(e));
          throw e;
        }
        if (message.type === "harness_note") {
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
                this.bus.publish({ type: "agent.log", runId: spec.runId, taskId: spec.taskId, sessionId, text: block.text.slice(0, 2000), ts: Date.now() });
              } else if (block?.type === "tool_use") {
                this.bus.publish({ type: "agent.tool_use", runId: spec.runId, taskId: spec.taskId, sessionId, tool: String(block.name ?? "?"), summary: JSON.stringify(block.input ?? {}).slice(0, 300), ts: Date.now() });
              }
            }
          }
          this.store.db.prepare("UPDATE sessions SET turns = ?, lastHeartbeatAt = ? WHERE id = ?").run(turns, Date.now(), sessionId);
        } else if (message.type === "result") {
          const m = message as {
            subtype?: string;
            is_error?: boolean;
            errors?: string[];
            result?: string;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          };
          resultText = m.result ?? "";
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
          this.store.recordUsage({ runId: spec.runId, taskId: spec.taskId, sessionId, model: spec.model, ...usage, costUsd: costDelta });
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
      if (settled && !killedByBudget) {
        this.bus.publish({
          type: "agent.log",
          runId: spec.runId,
          taskId: spec.taskId,
          sessionId,
          text: `the session ended abnormally but had already answered — keeping what it produced (${String(e).slice(0, 200)})`,
          ts: Date.now(),
        });
      } else if (killedByBudget) {
        throw e;
      } else {
        const stallNote = stalledMinutes ? `session watchdog: no output for ${stalledMinutes} minutes, aborted as hung. ` : "";
        const detail = stallNote + (stderrTail ? `${String(e)}\nstderr: ${stderrTail.trim().slice(-800)}` : String(e));
        this.endSession(spec, sessionId, turns, cost, "interrupted", detail);
        throw new Error(detail, { cause: e });
      }
    } finally {
      clearInterval(stallTimer);
      stream.close();
      if (liveKey && this.live.get(liveKey)?.stream === stream) this.live.delete(liveKey);
      await this.reap(spec, sessionId);
    }
    this.endSession(spec, sessionId, turns, cost, abnormal ? "error" : "done", abnormal);
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
