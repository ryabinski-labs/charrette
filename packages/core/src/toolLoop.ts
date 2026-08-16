import { providerFor } from "@harness/shared";
import { toolsFor, unsupportedTools, type LocalTool, type ToolContext } from "./agentTools.js";
import { parseCheckpoint } from "./checkpoint.js";
import { budgetFor, compact, fold } from "./compact.js";
import { clientFor, type Fetch, type LoopMessage, type ProviderClient, type Usage } from "./providerClients.js";
import { rtkCommandRewriter } from "./rtk.js";

/**
 * The agentic loop for providers that are not Anthropic.
 *
 * The Claude Agent SDK runs this loop inside its own process: it asks the
 * model, executes the tool calls, feeds the results back, and stops when the
 * model answers without asking for a tool. OpenAI and Google sell the model
 * turn and nothing else, so the harness runs the loop itself — and, running it
 * itself, it is the harness that decides which tools exist and what happens
 * before a command reaches a shell (agentTools.ts).
 *
 * It yields the same message shapes `query()` yields, so `AgentPool.run` never
 * learns which vendor answered: usage still books per turn, text and tool calls
 * still reach the bus, the stall watchdog still counts from the last message,
 * and mid-flight operator feedback still lands in the running conversation.
 */

/** What the loop needs from the session's stdin. Implemented by PromptStream. */
export interface PromptSource {
  /** Blocks for the next operator message; null once the session is finished. */
  next(): Promise<string | null>;
  /** Whatever is queued right now, without blocking. */
  drain(): string[];
}

export interface ToolLoopSpec {
  model: string;
  systemPrompt: string;
  cwd: string;
  env?: Record<string, string>;
  tools?: unknown;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: unknown;
  maxTurns?: number;
  maxOutputTokens?: number;
}

export interface ToolLoopOptions {
  spec: ToolLoopSpec;
  prompts: PromptSource;
  signal: AbortSignal;
  /** Injected in tests; otherwise built from the provider and the environment. */
  client?: ProviderClient;
  fetchImpl?: Fetch;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests, so a tool loop can be driven without touching a disk. */
  toolsOverride?: LocalTool[];
  execOverride?: ToolContext["exec"];
  /** Characters of transcript to allow before compacting. Defaults per provider. */
  contextBudget?: number;
  /**
   * Fold the transcript into the agent's own checkpoint digest when it writes
   * one (checkpoint.ts). Off leaves the digest in the record as ordinary
   * narration, which is all the Anthropic transport can do with it anyway.
   */
  foldOnCheckpoint?: boolean;
}

/**
 * A spec this transport cannot honour, or null when it can.
 *
 * Refused before the session row is written, not on the turn that needs the
 * missing piece: an agent that silently lacks the tool it was told to use does
 * not report that it lacked it — it improvises, and run 40da9337 is what
 * improvising looks like on the invoice.
 */
export function unsupportedSpec(spec: ToolLoopSpec): string | null {
  if (spec.mcpServers && Object.keys(spec.mcpServers as object).length > 0) {
    return "this role uses in-process MCP tools, which only the Anthropic transport can expose";
  }
  const missing = unsupportedTools(spec);
  if (missing.length) {
    return `the harness tool loop has no implementation for ${missing.join(", ")}`;
  }
  return null;
}

/** The zero every usage total starts from. */
const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

function add(into: Usage, from: Usage): void {
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cacheReadTokens += from.cacheReadTokens;
  into.cacheWriteTokens += from.cacheWriteTokens;
}

/** Usage in the shape the SDK reports it, which is what pool.ts reads. */
function sdkUsage(u: Usage) {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    cache_read_input_tokens: u.cacheReadTokens,
    cache_creation_input_tokens: u.cacheWriteTokens,
  };
}

/**
 * How the loop tells the model to stop asking for tools and answer. Mirrors
 * what the SDK does at its own ceiling — see the wrap-up message in pool.ts.
 */
const OUT_OF_TURNS =
  "[HARNESS] You have reached this session's turn limit. Stop calling tools and give your final answer now, in exactly the output format you were asked for.";

export async function* toolLoop(opts: ToolLoopOptions): AsyncGenerator<Record<string, unknown>> {
  const { spec, prompts, signal } = opts;
  const provider = providerFor(spec.model);
  const client = opts.client ?? clientFor(provider, opts.env ?? process.env, opts.fetchImpl ?? globalThis.fetch);
  const tools = opts.toolsOverride ?? toolsFor(spec);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const ctx: ToolContext = {
    cwd: spec.cwd,
    env: { ...(process.env as Record<string, string>), ...(spec.env ?? {}) },
    signal,
    rewrite: rtkCommandRewriter(opts.env ?? process.env),
    exec: opts.execOverride,
  };

  // A session id of our own, so a resumed spec and the bus have something
  // stable to point at. It is not a handle any provider will re-attach to —
  // these APIs are stateless — which is why `resume` is not offered off the
  // Anthropic transport.
  const sessionId = `${provider}-${Math.abs(hash(spec.cwd + spec.systemPrompt)).toString(36)}`;

  const messages: LoopMessage[] = [];
  const turnCap = spec.maxTurns ?? 100;
  const budget = budgetFor(spec.model, opts.contextBudget);
  let turns = 0;
  let sinceResult = noUsage();

  /**
   * Bring the transcript under budget before it is sent, and say so.
   *
   * Compaction is not free — the agent loses detail it may still want — so it is
   * reported rather than done quietly: an operator judging a worker's output
   * needs to know it was working from an abridged record. `exhausted` is the
   * case worth shouting about, because it means the protected material alone is
   * over budget and the next request may be refused.
   */
  const fit = (): Record<string, unknown> | null => {
    const result = compact(messages, budget);
    // Nothing saved AND still over budget is the worst case, not a quiet one: it
    // means the protected material alone does not fit and the request is about
    // to be refused. Only a transcript that actually fits stays silent.
    if (result.saved === 0 && !result.exhausted) return null;
    messages.splice(0, messages.length, ...result.messages);
    const note = result.exhausted
      ? `compacted ${result.saved} characters of older tool output and the transcript is STILL over the ${budget}-character budget — the next request may be refused`
      : `compacted ${result.saved} characters of older tool output to stay inside the ${budget}-character context budget`;
    return { type: "harness_note", session_id: sessionId, text: note };
  };

  for (let prompt = await prompts.next(); prompt !== null; prompt = await prompts.next()) {
    messages.push({ role: "user", text: prompt });

    for (;;) {
      if (signal.aborted) return;

      const note = fit();
      if (note) yield note;

      const turn = await client({
        model: spec.model,
        system: spec.systemPrompt,
        messages,
        tools,
        maxOutputTokens: spec.maxOutputTokens,
        signal,
      });
      turns++;
      add(sinceResult, turn.usage);

      const content: Record<string, unknown>[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
      yield { type: "assistant", session_id: sessionId, message: { content, usage: sdkUsage(turn.usage) } };

      // `signature` rides along untouched: the provider that issued it is the
      // only thing that reads it, and it must come back exactly as it left.
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, signature: turn.signature });

      // The agent just wrote an account of its own work, so the material that
      // account was derived from can go. This is the only place the harness
      // gets to compact by understanding rather than by deletion — see
      // `fold` in compact.ts — and it happens after the assistant message is
      // appended so that the digest itself sits in the protected tail and is
      // not folded away by the call that is folding on its behalf.
      if (opts.foldOnCheckpoint) {
        const checkpoint = parseCheckpoint(turn.text);
        if (checkpoint?.digest) {
          const folded = fold(messages, checkpoint.digest);
          if (folded.saved > 0) {
            messages.splice(0, messages.length, ...folded.messages);
            yield {
              type: "harness_note",
              session_id: sessionId,
              text: `folded ${folded.saved} characters of earlier narration and tool output into the agent's own checkpoint digest`,
            };
          }
        }
      }

      // No tool calls means the model has answered. Same terminal condition the
      // SDK uses, and the point where the operator's next message is awaited.
      if (turn.toolCalls.length === 0) {
        yield { type: "result", subtype: "success", session_id: sessionId, result: turn.text, usage: sdkUsage(sinceResult) };
        sinceResult = noUsage();
        break;
      }

      for (const call of turn.toolCalls) {
        const tool = byName.get(call.name);
        let text: string;
        if (!tool) {
          text = `error: no tool named ${call.name}. Available: ${tools.map((t) => t.name).join(", ") || "(none)"}.`;
        } else {
          try {
            text = await tool.run(call.input, ctx);
          } catch (e) {
            // A tool that throws is a result the agent can act on, not a dead
            // session: a bad path or a missing file is an ordinary mistake.
            text = `error: ${String(e)}`;
          }
        }
        messages.push({ role: "tool", callId: call.id, name: call.name, text });
      }

      // Operator feedback pushed while the model was working joins the
      // conversation here — between rounds, which is the first moment the
      // transcript is consistent.
      for (const extra of prompts.drain()) messages.push({ role: "user", text: extra });

      if (turns >= turnCap) {
        messages.push({ role: "user", text: OUT_OF_TURNS });
        // The wrap-up turn is the one that must not be refused: it is where a
        // session that did all the work finally says what it found.
        const wrapNote = fit();
        if (wrapNote) yield wrapNote;
        const last = await client({ model: spec.model, system: spec.systemPrompt, messages, tools: [], maxOutputTokens: spec.maxOutputTokens, signal });
        turns++;
        add(sinceResult, last.usage);
        yield { type: "assistant", session_id: sessionId, message: { content: last.text ? [{ type: "text", text: last.text }] : [], usage: sdkUsage(last.usage) } };
        yield {
          type: "result",
          subtype: "error_max_turns",
          session_id: sessionId,
          result: last.text,
          usage: sdkUsage(sinceResult),
        };
        sinceResult = noUsage();
        return;
      }
    }
  }
}

/** Small stable hash, only ever used to name a session. */
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}
