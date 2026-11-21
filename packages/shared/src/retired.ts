import { modelId } from "./providers.js";

/**
 * Models the charrette no longer runs, and the current model that replaces each.
 *
 * A run copies its routing table when it is created, and the copy outlives
 * every change to the defaults: a run started on `claude-opus-5` was still
 * sending interface tasks to it after Opus 5.5 became the default, and
 * `charrette resume` kept it there. Retiring a model fixes that in one place.
 * Every config the charrette parses — a run's frozen table, the
 * `charrette.config.json` models block, a `--model` flag, a dashboard edit —
 * reads a retired id as its replacement, and `Store` rewrites the frozen
 * tables at open so the database says what actually runs.
 *
 * Each replacement is the same vendor and the same tier, one generation on:
 * a role never changes vendor or drops a tier by being upgraded, so a pinned
 * judge stays inside its pin. Gemini Flash-Lite and the GPT-5.6 tiers are
 * still current and are not listed.
 */
export const RETIRED_MODELS: Readonly<Record<string, string>> = {
  "claude-fable-5": "claude-fable-5-2",
  "claude-fable-5-1": "claude-fable-5-2",
  "claude-opus-5": "claude-opus-5-5",
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-haiku-4-5": "claude-haiku-5-5",
  "claude-haiku-4-5-20251001": "claude-haiku-5-5",
  "gemini-3.6-flash": "gemini-3.8-flash",
  "gemini-3.7-flash": "gemini-3.8-flash",
};

/**
 * The model to run in place of `model`: its replacement when it is retired,
 * otherwise `model` itself. A `provider/` prefix is kept, so
 * `anthropic/claude-opus-5` becomes `anthropic/claude-opus-5-5`.
 */
export function currentModel(model: string): string {
  const id = modelId(model);
  const to = RETIRED_MODELS[id];
  return to ? model.slice(0, model.length - id.length) + to : model;
}

/** One role moved off a retired model. */
export interface RetiredMove {
  role: string;
  from: string;
  to: string;
}

/** Every role in a routing table that names a retired model, and where it moves. */
export function retiredMoves(models: Record<string, unknown>): RetiredMove[] {
  const out: RetiredMove[] = [];
  for (const [role, from] of Object.entries(models)) {
    if (typeof from !== "string") continue;
    const to = currentModel(from);
    if (to !== from) out.push({ role, from, to });
  }
  return out;
}

/** A routing table with every retired model replaced. Anything that is not a plain object passes through untouched. */
export function retireModels(models: unknown): unknown {
  if (!models || typeof models !== "object" || Array.isArray(models)) return models;
  return Object.fromEntries(Object.entries(models).map(([role, m]) => [role, typeof m === "string" ? currentModel(m) : m]));
}
