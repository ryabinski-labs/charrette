import { randomUUID } from "node:crypto";
import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentRole } from "@harness/shared";
import { Bus } from "./bus.js";
import { Store } from "./store.js";
import { costUsd } from "./budget.js";
import { rtkHooks } from "./rtk.js";

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
 * longest legitimate silence is a single long tool call, and those are bounded
 * at 10 minutes. Aborting hands the task to the existing crash/respawn path —
 * measured cost of not doing this: one wedged QA session stalled a whole run
 * for 62 minutes until the operator noticed.
 */
const STALL_ABORT_MS = 15 * 60 * 1000;

/** The SDK's own default, named so the wrap-up trigger and the option agree. */
const DEFAULT_MAX_TURNS = 100;

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

  constructor(private first: string) {}

  private message(text: string): SDKUserMessage {
    return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" };
  }

  /** Queue a message for the live session. False once the stream has closed. */
  push(text: string): boolean {
    if (this.closed) return false;
    this.queue.push(this.message(text));
    this.wake?.();
    return true;
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

  async *stream(): AsyncGenerator<SDKUserMessage> {
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
    const sessionId = spec.sessionId ?? randomUUID();
    const abort = new AbortController();
    const now = Date.now();
    this.store.db
      .prepare("INSERT INTO sessions (id, runId, taskId, role, model, state, startedAt) VALUES (?,?,?,?,?,?,?)")
      .run(sessionId, spec.runId, spec.taskId ?? null, spec.role, spec.model, "running", now);
    this.bus.publish({ type: "agent.spawned", runId: spec.runId, taskId: spec.taskId, sessionId, role: spec.role, model: spec.model, ts: now });

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
      // programmatically: Bash commands route through rtk when it's installed.
      hooks: rtkHooks(),
      // `env` replaces the inherited environment wholesale, so spread rather than
      // set: workers reach gh/aws/podman through PATH (see toolbelt.ts).
      ...(spec.maxOutputTokens
        ? { env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.maxOutputTokens) } }
        : {}),
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
    let killedByBudget = false;
    let abnormal = "";
    // Watchdog for a wedged subprocess: no message for STALL_ABORT_MS → abort.
    let lastMessageAt = Date.now();
    let stalledMinutes = 0;
    const stallTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > STALL_ABORT_MS) {
        stalledMinutes = Math.round((Date.now() - lastMessageAt) / 60_000);
        abort.abort();
      }
    }, 30_000);
    try {
      for await (const message of query({ prompt: stream.stream(), options })) {
        lastMessageAt = Date.now();
        const sid = (message as { session_id?: string }).session_id;
        if (sid) sdkSessionId = sid;
        try {
          await spec.budgetCheck?.();
        } catch (e) {
          abort.abort();
          killedByBudget = true;
          this.endSession(spec, sessionId, turns, cost, "killed", String(e));
          throw e;
        }
        if (message.type === "assistant") {
          turns++;
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
          if (turns === wrapUpAt) {
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
            errors?: string[];
            result?: string;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
          };
          resultText = m.result ?? "";
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
          stream.settle();
        }
      }
    } catch (e) {
      if (!killedByBudget) {
        const stallNote = stalledMinutes ? `session watchdog: no output for ${stalledMinutes} minutes, aborted as hung. ` : "";
        const detail = stallNote + (stderrTail ? `${String(e)}\nstderr: ${stderrTail.trim().slice(-800)}` : String(e));
        this.endSession(spec, sessionId, turns, cost, "interrupted", detail);
        throw new Error(detail, { cause: e });
      }
      throw e;
    } finally {
      clearInterval(stallTimer);
      stream.close();
      if (liveKey && this.live.get(liveKey)?.stream === stream) this.live.delete(liveKey);
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

  private endSession(spec: AgentSpec, sessionId: string, turns: number, cost: number, state: string, detail: string): void {
    // `cost` only advances when a result message arrives, so a session that
    // died mid-stream books zero however much it spent — 13 interrupted
    // sessions in one run showed $0.00 against $16.02 of ledger rows, and the
    // sessions table came out a third short of the ledger for the whole run.
    // The ledger is the one that pays, so let it settle the bill.
    this.store.db
      .prepare(
        "UPDATE sessions SET state = ?, endedAt = ?, turns = ?, costUsd = MAX(?, (SELECT COALESCE(SUM(costUsd),0) FROM ledger WHERE ledger.sessionId = sessions.id)) WHERE id = ?"
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
