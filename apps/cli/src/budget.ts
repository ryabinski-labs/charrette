import { createInterface } from "node:readline/promises";
import type { BudgetGate, RunController } from "@harness/core";

/** Ask on stdin. Split out so the prompt can be tested without a terminal. */
async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

/**
 * Terminal budget gate. The agent session that tripped the cap is still open and
 * waiting, so the default is to keep going: enter accepts the suggested cap and
 * the worker carries on from where it stopped. `s` parks the run instead.
 */
export async function promptForNewCap(
  gate: BudgetGate,
  ask: (question: string) => Promise<string> = askOnTerminal,
  write: (text: string) => void = (text) => void process.stdout.write(text)
): Promise<number | null> {
  // Enough headroom to finish the work in flight rather than re-asking in a minute.
  const suggested = Math.ceil((gate.spentUsd + gate.capUsd) * 100) / 100;
  write(
    `\n===== BUDGET =====\n` +
      `The ${gate.scope} cap of $${gate.capUsd.toFixed(2)} was reached${gate.taskId ? ` on task ${gate.taskId}` : ""}: ` +
      `$${gate.spentUsd.toFixed(2)} spent.\n` +
      (gate.scope === "task" ? `This run has spent $${gate.runSpentUsd.toFixed(2)} in total.\n` : "") +
      `The agent is paused, not cancelled — raising the cap continues it.\n`
  );
  for (;;) {
    const answer = (await ask(`New ${gate.scope} cap in USD? [enter = $${suggested} / s = stop and park the run] `)).trim();
    if (answer.toLowerCase() === "s") return null;
    if (answer === "") return suggested;
    const parsed = Number(answer);
    if (Number.isFinite(parsed) && parsed > gate.spentUsd) return parsed;
    write(`  A new cap must be a number above the $${gate.spentUsd.toFixed(2)} already spent, or "s" to stop.\n`);
  }
}

const BUDGET_COMMAND = /^budget\s+(run|task)\s+([0-9]*\.?[0-9]+)\s*$/i;
const BUDGET_ATTEMPT = /^budget\b/i;

/**
 * A cap raised before it is ever reached, not after — typed into the run's
 * own terminal at any point while it is executing, not only when a gate
 * prompt is on screen. `promptForNewCap` answers "the cap was just hit,
 * what now"; this is for the operator who would rather move first.
 *
 * Reads raw `data` off stdin instead of opening a `readline.Interface`: a
 * plan, task, or pit-stop gate may have one open and waiting for its own
 * answer at the same moment, and a second interface fighting the same
 * stream for line-buffering is the more fragile way to coexist with it.
 * Watching quietly and only ever acting on a line that matches `budget
 * run|task <amount>` costs those prompts nothing when it does not.
 */
export function watchBudgetCommands(
  controller: RunController,
  runId: () => string | undefined,
  write: (text: string) => void = (text) => void process.stdout.write(text)
): () => void {
  if (!process.stdin.isTTY) return () => undefined;
  let buf = "";
  const onData = (chunk: Buffer | string) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      const m = BUDGET_COMMAND.exec(line);
      if (!m) {
        // Only for a line that was clearly an attempt at this command — every
        // other line typed anywhere in the run (chat, gate answers, "y") passes
        // through here too, and those must stay silent.
        if (BUDGET_ATTEMPT.test(line)) write(`  not a budget command: "${line}" — try 'budget run <usd>' or 'budget task <usd>'\n`);
        continue;
      }
      const id = runId();
      if (!id) {
        write("  no run yet to raise a budget for\n");
        continue;
      }
      write(`  ${controller.raiseBudget(id, m[1]!.toLowerCase() as "run" | "task", Number(m[2]))}\n`);
    }
  };
  process.stdin.on("data", onData);
  return () => process.stdin.off("data", onData);
}
