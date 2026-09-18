import { createInterface } from "node:readline/promises";
import type { SubscriptionChoice, SubscriptionGate } from "@charrette/core";
import { notifyDone } from "./notify.js";

/** Ask on stdin. Split out so the prompt can be tested without a terminal. */
async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer;
}

/**
 * Terminal subscription gate: the account's plan is nearly spent.
 *
 * The default — pressing enter — is to stop, which is the opposite of the
 * budget gate's default and deliberate. Raising a cap is the operator agreeing
 * to spend more of a thing they have; carrying on here is the operator agreeing
 * to walk into a wall that reopens in days, with every session in flight dying
 * against it at the same moment. So the safe key is the easy one, and the two
 * ways forward — another subscription, or spending the rest of the window on
 * purpose — are both typed deliberately.
 *
 * The alert fires before the prompt is drawn: a run that reaches this at 3am
 * has an operator who is not reading the terminal, and the whole value of
 * stopping at 95% instead of 100% is that somebody can still choose.
 */
export async function promptForAccount(
  gate: SubscriptionGate,
  ask: (question: string) => Promise<string> = askOnTerminal,
  write: (text: string) => void = (text) => void process.stdout.write(text),
  alert: (title: string, body: string) => void = notifyDone
): Promise<SubscriptionChoice> {
  alert("Claude subscription nearly spent", `${gate.summary} — the run is paused and waiting for you`);
  write(
    `\n===== SUBSCRIPTION =====\n` +
      `${gate.summary}\n` +
      `That is past the ${gate.pauseAtPercent}% line, and the window reopens in ${gate.untilReset}.\n` +
      `The agents are paused, not cancelled${gate.account ? ` — this run is spending "${gate.account}"` : ""}.\n` +
      (gate.alternatives.length
        ? `Other subscriptions configured: ${gate.alternatives.join(", ")}\n`
        : `No other subscriptions are configured. Add one under "subscription.accounts" to be able to switch here.\n`)
  );
  for (;;) {
    const answer = (
      await ask(
        `What now?\n` +
          (gate.alternatives.length ? `  <name>   continue on that subscription (${gate.alternatives.join(", ")})\n` : "") +
          `  c        carry on spending this one and take the limit when it comes\n` +
          `  enter    park the run; \`charrette resume\` picks it up where it stopped\n> `
      )
    ).trim();
    if (answer === "") return { action: "park" };
    if (answer.toLowerCase() === "c") return { action: "continue" };
    // Matched case-insensitively, because the operator is retyping a name they
    // wrote in a config file weeks ago and "Work" for "work" is not a decision
    // worth re-asking for.
    const picked = gate.alternatives.find((name) => name.toLowerCase() === answer.toLowerCase());
    if (picked) return { action: "switch", account: picked };
    write(
      `  "${answer}" is not one of the configured subscriptions` +
        (gate.alternatives.length ? ` (${gate.alternatives.join(", ")})` : "") +
        `. Use "c" to carry on, or enter to park the run.\n`
    );
  }
}
