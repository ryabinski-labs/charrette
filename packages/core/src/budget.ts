/** Versioned price table (USD per MTok). Update alongside Anthropic pricing changes. */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;

export function priceFor(model: string): { in: number; out: number } {
  const exact = PRICES[model];
  if (exact) return exact;
  const key = Object.keys(PRICES).find((k) => model.startsWith(k) || k.startsWith(model));
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
  constructor(public scope: "run" | "task", public spent: number, public cap: number, public runId?: string) {
    super(
      `${scope} budget exceeded: $${spent.toFixed(2)} >= $${cap.toFixed(2)}` +
        (runId ? ` — run parked. Raise the cap and pick it up with: harness resume ${runId}` : "")
    );
  }
}
