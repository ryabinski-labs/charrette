import { describe, expect, it } from "vitest";
import { SubscriptionConfig } from "@harness/shared";
import {
  accountEnv,
  alternatives,
  describeReading,
  keepsTranscript,
  readRateLimitEvent,
  readUsageSnapshot,
  SubscriptionPaused,
  tripped,
  untilReset,
  watched,
  windowLabel,
} from "./subscription.js";

/**
 * Reading the account's own metering, from two sources that disagree.
 *
 * The disagreement is not hypothetical and is the reason this module exists.
 * Probed against one live Max account, seconds apart, for the same weekly
 * window: the streamed `rate_limit_event` said `utilization: 0.82` with
 * `resetsAt: 1787054400`, and the control channel said `utilization: 82` with
 * `resets_at: "2026-08-18T11:59:59+00:00"`. A fraction and a percentage; epoch
 * seconds and an ISO string. Read either one with the other's contract and the
 * 95% gate never opens, or opens on the first reading of every run.
 */

const config = (over: Partial<Parameters<typeof SubscriptionConfig.parse>[0]> = {}) => SubscriptionConfig.parse(over);

const rateLimitEvent = (over: Record<string, unknown> = {}) => ({
  type: "rate_limit_event",
  session_id: "s1",
  rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.82, resetsAt: 1787054400, ...over },
});

describe("the streamed rate limit event", () => {
  it("reads the live shape the SDK actually emits", () => {
    expect(readRateLimitEvent(rateLimitEvent())).toEqual({
      window: "seven_day",
      // 0.82 of the window, as a percentage — the same number the operator sees.
      percent: 82,
      // Epoch seconds, as milliseconds.
      resetsAt: 1787054400_000,
    });
  });

  it("is not confused by any other message on the stream", () => {
    expect(readRateLimitEvent({ type: "assistant", message: { usage: {} } })).toBeNull();
    expect(readRateLimitEvent(null)).toBeNull();
    expect(readRateLimitEvent("result")).toBeNull();
  });

  it("ignores an event with nothing to read", () => {
    // A shape the SDK does not emit today. It costs nothing to survive it, and
    // reading `undefined` as 0% would report an empty window as a full one.
    expect(readRateLimitEvent({ type: "rate_limit_event" })).toBeNull();
    expect(readRateLimitEvent(rateLimitEvent({ rateLimitType: undefined }))).toBeNull();
    expect(readRateLimitEvent(rateLimitEvent({ utilization: undefined }))).toBeNull();
  });

  it("takes a utilization above 1 as a percentage rather than as 8200%", () => {
    // The contract-break guard: if the streamed event ever switches to the
    // control channel's scale, this reads late rather than parking every run.
    expect(readRateLimitEvent(rateLimitEvent({ utilization: 82 }))?.percent).toBe(82);
    expect(readRateLimitEvent(rateLimitEvent({ utilization: 400 }))?.percent).toBe(100);
    expect(readRateLimitEvent(rateLimitEvent({ utilization: Number.NaN }))?.percent).toBe(0);
    expect(readRateLimitEvent(rateLimitEvent({ utilization: -1 }))?.percent).toBe(0);
  });

  it("reads whichever form of reset time the event carried", () => {
    expect(readRateLimitEvent(rateLimitEvent({ resetsAt: 1787054400_000 }))?.resetsAt).toBe(1787054400_000);
    expect(readRateLimitEvent(rateLimitEvent({ resetsAt: "2026-08-18T11:59:59+00:00" }))?.resetsAt).toBe(Date.parse("2026-08-18T11:59:59+00:00"));
    expect(readRateLimitEvent(rateLimitEvent({ resetsAt: "not a date" }))?.resetsAt).toBeNull();
    expect(readRateLimitEvent(rateLimitEvent({ resetsAt: undefined }))?.resetsAt).toBeNull();
    expect(readRateLimitEvent(rateLimitEvent({ resetsAt: Number.POSITIVE_INFINITY }))?.resetsAt).toBeNull();
  });
});

describe("the control channel's snapshot", () => {
  // Trimmed from a real response. The codenamed windows are not an invention:
  // the live account returned `seven_day_cowork` and `nimbus_quill` alongside
  // the documented ones, which is why nothing here enumerates known names.
  const usage = {
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 4, resets_at: "2026-08-15T07:19:59+00:00" },
      seven_day: { utilization: 82, resets_at: "2026-08-18T11:59:59+00:00" },
      seven_day_opus: null,
      nimbus_quill: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false, monthly_limit: null },
    },
  };

  it("reads every window the plan reported, on the percentage scale it used", () => {
    expect(readUsageSnapshot(usage)).toEqual([
      { window: "five_hour", percent: 4, resetsAt: Date.parse("2026-08-15T07:19:59+00:00") },
      { window: "seven_day", percent: 82, resetsAt: Date.parse("2026-08-18T11:59:59+00:00") },
      // Kept, though it is a window nobody has a name for yet: the operator's
      // `windows` prefixes decide what matters, not this list.
      { window: "nimbus_quill", percent: 0, resetsAt: null },
    ]);
  });

  it("reads nothing from an account whose plan does not meter", () => {
    // An API key, Bedrock or Vertex session: `rate_limits_available: false` and
    // no limits at all. Not an error — there is simply no plan to watch.
    expect(readUsageSnapshot({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toEqual([]);
    expect(readUsageSnapshot({})).toEqual([]);
    expect(readUsageSnapshot(null)).toEqual([]);
    expect(readUsageSnapshot({ rate_limits: "gone" })).toEqual([]);
  });
});

describe("which windows stop a run", () => {
  const weekly = { window: "seven_day", percent: 96, resetsAt: null };
  const opus = { window: "seven_day_opus", percent: 96, resetsAt: null };
  const short = { window: "five_hour", percent: 99, resetsAt: null };

  it("watches every weekly window from one prefix, including ones that do not exist yet", () => {
    expect(watched(weekly, config())).toBe(true);
    expect(watched(opus, config())).toBe(true);
    expect(watched({ window: "seven_day_tangerine", percent: 96, resetsAt: null }, config())).toBe(true);
  });

  it("leaves the short window to the wait that already handles it", () => {
    // `usageLimitWaitMinutes` sleeps a five-hour window off without asking
    // anybody anything, which is the right answer for a wall that reopens over
    // lunch. Stopping the run to ask about it would be an interruption a night
    // run cannot answer.
    expect(watched(short, config())).toBe(false);
    expect(tripped([short], config())).toBeNull();
    expect(watched(short, config({ windows: ["seven_day", "five_hour"] }))).toBe(true);
  });

  it("opens on the window closest to the wall when several are over at once", () => {
    const readings = [weekly, { ...opus, percent: 99 }];
    expect(tripped(readings, config())?.window).toBe("seven_day_opus");
  });

  it("says nothing below the line", () => {
    expect(tripped([{ window: "seven_day", percent: 94.9, resetsAt: null }], config())).toBeNull();
    expect(tripped([{ window: "seven_day", percent: 95, resetsAt: null }], config())?.percent).toBe(95);
    expect(tripped([weekly], config({ pauseAtPercent: 99 }))).toBeNull();
  });
});

describe("what the operator is told", () => {
  it("says which limit, in the words the plan itself uses", () => {
    expect(windowLabel("seven_day")).toBe("weekly limit");
    expect(windowLabel("five_hour")).toBe("5-hour limit");
    // The confusing case, spelled out: 95% of the Opus window is not 95% of
    // the plan, and an operator told "weekly limit" would stop a run that had
    // most of its account left.
    expect(windowLabel("seven_day_opus")).toBe("weekly opus limit");
    expect(windowLabel("seven_day_overage_included")).toBe("weekly overage included limit");
    expect(windowLabel("nimbus_quill")).toBe("nimbus quill limit");
  });

  it("renders the sentence Claude Code itself shows, in the machine's own zone", () => {
    const said = describeReading({ window: "seven_day", percent: 81.6, resetsAt: Date.parse("2026-08-18T11:59:59Z") });
    // Asserted by shape rather than by string: the zone is the machine's, and
    // pinning one would only prove what the test box is set to.
    expect(said).toMatch(/^82% of the weekly limit · resets \w{3} \d{1,2} at \d{1,2}(:\d{2})?[ap]m \(.+\)$/);
  });

  it("says what it knows when the plan named no reset", () => {
    expect(describeReading({ window: "seven_day", percent: 95, resetsAt: null })).toBe("95% of the weekly limit");
    expect(untilReset({ window: "seven_day", percent: 95, resetsAt: null }, 0)).toBe("an unstated time");
  });

  it("puts the wait in the units an operator decides in", () => {
    const at = (ms: number) => untilReset({ window: "seven_day", percent: 96, resetsAt: 1_000_000 + ms }, 1_000_000);
    expect(at(0)).toBe("under an hour");
    expect(at(90 * 60_000)).toBe("2h");
    expect(at(47 * 3_600_000)).toBe("47h");
    expect(at(52 * 3_600_000)).toBe("2d 4h");
    expect(at(72 * 3_600_000)).toBe("3d");
    // A reset in the past is a wait of nothing, not a negative one.
    expect(at(-5 * 3_600_000)).toBe("under an hour");
  });
});

describe("pointing a run at another subscription", () => {
  const accounts = config({
    active: "personal",
    accounts: [
      { name: "personal", env: { CLAUDE_CODE_OAUTH_TOKEN: "$PERSONAL_TOKEN" }, note: "" },
      { name: "work", env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-work" }, note: "the day job" },
      { name: "literal", env: { ANTHROPIC_API_KEY: "sk-inline" }, note: "" },
    ],
  });

  it("offers every account except the one already being spent", () => {
    expect(alternatives(accounts)).toEqual(["work", "literal"]);
  });

  it("reads a credential from the shell rather than from the repository", () => {
    // The config file is committable; a token written into it is a token
    // published. `$NAME` is how one gets in without being in there.
    expect(accountEnv(accounts, "personal", { PERSONAL_TOKEN: "oat-secret" })).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oat-secret" });
    expect(accountEnv(config({ accounts: [{ name: "braces", env: { T: "${WRAPPED}" }, note: "" }] }), "braces", { WRAPPED: "v" })).toEqual({ T: "v" });
  });

  it("passes a plain value through untouched", () => {
    expect(accountEnv(accounts, "work")).toEqual({ CLAUDE_CONFIG_DIR: "/home/me/.claude-work" });
    expect(accountEnv(accounts, "literal")).toEqual({ ANTHROPIC_API_KEY: "sk-inline" });
  });

  it("spawns nothing at all rather than a session with a blank credential", () => {
    // The failure this prevents: an unresolved token falls back to the ambient
    // login — the exhausted account the switch exists to get away from — and
    // the run carries on spending it while the log says it moved.
    expect(() => accountEnv(accounts, "personal", {})).toThrow(/PERSONAL_TOKEN is not set in this shell/);
    expect(() => accountEnv(accounts, "personal", {})).toThrow(/claude setup-token/);
  });

  it("names what it knows when asked for an account that is not configured", () => {
    expect(() => accountEnv(accounts, "typo")).toThrow(/No subscription account named "typo" — known accounts: personal, work, literal/);
    expect(() => accountEnv(config(), "any")).toThrow(/none configured/);
  });

  it("treats no account as the login the operator already has", () => {
    expect(accountEnv(accounts, "")).toEqual({});
  });

  it("knows when a switch leaves the running conversation behind", () => {
    // A session's transcript lives under the config dir that produced it, so a
    // switch that moves it cannot resume the interrupted session — the id is
    // unfindable, and the retry would fail with the attempt already spent.
    expect(keepsTranscript({ CLAUDE_CODE_OAUTH_TOKEN: "a" }, { CLAUDE_CODE_OAUTH_TOKEN: "b" })).toBe(true);
    expect(keepsTranscript({}, { CLAUDE_CONFIG_DIR: "/other" })).toBe(false);
    expect(keepsTranscript({ CLAUDE_CONFIG_DIR: "/same" }, { CLAUDE_CONFIG_DIR: "/same" })).toBe(true);
  });
});

describe("the run parked on quota", () => {
  it("says what parked it and what un-parks it", () => {
    const paused = new SubscriptionPaused("96% of the weekly limit", "abc123");
    expect(paused.message).toMatch(/96% of the weekly limit/);
    expect(paused.message).toMatch(/harness resume abc123 --account <name>/);
    // Thrown without a run id by anything that has none to give.
    expect(new SubscriptionPaused("96% of the weekly limit").message).not.toMatch(/harness resume/);
  });
});
