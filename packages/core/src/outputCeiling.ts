import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * How much the installed agent SDK will actually let a model emit in one message.
 *
 * `maxOutputTokens` is a request, not a grant. The SDK clamps every message to a
 * per-model ceiling chosen by substring match, and a model it has never heard of
 * falls through to 32k however high `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is set. In
 * 0.1.77 the table keys are `3-5`, `claude-3-opus`, `claude-3-sonnet`,
 * `claude-3-haiku`, `opus-4-5`, `opus-4`, `sonnet-4`, `haiku-4` — so
 * `claude-opus-5` matches nothing and is handed the default.
 *
 * That is a silent failure, and it cost a real run: the planner asked for 64k,
 * was given 32k, and phase B died mid-JSON with "response exceeded the 32000
 * output token maximum". Nothing in the harness had said the request was refused,
 * so the retry told the planner to *write less* — advice that would have been
 * right if the plan were genuinely too big and was wrong here.
 *
 * ## Why this reads the SDK's own table rather than keeping a copy
 *
 * A copy is stale the day the SDK adds a model, and a stale copy warning about a
 * model that now works is worse than no warning at all. So the ceiling is parsed
 * out of the SDK's bundle, which means it is right for whichever version happens
 * to be installed and goes quiet by itself the moment the SDK learns the model.
 * The parse is deliberately shallow and every failure is silent: a bundle whose
 * shape has changed yields no table, and no table yields no claim.
 *
 * ## Why this warns rather than refuses to start
 *
 * The harness already survives the clamp — planning is split in two precisely so
 * that no single message has to carry a whole plan (see `plan`). Halting a run
 * over a ceiling the run is built to work under would turn a recoverable
 * condition into an outage for every operator on an SDK that predates their
 * model. What was missing was never the failure, it was the explanation.
 */

/** One arm of the SDK's ceiling chain: any of these substrings means this cap. */
export interface CeilingRule {
  match: string[];
  cap: number;
}

/** The SDK's per-model output ceilings, as read from the installed bundle. */
export interface CeilingTable {
  rules: CeilingRule[];
  /** What a model matching no rule is given. */
  fallback: number;
}

/** What the installed SDK will grant one model. */
export interface OutputCeiling {
  model: string;
  cap: number;
  /**
   * Whether a rule actually matched. False means the cap is the SDK's fallback —
   * which may be generous enough by accident, and still says the SDK does not
   * know this model.
   */
  recognized: boolean;
}

/**
 * The minified chain is `if(Q.includes("3-5"))B=8192;else if(...)B=4096;…;else
 * B=32000`, immediately before the env-var clamp. Anchoring on the env var
 * rather than on the function name is what makes this survive a re-minify:
 * identifiers are regenerated every build, the environment variable is not.
 */
const CLAMP_ANCHOR = ".validate(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS)";

/** Enough of the bundle to hold the chain, small enough to hold nothing else. */
const CHAIN_WINDOW = 800;

/** Below this many arms it is not the table, it is a coincidence that parsed. */
const MIN_RULES = 3;

/**
 * Read the ceiling chain out of an SDK bundle.
 *
 * Returns undefined for any bundle that does not contain a chain of the expected
 * shape — a newer SDK that computes ceilings some other way says nothing rather
 * than guessing, which is the whole point of reading it instead of assuming it.
 */
export function ceilingTable(bundle: string): CeilingTable | undefined {
  const anchor = bundle.indexOf(CLAMP_ANCHOR);
  if (anchor < 0) return undefined;
  // From the `.toLowerCase()` that starts the chain to the clamp that ends it.
  const before = bundle.slice(Math.max(0, anchor - CHAIN_WINDOW), anchor);
  const start = before.lastIndexOf(".toLowerCase()");
  if (start < 0) return undefined;
  const chain = before.slice(start);

  const rules: CeilingRule[] = [];
  let fallback: number | undefined;
  let assigned: string | undefined;
  for (const arm of chain.split(/\belse\b/)) {
    const match = [...arm.matchAll(/\.includes\("([^"]+)"\)/g)].map((m) => m[1]!);
    const assignment = arm.match(/([A-Za-z_$][\w$]*)=(\d+)/);
    // An arm whose ceiling is not a plain number cannot be reproduced here, and
    // a table silently missing one arm is worse than no table: it answers
    // confidently and wrongly for exactly the model that arm was written for.
    if (!assignment) return undefined;
    // Every arm must assign the same variable. If they do not, this is not one
    // chain and the window has caught something else alongside it.
    assigned ??= assignment[1];
    if (assignment[1] !== assigned) return undefined;
    if (match.length) rules.push({ match, cap: Number(assignment[2]) });
    else fallback = Number(assignment[2]);
  }
  if (rules.length < MIN_RULES || fallback === undefined) return undefined;
  return { rules, fallback };
}

/** Apply the table the way the SDK does: first matching substring, else the fallback. */
export function modelCeiling(table: CeilingTable, model: string): OutputCeiling {
  const lower = model.toLowerCase();
  const hit = table.rules.find((r) => r.match.some((m) => lower.includes(m)));
  return { model, cap: hit?.cap ?? table.fallback, recognized: Boolean(hit) };
}

let cached: Promise<CeilingTable | undefined> | undefined;

/** Where the SDK's bundle lives, next to the entry point the harness imports. */
function bundlePath(): string {
  const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  return path.join(path.dirname(entry), "cli.js");
}

/**
 * The installed SDK's ceiling for one model, or undefined if it could not be read.
 *
 * The bundle is ten megabytes and does not change while the harness runs, so it
 * is read once per process. Never throws: an SDK that cannot be resolved, read,
 * or parsed produces no opinion.
 */
export async function sdkCeiling(model: string, load = () => readFile(bundlePath(), "utf8")): Promise<OutputCeiling | undefined> {
  cached ??= load()
    .then(ceilingTable)
    .catch(() => undefined);
  const table = await cached;
  return table && modelCeiling(table, model);
}

/** Forget the cached bundle. Tests only; a process never installs a second SDK. */
export function forgetCeilingTable(): void {
  cached = undefined;
}

/**
 * What the operator is told when the SDK will grant less than the harness asked for.
 *
 * Undefined when there is nothing to say — the ceiling could not be read, or it
 * is high enough that the request stands. Silence here means the request was
 * honoured, which is why it has to be silence and not a reassurance nobody reads.
 */
export function ceilingNote(ceiling: OutputCeiling | undefined, asked: number, role = "the planner"): string | undefined {
  if (!ceiling || ceiling.cap >= asked) return undefined;
  const head = `output ceiling: ${role} asks for ${asked} tokens per message and the installed agent SDK will give ${ceiling.cap}`;
  if (ceiling.recognized) return `${head} — ${ceiling.model} is capped there and long output will be cut off mid-message`;
  return `${head}, because it does not recognise ${ceiling.model} and falls back to its default — upgrade @anthropic-ai/claude-agent-sdk, or expect long output to be cut off mid-message`;
}
