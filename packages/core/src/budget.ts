import { modelId } from "@harness/shared";

/**
 * Versioned price table (USD per MTok). Update alongside provider pricing changes.
 *
 * Every model a run can be pointed at needs a row here, not just the Anthropic
 * ones: caps are enforced from `costUsd`, and a session on an unpriced model
 * spends real money the budget gate cannot see. The unknown-model fallback in
 * `priceFor` is the top tier for exactly that reason — an unpriced model is
 * over-charged and stops the run early, never under-charged and let run on.
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  // OpenAI GPT-5.6, standard tier (developers.openai.com/api/docs/pricing).
  // Cached input is a flat 0.1x on all three, which is CACHE_READ_MULT already.
  // Only the standard tier is listed: the harness sends interactive requests, so
  // batch and flex prices would under-charge, and fast mode would over-charge.
  "gpt-5.6-sol": { in: 5, out: 30 },
  "gpt-5.6-terra": { in: 2, out: 12 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
  // Google Gemini 3.5. Only the model whose price was verified is listed —
  // a guessed row would under-charge silently, where an absent one is caught
  // by the top-tier fallback below and merely stops the run early.
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

export function priceFor(model: string): { in: number; out: number } {
  // `openai/gpt-5.6-terra` and `gpt-5.6-terra` are the same model and must cost
  // the same; without this the prefixed spelling falls through to the fallback
  // and the operator is over-charged for using a form the config accepts.
  const name = modelId(model);
  const exact = PRICES[name];
  if (exact) return exact;
  const key = Object.keys(PRICES).find((k) => name.startsWith(k) || k.startsWith(name));
  return key ? PRICES[key]! : { in: 5, out: 25 }; // unknown models priced at the top tier, never under
}

export function costUsd(model: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  const p = priceFor(model);
  return (
    (usage.inputTokens * p.in +
      usage.cacheReadTokens * p.in * CACHE_READ_MULT +
      usage.cacheWriteTokens * p.in * CACHE_WRITE_MULT +
      usage.outputTokens * p.out) /
    1_000_000
  );
}

/**
 * Thrown only once the operator has been asked and declined to raise the cap —
 * reaching a cap on its own opens a budget gate instead (RunController.enforce).
 */
export class BudgetExceeded extends Error {
  constructor(public spent: number, public cap: number, public runId?: string) {
    super(
      `run budget exceeded: $${spent.toFixed(2)} >= $${cap.toFixed(2)}` +
        (runId ? ` — run parked. Raise the cap and pick it up with: harness resume ${runId}` : "")
    );
  }
}
