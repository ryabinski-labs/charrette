import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_CHECK_TIMEOUT_MINUTES } from "@charrette/shared";

const execFileP = promisify(execFile);

export interface CheckFailure {
  command: string;
  output: string;
  /**
   * The charrette killed this command at the timeout rather than the command
   * deciding anything. Nothing it printed is a verdict on the tree — a kill
   * lands mid-suite, so the tail is whatever the runner happened to be saying
   * — and it is never charged to a task.
   */
  timedOut?: boolean;
}

export interface CheckResult {
  ok: boolean;
  failures: CheckFailure[];
}

/**
 * Deterministic checks (PRD §11.1 QA Pipeline): build/lint/test commands from
 * charrette config, run in the worktree BEFORE any QA tokens are spent.
 * Output is truncated to tails — full logs stay on disk in the worktree (PERF risk #4).
 *
 * The commands run concurrently: lint/typecheck/test read the same tree but do
 * not mutate it, so the wall clock is the slowest check instead of the sum —
 * and this re-runs on every QA iteration, so the sum was paid repeatedly.
 * Failures keep the configured order regardless of finish order.
 */
export async function runDeterministicChecks(cwd: string, commands: string[], timeoutMinutes: number = DEFAULT_CHECK_TIMEOUT_MINUTES): Promise<CheckResult> {
  // Minutes because that is the unit an operator thinks in for a test suite;
  // milliseconds here so a fractional value stays honest rather than rounding
  // up to a minute nobody asked for.
  const timeout = Math.max(1, Math.round(timeoutMinutes * 60 * 1000));
  const results = await Promise.all(
    commands.map(async (command) => {
      try {
        await execFileP("sh", ["-c", command], { cwd, maxBuffer: 16 * 1024 * 1024, timeout });
        return null;
      } catch (e) {
        // `??` was wrong here: execFileP attaches `stderr` as an empty string
        // rather than leaving it undefined, so a check that failed without
        // writing anything — `exit 1` in a script, a missing binary — never
        // reached `message` and handed QA a failure with no explanation at all.
        const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string };
        // Sliced per stream, not after the join. `cargo test` writes its
        // progress to stderr and its assertions to stdout, and Node hands back
        // each stream whole, so the concatenation is [every assertion][every
        // "Running tests/..." line] and a tail of it is reliably all progress
        // and no verdict. On run bc691359 that is precisely what a task gate,
        // its advisor and three worker sessions were shown of a failing
        // workspace suite: the last few Running lines, and none of the
        // assertion above them. Splitting the budget costs the same characters
        // and keeps the end of both.
        const tails = (budget: number) =>
          [err.stdout, err.stderr || err.message]
            .filter((part): part is string => Boolean(part))
            .map((part) => part.trim().slice(-budget))
            .filter(Boolean)
            .join("\n");
        const output = tails(2000);
        // Node sets both of these only when it is the one that ended the
        // process at `timeout`; a command that kills itself exits with a code.
        if (err.killed && err.signal === "SIGTERM") {
          return {
            command,
            timedOut: true,
            output: `the charrette killed this command after ${timeoutMinutes} minute(s) — it never finished, so nothing below is a verdict on this tree:\n${tails(1000)}`,
          };
        }
        return { command, output };
      }
    })
  );
  const failures = results.filter((r): r is CheckFailure => r !== null);
  return { ok: failures.length === 0, failures };
}

/** Colour, timings, addresses and line/column noise — the things that differ between two runs of the same failure. */
function normalizeLine(line: string): string {
  return line
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\(\s*\d+(\.\d+)?\s*(ms|s)\s*\)/g, "")
    .replace(/\b\d+(\.\d+)?\s?(ms|µs)\b/g, "")
    .replace(/:\d+:\d+\b/g, "")
    .replace(/0x[0-9a-f]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How the common runners announce a failing test, across node:test, vitest,
 * jest, go, pytest and cargo. Cargo earns its own alternative because it is the
 * one runner here that puts the verdict at the end of the line — `test path ...
 * FAILED` — and for as long as it was missing, every Rust failure collapsed
 * into one whole-tail signature and none of the per-failure comparisons below
 * ever applied to a Rust repository.
 */
const FAILURE_MARKER = /^(?:[✖✕×✗✘●]|not ok\b|FAIL\b|FAILED\b|--- FAIL:|\d+\)\s|test .+ \.\.\. FAILED\b)/;

/**
 * The distinct failures in a check's output, in a form that survives a re-run.
 *
 * Output with no recognisable per-test markers — a compiler error, a runner that
 * crashed before it printed anything — has no structure to compare, so the whole
 * tail becomes one signature. That errs toward calling a difference "new", which
 * is the safe direction: the cost of a false "new" is the status quo, and the
 * cost of a false "inherited" is a real defect waved through.
 */
export function failureSignatures(output: string): string[] {
  const lines = output.split("\n").map(normalizeLine).filter(Boolean);
  const marked = [...new Set(lines.filter((l) => FAILURE_MARKER.test(l)))];
  return marked.length ? marked : [lines.join("\n").slice(-2000)];
}

/**
 * Whether two runs of this output could be compared failure by failure.
 *
 * The per-signature judgements in `confirmFailures` are only sound when the
 * signatures name individual failures. A whole-tail signature is one blob of
 * everything the command printed, and two runs of the same real defect can
 * differ anywhere in that blob — so for unmarked output the comparisons fall
 * back to the command-level question, which errs toward charging.
 */
export function hasFailureMarkers(output: string): boolean {
  return output.split("\n").some((l) => FAILURE_MARKER.test(normalizeLine(l)));
}

export interface InheritedSplit {
  /** Failures this tree introduced — the only ones the task should answer for. */
  failures: { command: string; output: string; introduced: string[] }[];
  /** Failures that fail on the base too, named so that nobody is sent to chase them. */
  inherited: { command: string; signatures: string[] }[];
  /**
   * Commands the charrette killed at the timeout. Not a verdict on anything, so
   * not charged and not re-run — but not silently dropped either: a check that
   * never finishes is the operator's problem to fix, in the configuration, and
   * it has to be visible to be fixed.
   */
  timedOut: { command: string; output: string }[];
}

export interface ConfirmedFailures extends InheritedSplit {
  /** Commands that failed once and then produced nothing chargeable on the re-run. */
  flaky: string[];
  /**
   * Failures that survived the re-run but whose every repeated signature is one
   * this repository has already watched fail and then pass. Not charged, and
   * not silent either: the worker is told what was excused and why, so a task
   * that genuinely broke a known-flaky test can still say so.
   */
  excused: { command: string; signatures: string[] }[];
  /**
   * Individual failures watched to fail and then pass on this same tree — the
   * signature-level fact `observeFlakySignatures` records for the next task
   * that meets them. Only from marked output: a whole-tail signature names a
   * run, not a failure, and remembering one teaches nothing.
   */
  flakySignatures: string[];
}

/**
 * Run the failing commands a second time and keep only what fails again —
 * failure by failure, not command by command.
 *
 * A check can fail for reasons that have nothing to do with the tree it ran in:
 * another worktree's leftover process writing to the same local database, a port
 * that was still bound, a suite that shares a counter between its own cases. The
 * charrette cannot tell those from a real defect by reading the output — but it
 * can ask again, and a contaminated failure usually does not survive the asking.
 *
 * Charging one to the task is expensive twice over: the worker spends an
 * iteration trying to fix code that was never broken, and the iteration cap it
 * burns is what opens a gate. 29 of the 77 gates in run 40da9337 were failing
 * deterministic checks, and the run's own logs attribute most of them to a
 * DynamoDB table shared across worktrees.
 *
 * The comparison is per signature because a flake generator keeps its command
 * red while never failing the same way twice: a property test drawing a fresh
 * input each run, a timing assertion tripping on whichever case the load
 * landed on. Run bc691359's `deploy-container-images-pinned` reopened its gate
 * three times on exactly that shape — `cargo test --workspace` red twice in a
 * row, each time on a pre-existing test its diff never touched. So of a command
 * that fails twice, only the signatures present in *both* runs are charged; a
 * command with none in common is flaky, and the disagreements are recorded as
 * signature-level flakes for the next task that meets them (`knownFlaky` is
 * that memory, read back in). Unmarked output — a compiler error, a crashed
 * runner — has no per-failure structure to compare, so failing twice still
 * charges it whole: the cost of a false charge is the status quo, and the cost
 * of a false excusal is a real defect waved through.
 *
 * Only the introduced failures are re-run — inherited ones were already settled
 * against the base and cost nothing to keep — so this spends a second check pass
 * exactly when the alternative is a wasted worker iteration.
 */
export async function confirmFailures(cwd: string, split: InheritedSplit, base: CheckResult, knownFlaky: ReadonlySet<string> = new Set(), timeoutMinutes: number = DEFAULT_CHECK_TIMEOUT_MINUTES): Promise<ConfirmedFailures> {
  if (!split.failures.length) return { ...split, flaky: [], excused: [], flakySignatures: [] };
  // The same ceiling as the first pass: a re-run allowed to outlive it would
  // call a check green that the first pass was never given time to finish.
  const rerun = await runDeterministicChecks(
    cwd,
    split.failures.map((f) => f.command),
    timeoutMinutes
  );
  const again = splitInheritedFailures(rerun, base);
  const secondRun = new Map(again.failures.map((f) => [f.command, f]));
  // Re-splitting can move a command from introduced to inherited — a second run
  // that produced only the base's own failures. Fold those in without listing a
  // command twice: `inherited` is printed to the worker as "not yours".
  const inherited = [...split.inherited];
  for (const i of again.inherited) {
    if (!inherited.some((h) => h.command === i.command)) inherited.push(i);
  }

  // A command that ran to a verdict once and was killed on the re-run says
  // nothing the second time; carry the kill up rather than charging the first
  // run for it.
  const timedOut = [...split.timedOut];
  for (const t of again.timedOut) {
    if (!timedOut.some((h) => h.command === t.command)) timedOut.push(t);
  }

  const confirmed: ConfirmedFailures = { failures: [], inherited, timedOut, flaky: [], excused: [], flakySignatures: [] };
  for (const first of split.failures) {
    if (again.inherited.some((i) => i.command === first.command)) continue; // settled above: the base's, not this task's
    if (again.timedOut.some((t) => t.command === first.command)) continue; // killed on the re-run: no second opinion to compare
    const second = secondRun.get(first.command);
    if (!second) {
      confirmed.flaky.push(first.command);
      if (hasFailureMarkers(first.output)) confirmed.flakySignatures.push(...first.introduced);
      continue;
    }
    if (!hasFailureMarkers(first.output) || !hasFailureMarkers(second.output)) {
      confirmed.failures.push(second);
      continue;
    }
    const firstSigs = new Set(first.introduced);
    const secondSigs = new Set(second.introduced);
    confirmed.flakySignatures.push(...first.introduced.filter((s) => !secondSigs.has(s)));
    const repeated = second.introduced.filter((s) => firstSigs.has(s));
    if (!repeated.length) {
      confirmed.flaky.push(first.command);
      continue;
    }
    const charged = repeated.filter((s) => !knownFlaky.has(s));
    if (charged.length) confirmed.failures.push({ ...second, introduced: charged });
    else confirmed.excused.push({ command: second.command, signatures: repeated });
  }
  confirmed.flakySignatures = [...new Set(confirmed.flakySignatures)];
  return confirmed;
}

/**
 * Separate the failures a task caused from the ones it inherited.
 *
 * A task's worktree branches from the integration branch, and a catch-up merge
 * pulls that branch in mid-flight — so a suite that is red on the base is red in
 * the worktree of every task in the run. Holding a task to account for that
 * spends its iteration cap on other people's bugs and then parks work nobody
 * ever found fault with, which is the single most expensive way this charrette
 * fails. A failure that also fails on the base is not evidence about this task.
 */
export function splitInheritedFailures(current: CheckResult, base: CheckResult): InheritedSplit {
  const onBase = new Map(base.failures.filter((f) => !f.timedOut).map((f) => [f.command, new Set(failureSignatures(f.output))]));
  const split: InheritedSplit = { failures: [], inherited: [], timedOut: [] };
  for (const failure of current.failures) {
    // A kill is not evidence. Comparing its tail against the base's asks
    // whether two interruptions interrupted the same sentence.
    if (failure.timedOut) {
      split.timedOut.push({ command: failure.command, output: failure.output });
      continue;
    }
    const known = onBase.get(failure.command);
    const signatures = failureSignatures(failure.output);
    const introduced = known ? signatures.filter((s) => !known.has(s)) : signatures;
    if (introduced.length) split.failures.push({ ...failure, introduced });
    else split.inherited.push({ command: failure.command, signatures });
  }
  return split;
}
