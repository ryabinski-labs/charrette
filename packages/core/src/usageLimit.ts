/**
 * The account ran out of quota — and when it comes back.
 *
 * Claude plans meter usage in windows, and when a window is spent every session
 * in flight dies at once with the same sentence: "You've hit your session limit
 * · resets 8:20pm (America/New_York)". Nothing in it is the agent's fault, the
 * prompt's fault or the repo's fault, and nothing about it is fixed by trying
 * again a second later.
 *
 * Read as an ordinary error it is the most expensive failure the harness has,
 * because it arrives everywhere simultaneously and instantly: in the run that
 * motivated this, the planner spent all three of its attempts inside one second
 * against a wall that had nothing to do with the plan, the run ended
 * `harness: fatal`, and the intake conversation the operator had already sat
 * through went with it. A limit is not a verdict on the work. It is a wait.
 *
 * This module answers the two questions the pool needs to wait it out: is this
 * a limit, and until when.
 */

/** A session death that means the account is out of quota. */
export interface UsageLimit {
  /**
   * When the message said work could resume, in epoch ms — null when it named
   * no time this could read, which is the case the backoff in `limitWaitMs`
   * exists for.
   */
  resetAt: number | null;
  /** What it said, on one line, for the operator's log. */
  said: string;
}

/**
 * The shapes the limit arrives in. Deliberately narrow: this is matched against
 * error text that also carries the harness's own walls — `error_max_turns`, the
 * per-message output ceiling, the operator's budget cap — and treating one of
 * those as a quota limit would park a session for hours over something a retry
 * fixes in seconds. Every one of those says "ceiling", "cap" or "maximum";
 * none of them says a limit was hit or reached.
 */
const LIMIT_PHRASES = [
  // "You've hit your session limit", "You have reached your weekly limit"
  /\byou'?(?:ve|re)?(?:\s+have)?\s+(?:hit|reached)\b[^.\n]{0,40}\blimit\b/i,
  // "Claude usage limit reached", "Claude AI usage limit reached|1759872000"
  /\b(?:usage|session|weekly|hourly|rate|account)[- ]limit\s+(?:reached|exceeded)\b/i,
  // "Your limit will reset at 3pm (America/New_York)"
  /\blimit will reset\b/i,
];

/** Clock time in a message: "resets 8:20pm (America/New_York)", "reset at 10:00 (UTC)". */
const CLOCK = /\breset\w*(?:\s+(?:at|on))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*(?:\(([^)]{1,40})\))?/i;

/** The epoch form some builds append: "…usage limit reached|1759872000". */
const EPOCH = /\|\s*(\d{10})\b/;

/** "try again in 12 minutes" — a retry-after in prose. */
const IN_A_WHILE = /\b(?:try again|retry|available again|back)\s+in\s+(\d{1,4})\s*(second|minute|hour)s?\b/i;

/**
 * Read a session's dying words as a usage limit, or null if they are not one.
 *
 * `now` is injectable because every time this module derives is relative to it
 * — a limit that resets at 8:20pm means nothing without knowing what time it is
 * where the account is metered.
 */
export function usageLimitOf(detail: string | undefined, now = Date.now()): UsageLimit | null {
  if (!detail) return null;
  const text = detail.replace(/\s+/g, " ").trim();
  if (!LIMIT_PHRASES.some((r) => r.test(text))) return null;
  return { resetAt: resetAt(text, now), said: text.slice(0, 200) };
}

/**
 * How long to sleep before trying again.
 *
 * `priorWaits` is how many times this same session has already waited out a
 * limit, and it is what keeps the loop honest in the two ways it can go wrong.
 * A message that names no time gets a probe in a minute and then a widening
 * backoff, rather than a guess at how long a quota window is. And a message
 * whose stated reset has *just* passed — the retry that lands a minute late and
 * is refused again — cannot spin: the second wait is at least five minutes
 * however soon the clock says the quota is back.
 */
export function limitWaitMs(limit: UsageLimit, priorWaits: number, now = Date.now()): number {
  // Wake a little after the stated reset rather than exactly on it: the reset is
  // quoted to the minute, and a request that arrives on the boundary is refused
  // by whichever clock is running slightly behind.
  const stated = limit.resetAt === null ? 0 : Math.max(0, limit.resetAt - now) + RESET_GRACE_MS;
  return Math.max(stated, BACKOFF_MS[Math.min(priorWaits, BACKOFF_MS.length - 1)]!);
}

const RESET_GRACE_MS = 60_000;

/** The floor under each successive wait: a probe, then patience. */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

/** "2h 5m", "45m", "90s" — a wait an operator reads at a glance. */
export function humanWait(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${Math.floor(minutes / 60)}h`;
}

function resetAt(text: string, now: number): number | null {
  const epoch = EPOCH.exec(text);
  if (epoch) {
    const at = Number(epoch[1]) * 1000;
    // A ten-digit number is only a reset time if it lands somewhere a reset
    // could plausibly be; anything else in that shape is a coincidence.
    if (at > now - 24 * 3600_000 && at < now + 30 * 24 * 3600_000) return at;
  }
  const soon = IN_A_WHILE.exec(text);
  if (soon) {
    const unit = { second: 1000, minute: 60_000, hour: 3600_000 }[soon[2]!.toLowerCase() as "second" | "minute" | "hour"];
    return now + Number(soon[1]) * unit;
  }
  const clock = CLOCK.exec(text);
  if (!clock) return null;
  const [, rawHour, rawMinute, meridiem, zone] = clock;
  // "reset 3 times" is not a clock. A time has minutes, or it has am/pm.
  if (!rawMinute && !meridiem) return null;
  let hour = Number(rawHour);
  if (hour > 23) return null;
  if (meridiem) {
    if (hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  const minute = Number(rawMinute ?? 0);
  if (minute > 59) return null;
  return now + msUntilClock(hour, minute, zone, now);
}

/**
 * Milliseconds from now until a wall-clock time in the zone the message quoted.
 *
 * Derived as a delta from the current time *in that zone* rather than by
 * building a date in it: the delta needs no date arithmetic across zones, and a
 * zone name the platform does not know degrades to the local clock instead of
 * throwing. Being an hour out at a DST boundary costs an hour of waiting, which
 * the retry then corrects; being unable to parse at all costs the whole feature.
 */
function msUntilClock(hour: number, minute: number, zone: string | undefined, now: number): number {
  const clock = zoneClock(zone, now);
  const delta = hour * 3600 + minute * 60 - (clock.hour * 3600 + clock.minute * 60 + clock.second);
  // Just gone: the reset the message named is in the past by a few minutes,
  // because the message took a moment to reach here. That is now, not tomorrow.
  if (delta <= 0 && delta > -JUST_PASSED_S) return 0;
  return (delta > 0 ? delta : delta + 24 * 3600) * 1000;
}

const JUST_PASSED_S = 15 * 60;

function zoneClock(zone: string | undefined, now: number): { hour: number; minute: number; second: number } {
  const date = new Date(now);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(date);
    // A part that was asked for and did not come back throws, which lands on
    // the local clock below — the same place an unknown zone lands.
    const at = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return { hour: at("hour") % 24, minute: at("minute"), second: at("second") };
  } catch {
    // An unknown zone ("PT", a typo, a name this ICU build lacks) is not a
    // reason to abandon the wait — the operator's own clock is usually the
    // account's clock, and the retry corrects the rest.
    return { hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() };
  }
}
