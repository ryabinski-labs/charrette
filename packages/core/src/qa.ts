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
 */
export async function runDeterministicChecks(cwd: string, commands: string[]): Promise<CheckResult> {
  const failures: { command: string; output: string }[] = [];
  for (const command of commands) {
    try {
      await execFileP("sh", ["-c", command], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const output = `${err.stdout ?? ""}\n${err.stderr ?? err.message ?? ""}`.trim();
      failures.push({ command, output: output.slice(-4000) });
    }
  }
  return { ok: failures.length === 0, failures };
}
