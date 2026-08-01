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
