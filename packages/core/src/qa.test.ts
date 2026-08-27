import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { confirmFailures, failureSignatures, runDeterministicChecks, splitInheritedFailures, type CheckResult } from "./qa.js";

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
describe("a failure whose tool talks on both streams", () => {
  // `cargo test` writes "Running tests/..." to stderr and its assertions to
  // stdout, and Node hands back each stream whole. Keeping the tail of the two
  // concatenated therefore keeps the end of stderr and nothing else — on run
  // bc691359 a task gate, its advisor and three worker sessions were shown the
  // last few Running lines of a failing workspace suite and none of the
  // assertion above them, and the task spent 45 minutes of wall clock on it.
  const noisy = `printf 'test docs::numbers_match ... FAILED\\nassertion failed: 48.47%% != 48.49%%\\n'; i=0; while [ $i -lt 400 ]; do printf 'Running tests/filler_%s.rs (target/debug/deps/filler-abcdef0123456789)\\n' "$i" >&2; i=$((i+1)); done; exit 1`;

  it("keeps the end of stdout as well as the end of stderr", async () => {
    const result = await runDeterministicChecks("/tmp", [noisy]);
    expect(result.ok).toBe(false);
    const output = result.failures[0]!.output;
    // The half that says what is wrong.
    expect(output).toContain("assertion failed: 48.47% != 48.49%");
    // And the half that says where it got to, which is all the old tail was.
    expect(output).toContain("Running tests/filler_399.rs");
  });

  it("still spends no more characters than it used to", async () => {
    const result = await runDeterministicChecks("/tmp", [noisy]);
    expect(result.failures[0]!.output.length).toBeLessThanOrEqual(4001);
  });

  it("keeps both ends of a command the harness had to kill, too", async () => {
    const result = await runDeterministicChecks(
      "/tmp",
      [`printf 'the last thing the suite said\\n'; printf 'progress\\n' >&2; sleep 30`],
      0.02
    );
    expect(result.failures[0]!.timedOut).toBe(true);
    expect(result.failures[0]!.output).toContain("never finished");
    expect(result.failures[0]!.output).toContain("the last thing the suite said");
  });
});

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
      "test ops::pm::detects_argument_split ... FAILED",
    ]) {
      expect(failureSignatures(`some preamble\n${line}\ntrailing noise`), line).toContain(line);
    }
  });
});

/**
 * The other half of "not this task's fault": a failure that belongs to nobody's
 * code at all. 29 of the 77 gates in run 40da9337 were failing deterministic
 * checks, and the run's own logs put most of them on a DynamoDB table shared
 * between worktrees — a task charged for a neighbour's leftover process.
 */
describe("asking a failing check a second time", () => {
  const green: CheckResult = { ok: true, failures: [] };
  const split = (command: string, output: string) => splitInheritedFailures(check(command, output), green);

  it("drops a failure that does not survive the re-run, and remembers which failure it was", async () => {
    const confirmed = await confirmFailures("/tmp", split("true", "✖ flake"), green);

    expect(confirmed.failures).toEqual([]);
    expect(confirmed.flaky).toEqual(["true"]);
    // The signature-level fact, for the repository's memory: this named
    // failure was watched to fail and then pass on the same tree.
    expect(confirmed.flakySignatures).toEqual(["✖ flake"]);
  });

  it("does not turn a vanished unmarked failure into a signature memory", async () => {
    // A whole-tail signature names a run of output, not a failure. Remembering
    // one would excuse nothing real later and bloat the table now.
    const confirmed = await confirmFailures("/tmp", split("true", "segfault during startup"), green);

    expect(confirmed.flaky).toEqual(["true"]);
    expect(confirmed.flakySignatures).toEqual([]);
  });

  it("keeps one that fails again, with the fresh output", async () => {
    const confirmed = await confirmFailures("/tmp", split("echo '✖ real' >&2; false", "✖ real"), green);

    expect(confirmed.flaky).toEqual([]);
    expect(confirmed.failures).toHaveLength(1);
    expect(confirmed.failures[0]!.output).toContain("✖ real");
  });

  it("does not run anything when there was nothing to confirm", async () => {
    // The common case by a wide margin: a green tree must cost no second pass.
    const confirmed = await confirmFailures("/tmp", { failures: [], inherited: [{ command: "x", signatures: [] }], timedOut: [] }, green);

    expect(confirmed).toEqual({ failures: [], inherited: [{ command: "x", signatures: [] }], timedOut: [], flaky: [], excused: [], flakySignatures: [] });
  });

  it("moves a command the re-run shows as the base's own into inherited, not flaky", async () => {
    // First pass: one new failure and one the base has. Second: only the base's.
    // The task is owed "not yours", not "it passed" — nothing passed.
    const command = "echo '✖ base only' >&2; false";
    const base = check(command, "✖ base only");
    const first = splitInheritedFailures(check(command, "✖ base only\n✖ mine"), base);
    const confirmed = await confirmFailures("/tmp", first, base);

    expect(confirmed.failures).toEqual([]);
    expect(confirmed.flaky).toEqual([]);
    expect(confirmed.inherited.map((i) => i.command)).toEqual([command]);
  });

  it("does not list a command twice when it was already known to be inherited", async () => {
    const command = "echo '✖ base only' >&2; false";
    const base: CheckResult = { ok: false, failures: [{ command, output: "✖ base only" }, { command: "true", output: "✖ other" }] };
    const first = splitInheritedFailures(
      { ok: false, failures: [{ command, output: "✖ base only\n✖ mine" }, { command: "true", output: "✖ other" }] },
      base
    );
    const confirmed = await confirmFailures("/tmp", first, base);

    expect(confirmed.inherited.map((i) => i.command).sort()).toEqual([command, "true"]);
  });
});

/**
 * The shape that reopened run bc691359's `deploy-container-images-pinned` gate
 * three times: `cargo test --workspace` red twice in a row, each time on a
 * different pre-existing test the task's diff never touched. Command-level
 * confirmation cannot see that — the command DID fail twice — so the question
 * is asked failure by failure.
 */
describe("confirming failure by failure, not command by command", () => {
  const green: CheckResult = { ok: true, failures: [] };
  const split = (command: string, output: string) => splitInheritedFailures(check(command, output), green);

  it("calls a command flaky when its two failures have nothing in common", async () => {
    // First run failed one test, the re-run fails a different one: a property
    // test on a fresh draw, a timing assertion tripping elsewhere. Nothing
    // failed twice, so nothing is charged.
    const confirmed = await confirmFailures("/tmp", split("echo '✖ beta' >&2; false", "✖ alpha"), green);

    expect(confirmed.failures).toEqual([]);
    expect(confirmed.flaky).toEqual(["echo '✖ beta' >&2; false"]);
    expect(confirmed.flakySignatures).toEqual(["✖ alpha"]);
  });

  it("charges only the failures present in both runs, on the fresh output", async () => {
    const command = "printf '✖ real\\n✖ another draw\\n' >&2; false";
    const confirmed = await confirmFailures("/tmp", split(command, "✖ real\n✖ first draw"), green);

    expect(confirmed.failures).toHaveLength(1);
    expect(confirmed.failures[0]!.introduced).toEqual(["✖ real"]);
    expect(confirmed.failures[0]!.output).toContain("another draw");
    // Both one-run-only failures were watched to come and go.
    expect(confirmed.flakySignatures).toEqual(["✖ first draw"]);
  });

  it("still charges unmarked output that fails twice, however much it differs", async () => {
    // A compiler error carries no per-test lines, so two runs of the same real
    // defect can differ anywhere. Failing twice keeps the charge — the cost of
    // a false charge is the status quo; a false excusal waves a defect through.
    const confirmed = await confirmFailures("/tmp", split("echo 'panic at 0x2' >&2; false", "panic at 0x1"), green);

    expect(confirmed.flaky).toEqual([]);
    expect(confirmed.failures).toHaveLength(1);
  });

  it("still charges when only one of the two runs had per-test markers", async () => {
    // First run failed a named test, the re-run could not even compile: those
    // are not comparable failure by failure, and neither run is innocent.
    const confirmed = await confirmFailures("/tmp", split("echo 'error TS2551 somewhere' >&2; false", "✖ named test"), green);

    expect(confirmed.flaky).toEqual([]);
    expect(confirmed.failures).toHaveLength(1);
  });
});

describe("excusing the failures the repository already knows are weather", () => {
  const green: CheckResult = { ok: true, failures: [] };
  const split = (command: string, output: string) => splitInheritedFailures(check(command, output), green);

  it("does not charge a failure that repeats when every repeat is a known flake", async () => {
    const command = "echo '✖ timing test' >&2; false";
    const confirmed = await confirmFailures("/tmp", split(command, "✖ timing test"), green, new Set(["✖ timing test"]));

    expect(confirmed.failures).toEqual([]);
    expect(confirmed.flaky).toEqual([]);
    // Excused is not silent: the worker is told what was set aside, so a task
    // that genuinely broke a known-flaky test can still say so.
    expect(confirmed.excused).toEqual([{ command, signatures: ["✖ timing test"] }]);
  });

  it("charges what is left after the known flakes are set aside", async () => {
    const command = "printf '✖ timing test\\n✖ mine\\n' >&2; false";
    const confirmed = await confirmFailures("/tmp", split(command, "✖ timing test\n✖ mine"), green, new Set(["✖ timing test"]));

    expect(confirmed.excused).toEqual([]);
    expect(confirmed.failures).toHaveLength(1);
    expect(confirmed.failures[0]!.introduced).toEqual(["✖ mine"]);
  });
});

describe("a check the harness killed is not a verdict", () => {
  const green: CheckResult = { ok: true, failures: [] };
  // 0.01 minutes = 600ms. The unit is minutes because that is what an operator
  // configures; the runner keeps it in milliseconds so a test can afford one.
  const tooLong = "echo 'Running tests/slow.rs (target/debug/deps/slow-9d1)'; sleep 30";

  it("marks a command it killed at the timeout, and says so in the output", async () => {
    const result = await runDeterministicChecks("/tmp", [tooLong], 0.01);

    expect(result.ok).toBe(false);
    expect(result.failures[0]!.timedOut).toBe(true);
    expect(result.failures[0]!.output).toContain("killed this command after 0.01 minute(s)");
    // The tail is kept — it is the only clue to where the check got to — but
    // introduced by a sentence saying it decided nothing.
    expect(result.failures[0]!.output).toContain("nothing below is a verdict");
  });

  it("leaves an ordinary failure unmarked", async () => {
    const result = await runDeterministicChecks("/tmp", ["echo '✖ real' >&2; false"], 1);

    expect(result.failures[0]!.timedOut).toBeUndefined();
  });

  it("does not charge a killed check to the task, and does not re-run it", async () => {
    // The bug this exists for: run bc691359's `cargo test --workspace` passes
    // in 21 minutes, was killed at 10, and the kill was reported as a failing
    // test. Seven gates went into looking for a test that was never red.
    const split = splitInheritedFailures(await runDeterministicChecks("/tmp", [tooLong], 0.01), green);

    expect(split.failures).toEqual([]);
    expect(split.inherited).toEqual([]);
    expect(split.timedOut.map((t) => t.command)).toEqual([tooLong]);

    // A second pass would cost another timeout and settle nothing, so there is
    // nothing to confirm and the kill still arrives at the caller.
    const started = Date.now();
    const confirmed = await confirmFailures("/tmp", split, green);
    expect(Date.now() - started).toBeLessThan(500);
    expect(confirmed.failures).toEqual([]);
    expect(confirmed.timedOut.map((t) => t.command)).toEqual([tooLong]);
  });

  it("does not compare a real failure against a base whose check was killed", async () => {
    // A kill on the base is not "the base is red here" — comparing its tail to
    // the worktree's asks whether two interruptions interrupted the same
    // sentence, and the answer is always no, so the task gets charged.
    const command = "echo '✖ real' >&2; false";
    const base = await runDeterministicChecks("/tmp", [tooLong], 0.01);
    const split = splitInheritedFailures(check(command, "✖ real"), base);

    expect(split.failures.map((f) => f.introduced)).toEqual([["✖ real"]]);
  });

  it("carries up a kill that only happened on the re-run", async () => {
    // Ran to a verdict once and was killed the second time: the first run has
    // no second opinion to be confirmed against, so it is not charged either.
    const marker = "/tmp/qa-rerun-kill-marker";
    rmSync(marker, { force: true });
    const flakeThenHang = `test -e ${marker} && exec sleep 30; : > ${marker}; echo '✖ real' >&2; false`;
    const first = await runDeterministicChecks("/tmp", [flakeThenHang], 1);
    const confirmed = await confirmFailures("/tmp", splitInheritedFailures(first, green), green, new Set(), 0.01);
    rmSync(marker, { force: true });

    expect(confirmed.failures).toEqual([]);
    expect(confirmed.timedOut.map((t) => t.command)).toEqual([flakeThenHang]);
  });
});
