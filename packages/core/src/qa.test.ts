import { describe, expect, it } from "vitest";
import { failureSignatures, runDeterministicChecks, splitInheritedFailures, type CheckResult } from "./qa.js";

const check = (command: string, output: string): CheckResult => ({ ok: false, failures: [{ command, output }] });

describe("deterministic checks", () => {
  it("reports failures in the configured order, whatever order they finish in", async () => {
    const result = await runDeterministicChecks("/tmp", ["sleep 0.3; echo slowfail >&2; false", "echo fastfail >&2; false", "true"]);
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.command)).toEqual(["sleep 0.3; echo slowfail >&2; false", "echo fastfail >&2; false"]);
    expect(result.failures[0]!.output).toContain("slowfail");
  });

  it("runs the commands concurrently — wall clock is the slowest check, not the sum", async () => {
    const started = Date.now();
    const result = await runDeterministicChecks("/tmp", ["sleep 0.6", "sleep 0.6", "sleep 0.6"]);
    expect(result.ok).toBe(true);
    // Serial would be 1.8s+; allow generous headroom for a loaded machine.
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

/**
 * The failure mode this exists for, seen in production: a task's worktree
 * branches from an integration branch whose suite is already red, or a catch-up
 * merge pulls that suite in mid-flight. The task then fails checks it did not
 * break, spends its whole iteration cap on them, and parks — with correct work
 * sitting in the worktree.
 */
describe("telling a task's own failures from the ones it inherited", () => {
  const RED_BASE = [
    "✖ card provider rejects an expired token (196.264417ms)",
    "  Error: Parse Error: Expected HTTP/, RTSP/ or ICE/",
    "  at Socket.socketOnData (node:_http_client:615:22)",
  ].join("\n");

  it("does not charge a task for a failure that is already red on the base", () => {
    const split = splitInheritedFailures(check("npm run test", RED_BASE), check("npm run test", RED_BASE));
    expect(split.failures).toEqual([]);
    expect(split.inherited.map((i) => i.command)).toEqual(["npm run test"]);
  });

  it("still charges it for the one it did break", () => {
    const alsoMine = `${RED_BASE}\n✖ webhook signature verifies against the endpoint secret (12ms)`;
    const split = splitInheritedFailures(check("npm run test", alsoMine), check("npm run test", RED_BASE));
    expect(split.inherited).toEqual([]);
    expect(split.failures).toHaveLength(1);
    // And it is told which one, so it does not go hunting through the other's.
    expect(split.failures[0]!.introduced).toEqual(["✖ webhook signature verifies against the endpoint secret"]);
  });

  it("ignores the noise that differs between two runs of the same failure", () => {
    const rerun = RED_BASE.replace("196.264417ms", "212.001ms").replace(":615:22", ":617:31");
    expect(splitInheritedFailures(check("npm run test", rerun), check("npm run test", RED_BASE)).failures).toEqual([]);
  });

  it("charges the task for a command the base never ran, or ran green", () => {
    const split = splitInheritedFailures(check("npm run lint", "✖ no-unused-vars"), { ok: true, failures: [] });
    expect(split.failures).toHaveLength(1);
    expect(split.inherited).toEqual([]);
  });

  it("compares whole output when there are no per-test markers to compare", () => {
    // A compiler error has no failing-test lines. Identical output is the same
    // failure; any difference is treated as new, which is the safe direction.
    const tsc = "src/a.ts(4,10): error TS2345: Argument of type 'string'";
    expect(splitInheritedFailures(check("tsc", tsc), check("tsc", tsc)).inherited).toHaveLength(1);
    expect(splitInheritedFailures(check("tsc", `${tsc}\nsrc/b.ts(9,1): error TS2551`), check("tsc", tsc)).failures).toHaveLength(1);
  });

  it("recognises how the common runners announce a failure", () => {
    for (const line of [
      "✖ name of the test",
      "✕ name of the test",
      "not ok 3 - name of the test",
      "FAIL src/thing.test.ts",
      "--- FAIL: TestThing",
      "FAILED tests/test_x.py::test_y",
      "1) Suite name",
    ]) {
      expect(failureSignatures(`some preamble\n${line}\ntrailing noise`), line).toContain(line);
    }
  });
});
