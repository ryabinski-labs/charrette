import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface CheckResult {
  ok: boolean;
  failures: { command: string; output: string }[];
}

/**
 * Deterministic checks (PRD §11.1 QA Pipeline): build/lint/test commands from
 * harness config, run in the worktree BEFORE any QA tokens are spent.
 * Output is truncated to tails — full logs stay on disk in the worktree (PERF risk #4).
 *
 * The commands run concurrently: lint/typecheck/test read the same tree but do
 * not mutate it, so the wall clock is the slowest check instead of the sum —
 * and this re-runs on every QA iteration, so the sum was paid repeatedly.
 * Failures keep the configured order regardless of finish order.
 */
export async function runDeterministicChecks(cwd: string, commands: string[]): Promise<CheckResult> {
  const results = await Promise.all(
    commands.map(async (command) => {
      try {
        await execFileP("sh", ["-c", command], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
        return null;
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        const output = `${err.stdout ?? ""}\n${err.stderr ?? err.message ?? ""}`.trim();
        return { command, output: output.slice(-4000) };
      }
    })
  );
  const failures = results.filter((r): r is { command: string; output: string } => r !== null);
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

/** How the common runners announce a failing test, across node:test, vitest, jest, go and pytest. */
const FAILURE_MARKER = /^(?:[✖✕×✗✘●]|not ok\b|FAIL\b|FAILED\b|--- FAIL:|\d+\)\s)/;

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

export interface InheritedSplit {
  /** Failures this tree introduced — the only ones the task should answer for. */
  failures: { command: string; output: string; introduced: string[] }[];
  /** Failures that fail on the base too, named so that nobody is sent to chase them. */
  inherited: { command: string; signatures: string[] }[];
}

/**
 * Separate the failures a task caused from the ones it inherited.
 *
 * A task's worktree branches from the integration branch, and a catch-up merge
 * pulls that branch in mid-flight — so a suite that is red on the base is red in
 * the worktree of every task in the run. Holding a task to account for that
 * spends its iteration cap on other people's bugs and then parks work nobody
 * ever found fault with, which is the single most expensive way this harness
 * fails. A failure that also fails on the base is not evidence about this task.
 */
export function splitInheritedFailures(current: CheckResult, base: CheckResult): InheritedSplit {
  const onBase = new Map(base.failures.map((f) => [f.command, new Set(failureSignatures(f.output))]));
  const split: InheritedSplit = { failures: [], inherited: [] };
  for (const failure of current.failures) {
    const known = onBase.get(failure.command);
    const signatures = failureSignatures(failure.output);
    const introduced = known ? signatures.filter((s) => !known.has(s)) : signatures;
    if (introduced.length) split.failures.push({ ...failure, introduced });
    else split.inherited.push({ command: failure.command, signatures });
  }
  return split;
}
