import type { SubscriptionConfig } from "@harness/shared";

/**
 * How much of the account's plan is gone, and which subscription is spending it.
 *
 * This is the *other* budget. `budget.ts` prices what a run spent in dollars and
 * stops it at a cap the operator chose; nothing there can see the wall a Claude
 * plan actually has — a weekly window, metered by the account across every
 * machine and every session, which a run can walk into while sitting well under
 * its dollar cap. `usageLimit.ts` reads that wall's dying words *after* every
 * session in flight has hit it. This module reads the climb towards it, so the
 * run can stop while stopping is still cheap.
 *
 * Two sources report it, and they disagree in both fields that matter. Measured
 * against the same account, the same window, seconds apart:
 *
 *   streamed `rate_limit_event`   utilization 0.82   resetsAt 1787054400
 *   control channel (`/usage`)    utilization 82     resets_at "2026-08-18T11:59:59+00:00"
 *
 * A fraction and a percentage; epoch seconds and an ISO string. Either scale
 * hardcoded is a gate that never fires or a gate that fires immediately, and
 * both failures are silent, so neither source is read raw anywhere outside this
 * module: each reader knows which contract it is reading and both produce the
 * same `SubscriptionReading`.
 */

/** One window's utilization, normalised. */
export interface SubscriptionReading {
  /** The plan's own name for the window: `seven_day`, `five_hour`, … */
  window: string;
  /** How much of it is spent, 0-100, whatever scale the source used. */
  percent: number;
  /** Epoch ms the window reopens, or null when the source named no time. */
  resetsAt: number | null;
}

/**
 * A reading from the streamed `rate_limit_event`, or null when the message is
 * not one or names no window.
 *
 * Typed as `unknown` and narrowed here rather than against the SDK's exported
 * type: this is the harness's boundary with a message shape it does not own,
 * and the same normalisation has to serve the tool-loop transport, which emits
 * nothing of the sort today and may tomorrow.
 */
export function readRateLimitEvent(message: unknown): SubscriptionReading | null {
  const m = message as { type?: string; rate_limit_info?: Record<string, unknown> } | null;
  if (!m || m.type !== "rate_limit_event") return null;
  const info = m.rate_limit_info;
  if (!info) return null;
  const window = typeof info.rateLimitType === "string" ? info.rateLimitType : "";
  if (!window) return null;
  const raw = typeof info.utilization === "number" ? info.utilization : null;
  if (raw === null) return null;
  return { window, percent: fromFraction(raw), resetsAt: epochMs(info.resetsAt) };
}

/**
 * Readings from the control channel's structured `/usage` answer — the same data
 * the `/usage` command renders, which is where the operator's "you've used 81%
 * of your weekly limit" sentence comes from.
 *
 * The response carries more window keys than any published type lists (the live
 * account returns `seven_day_cowork`, `nimbus_quill` and others alongside the
 * documented ones), so every key whose value looks like a window is read and the
 * caller's `windows` prefixes decide which ones matter. Enumerating the known
 * names here instead would silently ignore whichever window the plan grows next.
 */
export function readUsageSnapshot(usage: unknown): SubscriptionReading[] {
  const limits = (usage as { rate_limits?: Record<string, unknown> } | null)?.rate_limits;
  if (!limits || typeof limits !== "object") return [];
  const out: SubscriptionReading[] = [];
  for (const [window, value] of Object.entries(limits)) {
    const v = value as { utilization?: unknown; resets_at?: unknown } | null;
    if (!v || typeof v !== "object" || typeof v.utilization !== "number") continue;
    out.push({ window, percent: clampPercent(v.utilization), resetsAt: epochMs(v.resets_at) });
  }
  return out;
}

/**
 * A fraction (0-1) as a percentage.
 *
 * Anything above 1 is taken as already being a percentage rather than as 150%
 * of a window, because a window cannot be more than spent: the only way this
 * sees such a number is the streamed event switching to the other scale, and
 * reading that as 8200% would park every run on the first reading. Guessing
 * wrong here costs one gate that opens late; guessing the other way costs every
 * gate opening at once.
 */
function fromFraction(value: number): number {
  return clampPercent(value <= 1 ? value * 100 : value);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Epoch milliseconds from whichever of the three forms the source used: an ISO
 * string, epoch seconds, or epoch milliseconds.
 *
 * Seconds and milliseconds are told apart by magnitude, which is exact for every
 * time this can be asked about: a reset is always in the near future, and the
 * boundary sits at 1973 read as milliseconds — a date no window resets on.
 */
function epochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < SECONDS_CEILING ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const SECONDS_CEILING = 1e11;

/**
 * Is this a window the operator asked to be stopped for?
 *
 * Prefix matching, so `seven_day` covers the plan-wide weekly window and every
 * per-model one the plan meters beside it (`seven_day_opus`, `seven_day_sonnet`,
 * and whatever it adds next) without the config having to list names that do not
 * exist yet.
 */
export function watched(reading: SubscriptionReading, config: SubscriptionConfig): boolean {
  return config.windows.some((prefix) => reading.window.startsWith(prefix));
}

/**
 * The reading that should stop the run, or null. The worst watched window wins
 * when several are over at once — the operator is being asked one question, and
 * it should be about the one that is closest to the wall.
 */
export function tripped(readings: SubscriptionReading[], config: SubscriptionConfig): SubscriptionReading | null {
  const over = readings.filter((r) => watched(r, config) && r.percent >= config.pauseAtPercent);
  return over.sort((a, b) => b.percent - a.percent)[0] ?? null;
}

/**
 * The window as a person says it: "the weekly limit", "the 5-hour limit".
 *
 * The per-model weekly windows keep their model in the name because they are the
 * confusing case — a run stopped at 95% of `seven_day_opus` still has its whole
 * plan-wide weekly window, and an operator told only "the weekly limit" would
 * reasonably conclude the account was finished for the week.
 */
export function windowLabel(window: string): string {
  if (window === "seven_day") return "weekly limit";
  if (window === "five_hour") return "5-hour limit";
  const model = /^seven_day_(.+)$/.exec(window)?.[1];
  if (model) return `weekly ${model.replace(/_/g, " ")} limit`;
  return `${window.replace(/_/g, " ")} limit`;
}

/**
 * The sentence the operator gets, in the shape Claude Code itself uses:
 * "82% of the weekly limit · resets Aug 18 at 10pm (Australia/Melbourne)".
 *
 * Rendered in the machine's own zone, named explicitly. A reset quoted with no
 * zone is the one detail an operator will misread at exactly the wrong moment —
 * the plan meters in the account's zone and reports an absolute instant, and
 * "resets at 10pm" means nothing until it says whose 10pm.
 */
export function describeReading(reading: SubscriptionReading): string {
  const used = `${Math.round(reading.percent)}% of the ${windowLabel(reading.window)}`;
  if (reading.resetsAt === null) return used;
  return `${used} · resets ${formatReset(reading.resetsAt)}`;
}

function formatReset(at: number): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Date(at);
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: zone }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })
    .format(date)
    // "10:00 PM" reads as "10pm" everywhere Claude Code says this.
    .replace(":00", "")
    .replace(/\s?([AP])M$/, (_, m: string) => m.toLowerCase() + "m");
  return `${day} at ${time} (${zone})`;
}

/** How long until the window reopens, as an operator reads it: "3d 4h", "2h". */
export function untilReset(reading: SubscriptionReading, now: number): string {
  if (reading.resetsAt === null) return "an unstated time";
  const ms = Math.max(0, reading.resetsAt - now);
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return hours <= 1 ? "under an hour" : `${hours}h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/** The accounts the operator may switch to, minus the one already in use. */
export function alternatives(config: SubscriptionConfig): string[] {
  return config.accounts.map((a) => a.name).filter((name) => name !== config.active);
}

/**
 * The environment overlay that points a session at a named account, with `$VAR`
 * references resolved from the harness's own environment.
 *
 * Throws rather than spawning a session with a blank credential. A missing token
 * would otherwise fall back to the ambient login — the account this switch
 * exists to get away from — and the run would carry on spending the exhausted
 * subscription while the log said it had switched.
 *
 * Never logs a value. The names are safe to print and are; the values are the
 * subscription itself.
 */
export function accountEnv(config: SubscriptionConfig, name: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!name) return {};
  const account = config.accounts.find((a) => a.name === name);
  if (!account) {
    const known = config.accounts.map((a) => a.name).join(", ") || "none configured";
    throw new Error(`No subscription account named "${name}" — known accounts: ${known}`);
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(account.env)) {
    const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
    if (!ref) {
      out[key] = raw;
      continue;
    }
    const value = env[ref[1]!];
    if (!value) {
      throw new Error(
        `Subscription account "${name}" sets ${key} from ${raw}, but ${ref[1]} is not set in this shell. ` +
          `Export it (a token from \`claude setup-token\` on that account) and try again.`
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * Thrown when the operator, asked whether to carry on with the plan nearly
 * spent, said no.
 *
 * The sibling of `BudgetExceeded`, and it reads the same way on purpose: the
 * run is parked, not failed, and the message says what to do about it. The
 * difference is what un-parks it — money there, and here either another
 * subscription or a date on the calendar.
 */
export class SubscriptionPaused extends Error {
  constructor(public summary: string, public runId?: string) {
    super(
      `paused on subscription usage: ${summary}` +
        (runId ? ` — run parked. Pick it up with: harness resume ${runId} --account <name>, or once the window resets` : "")
    );
  }
}

/**
 * Two accounts are the same login unless something in the overlay says
 * otherwise — used to decide whether a session interrupted by a switch can be
 * resumed or has to start over.
 *
 * A session's transcript lives under the config directory that produced it, so a
 * switch that moves `CLAUDE_CONFIG_DIR` leaves the old session id unfindable:
 * resuming it fails at the point where the run is already down one attempt.
 * Swapping only a token leaves the transcript exactly where it was.
 */
export function keepsTranscript(before: Record<string, string>, after: Record<string, string>): boolean {
  return (before.CLAUDE_CONFIG_DIR ?? "") === (after.CLAUDE_CONFIG_DIR ?? "");
}
