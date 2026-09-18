import { providerFor, type Provider } from "@charrette/shared";
import type { LoopMessage } from "./providerClients.js";

/**
 * Keeping a long session inside the model's context window.
 *
 * The Claude Agent SDK compacts its own transcript, so the Anthropic transport
 * never needed this. The charrette-run loop (toolLoop.ts) only ever appends, and a
 * worker on a tool-heavy task appends fast: agentTools clamps a single tool
 * result at 30k characters, and forty turns of those is past every window on the
 * market. What that produces is the worst kind of failure — the session dies
 * late, after the budget has been spent on it, with nothing merged.
 *
 * The rule for what may be compacted is taken from Hermes' micro-compaction
 * (github.com/NousResearch/hermes-agent, docs/micro-compaction.md): compact the
 * derived material, never the source of truth. What an agent writes is an
 * account of what it did — "I read this file, I ran that command" — and survives
 * being shortened with little loss. What the OPERATOR wrote is the intent all of
 * that was derived from, and cannot be reconstructed from the work that
 * followed. Paraphrasing "use the existing retry helper, do not add a new one"
 * is exactly how an agent confidently does the thing it was told not to, six
 * turns later. So `user` messages — the task prompt and any mid-flight feedback
 * — are never touched here, at any pressure.
 *
 * Two deliberate departures from Hermes:
 *
 * Hermes folds one exchange per turn, which amortises the cost but rewrites
 * already-sent history every turn and so breaks the provider's cached prefix
 * every turn. providerClients.ts prices OpenAI's cached input at a tenth of the
 * uncached rate, so paying that repeatedly would cost more than it saves. This
 * compacts at a high-water mark down to a low-water mark instead, leaving the
 * prefix untouched on the turns in between.
 *
 * Hermes summarises with an auxiliary model. This does not call a model at all.
 * A summarisation call on the path whose entire job is "do not die" would add
 * both a bill and a new way to fail; elision is free, cannot throw, and cannot
 * be wrong about what it dropped because it says so in place.
 */

/**
 * When to start compacting, in characters of transcript.
 *
 * Characters rather than tokens because the true count is the provider's to
 * decide and is only known after the request that would have failed. Roughly
 * four characters per token, set well under each window so that the estimate
 * being wrong by a wide margin still leaves room.
 */
export const BUDGETS: Record<Provider, number> = {
  anthropic: 600_000, // unused — the SDK compacts its own transcript
  openai: 600_000,
  google: 2_000_000,
};

/** How much of the window to fall back to, so compaction is not re-triggered every turn. */
const LOW_WATER = 0.6;

/** Exchanges left verbatim at the end, where the agent is actually working. */
const KEEP_RECENT = 3;

/** Head and tail kept when a tool result is shortened rather than dropped. */
const HEAD = 600;
const TAIL = 400;

export function messageChars(m: LoopMessage): number {
  if (m.role === "assistant") {
    return m.text.length + m.toolCalls.reduce((n, c) => n + c.name.length + JSON.stringify(c.input).length, 0);
  }
  return m.text.length;
}

export function transcriptChars(messages: LoopMessage[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0);
}

/**
 * Index from which everything is left alone.
 *
 * The recent tail is where the agent is mid-thought: shortening a tool result it
 * is still reasoning about does not save a session, it derails one. Counted in
 * assistant messages because that is what bounds an exchange.
 */
export function protectedFrom(messages: LoopMessage[], keepRecent = KEEP_RECENT): number {
  const assistants: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i]!.role === "assistant") assistants.push(i);
  if (assistants.length <= keepRecent) return 0;
  return assistants[assistants.length - keepRecent]!;
}

function digest(text: string): string {
  if (text.length <= HEAD + TAIL) return text;
  const dropped = text.length - HEAD - TAIL;
  return `${text.slice(0, HEAD)}\n\n[… ${dropped} characters elided to stay inside the context window …]\n\n${text.slice(-TAIL)}`;
}

function elided(name: string, originalChars: number): string {
  return `[${name} output — ${originalChars} characters elided to stay inside the context window]`;
}

export interface CompactResult {
  messages: LoopMessage[];
  /** Characters removed. Zero when nothing needed doing, which is the common case. */
  saved: number;
  /** True when the transcript is still over budget with everything compactable already compacted. */
  exhausted: boolean;
}

/**
 * Bring a transcript under budget, oldest material first.
 *
 * Tool output goes before anything else because that is where the bulk is and
 * because the assistant message above it already says what the tool was for. Two
 * passes: shorten every eligible result, and only if that was not enough, drop
 * them outright. Assistant narration is never removed — it is the cheapest
 * record of what has already been tried, and an agent that loses it repeats it.
 */
export function compact(messages: LoopMessage[], budget: number, keepRecent = KEEP_RECENT): CompactResult {
  const before = transcriptChars(messages);
  if (before <= budget) return { messages, saved: 0, exhausted: false };

  const target = Math.floor(budget * LOW_WATER);
  const out = messages.slice();
  const limit = protectedFrom(messages, keepRecent);
  let total = before;

  // How big each tool result was before anything was done to it. The elide pass
  // runs after the digest pass has already shrunk the same message, so without
  // this it would report the size of the digest and tell the operator a
  // hundred-thousand-character result was a thousand.
  const original = new Map<number, number>();
  for (let i = 0; i < limit; i++) {
    const m = messages[i]!;
    if (m.role === "tool") original.set(i, m.text.length);
  }

  for (const pass of ["digest", "elide"] as const) {
    for (let i = 0; i < limit && total > target; i++) {
      const m = out[i]!;
      if (m.role !== "tool") continue;
      const next = pass === "digest" ? digest(m.text) : elided(m.name, original.get(i)!);
      if (next.length >= m.text.length) continue;
      total -= m.text.length - next.length;
      out[i] = { ...m, text: next };
    }
  }

  return { messages: out, saved: before - total, exhausted: total > budget };
}

/** The budget for whichever provider is answering, with an explicit override for tests and config. */
export function budgetFor(model: string, override?: number): number {
  return override ?? BUDGETS[providerFor(model)];
}

/**
 * Replace the older half of the transcript with the agent's own account of it.
 *
 * This is the other kind of compaction — the one the operator gets from
 * `/compact`, and the reason checkpoint.ts asks for a digest at all. Everything
 * above says elision is preferable to summarisation *on the pressure path*,
 * because a model call there adds a bill and a way to fail to the one routine
 * whose entire job is not to die. None of that applies here: the summary has
 * already been written, by the agent itself, on a turn that was going to happen
 * anyway. There is nothing left to pay for and nothing left to throw.
 *
 * What it buys over elision is the difference between a six-hundred-character
 * stub of a file the agent read and a sentence saying what the file turned out
 * to contain. Elision keeps the shape of the work; this keeps its conclusions.
 *
 * The source-of-truth rule is unchanged and is why this is not simply a splice:
 * `user` messages survive in their original order, digest or no digest. They are
 * the assignment and the operator's mid-flight corrections — the two things in
 * the transcript that cannot be reconstructed from an agent's summary of its own
 * behaviour, and precisely the things an agent paraphrases into the opposite of
 * what they said. Only assistant narration and tool output are folded away, and
 * only from before the protected tail, which is where the agent is still
 * thinking.
 *
 * The digest goes in last, immediately before that tail, so the conversation
 * reads in the order it happened: the assignment, anything the operator said
 * since, then "here is where I have got to", then live work.
 */
export function fold(messages: LoopMessage[], digest: string, keepRecent = KEEP_RECENT): CompactResult {
  const before = transcriptChars(messages);
  const limit = protectedFrom(messages, keepRecent);
  // Nothing old enough to be safe to fold. Common on a short session, and the
  // caller must be able to tell that from a fold that did something.
  if (limit === 0) return { messages, saved: 0, exhausted: false };

  const kept: LoopMessage[] = [];
  for (let i = 0; i < limit; i++) {
    const m = messages[i]!;
    if (m.role === "user") kept.push(m);
  }
  kept.push({
    role: "assistant",
    text: `[Checkpoint digest — the work up to this point, in place of ${limit - kept.length} earlier messages of narration and tool output]\n\n${digest}`,
    toolCalls: [],
  });

  const out = [...kept, ...messages.slice(limit)];
  const total = transcriptChars(out);
  // A digest longer than what it replaced is not a saving, and swapping detail
  // for a longer paraphrase of it is a straight loss. Rare, but a chatty agent
  // on a short tail will do it.
  if (total >= before) return { messages, saved: 0, exhausted: false };
  return { messages: out, saved: before - total, exhausted: false };
}
