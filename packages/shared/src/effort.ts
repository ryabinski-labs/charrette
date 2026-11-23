import { z } from "zod";
import { providerFor, splitModel } from "./providers.js";
import { currentModel } from "./retired.js";

/**
 * How hard each model may be asked to think, and the one table that says so.
 *
 * Config validation, the CLI and the dashboard all read `MODEL_EFFORTS`, so the
 * page cannot offer a level the server would refuse. A level a model does not
 * take is refused when the config is parsed: sent anyway it is a 400 on the
 * first turn of whichever role reaches that model, possibly hours into a run.
 *
 * Each vendor spells the setting differently, and the transport does the
 * translating (pool.ts for Anthropic, providerClients.ts for the rest):
 *
 *   - Anthropic: the Agent SDK's `effort` option. All five levels on the current
 *     models (platform.claude.com/docs/en/build-with-claude/effort).
 *   - OpenAI: `reasoning.effort` on the Responses API
 *     (developers.openai.com/api/docs/models/gpt-5.6-sol).
 *   - Google: `generationConfig.thinkingConfig.thinkingLevel`
 *     (aistudio.google.com/docs/thinking).
 *   - DeepSeek: `reasoning_effort` (api-docs.deepseek.com/guides/thinking_mode).
 *     Its API also accepts `medium` and `xhigh`, but silently runs them as
 *     `high`, so they are not offered: the setting would claim a level that is
 *     not the one running.
 *
 * Read from those pages on 2026-11-23. A model absent from this table has no
 * effort setting, and nothing is ever sent for it.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const CLAUDE: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const GPT_5_6: readonly EffortLevel[] = ["none", "low", "medium", "high", "xhigh", "max"];
const GEMINI_THREE_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"];
const GEMINI_FOUR_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh"];
const DEEPSEEK: readonly EffortLevel[] = ["low", "high", "max"];

export const MODEL_EFFORTS: Readonly<Record<string, readonly EffortLevel[]>> = {
  "claude-fable-5-2": CLAUDE,
  "claude-opus-5-5": CLAUDE,
  "claude-sonnet-5-5": CLAUDE,
  "claude-haiku-5-5": CLAUDE,
  "gpt-5.6-sol": GPT_5_6,
  "gpt-5.6-terra": GPT_5_6,
  "gpt-5.6-luna": GPT_5_6,
  "gemini-4-carbon": GEMINI_THREE_LEVELS,
  "gemini-4-neon": GEMINI_FOUR_LEVELS,
  "gemini-4-hydrogen": GEMINI_FOUR_LEVELS,
  "gemini-3.8-flash": GEMINI_THREE_LEVELS,
  "gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
  "deepseek-flash": DEEPSEEK,
  "deepseek-v4-flash": DEEPSEEK,
};

/**
 * The name a model's effort is stored under: no `provider/` prefix, and a
 * retired id read as its replacement, so every spelling of one model shares one
 * setting.
 */
export function effortKey(model: string): string {
  return splitModel(currentModel(model)).id;
}

/** The levels a model accepts. Empty means it has no effort setting. */
export function effortLevels(model: string): readonly EffortLevel[] {
  const { provider, id } = splitModel(currentModel(model));
  // An explicit prefix can send a model to a vendor that does not serve it.
  // That vendor's parameter is not this table's to promise.
  if (providerFor(id) !== provider || !Object.hasOwn(MODEL_EFFORTS, id)) return [];
  return MODEL_EFFORTS[id]!;
}

/** One line saying why this model cannot run at this level, or null when it can. */
export function effortProblem(model: string, level: string): string | null {
  const key = effortKey(model);
  const name = key === splitModel(model).id ? model : `${model} (now ${key})`;
  const levels = effortLevels(model);
  if (!levels.length) return `${name} has no effort setting.`;
  if ((levels as readonly string[]).includes(level)) return null;
  return `${name} does not support effort "${level}"; use one of: ${levels.join(", ")}.`;
}

/** The level to send for this model, or undefined to send nothing. */
export function effortFor(table: Readonly<Record<string, string>> | undefined, model: string): EffortLevel | undefined {
  const level = table?.[effortKey(model)];
  return (effortLevels(model) as readonly (string | undefined)[]).includes(level) ? (level as EffortLevel) : undefined;
}

/**
 * The `effort` block of a run config, keyed by model.
 *
 * Empty by default, which sends nothing and leaves every vendor on its own
 * default. Keys come out canonical, so a config naming `claude-opus-5` stores
 * its setting under `claude-opus-5-5`, the model that actually runs.
 */
export const EffortConfig = z.record(z.string(), z.string()).transform((raw, ctx) => {
  const out: Record<string, EffortLevel> = {};
  for (const [model, level] of Object.entries(raw)) {
    const problem = effortProblem(model, level);
    if (problem) {
      ctx.addIssue({ code: "custom", message: problem });
      continue;
    }
    const key = effortKey(model);
    if (out[key] && out[key] !== level) {
      ctx.addIssue({ code: "custom", message: `${key} is set twice, to ${out[key]} and ${level}; keep one.` });
      continue;
    }
    out[key] = level as EffortLevel;
  }
  return out;
});
export type EffortConfig = z.infer<typeof EffortConfig>;

/**
 * Lay `overrides` over `base`, by model. The level `default` removes a model's
 * setting, which is how a flag returns one model to its vendor's default.
 */
export function mergeEfforts(base: Readonly<Record<string, string>>, overrides: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [model, level] of Object.entries(base)) out[effortKey(model)] = level;
  for (const [model, level] of Object.entries(overrides)) {
    if (level === "default") delete out[effortKey(model)];
    else out[effortKey(model)] = level;
  }
  return out;
}

/**
 * What survives of a recorded run's effort block under today's table.
 *
 * `getRun` re-parses the stored config on every read, so a level that was valid
 * when the run started and has since been withdrawn, or a model retired into one
 * without that level (`gemini-3.6-flash` at `minimal` becomes 3.8 Flash, which
 * has no `minimal`), would otherwise make the whole run unreadable. Those
 * entries are dropped and reported: the model returns to its vendor's default.
 */
export function settleEfforts(raw: unknown): { effort: Record<string, EffortLevel>; dropped: string[] } {
  const effort: Record<string, EffortLevel> = {};
  const dropped: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { effort, dropped };
  for (const [model, level] of Object.entries(raw)) {
    const key = effortKey(model);
    if (typeof level !== "string" || effortProblem(model, level) || (effort[key] && effort[key] !== level)) {
      dropped.push(`${model}=${String(level)}`);
      continue;
    }
    effort[key] = level as EffortLevel;
  }
  return { effort, dropped };
}
