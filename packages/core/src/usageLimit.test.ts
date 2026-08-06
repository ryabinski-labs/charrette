import { describe, expect, it } from "vitest";
import { humanWait, limitWaitMs, usageLimitOf } from "./usageLimit.js";

/**
 * Reading a quota window's closing sentence.
 *
 * Two things are being pinned here, and the second matters more than the first.
 * One: the shapes the limit actually arrives in are recognised, and the time in
 * them is read in the zone the account is metered in. Two: nothing else is —
 * every wall the harness raises itself (turn ceilings, output ceilings, the
 * operator's budget cap) reaches the same code, and mistaking one of those for a
 * quota limit would park a session for hours over something a retry fixes.
 */

/** 2026-08-05 20:00 UTC — 16:00 in New York, which is UTC-4 in August. */
const NOW = Date.UTC(2026, 7, 5, 20, 0, 0);
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

describe("recognising a usage limit", () => {
  it("reads the session-limit sentence and the zone its reset is quoted in", () => {
    const limit = usageLimitOf("the session ended in an error: You've hit your session limit · resets 8:20pm (America/New_York)", NOW);
    expect(limit).not.toBeNull();
    // 16:00 in New York to 20:20 in New York.
    expect(limit!.resetAt).toBe(NOW + hours(4) + minutes(20));
    expect(limit!.said).toMatch(/session limit/);
  });

  it("reads the older phrasing, and an hour with no minutes", () => {
    const limit = usageLimitOf("Claude usage limit reached. Your limit will reset at 6pm (America/New_York).", NOW);
    expect(limit!.resetAt).toBe(NOW + hours(2));
  });

  it("reads a 24-hour clock quoted without am or pm", () => {
    expect(usageLimitOf("You have reached your weekly limit — resets 23:30 (UTC)", NOW)!.resetAt).toBe(NOW + hours(3) + minutes(30));
  });

  it("takes midnight and noon as the account means them", () => {
    expect(usageLimitOf("usage limit reached, resets 12:00am (UTC)", NOW)!.resetAt).toBe(NOW + hours(4));
    expect(usageLimitOf("usage limit reached, resets 12:30pm (UTC)", NOW)!.resetAt).toBe(NOW + hours(16) + minutes(30));
  });

  it("waits for tomorrow when the reset has properly gone", () => {
    // 3pm in New York is an hour behind the 16:00 it is there now, and an hour
    // is far too long to be the message arriving late.
    expect(usageLimitOf("usage limit reached, resets 3pm (America/New_York)", NOW)!.resetAt).toBe(NOW + hours(23));
  });

  it("treats a reset that has only just gone as now", () => {
    // The message took a moment to get here; the quota is back, not a day away.
    expect(usageLimitOf("usage limit reached, resets 3:55pm (America/New_York)", NOW)!.resetAt).toBe(NOW);
  });

  it("falls back to the local clock for a zone this machine has never heard of", () => {
    const limit = usageLimitOf("usage limit reached, resets 9:15am (PT)", NOW);
    expect(limit!.resetAt).toBeGreaterThanOrEqual(NOW);
    expect(limit!.resetAt).toBeLessThanOrEqual(NOW + hours(24));
  });

  it("reads the epoch form some builds append", () => {
    expect(usageLimitOf(`Claude AI usage limit reached|${Math.floor((NOW + hours(3)) / 1000)}`, NOW)!.resetAt).toBe(NOW + hours(3));
  });

  it("ignores a ten-digit number that cannot be a reset time", () => {
    // Last year's timestamp in the same shape: a coincidence, not an answer.
    expect(usageLimitOf(`Claude AI usage limit reached|${Math.floor((NOW - hours(48)) / 1000)}`, NOW)!.resetAt).toBeNull();
  });

  it("reads a retry-after written in prose", () => {
    expect(usageLimitOf("usage limit reached — try again in 12 minutes", NOW)!.resetAt).toBe(NOW + minutes(12));
    expect(usageLimitOf("usage limit reached — try again in 90 seconds", NOW)!.resetAt).toBe(NOW + 90_000);
    expect(usageLimitOf("usage limit reached — try again in 2 hours", NOW)!.resetAt).toBe(NOW + hours(2));
  });

  it("says a limit was hit even when it cannot say when it lifts", () => {
    const limit = usageLimitOf("You've hit your weekly limit for Claude Opus", NOW);
    expect(limit).not.toBeNull();
    expect(limit!.resetAt).toBeNull();
  });

  it("does not read a clock out of something that is not one", () => {
    expect(usageLimitOf("usage limit reached; the connection was reset 3 times", NOW)!.resetAt).toBeNull();
    expect(usageLimitOf("usage limit reached, resets 25:30 (UTC)", NOW)!.resetAt).toBeNull();
    expect(usageLimitOf("usage limit reached, resets 19:75 (UTC)", NOW)!.resetAt).toBeNull();
    expect(usageLimitOf("usage limit reached, resets 19pm (UTC)", NOW)!.resetAt).toBeNull();
  });
});

describe("the walls that are not usage limits", () => {
  it.each([
    ["nothing at all", undefined],
    ["an empty detail", ""],
    ["the turn ceiling", "error_max_turns (hit the turn ceiling of 90)"],
    ["the output ceiling", "max_tokens (the answer hit the per-message output ceiling of 32000 tokens and was cut off mid-message)"],
    ["an API error about output", "the session ended in an error: API Error: Claude's response exceeded the 1024 output token maximum"],
    ["the operator's own cap", "run budget exceeded: spent $42.10 of a $40.00 cap"],
    ["a crashed subprocess", "Claude Code process exited with code 1"],
    // A worker whose task is *about* rate limiting says the words all day.
    ["work that mentions limits", "the session ended in an error: implemented the rate limit middleware; the limit resets per window"],
  ])("is not one: %s", (_name, detail) => {
    expect(usageLimitOf(detail, NOW)).toBeNull();
  });
});

describe("how long to wait", () => {
  const at = (resetAt: number | null) => ({ resetAt, said: "You've hit your session limit" });

  it("waits until the stated reset, a minute past it", () => {
    expect(limitWaitMs(at(NOW + hours(2)), 0, NOW)).toBe(hours(2) + minutes(1));
  });

  it("probes in a minute when nothing said when, then backs off", () => {
    expect(limitWaitMs(at(null), 0, NOW)).toBe(minutes(1));
    expect(limitWaitMs(at(null), 1, NOW)).toBe(minutes(5));
    expect(limitWaitMs(at(null), 2, NOW)).toBe(minutes(15));
    expect(limitWaitMs(at(null), 3, NOW)).toBe(minutes(30));
    expect(limitWaitMs(at(null), 4, NOW)).toBe(minutes(60));
    // However many times it has been refused, the wait stops widening.
    expect(limitWaitMs(at(null), 9, NOW)).toBe(minutes(60));
  });

  it("cannot spin against a reset the account did not honour", () => {
    // Woken on the stated reset and refused again: the second wait is a real
    // wait, not another immediate retry against the same wall.
    expect(limitWaitMs(at(NOW), 1, NOW)).toBe(minutes(5));
  });
});

describe("saying a wait out loud", () => {
  it.each([
    [30_000, "30s"],
    [minutes(45), "45m"],
    [hours(2), "2h"],
    [hours(2) + minutes(5), "2h 5m"],
    [500, "1s"],
  ])("%dms reads as %s", (ms, text) => {
    expect(humanWait(ms)).toBe(text);
  });
});
