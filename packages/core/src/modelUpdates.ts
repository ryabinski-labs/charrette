import { modelId, providerFor, type Provider } from "@charrette/shared";
import { isPriced } from "./budget.js";
import { installedCeilingTable } from "./outputCeiling.js";
import { apiKeyFor, type Fetch } from "./providerClients.js";

/**
 * Newer models, recommended at startup and never applied.
 *
 * Vendors ship a new generation every few months, and a routing table written
 * against the last one keeps running on it until somebody notices. Nothing in
 * a run says so: the old model still answers, still prices, still passes. So at
 * `charrette run` each vendor in use is asked what it serves, and a role whose
 * model has a newer release in the same family gets one line saying which and
 * how to switch.
 *
 * Only ever a recommendation. A new model changes what every agent in the run
 * does, and the operator decides that, not a list endpoint. And only within a
 * family — Sonnet to a newer Sonnet, Flash to a newer Flash — because moving a
 * role across tiers is a price and capability decision this check cannot make.
 * That rule also keeps a pinned judge above its floor: a Sonnet is never
 * recommended down to a Haiku.
 *
 * Every failure is silent. An unreachable vendor, a missing key or an
 * unexpected response shape means no recommendation for that vendor, never a
 * delayed or refused start.
 */

/** What a model id says about where it sits: its family, and its version within it. */
export interface ModelFamily {
  provider: Provider;
  family: string;
  version: number[];
}

const CLAUDE = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;
const GEMINI = /^gemini-(\d+(?:\.\d+)*)-([a-z][a-z-]*)$/;
const GPT = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z]+))?$/;

/**
 * The family and version of a model id, or undefined when the id carries no
 * comparable version.
 *
 * `deepseek-flash` is the case that matters: DeepSeek serves its current
 * checkpoint behind the unversioned name, so there is nothing to be behind.
 * A dated Claude id (`claude-haiku-4-5-20251001`) reads as its version, so it
 * is compared with the undated ids the vendor lists now.
 */
export function modelFamily(model: string): ModelFamily | undefined {
  const id = modelId(model);
  const provider = providerFor(model);
  const numbers = (dotted: string) => dotted.split(".").map(Number);
  if (provider === "anthropic") {
    const m = CLAUDE.exec(id);
    return m ? { provider, family: m[1]!, version: [Number(m[2]), Number(m[3] ?? 0)] } : undefined;
  }
  if (provider === "google") {
    const m = GEMINI.exec(id);
    return m ? { provider, family: m[2]!, version: numbers(m[1]!) } : undefined;
  }
  if (provider === "openai") {
    const m = GPT.exec(id);
    return m ? { provider, family: m[2] ?? "", version: numbers(m[1]!) } : undefined;
  }
  return undefined;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The newest model in `available` from the same family as `current`, when it
 * is newer than `current`. Undated ids win a tie with dated ones, since the
 * undated alias is what the vendor points people at.
 */
export function newerModel(current: string, available: string[]): string | undefined {
  const mine = modelFamily(current);
  if (!mine) return undefined;
  let best: { id: string; version: number[] } | undefined;
  for (const id of available) {
    const theirs = modelFamily(id);
    if (!theirs || theirs.provider !== mine.provider || theirs.family !== mine.family) continue;
    if (compareVersions(theirs.version, mine.version) <= 0) continue;
    const order = best ? compareVersions(theirs.version, best.version) : 1;
    if (order > 0 || (order === 0 && id.length < best!.id.length)) best = { id, version: theirs.version };
  }
  return best?.id;
}

/**
 * One line per recommended move, naming every role it applies to and both
 * ways to make it. A model the price table does not know yet is said so: the
 * ledger bills it at the top-tier fallback until it is priced.
 */
export function modelRecommendations(models: Record<string, string>, available: Partial<Record<Provider, string[]>>): string[] {
  const moves = new Map<string, { to: string; roles: string[] }>();
  for (const [role, model] of Object.entries(models)) {
    const list = available[providerFor(model)];
    const to = list && newerModel(model, list);
    if (!to) continue;
    const move = moves.get(model) ?? { to, roles: [] };
    move.roles.push(role);
    moves.set(model, move);
  }
  return [...moves].map(([from, { to, roles }]) => {
    const flags = roles.map((r) => `--model ${r}=${to}`).join(" ");
    const json = roles.map((r) => `"${r}": "${to}"`).join(", ");
    const unpriced = isPriced(to) ? "" : ` Not in charrette's price table yet, so the ledger bills it at the $10/$50 fallback until it is.`;
    return `${to} is newer than ${from} (${roles.join(", ")}). To switch: ${flags}, or "models": { ${json} } in charrette.config.json.${unpriced}`;
  });
}

const TIMEOUT_MS = 4000;

async function getJson(fetchImpl: Fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const ids = (rows: unknown, key: string): string[] | undefined =>
  Array.isArray(rows) ? rows.map((r) => (r as Record<string, unknown>)?.[key]).filter((v): v is string => typeof v === "string") : undefined;

export interface ListOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Fetch;
  /** The Anthropic models the installed Agent SDK knows, for an operator signed in without an API key. */
  sdkModels?: () => Promise<string[] | undefined>;
}

const sdkModelIds = async () => (await installedCeilingTable())?.models.map((m) => m.id);

/**
 * What one vendor serves, or undefined when that cannot be found out.
 *
 * Anthropic is asked with an API key when there is one. Without one — the
 * operator signed in to Claude instead — the installed Agent SDK's own model
 * table stands in, which lists what the SDK can actually drive. DeepSeek is
 * never asked: its ids carry no version to compare.
 */
export async function listModels(provider: Provider, opts: ListOptions = {}): Promise<string[] | undefined> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const key = apiKeyFor(provider, env);
  try {
    if (provider === "anthropic") {
      if (!key) return await (opts.sdkModels ?? sdkModelIds)();
      const body = (await getJson(fetchImpl, "https://api.anthropic.com/v1/models?limit=1000", {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      })) as { data?: unknown };
      return ids(body.data, "id");
    }
    if (!key) return undefined;
    if (provider === "google") {
      const body = (await getJson(fetchImpl, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
        "x-goog-api-key": key,
      })) as { models?: unknown };
      return ids(body.models, "name")?.map((name) => name.replace(/^models\//, ""));
    }
    if (provider === "openai") {
      const body = (await getJson(fetchImpl, "https://api.openai.com/v1/models", { authorization: `Bearer ${key}` })) as { data?: unknown };
      return ids(body.data, "id");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The startup banner lines: every vendor the routing table uses, asked in
 * parallel, compared role by role. Empty when nothing is newer, when nothing
 * could be asked, or when `CHARRETTE_MODEL_CHECK=0` turns the check off.
 */
export async function newerModelBanner(models: Record<string, string>, opts: ListOptions = {}): Promise<string[]> {
  const env = opts.env ?? process.env;
  if (env.CHARRETTE_MODEL_CHECK === "0") return [];
  const providers = [...new Set(Object.values(models).map((m) => providerFor(m)))];
  const lists = await Promise.all(providers.map(async (p) => [p, await listModels(p, opts)] as const));
  const available: Partial<Record<Provider, string[]>> = {};
  for (const [p, list] of lists) if (list) available[p] = list;
  const lines = modelRecommendations(models, available);
  return lines.length
    ? [`newer      ${lines[0]}`, ...lines.slice(1).map((l) => `           ${l}`), "           (CHARRETTE_MODEL_CHECK=0 skips this check)"]
    : [];
}
