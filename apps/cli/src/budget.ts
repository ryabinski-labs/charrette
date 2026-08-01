import { createInterface } from "node:readline/promises";
import type { BudgetGate } from "@harness/core";

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
