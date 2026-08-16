import { describe, expect, it } from "vitest";
import { isRunnerStarvation, partitionUnhandled, starvationNote } from "./runnerLoad.js";

/** The error verbatim from CI run 31970423870, which failed a suite of 2298 passing tests. */
const STARVED = {
  name: "Error",
  message: '[vitest-worker]: Timeout calling "onTaskUpdate"',
  stack: 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"\n    at Object.onTimeoutError vitest/dist/chunks/rpc.-pEldfrD.js:53:10',
};

describe("telling a starved runner from a defect", () => {
  it("recognises the timeout that failed run 31970423870", () => {
    expect(isRunnerStarvation(STARVED)).toBe(true);
  });

  it("recognises the other calls that reach the parent the same way", () => {
    // Only onTaskUpdate has been seen, but onCollected and onUserConsoleLog
    // starve identically and must not each need a new release to survive.
    expect(isRunnerStarvation({ message: '[vitest-worker]: Timeout calling "onCollected"' })).toBe(true);
    expect(isRunnerStarvation({ message: "[vitest-worker]: Timeout calling 'onUserConsoleLog'" })).toBe(true);
  });

  it("reads it out of the stack when the message has been rewrapped", () => {
    expect(isRunnerStarvation({ message: "worker exited", stack: STARVED.stack })).toBe(true);
  });

  it("does not take a test's own timeout for the machine's", () => {
    // The costly mistake would be swallowing a real failure that merely says
    // "timeout". Each of these is a defect and must still fail the build.
    expect(isRunnerStarvation({ message: "Test timed out in 60000ms." })).toBe(false);
    expect(isRunnerStarvation({ message: "Timeout calling the payments API" })).toBe(false);
    expect(isRunnerStarvation({ message: "Error: connect ETIMEDOUT 10.0.0.1:443" })).toBe(false);
    expect(isRunnerStarvation({ message: "[vitest-worker]: Failed to terminate worker" })).toBe(false);
  });

  it("treats an error with nothing readable on it as a defect", () => {
    // Conservative on purpose: an unrecognised error costs a re-run, and an
    // ignored one ships.
    expect(isRunnerStarvation({})).toBe(false);
    expect(isRunnerStarvation({ message: 42, stack: null })).toBe(false);
  });
});

describe("what still fails the build", () => {
  it("keeps a real unhandled rejection fatal alongside a starvation error", () => {
    const rejection = { message: "Unhandled Rejection: store is closed" };
    const { fatal, starvation } = partitionUnhandled([STARVED, rejection]);

    expect(fatal).toEqual([rejection]);
    expect(starvation).toEqual([STARVED]);
  });

  it("has nothing to say about a run with no unhandled errors", () => {
    expect(partitionUnhandled([])).toEqual({ fatal: [], starvation: [] });
  });
});

describe("the note the operator reads", () => {
  it("quotes the call that timed out and says the build was not failed for it", () => {
    const note = starvationNote(1, [STARVED]);

    expect(note).toContain('Timeout calling "onTaskUpdate"');
    expect(note).toContain("1 unhandled error that is about this runner");
    expect(note).toContain("the build is not failed for this");
    expect(note).toContain("the runner is the thing to look at");
  });

  it("pluralises, and still says something when the message cannot be quoted", () => {
    const note = starvationNote(2, [STARVED, { stack: STARVED.stack }]);

    expect(note).toContain("2 unhandled errors that are about this runner");
    // One quotable line, not two — the second error carried no message, and a
    // blank bullet would read as a second distinct failure.
    expect(note.split("\n").filter((l) => l.startsWith("  [vitest-worker]"))).toHaveLength(1);
  });
});
