import { describe, expect, it } from "vitest";
import { promptForNewCap } from "./budget.js";

const GATE = { scope: "run" as const, spentUsd: 8.5, capUsd: 8, runSpentUsd: 8.5 };

/** Feeds scripted answers to the prompt and captures what the operator was shown. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const shown: string[] = [];
  let i = 0;
  return {
    asked,
    shown,
    ask: async (q: string) => {
      asked.push(q);
      return answers[i++] ?? "s";
    },
    write: (s: string) => void shown.push(s),
  };
}

describe("terminal budget prompt", () => {
  it("defaults to continuing, because the agent that tripped the cap is still waiting", async () => {
    const io = scripted([""]);
    // spent 8.50 + cap 8.00 = enough headroom to finish, not an open cheque.
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBe(16.5);
    expect(io.asked[0]).toMatch(/enter = \$16\.5/);
  });

  it("takes an explicit amount", async () => {
    const io = scripted(["25"]);
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBe(25);
  });

  it("stops on s", async () => {
    const io = scripted(["s"]);
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBeNull();
  });

  it("re-asks rather than accepting a cap already spent through", async () => {
    const io = scripted(["8.50", "nonsense", "30"]);
    await expect(promptForNewCap(GATE, io.ask, io.write)).resolves.toBe(30);
    expect(io.asked).toHaveLength(3);
    expect(io.shown.join("")).toMatch(/must be a number above the \$8\.50 already spent/);
  });

  it("says the agent is paused, not cancelled — that is the whole point", async () => {
    const io = scripted(["s"]);
    await promptForNewCap(GATE, io.ask, io.write);
    expect(io.shown.join("")).toMatch(/paused, not cancelled/);
  });

  it("names the task and the whole-run spend when it is the task cap that tripped", async () => {
    const io = scripted(["s"]);
    await promptForNewCap({ scope: "task", taskId: "publisher-reindex", spentUsd: 10, capUsd: 10, runSpentUsd: 22.4 }, io.ask, io.write);
    const text = io.shown.join("");
    expect(text).toMatch(/on task publisher-reindex/);
    expect(text).toMatch(/\$22\.40 in total/);
  });
});
