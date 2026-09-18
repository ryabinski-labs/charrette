import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * How much the installed agent SDK will actually let a model emit in one message.
 *
 * `maxOutputTokens` is a request, not a grant. The SDK clamps every message to a
 * per-model ceiling, and a model it has never heard of falls through to a default
 * — 32k — however high `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is set.
 *
 * That is a silent failure, and it has cost real runs twice. The first time, the
 * planner asked for 64k, was given 32k, and phase B died mid-JSON; nothing had
 * said the request was refused, so the retry told the planner to *write less* —
 * advice that would have been right if the plan were genuinely too big and was
 * wrong here. The second time was worse: the truncated turn was followed by the
 * charrette's own wrap-up message, which the API refuses to accept after a
 * `max_tokens` stop, and the 400 took the whole run down (see the `max_tokens`
 * branch in `pool.run`).
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
 * ## What the table looks like now
 *
 * Through 0.1.x it was a minified if/else chain of substring tests. From 0.2 the
 * bundle carries a real model registry instead — one entry per model, each with
 * `max_output_tokens:{default,upper}` — which is both easier to read and worth
 * more: `upper` is what the model will emit *when asked*, and it is higher than
 * the default for every current model. `claude-opus-5` defaults to 64k and
 * allows 128k, so a planner that asks gets twice the plan per message.
 *
 * ## Why this warns rather than refuses to start
 *
 * The charrette already survives the clamp — planning is split in two precisely so
 * that no single message has to carry a whole plan (see `plan`). Halting a run
 * over a ceiling the run is built to work under would turn a recoverable
 * condition into an outage for every operator on an SDK that predates their
 * model. What was missing was never the failure, it was the explanation.
 */

/** One model's output limits, as the SDK's own registry states them. */
export interface ModelLimits {
  /** What the model emits per message when nothing asks for more. */
  standard: number;
  /** The most it will emit when `CLAUDE_CODE_MAX_OUTPUT_TOKENS` asks for it. */
  upper: number;
}

/** The SDK's per-model output registry, as read from the installed bundle. */
export interface CeilingTable {
  /** Model id → limits, longest id first so a dated alias matches its family. */
  models: { id: string; limits: ModelLimits }[];
}

/**
 * What the installed SDK will grant one model — or why that is not known.
 *
 * The two unknowns are kept apart because they call for opposite advice. An
 * unreadable table is the charrette's problem and the operator can do nothing
 * about it, so it says nothing. A model the table does not list is the
 * operator's problem and entirely fixable: upgrade the SDK.
 */
export type CeilingReading =
  | ({ known: true; model: string } & ModelLimits)
  | { known: false; model: string; reason: "unlisted" | "unreadable" };

/**
 * Entries look like `{id:"claude-opus-5",…,max_output_tokens:{default:64000,upper:128000},…}`.
 * Splitting on the id key rather than matching across it is what keeps one
 * entry's limits from being read onto the entry before it, which is the failure
 * that would matter: a confident wrong number for a model nobody checked.
 */
const ENTRY_ANCHOR = '{id:"';

/** Below this many models it is not the registry, it is a coincidence that parsed. */
const MIN_MODELS = 5;

/**
 * Read the model registry out of an SDK bundle.
 *
 * Returns undefined for any bundle that does not contain a registry of the
 * expected shape — a newer SDK that states ceilings some other way says nothing
 * rather than guessing, which is the whole point of reading it instead of
 * assuming it.
 */
export function ceilingTable(bundle: string): CeilingTable | undefined {
  return tableOf(entriesIn(bundle));
}

/**
 * Every model entry in one blob of text, with no floor applied.
 *
 * Split out from `ceilingTable` because the floor is a judgment about a whole
 * registry and this is a judgment about one piece of text. Applying it per
 * piece is what `ceilingTableFromFile` did by calling `ceilingTable` on each
 * chunk: a registry that straddles a chunk boundary put four models in one
 * chunk and two in the next, both were refused as coincidences, and six models
 * became none. The floor now runs once, over the union.
 */
function entriesIn(text: string): { id: string; limits: ModelLimits }[] {
  const models: { id: string; limits: ModelLimits }[] = [];
  const seen = new Set<string>();
  for (const chunk of text.split(ENTRY_ANCHOR).slice(1)) {
    const id = /^(claude-[a-z0-9.\-]+)"/.exec(chunk)?.[1];
    if (!id || seen.has(id)) continue;
    // Only within this entry: the split guarantees the next model's numbers are
    // in the next chunk, so a model whose entry omits the field is skipped
    // rather than given its neighbour's ceiling.
    const limits = /max_output_tokens:\{default:(\d+),upper:(\d+)\}/.exec(chunk);
    if (!limits) continue;
    seen.add(id);
    models.push({ id, limits: { standard: Number(limits[1]), upper: Number(limits[2]) } });
  }
  return models;
}

/** The floor, and the order every reader depends on. */
function tableOf(models: { id: string; limits: ModelLimits }[]): CeilingTable | undefined {
  if (models.length < MIN_MODELS) return undefined;
  // Longest first, so `claude-opus-4-5-20251101` matches `claude-opus-4-5`
  // rather than stopping at a shorter id that happens to be a prefix of it.
  return { models: [...models].sort((a, b) => b.id.length - a.id.length) };
}

/**
 * Apply the table the way the SDK does: the model's own entry, found by the id
 * it starts with. Dated aliases (`…-20251101`) and suffixed variants (`…[1m]`)
 * are the same model as far as the output ceiling is concerned.
 */
export function modelCeiling(table: CeilingTable | undefined, model: string): CeilingReading {
  if (!table) return { known: false, model, reason: "unreadable" };
  const lower = model.toLowerCase();
  const hit = table.models.find((m) => lower.startsWith(m.id));
  return hit ? { known: true, model, ...hit.limits } : { known: false, model, reason: "unlisted" };
}

let cached: Promise<CeilingTable | undefined> | undefined;

/**
 * Where the SDK's bundle lives. It is the entry point the charrette already
 * imports: through 0.1.x the registry sat in a sibling `cli.js`, and from 0.2
 * the entry itself carries it.
 */
function bundlePath(): string {
  return createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
}

/**
 * Where the SDK's native binary lives, for the SDKs that keep the registry
 * there instead.
 *
 * From 0.3.25x the entry bundle is a thin bridge and the model table moved
 * into the platform binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64`
 * and its siblings), which is the Claude Code build the sessions actually run
 * on. It is resolved from the SDK's own directory rather than the charrette's,
 * so a pnpm layout that hoists nothing still finds the copy the SDK uses.
 */
function binaryPath(): string {
  const platform = `${process.platform}-${process.arch}`;
  const pkg = createRequire(bundlePath()).resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`);
  return path.join(path.dirname(pkg), binaryName(process.platform));
}

/**
 * The two files the SDK's platform package should have put on disk: the Claude
 * Code binary every agent session is spawned from, and the manifest that says
 * how big it ought to be.
 *
 * Exported for `charrette version`, which reports whether they are actually
 * there. The platform package is an `optionalDependencies` entry, and a failed
 * fetch of one is not an install error — run de2cb7aa was resumed onto a
 * 0-byte package behind a valid-looking symlink, with pnpm recording the
 * install as complete and `--force` answering "Already up to date" twice. The
 * first thing that noticed was the run dying on `Native CLI binary for
 * darwin-arm64 not found`, which is late: by then the operator has restarted a
 * run to find out.
 */
export function agentBinaryFiles(): { binary: string; manifest: string } {
  return { binary: binaryPath(), manifest: path.join(path.dirname(bundlePath()), "manifest.json") };
}

/**
 * What the SDK's CLI binary is called. Only Windows differs, and only one
 * platform's binary package is ever installed — so this is a rule about a
 * machine the charrette may run on tomorrow, not one it can resolve today.
 */
export function binaryName(platform: string): string {
  return platform === "win32" ? "claude.exe" : "claude";
}

/** How much of the binary is read at a time, and how much of it is kept. */
const CHUNK_BYTES = 8 * 1024 * 1024;
const OVERLAP_BYTES = 1024 * 1024;

/**
 * Read the registry out of a file too big to hold as one string.
 *
 * The binary is two hundred megabytes and the registry inside it is a few
 * kilobytes, contiguous. So it is scanned in chunks, each one overlapping the
 * last by more than the registry is long, and every chunk is parsed exactly
 * as a bundle would be — the same anchor, the same shape, the same silence on
 * a chunk that carries nothing. An entry that straddles the overlap is seen
 * whole in the next chunk, and an entry seen twice is one entry.
 */
export async function ceilingTableFromFile(file: string, chunkBytes = CHUNK_BYTES, overlapBytes = OVERLAP_BYTES): Promise<CeilingTable | undefined> {
  const models = new Map<string, ModelLimits>();
  let carry = "";
  const stream = createReadStream(file, { highWaterMark: chunkBytes });
  for await (const chunk of stream) {
    // latin1: one byte, one character, so an offset is an offset and the
    // ASCII the registry is written in comes through untouched.
    const text = carry + (chunk as Buffer).toString("latin1");
    for (const m of entriesIn(text)) if (!models.has(m.id)) models.set(m.id, m.limits);
    carry = text.slice(-overlapBytes);
  }
  return tableOf([...models.entries()].map(([id, limits]) => ({ id, limits })));
}

/**
 * The installed SDK's registry, wherever this SDK keeps it: the entry bundle
 * first, the native binary when the bundle carries none. Undefined when
 * neither does, or neither can be read.
 */
export async function installedCeilingTable(
  loadBundle: () => Promise<string> = () => readFile(bundlePath(), "utf8"),
  loadBinary: () => Promise<CeilingTable | undefined> = () => ceilingTableFromFile(binaryPath())
): Promise<CeilingTable | undefined> {
  const fromBundle = await loadBundle()
    .then(ceilingTable)
    .catch(() => undefined);
  if (fromBundle) return fromBundle;
  return loadBinary().catch(() => undefined);
}

/**
 * The installed SDK's ceiling for one model.
 *
 * The registry does not change while the charrette runs, so it is read once per
 * process. Never throws: an SDK that cannot be resolved, read, or parsed
 * produces no opinion. `load` is the seam tests use to hand in a bundle; the
 * charrette itself reads whatever the installed SDK keeps.
 */
export async function sdkCeiling(model: string, load?: () => Promise<string>): Promise<CeilingReading> {
  cached ??= (load ? load().then(ceilingTable) : installedCeilingTable()).catch(() => undefined);
  return modelCeiling(await cached, model);
}

/** Forget the cached bundle. Tests only; a process never installs a second SDK. */
export function forgetCeilingTable(): void {
  cached = undefined;
}

/**
 * How much output the charrette may plan around: what it asked for, or the model's
 * ceiling when that is lower. A ceiling that could not be read means taking the
 * request at face value, which is what the charrette did before it could read one.
 */
export function grantedTokens(reading: CeilingReading, asked: number): number {
  return reading.known ? Math.min(reading.upper, asked) : asked;
}

/**
 * How much to actually ask for per message.
 *
 * Everything the model allows, because there is no reason to leave half a plan's
 * worth of it on the table — a message that fits is a message that does not have
 * to be split, repaired, or continued. `fallback` is for a model the SDK does
 * not list, where asking for more than it grants is harmless and asking for less
 * than it grants is not.
 */
export function requestTokens(reading: CeilingReading, fallback: number): number {
  return reading.known ? reading.upper : fallback;
}

/**
 * What the operator is told about the ceiling, or undefined when there is
 * nothing worth saying. Silence means the request was honoured, which is why it
 * has to be silence and not a reassurance nobody reads.
 */
export function ceilingNote(reading: CeilingReading, asked: number, role = "the planner"): string | undefined {
  if (reading.known) {
    if (reading.upper >= asked) return undefined;
    return `output ceiling: ${role} asks for ${asked} tokens per message and ${reading.model} tops out at ${reading.upper} — long output will be cut off mid-message`;
  }
  // Nothing the operator can act on, so nothing is said.
  if (reading.reason === "unreadable") return undefined;
  return (
    `output ceiling: the installed agent SDK does not list ${reading.model} in its model table, so it will fall back to its own default — 32000 tokens per message on every version so far — ` +
    `however high ${role} asks. Upgrade @anthropic-ai/claude-agent-sdk, or expect long output to be cut off mid-message.`
  );
}
